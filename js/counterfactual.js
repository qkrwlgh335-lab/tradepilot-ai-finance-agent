const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export class CounterfactualError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CounterfactualError";
    this.code = code;
    this.details = details;
  }
}

const fail = (code, message, details) => {
  throw new CounterfactualError(code, message, details);
};

const deepFreeze = (value) => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
};

export const SCENARIOS = deepFreeze([
  {
    id: "payment_delay_1m",
    label: "입금 1개월 지연",
    priority: "P0",
    implemented: true,
    allowedFields: ["transactions.*.months"],
  },
  {
    id: "revenue_drop_30",
    label: "매출·수취액 30% 감소",
    priority: "P0",
    implemented: true,
    allowedFields: ["transactions.*.amount"],
  },
  {
    id: "adverse_fx_5",
    label: "통화별 불리한 환율 5%",
    priority: "P0",
    implemented: true,
    allowedFields: ["rates.*"],
  },
  {
    id: "early_termination",
    label: "중도 해지 필요",
    priority: "P1",
    implemented: false,
    allowedFields: [],
  },
  {
    id: "eligibility_miss",
    label: "상품 자격 미충족",
    priority: "P1",
    implemented: false,
    allowedFields: [],
  },
]);

const scenarioById = new Map(SCENARIOS.map((scenario) => [scenario.id, scenario]));

const UNSAFE_PATH_SEGMENTS = new Set([
  "__proto__",
  "prototype",
  "constructor",
  ".",
  "..",
]);

const decodePathSegment = (segment) => {
  let decoded = segment;
  for (let round = 0; round < 16; round += 1) {
    let next;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return null;
    }
    if (next === decoded) return decoded;
    decoded = next;
  }
  return null;
};

const isSafeWildcardSegment = (segment) => {
  if (typeof segment !== "string" || segment.length === 0) return false;
  const decoded = decodePathSegment(segment);
  return decoded !== null
    && decoded.length > 0
    && !UNSAFE_PATH_SEGMENTS.has(decoded.toLowerCase());
};

const TRANSACTION_PATH_TOKEN = /^id~(?:[0-9a-f]{4})+$/;

const pathMatches = (pattern, path) => {
  if (typeof path !== "string") return false;
  const expected = pattern.split(".");
  const actual = path.split(".");
  return expected.length === actual.length
    && expected.every((part, index) => {
      if (part !== "*") return part === actual[index];
      if (!isSafeWildcardSegment(actual[index])) return false;
      return expected[0] !== "transactions"
        || index !== 1
        || TRANSACTION_PATH_TOKEN.test(actual[index]);
    });
};

export function isAllowedChangePath(scenarioId, path) {
  const scenario = scenarioById.get(scenarioId);
  return !!scenario && scenario.allowedFields.some((pattern) => pathMatches(pattern, path));
}

const isValidAfterValue = (scenarioId, value) => {
  if (!Number.isFinite(value)) return false;
  if (scenarioId === "payment_delay_1m") return value >= 0;
  return value > 0;
};

export function validateScenarioProposal(proposal) {
  const errors = [];
  if (!isObject(proposal)) return { ok: false, errors: ["시나리오 제안은 객체여야 합니다."] };
  const scenario = scenarioById.get(proposal.id);
  if (!scenario) errors.push("승인되지 않은 시나리오 ID입니다.");
  else if (!scenario.implemented) errors.push("아직 실행이 승인되지 않은 준비 중 시나리오입니다.");
  if (!Array.isArray(proposal.changes) || proposal.changes.length === 0) {
    errors.push("변경 목록이 필요합니다.");
  } else {
    const seen = new Set();
    for (const [index, change] of proposal.changes.entries()) {
      if (!isObject(change)) {
        errors.push(`${index + 1}번째 변경은 객체여야 합니다.`);
        continue;
      }
      if (!scenario || !isAllowedChangePath(proposal.id, change.path))
        errors.push(`${index + 1}번째 변경 경로는 허용되지 않습니다.`);
      if (typeof change.path === "string" && seen.has(change.path))
        errors.push(`${index + 1}번째 변경 경로가 중복됐습니다.`);
      if (typeof change.path === "string") seen.add(change.path);
      if (!scenario || !isValidAfterValue(proposal.id, change.after))
        errors.push(`${index + 1}번째 변경값이 올바르지 않습니다.`);
    }
  }
  return { ok: errors.length === 0, errors };
}

const requiredEngine = (engines, moduleName, functionName) => {
  const fn = engines?.[moduleName]?.[functionName];
  if (typeof fn !== "function")
    fail("INVALID_DEPENDENCY", `반사실 계산 의존성 ${moduleName}.${functionName}을 확인할 수 없습니다.`);
  return fn;
};

