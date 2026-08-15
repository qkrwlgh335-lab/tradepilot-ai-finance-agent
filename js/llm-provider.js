// Swappable explanation provider.
// The browser never receives an API key and never constructs a system/user prompt.
// External mode sends only { purpose, analysisPayload } to the loopback proxy.

import {
  ANALYSIS_PURPOSES,
  validateAnalysisPayload,
} from "./privacy.js";

export const ENV_DEFAULT_MODE = Object.freeze({
  demo: "mock",
  dev: "mock",
  production: "internal",
});

const MODES = new Set(["external", "mock", "internal", "off"]);

export function resolveMode(env, override) {
  if (MODES.has(override)) return override;
  return ENV_DEFAULT_MODE[env] || "off";
}

export function createProvider(mode, config = {}) {
  const {
    fetchImpl = globalThis.fetch,
    approved = false,
    mockText,
    timeoutMs = 30_000,
    endpoint = "http://127.0.0.1:8787/api/explain",
  } = config;

  const normalizedMode = MODES.has(mode) ? mode : "off";

  async function callExternal(request) {
    if (!approved || typeof fetchImpl !== "function") return null;
    if (!request || !ANALYSIS_PURPOSES.includes(request.purpose)) return null;
    const checked = validateAnalysisPayload(request.analysisPayload);
    if (!checked.ok) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          purpose: request.purpose,
          analysisPayload: checked.value,
        }),
      });
      if (!response.ok) return null;
      const data = await response.json();
      return typeof data?.text === "string" && data.text.trim()
        ? data.text
        : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    mode: normalizedMode,
    approved: !!approved,
    disabled: normalizedMode === "internal",
    modelId: normalizedMode === "external"
      ? "proxy-managed"
      : normalizedMode === "mock"
        ? "deterministic-mock"
        : "none",
    async complete(request = {}) {
      try {
        if (normalizedMode === "mock")
          return mockText != null
            ? String(mockText)
            : null;
        if (normalizedMode === "external") return await callExternal(request);
        // internal is an explicit, disabled production swap point in this prototype.
        return null;
      } catch {
        return null;
      }
    },
  };
}
