// T30 — the dev server triggers a market-data refresh only on HTML entry-points.
// Static asset requests never wait for a refresh, and refresh failure never blocks the response.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequestHandler } from "../scripts/dev-server.mjs";
import { createMarketDataRefreshHook } from "../scripts/market-data-refresh-hook.mjs";

async function withServer(hook, fn) {
  const server = createServer(createRequestHandler({ hook }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await fn(port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("GET / triggers the refresh; GET /js/parse-input.js does not", async () => {
  let calls = 0;
  const hook = createMarketDataRefreshHook({
    refresh: async () => { calls += 1; },
    now: () => 0,
  });
  await withServer(hook, async (port) => {
    // A static-asset request must not trigger a refresh.
    const staticRes = await fetch(`http://127.0.0.1:${port}/js/parse-input.js`);
    assert.equal(staticRes.status, 200);
    assert.equal(calls, 0);
    // The root request must trigger exactly one refresh.
    const rootRes = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(rootRes.status, 200);
    assert.equal(calls, 1);
  });
});

test("GET /index.html also counts as an HTML entry-point", async () => {
  let calls = 0;
  const hook = createMarketDataRefreshHook({
    refresh: async () => { calls += 1; },
    now: () => 0,
  });
  await withServer(hook, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/index.html`);
    assert.equal(res.status, 200);
    assert.equal(calls, 1);
  });
});

test("GET / still returns 200 with the existing cache when refresh fails", async () => {
  const hook = createMarketDataRefreshHook({
    refresh: async () => { throw new Error("official market-data request failed"); },
    now: () => 0,
  });
  await withServer(hook, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 200);
    const body = await res.text();
    // The cached index.html is served — the app can complete.
    assert.match(body, /<html/i);
  });
});

test("static-asset requests do not wait for an in-flight refresh", async () => {
  let resolveRefresh;
  const hook = createMarketDataRefreshHook({
    refresh: () => new Promise((r) => { resolveRefresh = r; }),
    now: () => 0,
  });
  await withServer(hook, async (port) => {
    // Kick off a / request; its refresh will hang until we resolve it.
    const rootPromise = fetch(`http://127.0.0.1:${port}/`);
    // Give / a moment to start the refresh.
    await new Promise((r) => setTimeout(r, 20));
    // A static asset must respond promptly even while the refresh is in flight.
    const start = Date.now();
    const staticRes = await fetch(`http://127.0.0.1:${port}/js/parse-input.js`);
    const elapsed = Date.now() - start;
    assert.equal(staticRes.status, 200);
    assert.ok(elapsed < 300, `static request waited ${elapsed}ms — must not block on refresh`);
    // Drain the hanging /.
    resolveRefresh();
    await rootPromise;
  });
});

test("concurrent GET / requests share one refresh (single-flight)", { timeout: 10_000 }, async () => {
  let calls = 0;
  let resolveRefresh;
  let signalRefreshStarted;
  const refreshStarted = new Promise((resolve) => { signalRefreshStarted = resolve; });
  const hook = createMarketDataRefreshHook({
    refresh: () => {
      calls += 1;
      signalRefreshStarted();
      return new Promise((resolve) => { resolveRefresh = resolve; });
    },
    now: () => 0,
  });
  await withServer(hook, async (port) => {
    const responses = Array.from({ length: 4 }, () => fetch(`http://127.0.0.1:${port}/`));
    // Wait for the refresh itself to start. A fixed sleep is flaky under the full parallel suite:
    // the HTTP requests may not be scheduled within that arbitrary window on a busy runner.
    await refreshStarted;
    assert.equal(calls, 1);
    resolveRefresh();
    const results = await Promise.all(responses);
    assert.ok(results.every((r) => r.status === 200));
  });
});
