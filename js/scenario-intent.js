// T17 — deterministic Korean natural-language scenario parser (no network, no embeddings).
// Turns a Korean sentence into an UNTRUSTED candidate ScenarioPlan. It never executes and
// never resolves an ambiguous target: it leaves the target absent so the trusted gate
// (scenario-plan.js) asks the user. Magnitudes default to the only engine-supported values;
// any explicit out-of-range magnitude is passed through and rejected by the gate.

const MAX_INPUT = 500;
const TYPE_ORDER = ["payment_delay", "receivable_drop", "adverse_fx"];

// Korean names only — Latin currency codes (USD…) are handled separately so that the "US"
// inside "USD" is never mistaken for the 미국(US) country.
const COUNTRY = { "미국": "US", "베트남": "VN", "독일": "DE", "일본": "JP", "중국": "CN" };
const CURRENCY = { "달러": "USD", "USD": "USD", "유로": "EUR", "EUR": "EUR", "엔": "JPY", "JPY": "JPY", "위안": "CNY", "CNY": "CNY" };
// Negation markers we refuse to interpret as an executable counterfactual (…하지 않으면 등).
const NEGATION = /않|없으면|안\s*(?:늦|밀|줄|감소|불리|오르|내리)/;

// Exported so the UI can compare the sentence a preview was generated from against the
// current input (stale-approval guard) using the exact same normalization.
export function normalizeIntentText(text) {
  return String(text ?? "").normalize("NFC").replace(/\s+/g, " ").trim();
}
const normalize = normalizeIntentText;

// ---------------------------------------------------------------------------
// T17-final: the parser derives NO magnitude. The execution number comes solely from the fixed
// presets (scenario-preset.js). Any sentence that CARRIES a magnitude marker — a digit, a ratio
// unit, a duration token, or a multiple/half — is rejected outright; we detect the PRESENCE of a
// magnitude structurally instead of interpreting its meaning, so there is no modifier denylist to
// grow. Compound words (프로그램/프로젝트) and date words (입금일/결제일/일본) carry no quantity+unit
// and therefore are never magnitude markers.
// ---------------------------------------------------------------------------

const RATIO_UNIT = "%|퍼센트|[0-9일이삼사오육칠팔구십백한두세네다섯여섯일곱여덟아홉열몇수]\\s*프로|프로(?=$|[\\s,.!?)가는은를을이도만])";
const DUR_QUANT = "[0-9]+(?:\\.[0-9]+)?|[일이삼사오육칠팔구십백한두세네다섯여섯일곱여덟아홉열]|몇|수|두어|서너|여러|약간|얼마";
const DURATION = "하루|이틀|사흘|나흘|닷새|엿새|이레|여드레|아흐레|열흘|보름|한나절|반나절"
  + `|(?:${DUR_QUANT})\\s*(?:개월|달|년|주일|주|일|시간|분)`;
const MAGNITUDE_MARKER = new RegExp(`[0-9]|${RATIO_UNIT}|${DURATION}`);
const KOREAN_QUANTITY = "[일이삼사오육칠팔구십백천만한두세네다섯여섯일곱여덟아홉열]+";
const MAGNITUDE_TOKEN_START = "(?:^|[\\s,.;:!?()])";
const MAGNITUDE_SUFFIX = "(?:으로|만큼|정도|쯤|가량|내외|안팎|미만|이하|초과|이상|전후|가|는|은|를|을|이|도|만|로)?";
const MAGNITUDE_TOKEN_END = `${MAGNITUDE_SUFFIX}(?=$|[\\s,.;:!?()])`;
const HALF_OR_MULTIPLE_MARKER = new RegExp(
  `${MAGNITUDE_TOKEN_START}(?:(?:절?반|반토막|반절)${MAGNITUDE_TOKEN_END}`
  + `|(?:${KOREAN_QUANTITY}|몇|수|여러)\\s*배${MAGNITUDE_TOKEN_END})`,
);