const resolveEngines = (deps) => {
  if (!isObject(deps) || !isObject(deps.engines))
    fail("INVALID_DEPENDENCY", "반사실 계산 엔진 묶음을 확인할 수 없습니다.");
  const engines = deps.engines;
  return {
    computeCFaRBuckets: requiredEngine(engines, "risk", "computeCFaRBuckets"),
    portfolioCFaR: requiredEngine(engines, "risk", "portfolioCFaR"),
    bucketNotionalKrw: requiredEngine(engines, "risk", "bucketNotionalKrw"),
    liquidityTimeline: requiredEngine(engines, "risk", "liquidityTimeline"),
    compareStrategies: requiredEngine(engines, "strategy", "compareStrategies"),
    buildProfile: requiredEngine(engines, "profile", "buildProfile"),
    recommend: requiredEngine(engines, "reasoner", "recommend"),
  };
};

const validateBaseInput = (input) => {
  if (!isObject(input)) fail("INVALID_INPUT", "반사실 기준 입력은 객체여야 합니다.");
  if (!Array.isArray(input.transactions) || input.transactions.length === 0)
    fail("INVALID_TRANSACTIONS", "반사실 계산에 사용할 거래 목록이 필요합니다.");
  if (!isObject(input.rates) || !isObject(input.annualVol))
    fail("INVALID_MARKET_DATA", "환율·변동성 기준 데이터를 확인할 수 없습니다.");
  if (!isObject(input.company))
    fail("INVALID_COMPANY", "기업 입력 정보를 확인할 수 없습니다.");

  const ids = new Set();
  for (const [index, transaction] of input.transactions.entries()) {
    if (!isObject(transaction))
      fail("INVALID_TRANSACTION", `${index + 1}번째 거래가 객체가 아닙니다.`);
    if (typeof transaction.transaction_id !== "string" || !transaction.transaction_id.trim())
      fail("MISSING_TRANSACTION_ID", `${index + 1}번째 거래 ID가 없습니다.`);
    if (ids.has(transaction.transaction_id))
      fail("DUPLICATE_TRANSACTION_ID", `중복된 거래 ID입니다: ${transaction.transaction_id}`);
    ids.add(transaction.transaction_id);
  }
};

const DERIVED_COMPANY_FACTS = new Set([
  "companyType",
  "isSme",
  "riskAppetite",
  "requestedPurposes",
  "existingHedges",
  "hasExistingHedge",
  "hasExport",
  "hasImport",
]);

const buildCounterfactualProfile = (input, engines) => {
  const built = engines.buildProfile({
    cashflows: input.transactions,
    rates: input.rates,
    company: input.company,
  });
  for (const [key, value] of Object.entries(input.company)) {
    if (!DERIVED_COMPANY_FACTS.has(key))
      built.facts.company[key] = structuredClone(value);
  }
  return built;
};

const maxShortfall = (timeline) =>
  timeline.reduce((maximum, point) => Math.max(maximum, point.shortfallKrw), 0);

const runPipeline = (input, deps, engines) => {
  const buckets = engines.computeCFaRBuckets(
    input.transactions,
    input.rates,
    input.annualVol,
    input.riskOptions,
  );
  const portfolio = engines.portfolioCFaR(buckets);
  const notionalKrw = engines.bucketNotionalKrw(buckets);
  const liquidityTimeline = engines.liquidityTimeline(
    input.transactions,
    input.rates,
    input.liquidity,
  );
  const builtProfile = buildCounterfactualProfile(input, engines);
  const recommendations = engines.recommend({
    profile: builtProfile,
    graph: deps.graph,
    rules: deps.rules,
    sources: deps.sources,
    schema: deps.schema,
    today: input.today ?? deps.today,
  });

  return {
    cfar: { ...portfolio, buckets },
    liquidity: {
      timeline: liquidityTimeline,
      worstShortfallKrw: maxShortfall(liquidityTimeline),
    },
    strategies: engines.compareStrategies(portfolio.total, notionalKrw, input.strategyOptions),
    recommendations,
  };
};

const candidateKey = (item) => `${item.purpose}:${item.product_id}`;
const recommendationRef = (item, extra = {}) => ({
  product_id: item.product_id,
  purpose: item.purpose,
  ...extra,
});

