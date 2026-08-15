// T16 — trusted ScenarioPlan gate.
// Turns an UNTRUSTED candidate plan into ONLY { scenarioId, options }.
// It performs NO financial mutation: no `changes`, no `after` values, no change paths.
// Execution belongs solely to counterfactual.runCounterfactual(scenarioId, baseInput, deps, options).
// The three executable magnitudes are pinned to the frozen engine and are the ONLY runnable
// values; anything else is recorded as an unsupported segment (ok:false, no execution).

export const SCENARIO_TYPES = Object.freeze(["payment_delay", "receivable_drop", "adverse_fx"]);

const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const PLAN_KEYS = new Set(["version", "steps", "missingFacts", "unsupportedSegments", "confidence"]);
const CONTEXT_KEYS = new Set(["transactions"]);
const STEP_KEYS = new Set(["type", "target", "params"]);
const TARGET_KEYS = new Set(["transaction_id", "scope"]);
const PARAM_KEYS = new Set(["months", "pct"]);

// Fixed executable magnitudes, matched exactly to the frozen counterfactual engine.
// The single source of the preset magnitudes — the preset adapter reads them from here so
// the natural-language parser never hardcodes 1 / 0.30 / 0.05.
export const EXECUTABLE = Object.freeze({
  payment_delay:   { scenarioId: "payment_delay_1m", param: "months", value: 1,    label: "입금 지연",     magnitude: "1개월" },
  receivable_drop: { scenarioId: "revenue_drop_30",  param: "pct",    value: 0.30, label: "매출·수취액 감소", magnitude: "30%" },
  adverse_fx:      { scenarioId: "adverse_fx_5",     param: "pct",    value: 0.05, label: "불리한 환율",    magnitude: "5%" },
});

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Reject non-plain objects, tampered prototypes, dangerous keys, and out-of-allowlist keys.
function checkObject(value, allowed) {
  if (!isPlainObject(value)) return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  for (const key of Object.getOwnPropertyNames(value)) {
    if (DANGEROUS_KEYS.has(key)) return false;
    if (!allowed.has(key)) return false;
  }
  return true;
}

const asString = (value) => String(value == null ? "" : value);

function classifyStep(step, transactions) {
  const missingFacts = [];
  const unsupportedSegments = [];
  const unsupported = (reason) => {
    unsupportedSegments.push({ text: "", reason });
    return { execution: null, missingFacts, unsupportedSegments };
  };
  const needTarget = () => {
    missingFacts.push({ field: "target", question: "어느 수취 거래를 말하는지 선택해 주세요" });
    return { execution: null, missingFacts, unsupportedSegments };
  };

  if (!checkObject(step, STEP_KEYS)) return unsupported("허용되지 않은 시나리오 구조입니다.");
  const type = step.type;
  if (!SCENARIO_TYPES.includes(type)) return unsupported(`지원하지 않는 시나리오 유형입니다: ${asString(type)}`);
  if (!checkObject(step.target ?? {}, TARGET_KEYS)) return unsupported("허용되지 않은 대상 구조입니다.");
  if (!checkObject(step.params ?? {}, PARAM_KEYS)) return unsupported("허용되지 않은 파라미터 구조입니다.");

  const spec = EXECUTABLE[type];
  const value = step.params ? step.params[spec.param] : undefined;
  if (!(typeof value === "number" && Number.isFinite(value) && value === spec.value))
    return unsupported(`'${spec.label}' 시나리오는 고정 크기 ${spec.magnitude}만 지원합니다. 요청한 크기는 아직 지원하지 않습니다.`);

  if (type === "payment_delay") {
    const id = step.target?.transaction_id;
    if (typeof id !== "string" || id === "") return needTarget();
    const target = transactions.find((t) => t && t.transaction_id === id);
    if (!target || target.direction !== "in") return needTarget();
    return { execution: { scenarioId: spec.scenarioId, options: { targetTransactionId: id } }, missingFacts, unsupportedSegments };
  }

  if (type === "receivable_drop") {
    if ((step.target?.scope ?? "all_receivables") !== "all_receivables")
      return unsupported("매출 감소 범위가 올바르지 않습니다.");
    if (!transactions.some((t) => t && t.direction === "in"))
      return unsupported("매출 감소를 적용할 수취 거래가 없습니다.");
    return { execution: { scenarioId: spec.scenarioId, options: {} }, missingFacts, unsupportedSegments };
  }

  // adverse_fx
  if ((step.target?.scope ?? "net_exposure") !== "net_exposure")
    return unsupported("환율 충격 범위가 올바르지 않습니다.");
  return { execution: { scenarioId: spec.scenarioId, options: {} }, missingFacts, unsupportedSegments };
}