// True if the sentence states any size/ratio/duration/multiple — in which case we do NOT execute
// from natural language (the user must pick a fixed preset instead).
export function hasMagnitudeMarker(text) {
  const normalized = normalize(text);
  // Standalone "배" is a normal noun in phrases such as "배 운송" and is not a
  // magnitude. Only quantity+배 or magnitude lexemes are blocked. Keeping this
  // check lexical (rather than adding sentence-shaped regex exceptions) closes
  // known 갑절/반감 variants without growing a sentence denylist.
  const magnitudeLexemes = ["절반", "곱절", "갑절", "반감"];
  const hasMagnitudeLexeme = normalized
    .split(/[^\p{L}\p{N}]+/u)
    .some((token) => magnitudeLexemes.some((lexeme) => token.startsWith(lexeme)));
  return MAGNITUDE_MARKER.test(normalized)
    || HALF_OR_MULTIPLE_MARKER.test(normalized)
    || hasMagnitudeLexeme;
}

function distinctMatches(text, table) {
  return [...new Set(Object.entries(table).filter(([name]) => text.includes(name)).map(([, code]) => code))];
}

// Resolves which receivable a payment-delay sentence targets. Exported so the UI can show
// only the CONDITION-MATCHING candidates in its chooser (never unrelated transactions).
//   status: "one" (resolved) | "many" (matched ≥2 → ask) | "ambiguous" (no condition, ≥2)
//         | "none" (explicit condition matched 0) | "conflict" (multiple countries/currencies)
export function resolveReceivableCandidates(text, transactions, countryAliases = COUNTRY) {
  const normalized = normalize(text);
  const receivables = (Array.isArray(transactions) ? transactions : []).filter((t) => t && t.direction === "in");
  const countries = distinctMatches(normalized, countryAliases);
  const currencies = distinctMatches(normalized, CURRENCY);
  if (countries.length > 1 || currencies.length > 1) return { status: "conflict", candidates: [] };

  // Apply the country/currency intersection FIRST — "가장 큰" then picks only within that set.
  const hasCondition = countries.length === 1 || currencies.length === 1;
  let candidates = receivables;
  if (countries.length === 1) candidates = candidates.filter((t) => t.country === countries[0]);
  if (currencies.length === 1) candidates = candidates.filter((t) => t.currency === currencies[0]);
  if (hasCondition && candidates.length === 0) return { status: "none", candidates: [] };

  if (/(?:가장|제일)\s*큰|최대/.test(normalized)) {
    const largest = [...candidates].sort((a, b) =>
      b.amount - a.amount || String(a.transaction_id).localeCompare(String(b.transaction_id)))[0];
    return largest
      ? { status: "one", transaction_id: largest.transaction_id, candidates: [largest] }
      : { status: "none", candidates: [] };
  }

  if (candidates.length === 1) return { status: "one", transaction_id: candidates[0].transaction_id, candidates: [...candidates] };
  return { status: hasCondition ? "many" : "ambiguous", candidates: [...candidates] };
}

function matchedTypes(text, intentList) {
  const hits = [];
  for (const type of TYPE_ORDER) {
    const intent = intentList.find((i) => i.type === type);
    if (intent && Array.isArray(intent.keywords)
        && intent.keywords.some((kw) => kw && text.includes(kw)))
      hits.push(type);
  }
  return hits;
}