const compareRecommendations = (before, after) => {
  const beforeCandidates = new Map((before.candidates || []).map((item) => [candidateKey(item), item]));
  const afterCandidates = new Map((after.candidates || []).map((item) => [candidateKey(item), item]));
  const afterPending = new Map((after.pending || []).map((item) => [candidateKey(item), item]));
  const sort = (items) => items.sort((a, b) =>
    a.purpose.localeCompare(b.purpose) || a.product_id.localeCompare(b.product_id));

  return {
    added: sort([...afterCandidates]
      .filter(([key]) => !beforeCandidates.has(key))
      .map(([, item]) => recommendationRef(item, { from: "not_candidate", to: "candidate" }))),
    removed: sort([...beforeCandidates]
      .filter(([key]) => !afterCandidates.has(key) && !afterPending.has(key))
      .map(([, item]) => recommendationRef(item, { from: "candidate", to: "not_candidate" }))),
    movedToPending: sort([...beforeCandidates]
      .filter(([key]) => afterPending.has(key))
      .map(([, item]) => recommendationRef(item, { from: "candidate", to: "needs_information" }))),
  };
};

const bucketDeltas = (beforeBuckets, afterBuckets) => {
  const key = (bucket) => `${bucket.currency}|${bucket.months}`;
  const before = new Map(beforeBuckets.map((bucket) => [key(bucket), bucket]));
  const after = new Map(afterBuckets.map((bucket) => [key(bucket), bucket]));
  const keys = [...new Set([...before.keys(), ...after.keys()])]
    .sort((a, b) => {
      const [ac, am] = a.split("|");
      const [bc, bm] = b.split("|");
      return ac.localeCompare(bc) || Number(am) - Number(bm);
    });
  return keys.map((bucketKey) => {
    const beforeBucket = before.get(bucketKey);
    const afterBucket = after.get(bucketKey);
    const [currency, months] = bucketKey.split("|");
    const beforeValue = beforeBucket?.cfar ?? 0;
    const afterValue = afterBucket?.cfar ?? 0;
    return {
      currency,
      months: Number(months),
      before: beforeValue,
      after: afterValue,
      delta: afterValue - beforeValue,
    };
  });
};

const buildDeltas = (before, after) => ({
  cfarTotalKrw: after.cfar.total - before.cfar.total,
  ...("scenarioPnL" in after ? { scenarioPnlKrw: after.scenarioPnL } : {}),
  worstShortfallKrw: after.liquidity.worstShortfallKrw - before.liquidity.worstShortfallKrw,
  byBucket: bucketDeltas(before.cfar.buckets, after.cfar.buckets),
});

const defaultReceivable = (transactions) => [...transactions]
  .filter((transaction) => transaction.direction === "in")
  .sort((a, b) =>
    b.amount - a.amount
    || a.months - b.months
    || a.transaction_id.localeCompare(b.transaction_id))[0];

const pathSegment = (value) => {
  const raw = String(value);
  let encoded = "";
  for (let index = 0; index < raw.length; index += 1)
    encoded += raw.charCodeAt(index).toString(16).padStart(4, "0");
  return `id~${encoded}`;
};

const applyPaymentDelay = (input, options) => {
  const explicit = options.targetTransactionId;
  const target = explicit
    ? input.transactions.find((transaction) => transaction.transaction_id === explicit)
    : defaultReceivable(input.transactions);
  if (!target)
    fail("TARGET_NOT_FOUND", explicit
      ? `대상 거래 ID를 찾을 수 없습니다: ${explicit}`
      : "지연 시나리오를 적용할 수취 거래가 없습니다.");
  if (target.direction !== "in")
    fail("INVALID_TARGET", "입금 지연 대상은 수취 거래여야 합니다.", {
      targetTransactionId: target.transaction_id,
    });

  const before = target.months;
  target.months += 1;
  return {
    scenarioFields: {
      targetTransactionId: target.transaction_id,
      targetScopeLabel: explicit
        ? `선택한 수취 거래 ${target.transaction_id}`
        : `가장 큰 수취 거래 ${target.transaction_id}`,
    },
    changedInputs: [{
      path: `transactions.${pathSegment(target.transaction_id)}.months`,
      before,
      after: target.months,
    }],
    explanationFacts: [{
      text: `${target.transaction_id} 수취 시점을 ${before}개월에서 ${target.months}개월로 늦춰 계산했습니다.`,
      transaction_id: target.transaction_id,
    }],
    limitations: ["브리지금융·연체이자·거래상대방의 실제 지급확률은 모델링하지 않습니다."],
  };
};

