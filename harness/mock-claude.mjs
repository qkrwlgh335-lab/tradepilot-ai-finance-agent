// Mock Claude API fetch implementations for deterministic tests of the LLM paths.
// Usage: pass the returned function as `fetchImpl` to agent.js functions.
export function mockClaude(kind = "success", text = "MOCK 응답") {
  switch (kind) {
    case "success":
      return async () => ({ ok: true, json: async () => ({ content: [{ type: "text", text }] }) });
    case "httpError":
      return async () => ({ ok: false, status: 500, json: async () => ({}) });
    case "malformed":
      return async () => ({ ok: true, json: async () => ({ nope: 1 }) });
    case "throw":
      return async () => { throw new Error("network down"); };
    case "timeout":
      // Hangs until the request's AbortController fires (agent uses AbortController).
      return async (_url, opts = {}) =>
        new Promise((_resolve, reject) => {
          const sig = opts.signal;
          if (sig) sig.addEventListener("abort", () => reject(new Error("aborted")));
        });
    default:
      throw new Error(`unknown mock kind: ${kind}`);
  }
}
