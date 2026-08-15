// Session-scoped metadata-only audit log.
// Raw payload values, model responses and credentials are never persisted.

const KEY = "kb_audit_log";
const LIMIT = 100;
let fallbackSequence = 0;

const eventId = () => {
  try {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function")
      return globalThis.crypto.randomUUID();
  } catch {
    // Deterministic structure matters more than randomness for the local demo fallback.
  }
  fallbackSequence += 1;
  return `audit-${Date.now().toString(36)}-${fallbackSequence.toString(36)}`;
};

export function getAuditLog(store) {
  try {
    const parsed = JSON.parse(store.getItem(KEY) || "[]");
    return Array.isArray(parsed) ? parsed.slice(-LIMIT) : [];
  } catch {
    return [];
  }
}

export function clearAuditLog(store) {
  try {
    if (typeof store.removeItem === "function") store.removeItem(KEY);
    else store.setItem(KEY, "[]");
  } catch {
    // Audit storage must never break the core deterministic flow.
  }
}

export function recordAudit(store, {
  purpose = "product_explanation",
  approval = false,
  provider = "off",
  modelId = "none",
  promptTemplateVersion = "t9-v1",
  policyVersion = "egress-v1",
  corpusHash = "product-kb-v1",
  outcome = "fallback",
  sentFields = [],
} = {}) {
  const entry = {
    event_id: eventId(),
    timestamp: new Date().toISOString(),
    purpose,
    approval: !!approval,
    provider,
    model_id: modelId,
    prompt_template_version: promptTemplateVersion,
    policy_version: policyVersion,
    corpus_hash: corpusHash,
    outcome,
    sent_fields: Array.isArray(sentFields)
      ? [...new Set(sentFields.filter((field) => typeof field === "string"))].sort()
      : [],
  };
  try {
    const log = getAuditLog(store);
    log.push(entry);
    store.setItem(KEY, JSON.stringify(log.slice(-LIMIT)));
  } catch {
    // Audit storage failure is non-fatal and does not change the analysis result.
  }
  return entry;
}
