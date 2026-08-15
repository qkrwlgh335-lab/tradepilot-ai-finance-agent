// 계산 불가 상황은 0으로 대체하지 않고 여기서 멈춘다(fail-closed).
// 시장데이터가 없어서 "위험 ₩0"이 찍히면 사용자는 안전하다고 읽는다 — 그게 가장 나쁜 결과다.
export class CalculationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CalculationError";
    this.code = code;
    this.details = details;
  }
}

// 원인별 분류. 사용자 입력 실수를 "시장데이터 없음"으로 보여주면 사용자는 고칠 수 없는
// 문제로 오해한다 — 무엇을 고쳐야 하는지가 제목에서 바로 드러나야 한다.
export const ERROR_KIND = {
  MISSING_RATE: "market_data",
  INVALID_RATE: "market_data",
  MISSING_VOLATILITY: "market_data",
  INVALID_VOLATILITY: "market_data",

  INVALID_CASHFLOWS: "user_input",
  INVALID_CASHFLOW: "user_input",
  INVALID_AMOUNT: "user_input",
  INVALID_MONTHS: "user_input",
  INVALID_DIRECTION: "user_input",
  INVALID_BUFFER: "user_input",
  INVALID_COMPANY_FACT: "user_input",

  INVALID_Z: "configuration",
  INVALID_ASSUMPTIONS: "configuration",
  INVALID_OPTIONS: "configuration",
  INVALID_HEDGE_RATIO: "configuration",
  INVALID_HEDGE_EFF: "configuration",
  INVALID_COST_RATE: "configuration",
  INVALID_CFAR: "configuration",
  INVALID_NOTIONAL: "configuration",
};

const KIND_TITLE = {
  market_data: "필수 시장데이터가 없어 계산할 수 없습니다",
  user_input: "입력값이 올바르지 않아 계산할 수 없습니다",
  configuration: "계산 가정 또는 설정이 올바르지 않습니다",
};

export function errorTitle(err) {
  return KIND_TITLE[ERROR_KIND[err && err.code]] || KIND_TITLE.configuration;
}

const fail = (code, message, details) => {
  throw new CalculationError(code, message, details);
};

const isFiniteNumber = (v) => typeof v === "number" && Number.isFinite(v);

// 옵션 인자 계약: 생략(undefined)은 기본값을 쓰되, 명시적 null·배열·비객체는 거부한다.
// `options || {}`는 null·false·0 등을 조용히 삼켜 잘못된 호출을 숨기므로 이 헬퍼로 대체한다.
export function requireOptions(options) {
  if (options === undefined) return {};
  if (options === null || typeof options !== "object" || Array.isArray(options))
    fail("INVALID_OPTIONS", "옵션 인자는 객체여야 합니다.", { value: options === null ? "null" : Array.isArray(options) ? "array" : typeof options });
  return options;
}

export function requireCashflowList(cashflows) {
  if (!Array.isArray(cashflows)) fail("INVALID_CASHFLOWS", "거래 목록이 배열이 아닙니다.", { value: typeof cashflows });
  return cashflows;
}

export function requirePositiveNumber(value, code, label) {
  if (!isFiniteNumber(value) || value <= 0) fail(code, `${label} 값은 0보다 큰 유한한 숫자여야 합니다.`, { value });
  return value;
}

export function requireRate(rates, currency) {
  const v = rates ? rates[currency] : undefined;
  if (v === undefined || v === null) fail("MISSING_RATE", `${currency} 환율이 없어 계산할 수 없습니다.`, { currency });
  if (!isFiniteNumber(v)) fail("INVALID_RATE", `${currency} 환율 값이 올바르지 않습니다.`, { currency, value: v });
  if (v <= 0) fail("INVALID_RATE", `${currency} 환율은 0보다 커야 합니다.`, { currency, value: v });
  return v;
}

export function requireVolatility(annualVol, currency) {
  const v = annualVol ? annualVol[currency] : undefined;
  if (v === undefined || v === null) fail("MISSING_VOLATILITY", `${currency} 변동성 데이터가 없어 계산할 수 없습니다.`, { currency });
  if (!isFiniteNumber(v)) fail("INVALID_VOLATILITY", `${currency} 변동성 값이 올바르지 않습니다.`, { currency, value: v });
  if (v < 0) fail("INVALID_VOLATILITY", `${currency} 변동성은 음수일 수 없습니다.`, { currency, value: v });
  return v;
}

export function requireCashflow(c) {
  if (c === null || typeof c !== "object" || Array.isArray(c))
    fail("INVALID_CASHFLOW", "거래 항목이 올바른 형식이 아닙니다.", { value: c === null ? "null" : typeof c });
  if (!isFiniteNumber(c.amount) || c.amount <= 0)
    fail("INVALID_AMOUNT", "거래 금액은 0보다 큰 숫자여야 합니다.", { value: c.amount, currency: c.currency });
  if (!isFiniteNumber(c.months) || c.months < 0)
    fail("INVALID_MONTHS", "결제 시점(개월)은 0 이상의 숫자여야 합니다.", { value: c.months, currency: c.currency });
  if (c.direction !== "in" && c.direction !== "out")
    fail("INVALID_DIRECTION", "거래 구분은 수취(in) 또는 지급(out)이어야 합니다.", { value: c.direction, currency: c.currency });
  return c;
}

export function requireRatio(value, code, label) {
  if (!isFiniteNumber(value)) fail(code, `${label} 값이 올바르지 않습니다.`, { value });
  if (value < 0 || value > 1) fail(code, `${label} 값은 0~1 사이여야 합니다.`, { value });
  return value;
}

export function requireNonNegative(value, code, label) {
  if (!isFiniteNumber(value)) fail(code, `${label} 값이 올바르지 않습니다.`, { value });
  if (value < 0) fail(code, `${label} 값은 음수일 수 없습니다.`, { value });
  return value;
}