const revenueTargets = (input, options) => {
  if (options.targetTransactionIds !== undefined) {
    if (!Array.isArray(options.targetTransactionIds) || options.targetTransactionIds.length === 0)
      fail("INVALID_TARGETS", "선택 수출 거래 ID 목록이 필요합니다.");
    const requested = new Set(options.targetTransactionIds);
    if (requested.size !== options.targetTransactionIds.length)
      fail("DUPLICATE_TARGET", "선택 수출 거래 ID가 중복됐습니다.");
    const targets = input.transactions.filter((transaction) => requested.has(transaction.transaction_id));
    if (targets.length !== requested.size)
      fail("TARGET_NOT_FOUND", "선택한 수출 거래 ID 중 존재하지 않는 값이 있습니다.");
    if (targets.some((transaction) =>
      transaction.tradeType !== "export" || transaction.direction !== "in"))
      fail("INVALID_TARGET", "매출 감소의 선택 대상은 수취 방향의 수출 거래여야 합니다.");
    return { targets, label: "선택된 수출 거래" };
  }

  if (options.scope !== undefined && options.scope !== "all_receivables"
      && options.scope !== "selected_exports")
    fail("INVALID_SCOPE", `지원하지 않는 매출 감소 범위입니다: ${options.scope}`);
  if (options.scope === "selected_exports")
    fail("INVALID_TARGETS", "선택된 수출 거래 범위에는 targetTransactionIds가 필요합니다.");
  return {
    targets: input.transactions.filter((transaction) => transaction.direction === "in"),
    label: "모든 수취 거래",
  };
};

const overHedgeFacts = (input, after) => {
  const hedges = input.company.existingHedges;
  if (!Array.isArray(hedges) || hedges.length === 0) return [];
  const grouped = new Map();
  for (const hedge of hedges) {
    const key = `${hedge.currency}|${hedge.maturityMonths}`;
    const group = grouped.get(key) || {
      currency: hedge.currency,
      maturityMonths: hedge.maturityMonths,
      amount: 0,
    };
    group.amount += hedge.amount;
    grouped.set(key, group);
  }
  const bucketMap = new Map(after.cfar.buckets.map((bucket) =>
    [`${bucket.currency}|${bucket.months}`, bucket]));

  return [...grouped.values()]
    .sort((a, b) => a.currency.localeCompare(b.currency) || a.maturityMonths - b.maturityMonths)
    .map((hedge) => {
      const bucket = bucketMap.get(`${hedge.currency}|${hedge.maturityMonths}`);
      if (!bucket) {
        return {
          text: `${hedge.currency} ${hedge.maturityMonths}개월 헤지는 동일 통화·만기 노출에 매핑할 수 없어 과헤지 판정을 보류합니다.`,
          mapping: "unmapped",
          status: "needs_information",
          currency: hedge.currency,
          maturityMonths: hedge.maturityMonths,
        };
      }
      const exposureAmount = Math.abs(bucket.netAtMaturity);
      const isOverHedged = hedge.amount > exposureAmount;
      return {
        text: isOverHedged
          ? `${hedge.currency} ${hedge.maturityMonths}개월 헤지 ${hedge.amount}가 같은 버킷 노출 ${exposureAmount}를 초과해 과헤지 가능성이 있습니다.`
          : `${hedge.currency} ${hedge.maturityMonths}개월 헤지는 같은 버킷 노출 범위 안입니다.`,
        mapping: "same_bucket",
        status: isOverHedged ? "over_hedged" : "within_exposure",
        currency: hedge.currency,
        maturityMonths: hedge.maturityMonths,
        hedgeAmount: hedge.amount,
        exposureAmount,
      };
    });
};

const applyRevenueDrop = (input, options) => {
  const { targets, label } = revenueTargets(input, options);
  if (!targets.length)
    fail("TARGET_NOT_FOUND", "매출 감소를 적용할 수취 거래가 없습니다.");
  const changedInputs = targets.map((target) => {
    const before = target.amount;
    target.amount *= 0.7;
    return {
      path: `transactions.${pathSegment(target.transaction_id)}.amount`,
      before,
      after: target.amount,
    };
  });
  return {
    scenarioFields: {
      targetTransactionId: targets.length === 1 ? targets[0].transaction_id : null,
      targetScopeLabel: `${label} ${targets.length}건`,
    },
    changedInputs,
    explanationFacts: [{
      text: `${label} ${targets.length}건의 금액을 각각 30% 줄이고 전 계산을 다시 실행했습니다.`,
      transaction_ids: targets.map((target) => target.transaction_id),
    }],
    limitations: ["매출 감소는 선택 거래 금액에만 적용하며 가격·수량·회수확률 변화로 분해하지 않습니다."],
    appendAfterFacts: overHedgeFacts,
  };
};

