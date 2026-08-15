import { CalculationError, requireRate } from "./errors.js";

// 기업 프로파일을 명시 입력 + 거래 집계로 만든다. 추정하지 않는다:
// - isSme 기본값 없음(누락 → missingFact + 질문)
// - hasExport/hasImport는 거래 행별 tradeType 집계(방향 in/out으로 판정하지 않음)
// - existingHedges 3-state: null/미입력=모름(질문), []=없음 확정, 비어있지 않음=있음
// - hasExistingHedge는 파생값이며 입력으로 받지 않는다

const REQUIRED_COMPANY = [
  ["companyType", "기업 형태(법인/개인사업자)를 선택해 주세요."],
  ["isSme", "기업 규모(중소기업/중견기업/그 외)를 선택해 주세요(추정하지 않습니다)."],
  ["riskAppetite", "위험성향(안정/중립/공격)을 선택해 주세요."],
];
// 사용자·은행 담당자가 명시적으로 확인한 상품 자격 사실만 프로필에 보존한다.
// hasExport/hasImport/hasExistingHedge 같은 파생 필드는 이 목록에 넣지 않는다.
const OPTIONAL_COMPANY_RULE_FACTS = Object.freeze([
  "companyScale",
  "internetBankingEnrolled",
  "creditGradeMeetsThreshold",
  "priorYearExportUsd",
  "reviewChannelConfirmed",
  "isManufacturer",
  "supplyChainProgramEligible",
  "partnerGuaranteeConfirmed",
]);
const RISK_TO_PURPOSE = { fx_rate: "fx_hedge", liquidity: "working_capital", country: "guarantee_insurance", credit: "guarantee_insurance" };

export function buildProfile({ cashflows = [], rates = {}, company = {} } = {}) {
  const missingFacts = [];

  // --- transactions: 안정적·고유한 transaction_id ---
  const seen = new Set();
  const transactions = cashflows.map((c) => ({ ...c }));
  for (const t of transactions) {
    if (t.transaction_id) {
      if (seen.has(t.transaction_id))
        throw new CalculationError("DUPLICATE_TRANSACTION_ID", `중복된 거래 ID입니다: ${t.transaction_id}`, { transaction_id: t.transaction_id });
      seen.add(t.transaction_id);
    }
  }
  let n = 0;
  for (const t of transactions) {
    if (!t.transaction_id) {
      let gen;
      do { gen = `txn-${++n}`; } while (seen.has(gen));
      seen.add(gen);
      t.transaction_id = gen;
    }
  }

  // 거래 행별 tradeType 누락 → 질문
  cashflows.forEach((c, i) => {
    if (c.tradeType !== "export" && c.tradeType !== "import")
      missingFacts.push({ factPath: `transactions[${i}].tradeType`, question: "각 거래의 수출/수입 구분을 선택해 주세요." });
  });

  // --- company facts (명시 입력만) ---
  const facts = { company: {} };
  const fc = facts.company;
  for (const key of ["companyType", "isSme", "riskAppetite", ...OPTIONAL_COMPANY_RULE_FACTS])
    if (company[key] !== undefined && company[key] !== null) fc[key] = company[key];
  for (const [field, question] of REQUIRED_COMPANY)
    if (company[field] === undefined || company[field] === null)
      missingFacts.push({ factPath: `company.${field}`, question });
  if (!Array.isArray(company.requestedPurposes) || company.requestedPurposes.length === 0)
    missingFacts.push({ factPath: "company.requestedPurposes", question: "필요한 지원 목적을 선택해 주세요." });

  // hasExport/hasImport = tradeType 집계 (방향 아님)
  fc.hasExport = transactions.some((t) => t.tradeType === "export");
  fc.hasImport = transactions.some((t) => t.tradeType === "import");

  // existingHedges 3-state (hasExistingHedge는 파생, 입력 hasExistingHedge는 무시)
  const eh = company.existingHedges;
  if (eh === undefined || eh === null) {
    missingFacts.push({ factPath: "company.existingHedges", question: "기존 헤지 계약이 있으면 통화·금액·만기를 입력하고, 없으면 '없음'으로 확정해 주세요." });
  } else if (Array.isArray(eh)) {
    fc.hasExistingHedge = eh.length > 0;
    fc.existingHedges = eh;
  }

  // --- exposures: CFaR 버킷과 동일 축 (currency, months) ---
  const buckets = new Map();
  for (const c of cashflows) {
    if (!Number.isFinite(c.amount) || !Number.isFinite(c.months)) continue;
    if (c.direction !== "in" && c.direction !== "out") continue;
    const key = `${c.currency}|${c.months}`;
    const b = buckets.get(key) || { currency: c.currency, months: c.months, netAtMaturity: 0 };
    b.netAtMaturity += (c.direction === "in" ? 1 : -1) * c.amount;
    buckets.set(key, b);
  }
  // 시장데이터 fail-closed: 환율이 없거나 0·음수·NaN이면 0으로 대체하지 않고 계산을 거부한다.
  const exposures = [...buckets.values()]
    .sort((a, b) => a.currency.localeCompare(b.currency) || a.months - b.months)
    .map((b) => ({ ...b, krwValue: Math.abs(b.netAtMaturity) * requireRate(rates, b.currency) }));

  // --- risks + suggestedPurposes (파생, 표시 전용 — 추천의 입력 아님) ---
  const risks = [];
  for (const e of exposures) if (e.netAtMaturity !== 0) risks.push({ riskType: "fx_rate", source: { currency: e.currency, months: e.months } });
  if (exposures.some((e) => e.netAtMaturity < 0)) risks.push({ riskType: "liquidity", source: null });

  const requestedPurposes = Array.isArray(company.requestedPurposes) ? [...company.requestedPurposes] : [];
  const suggestedPurposes = [...new Set(risks.map((r) => RISK_TO_PURPOSE[r.riskType]).filter(Boolean))]
    .filter((p) => !requestedPurposes.includes(p));

  // --- reasoner(T7)를 위한 파생 집계 ---
  // USD 환산은 USD 기준환율이 유효할 때만. 없으면 null(0으로 대체하지 않음).
  const usd = rates.USD;
  const usdUsable = typeof usd === "number" && Number.isFinite(usd) && usd > 0;
  const derived = {
    currencies: [...new Set(exposures.map((e) => e.currency))],
    maxHorizonMonths: exposures.reduce((m, e) => Math.max(m, e.months), 0),
    maxNetExposureUsd: usdUsable ? exposures.reduce((m, e) => Math.max(m, e.krwValue / usd), 0) : null,
  };

  return { facts, transactions, exposures, requestedPurposes, suggestedPurposes, risks, missingFacts, derived };
}
