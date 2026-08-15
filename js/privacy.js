// Shared browser/proxy egress contract.
// Only de-identified, deterministic analysis results are reconstructed here.
// Unknown top-level and nested fields are dropped; malformed known fields fail closed.

export const ANALYSIS_PURPOSES = Object.freeze([
  "counter_examples",
  "product_explanation",
]);

const deepFreeze = (value) => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
};

export const ANALYSIS_PAYLOAD_SCHEMA = deepFreeze({
  netRows: {
    kind: "array",
    fields: {
      currency: "currency",
      net: "finite_number",
    },
  },
  scenarios: {
    kind: "array",
    fields: {
      delta: "ratio_delta",
      totalPnl: "finite_number",
    },
  },
  cfarTotal: { kind: "number", rule: "non_negative_number" },
  strategies: {
    kind: "array",
    fields: {
      key: "short_string",
      hedgeRatio: "unit_ratio",
      residualCFaR: "non_negative_number",
      hedgeCost: "non_negative_number",
    },
  },
  counters: {
    kind: "array",
    fields: {
      q: "bounded_text",
      a: "bounded_text",
    },
  },
  countries: {
    kind: "array",
    fields: {
      name: "short_string",
      exposureShare: "unit_ratio",
    },
  },
  // Reasoner summary only. Product rules, source URLs and document text stay local.
  products: {
    kind: "array",
    fields: {
      product_id: "canonical_id",
      purpose: "canonical_id",
      status: "decision_status",
    },
  },
});

// Kept as a read-only compatibility view for code that needs to show the top-level policy.
export const EXTERNAL_ALLOWLIST = Object.freeze(Object.keys(ANALYSIS_PAYLOAD_SCHEMA));

const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const RRN = /\b\d{6}-?\d{7}\b/g;
const ACCOUNT = /\b\d{10,}\b/g;
const DECISION_STATUSES = new Set([
  "candidate",
  "pending",
  "excluded",
  "unavailable",
]);

const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isFiniteNumber = (value) =>
  typeof value === "number" && Number.isFinite(value);

export function maskSensitive(value) {
  if (typeof value === "string") {
    return value
      .replace(EMAIL, "***@***")
      .replace(RRN, "******-*******")
      .replace(ACCOUNT, "**********");
  }
  if (Array.isArray(value)) return value.map(maskSensitive);
  if (isPlainObject(value)) {
    const out = {};
    for (const [key, child] of Object.entries(value))
      out[key] = maskSensitive(child);
    return out;
  }
  return value;
}

function validateScalar(rule, value) {
  if (rule === "finite_number") return isFiniteNumber(value);
  if (rule === "non_negative_number")
    return isFiniteNumber(value) && value >= 0;
  if (rule === "unit_ratio")
    return isFiniteNumber(value) && value >= 0 && value <= 1;
  if (rule === "ratio_delta")
    return isFiniteNumber(value) && value >= -1 && value <= 1;
  if (rule === "currency")
    return typeof value === "string" && /^[A-Z]{3}$/.test(value);
  if (rule === "canonical_id")
    return typeof value === "string"
      && /^[a-z][a-z0-9_]*$/.test(value)
      && value.length <= 80;
  if (rule === "decision_status")
    return typeof value === "string" && DECISION_STATUSES.has(value);
  if (rule === "short_string")
    return typeof value === "string"
      && value.trim().length > 0
      && value.length <= 120;
  if (rule === "bounded_text")
    return typeof value === "string"
      && value.trim().length > 0
      && value.length <= 2_000;
  return false;
}

function reconstructRecord(value, fields, path, errors) {
  if (!isPlainObject(value)) {
    errors.push(`${path} must be an object`);
    return null;
  }
  const out = {};
  for (const [field, rule] of Object.entries(fields)) {
    const fieldPath = `${path}.${field}`;
    if (!(field in value)) {
      errors.push(`${fieldPath} is required`);
      continue;
    }
    const masked = maskSensitive(value[field]);
    if (!validateScalar(rule, masked)) {
      errors.push(`${fieldPath} is invalid`);
      continue;
    }
    out[field] = masked;
  }
  return out;
}

export function validateAnalysisPayload(payload) {
  const errors = [];
  const value = {};
  if (!isPlainObject(payload)) {
    return {
      ok: false,
      value,
      errors: ["analysisPayload must be an object"],
    };
  }

  for (const [key, definition] of Object.entries(ANALYSIS_PAYLOAD_SCHEMA)) {
    if (!(key in payload)) continue;
    const input = payload[key];
    if (definition.kind === "number") {
      if (!validateScalar(definition.rule, input)) {
        errors.push(`${key} is invalid`);
      } else {
        value[key] = input;
      }
      continue;
    }
    if (!Array.isArray(input)) {
      errors.push(`${key} must be an array`);
      continue;
    }
    const rows = [];
    for (const [index, row] of input.entries()) {
      const rebuilt = reconstructRecord(
        row,
        definition.fields,
        `${key}[${index}]`,
        errors,
      );
      if (rebuilt) rows.push(rebuilt);
    }
    value[key] = rows;
  }
  return { ok: errors.length === 0, value, errors };
}

export function buildAnalysisPayload(context) {
  return validateAnalysisPayload(context).value;
}

// Deprecated alias retained until documentation cleanup; it uses the same strict schema.
export const buildExternalPayload = buildAnalysisPayload;