const netByCurrency = (transactions) => {
  const totals = new Map();
  for (const transaction of transactions) {
    const signed = (transaction.direction === "in" ? 1 : -1) * transaction.amount;
    totals.set(transaction.currency, (totals.get(transaction.currency) || 0) + signed);
  }
  return [...totals].sort(([a], [b]) => a.localeCompare(b));
};

const applyAdverseFx = (input) => {
  const changedInputs = [];
  const explanationFacts = [];
  let scenarioPnL = 0;
  for (const [currency, net] of netByCurrency(input.transactions)) {
    if (net === 0) continue;
    const before = input.rates[currency];
    if (!Number.isFinite(before) || before <= 0)
      fail("INVALID_RATE", `${currency} 기준환율을 확인할 수 없습니다.`);
    const direction = net > 0 ? "down" : "up";
    const after = before * (net > 0 ? 0.95 : 1.05);
    input.rates[currency] = after;
    const pnlKrw = net * (after - before);
    scenarioPnL += pnlKrw;
    changedInputs.push({ path: `rates.${currency}`, before, after });
    explanationFacts.push({
      text: `${currency} ${net > 0 ? "순수취" : "순지급"}에 불리한 환율 ${net > 0 ? "하락" : "상승"} 5%를 적용했습니다.`,
      currency,
      net,
      direction,
      before,
      after,
      scenarioPnlKrw: pnlKrw,
    });
  }
  if (!changedInputs.length)
    fail("NO_NET_EXPOSURE", "불리한 환율 충격을 적용할 순노출이 없습니다.");
  return {
    scenarioFields: {
      targetTransactionId: null,
      targetScopeLabel: `통화별 순노출 방향 ${changedInputs.length}개`,
    },
    changedInputs,
    explanationFacts,
    limitations: [
      "5% 환율 충격 손익과 CFaR는 서로 다른 지표이며, CFaR 증감만으로 위험 개선·악화를 단정하지 않습니다.",
      "통화 간 상관관계·시장 유동성·헤지상품 가격 변화는 반영하지 않습니다.",
    ],
    scenarioPnL,
  };
};

const applyScenario = (scenarioId, input, options) => {
  if (scenarioId === "payment_delay_1m") return applyPaymentDelay(input, options);
  if (scenarioId === "revenue_drop_30") return applyRevenueDrop(input, options);
  if (scenarioId === "adverse_fx_5") return applyAdverseFx(input);
  fail("UNKNOWN_SCENARIO", `승인되지 않은 반사실 시나리오입니다: ${scenarioId}`);
};

export function runCounterfactual(scenarioId, baseInput, deps, options = {}) {
  const scenario = scenarioById.get(scenarioId);
  if (!scenario) fail("UNKNOWN_SCENARIO", `승인되지 않은 반사실 시나리오입니다: ${scenarioId}`);
  if (!scenario.implemented)
    fail("SCENARIO_NOT_IMPLEMENTED", `아직 구현되지 않은 준비 중 시나리오입니다: ${scenarioId}`);
  if (!isObject(options)) fail("INVALID_OPTIONS", "반사실 시나리오 옵션은 객체여야 합니다.");
  validateBaseInput(baseInput);
  const engines = resolveEngines(deps);

  const beforeInput = structuredClone(baseInput);
  const afterInput = structuredClone(baseInput);
  const before = runPipeline(beforeInput, deps, engines);
  const applied = applyScenario(scenarioId, afterInput, options);
  const after = runPipeline(afterInput, deps, engines);
  if (applied.scenarioPnL !== undefined) after.scenarioPnL = applied.scenarioPnL;

  const explanationFacts = [...applied.explanationFacts];
  if (typeof applied.appendAfterFacts === "function")
    explanationFacts.push(...applied.appendAfterFacts(afterInput, after));

  return {
    scenario: {
      id: scenario.id,
      label: scenario.label,
      priority: scenario.priority,
      ...applied.scenarioFields,
    },
    changedInputs: applied.changedInputs,
    before,
    after,
    deltas: buildDeltas(before, after),
    affectedRecommendations: compareRecommendations(
      before.recommendations,
      after.recommendations,
    ),
    explanationFacts,
    limitations: [
      ...applied.limitations,
      "CFaR는 통화·만기 버킷의 보수적 단순합이며 상관관계와 버킷 간 상쇄를 반영하지 않습니다.",
      "상품 추천은 입력 사실과 현재 검증된 공식 규칙 범위의 1차 스크리닝 결과입니다.",
    ],
  };
}
