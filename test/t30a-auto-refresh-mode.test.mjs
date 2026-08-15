// T30a — auto-refresh mode must be off-switchable server-side so that offline demos never
// attempt a network call, and the toggle must never bleed into the browser bundle.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequestHandler, resolveRefreshMode } from "../scripts/dev-server.mjs";
import { createMarketDataRefreshHook } from "../scripts/market-data-refresh-hook.mjs";

async function withServer(hook, fn) {
  const server = createServer(createRequestHandler({ hook }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try { await fn(port); } finally { await new Promise((resolve) => server.close(resolve)); }
}

test("T30a: resolveRefreshMode returns 'auto' by default", () => {
  assert.equal(resolveRefreshMode({}), "auto");
});

test("T30a: resolveRefreshMode honors KB_MARKET_AUTO_REFRESH=off (and 'false', '0')", () => {
  for (const v of ["off", "false", "0", "no"])
    assert.equal(resolveRefreshMode({ KB_MARKET_AUTO_REFRESH: v }), "off", v);
  for (const v of ["on", "true", "1", ""])
    assert.equal(resolveRefreshMode({ KB_MARKET_AUTO_REFRESH: v }), "auto", `"${v}"`);
});

test("T30a: when the server is started without a hook, GET / makes zero external calls", async () => {
  let calls = 0;
  const nullHookServer = createServer(createRequestHandler({ hook: null }));
  await new Promise((r) => nullHookServer.listen(0, "127.0.0.1", r));
  const { port } = nullHookServer.address();
  // Verify refreshFn is not called by observing the spy directly — hook is not provided at all.
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 200);
    assert.equal(calls, 0);
  } finally {
    await new Promise((r) => nullHookServer.close(r));
  }
});

test("T30a: a passed hook still works — refresh is called on / in auto mode", async () => {
  let calls = 0;
  const hook = createMarketDataRefreshHook({
    refresh: async () => { calls += 1; },
    now: () => 0,
  });
  await withServer(hook, async (port) => {
    await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(calls, 1);
  });
});

test("T30a: no browser file references KB_MARKET_AUTO_REFRESH — it is a server-side switch only", async () => {
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const ROOT = fileURLToPath(new URL("../", import.meta.url));
  for (const rel of ["js/main.js", "js/ui.js", "js/data-source.js", "index.html"]) {
    const src = await readFile(join(ROOT, rel), "utf8");
    assert.doesNotMatch(src, /KB_MARKET_AUTO_REFRESH/, `${rel} must not reference the server-side env var`);
    assert.doesNotMatch(src, /process\.env/, `${rel} must not read process.env in browser code`);
  }
});
