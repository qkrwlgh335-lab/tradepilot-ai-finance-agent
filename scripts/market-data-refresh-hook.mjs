// T30 — refresh coordinator wrapped around a supplied refresh() function.
// Contract: single-flight for concurrent callers; a successful refresh is trusted for `ttlMs`;
// a failed refresh is not retried for `cooldownMs`; each attempt is bounded by `timeoutMs`; and
// ensureFresh() NEVER rejects — a caller can await it before responding and always proceed.

const HOUR_MS = 60 * 60_000;

export function createMarketDataRefreshHook({
  refresh,
  now = () => Date.now(),
  ttlMs = 30 * 60_000,
  cooldownMs = 5 * 60_000,
  timeoutMs = 5_000,
} = {}) {
  if (typeof refresh !== "function") throw new Error("refresh must be a function");
  if (![ttlMs, cooldownMs, timeoutMs].every((v) => Number.isFinite(v) && v > 0))
    throw new Error("ttlMs / cooldownMs / timeoutMs must be positive finite numbers");
  if (timeoutMs > HOUR_MS)
    throw new Error("timeoutMs must be bounded — a dev server cannot block a request for hours");

  let lastSuccessAt = null;
  let lastFailureAt = null;
  let inFlight = null;

  async function attempt() {
    // Adapt any callable — sync-throw, async, thenable — into a promise we can race safely.
    const refreshPromise = Promise.resolve().then(() => refresh());
    refreshPromise.catch(() => {}); // suppress unhandled rejection if we abandon it on timeout
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("market-data refresh timed out")), timeoutMs);
    });
    try {
      await Promise.race([refreshPromise, timeoutPromise]);
      lastSuccessAt = now();
      return { status: "refreshed" };
    } catch (error) {
      lastFailureAt = now();
      return { status: "failed", error };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async ensureFresh() {
      const t = now();
      if (lastSuccessAt !== null && t - lastSuccessAt < ttlMs)
        return { status: "cached" };
      if (lastFailureAt !== null && t - lastFailureAt < cooldownMs)
        return { status: "cooldown" };
      if (inFlight) return inFlight;
      inFlight = attempt();
      inFlight.finally(() => { inFlight = null; }).catch(() => {});
      return inFlight;
    },
  };
}
