// Optional external intent-classification adapter.
// Disabled by default. It sends only locally masked text to the loopback proxy,
// accepts only {type, confidence}, and cannot provide targets or magnitudes.

const TYPES = new Set(["payment_delay", "receivable_drop", "adverse_fx"]);
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/gu;
const LONG_NUMBER = /\b\d{6,}\b/gu;
const TRANSACTION_ID = /\b(?:tx|txn)-[a-z0-9_-]+\b/giu;
const MAX_TEXT = 500;

const isPlainObject = (value) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

export function maskScenarioText(text) {
  return String(text ?? "")
    .normalize("NFC")
    .replace(EMAIL, "[EMAIL]")
    .replace(TRANSACTION_ID, "[TRANSACTION]")
    .replace(LONG_NUMBER, "[NUMBER]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TEXT);
}

export function validateExternalIntentProposal(proposal) {
  const errors = [];
  if (!isPlainObject(proposal)) return { ok: false, value: null, errors: ["proposal must be an object"] };
  const keys = Object.keys(proposal).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["confidence", "type"]))
    errors.push("proposal keys are invalid");
  if (!TYPES.has(proposal.type)) errors.push("type is invalid");
  if (!(typeof proposal.confidence === "number"
      && Number.isFinite(proposal.confidence)
      && proposal.confidence >= 0
      && proposal.confidence <= 1))
    errors.push("confidence is invalid");
  return {
    ok: errors.length === 0,
    value: errors.length ? null : { type: proposal.type, confidence: proposal.confidence },
    errors,
  };
}

export function createExternalIntentAdapter({
  approved = false,
  fetchImpl = globalThis.fetch,
  endpoint = "http://127.0.0.1:8787/api/intent",
  timeoutMs = 15_000,
  minConfidence = 0.80,
} = {}) {
  return {
    state: () => approved ? "optional" : "disabled",
    async classify(text) {
      if (!approved || typeof fetchImpl !== "function")
        return { status: "unavailable", type: null, confidence: 0, mode: "external-disabled" };
      const maskedText = maskScenarioText(text);
      if (!maskedText)
        return { status: "low_confidence", type: null, confidence: 0, mode: "external" };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(endpoint, {
          method: "POST",
          signal: controller.signal,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ purpose: "scenario_intent", maskedText }),
        });
        if (!response.ok)
          return { status: "unavailable", type: null, confidence: 0, mode: "external" };
        const checked = validateExternalIntentProposal(await response.json());
        if (!checked.ok)
          return { status: "low_confidence", type: null, confidence: 0, mode: "external" };
        if (checked.value.confidence < minConfidence)
          return {
            status: "low_confidence",
            type: null,
            confidence: checked.value.confidence,
            mode: "external",
          };
        return { status: "matched", ...checked.value, mode: "external" };
      } catch {
        return { status: "unavailable", type: null, confidence: 0, mode: "external" };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