export function validatePlan(plan, context = {}) {
  const errors = [];
  const missingFacts = [];
  const unsupportedSegments = [];
  const fail = () => ({ ok: false, errors, missingFacts, unsupportedSegments });
  const addMissing = (item) => { if (!missingFacts.some((m) => m.question === item.question)) missingFacts.push(item); };
  const addUnsupported = (item) => { if (!unsupportedSegments.some((u) => u.reason === item.reason)) unsupportedSegments.push(item); };

  // T16.2: validate the context container exactly like the plan — never throw on bad input.
  if (!checkObject(context, CONTEXT_KEYS)) { errors.push("context 형식이 올바르지 않습니다."); return fail(); }
  if (context.transactions !== undefined && !Array.isArray(context.transactions)) {
    errors.push("context.transactions는 배열이어야 합니다.");
    return fail();
  }
  const transactions = Array.isArray(context.transactions) ? context.transactions : [];

  if (!checkObject(plan, PLAN_KEYS)) { errors.push("계획 구조가 올바르지 않습니다."); return fail(); }
  if (plan.version !== "1") { errors.push("지원하지 않는 계획 버전입니다."); return fail(); }
  if (!Array.isArray(plan.steps)) { errors.push("steps는 배열이어야 합니다."); return fail(); }
  if (!(typeof plan.confidence === "number" && Number.isFinite(plan.confidence)
        && plan.confidence >= 0 && plan.confidence <= 1)) {
    errors.push("confidence 값이 올바르지 않습니다(0~1 사이 숫자여야 합니다).");
    return fail();
  }
  if (!Array.isArray(plan.missingFacts) || !Array.isArray(plan.unsupportedSegments)) {
    errors.push("missingFacts/unsupportedSegments는 배열이어야 합니다.");
    return fail();
  }

  // Strictly validate and carry forward the caller's advisory state — any advisory blocks execution.
  for (const seg of plan.missingFacts) {
    if (!isPlainObject(seg) || typeof seg.question !== "string") { errors.push("missingFacts 항목이 올바르지 않습니다."); return fail(); }
    addMissing({ field: asString(seg.field), question: asString(seg.question) });
  }
  for (const seg of plan.unsupportedSegments) {
    if (!isPlainObject(seg) || typeof seg.reason !== "string") { errors.push("unsupportedSegments 항목이 올바르지 않습니다."); return fail(); }
    addUnsupported({ text: asString(seg.text), reason: asString(seg.reason) });
  }

  if (plan.steps.length === 0) {
    // Don't duplicate the generic reason when the caller already explained why (부정형/기간 등).
    if (!unsupportedSegments.length) addUnsupported({ text: "", reason: "실행할 시나리오가 없습니다." });
    return fail();
  }
  if (plan.steps.length > 1) {
    addUnsupported({ text: "", reason: "복합 시나리오는 아직 지원하지 않습니다 — 한 번에 한 가지 위기만 재검증합니다." });
    return fail();
  }

  const classified = classifyStep(plan.steps[0], transactions);
  classified.missingFacts.forEach(addMissing);
  classified.unsupportedSegments.forEach(addUnsupported);

  // Fail-closed: execute only when there is a single executable step AND no advisory of any kind.
  if (!classified.execution || missingFacts.length || unsupportedSegments.length) return fail();

  return { ok: true, execution: classified.execution, errors, missingFacts, unsupportedSegments };
}