// Produces an INTENT step { type, target } with NO magnitude — the preset adapter injects params.
function buildIntentStep(type, text, transactions, countryAliases) {
  if (type === "payment_delay") {
    const target = resolveReceivableCandidates(text, transactions, countryAliases);
    if (target.status === "none")
      return { unsupported: "요청한 국가·통화 조건과 일치하는 수취 거래가 없습니다." };
    if (target.status === "conflict")
      return { unsupported: "여러 국가·통화 조건이 섞여 있어 대상 거래를 특정할 수 없습니다." };
    return { step: { type, target: target.status === "one" ? { transaction_id: target.transaction_id } : {} } };
  }
  return { step: { type, target: { scope: type === "receivable_drop" ? "all_receivables" : "net_exposure" } } };
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function parseScenarioIntent(text, context = {}) {
  // A ScenarioIntent: steps carry type + target only. Execution magnitudes come from fixed presets
  // (magnitudeSource) — never from the user's words. The preset adapter injects params before the gate.
  const plan = { version: "1", steps: [], magnitudeSource: "fixed_preset", missingFacts: [], unsupportedSegments: [], confidence: 0 };

  // T17.3: fail closed on malformed context — never throw, never silently coerce to {}.
  if (!isPlainObject(context)) {
    plan.unsupportedSegments.push({ text: "", reason: "분석 컨텍스트가 올바르지 않아 시나리오를 해석할 수 없습니다." });
    return plan;
  }
  if (context.transactions !== undefined && !Array.isArray(context.transactions)) {
    plan.unsupportedSegments.push({ text: "", reason: "거래 목록(transactions)이 배열이 아니어서 해석할 수 없습니다." });
    return plan;
  }
  const countryAliases = context.countryAliases ?? COUNTRY;
  if (!isPlainObject(countryAliases)
      || Object.entries(countryAliases).some(([name, iso]) =>
        !name.trim() || typeof iso !== "string" || !/^[A-Z]{2}$/.test(iso))) {
    plan.unsupportedSegments.push({ text: "", reason: "거래국 별칭 목록이 올바르지 않아 해석할 수 없습니다." });
    return plan;
  }
  const transactions = Array.isArray(context.transactions) ? context.transactions : [];
  const intentList = context.intents && Array.isArray(context.intents.intents) ? context.intents.intents : [];

  const raw = String(text ?? "");
  if (raw.length > MAX_INPUT) {
    plan.unsupportedSegments.push({ text: "", reason: "입력이 너무 길어 해석하지 않습니다." });
    return plan;
  }
  const normalized = normalize(raw);
  if (!normalized) {
    plan.unsupportedSegments.push({ text: "", reason: "해석할 문장이 없습니다." });
    return plan;
  }

  // Negations ("…하지 않으면") are not executable counterfactuals — fail closed.
  if (NEGATION.test(normalized)) {
    plan.unsupportedSegments.push({
      text: normalized,
      reasonCode: "negated_condition",
      reason: "부정형 조건(…하지 않으면)은 실행 가능한 위기 시나리오가 아닙니다.",
    });
    plan.confidence = 0.2;
    return plan;
  }

  const types = matchedTypes(normalized, intentList);
  if (types.length === 0) {
    plan.unsupportedSegments.push({
      text: normalized,
      reasonCode: "intent_unmatched",
      reason: "지원하는 위기 시나리오(입금 지연·매출 감소·불리한 환율)로 해석되지 않았습니다.",
    });
    plan.confidence = 0.2;
    return plan;
  }

  // Any stated size/ratio/duration → do NOT execute from natural language; direct the user to a preset.
  if (hasMagnitudeMarker(normalized)) {
    plan.unsupportedSegments.push({
      text: normalized,
      reasonCode: "magnitude_present",
      reason: "자연어의 숫자·기간은 금융 계산에 사용하지 않습니다. 아래 고정 시나리오 프리셋을 선택해 주세요.",
    });
    plan.confidence = 0.3;
    return plan;
  }

  for (const type of types) {
    const built = buildIntentStep(type, normalized, transactions, countryAliases);
    if (built.step) plan.steps.push(built.step);
    else plan.unsupportedSegments.push({ text: "", reason: built.unsupported });
  }
  plan.confidence = types.length === 1 && plan.steps.length === 1 ? 0.9 : plan.steps.length ? 0.5 : 0.2;
  return plan;
}

// Accepts only a type proposal. Target resolution and all safety checks stay in
// this deterministic module; callers cannot provide params or execution values.
export function buildScenarioIntentFromType(type, text, context = {}, confidence = 0.7) {
  if (!TYPE_ORDER.includes(type) || !isPlainObject(context))
    return parseScenarioIntent(text, context);
  const normalized = normalize(text);
  const result = parseScenarioIntent(text, {
    transactions: context.transactions,
    intents: { intents: [{ type, keywords: normalized ? [normalized] : [] }] },
    countryAliases: context.countryAliases,
  });
  if (result.steps.length === 1 && Number.isFinite(confidence))
    result.confidence = Math.max(0, Math.min(1, confidence));
  return result;
}
