// T30 — coordinator for the market-data refresh triggered by "/" access.
// Contract: single-flight, 30 min success TTL, 5 min failure cooldown, 5 s outer timeout,
// and ensureFresh() NEVER rejects — failures preserve the existing verified cache instead.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMarketDataRefreshHook } from "../scripts/market-data-refresh-hook.mjs";

const makeClock = () => {
  const clock = { current: 0 };
  return { now: () => clock.current, advance: (ms) => { clock.current += ms; } };
};

test("first ensureFresh triggers refresh and reports 'refreshed'", async () => {
  let calls = 0;
  const clock = makeClock();
  const hook = createMarketDataRefreshHook({
    refresh: async () => { calls += 1; },
    now: clock.now,
  });
  const result = await hook.ensureFresh();
  assert.equal(calls, 1);
  assert.equal(result.status, "refreshed");
});

test("concurrent ensureFresh calls share one refresh (single-flight)", async () => {
  let calls = 0;
  let resolveRefresh;
  const clock = makeClock();
  const hook = createMarketDataRefreshHook({
    refresh: () => { calls += 1; return new Promise((r) => { resolveRefresh = r; }); },
    now: clock.now,
  });
  const promises = Array.from({ length: 5 }, () => hook.ensureFresh());
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls, 1, "refresh must be called exactly once");
  resolveRefresh();
  const results = await Promise.all(promises);
  assert.ok(results.every((r) => r.status === "refreshed"));
});

test("within TTL, second ensureFresh returns 'cached' with no additional refresh call", async () => {
  let calls = 0;
  const clock = makeClock();
  const hook = createMarketDataRefreshHook({
    refresh: async () => { calls += 1; },
    now: clock.now,
    ttlMs: 30 * 60_000,
  });
  await hook.ensureFresh();
  assert.equal(calls, 1);
  clock.advance(29 * 60_000);
  const second = await hook.ensureFresh();
  assert.equal(calls, 1);
  assert.equal(second.status, "cached");
});

test("after TTL expires, ensureFresh refreshes again", async () => {
  let calls = 0;
  const clock = makeClock();
  const hook = createMarketDataRefreshHook({
    refresh: async () => { calls += 1; },
    now: clock.now,
    ttlMs: 30 * 60_000,
  });
  await hook.ensureFresh();
  clock.advance(30 * 60_000 + 1);
  const second = await hook.ensureFresh();
  assert.equal(calls, 2);
  assert.equal(second.status, "refreshed");
});

test("after a failed refresh, ensureFresh stays in cooldown (no retry)", async () => {
  let calls = 0;
  const clock = makeClock();
  const hook = createMarketDataRefreshHook({
    refresh: async () => { calls += 1; throw new Error("official market-data request failed"); },
    now: clock.now,
    cooldownMs: 5 * 60_000,
  });
  const first = await hook.ensureFresh();
  assert.equal(first.status, "failed");
  clock.advance(5 * 60_000 - 1);
  const second = await hook.ensureFresh();
  assert.equal(calls, 1);
  assert.equal(second.status, "cooldown");
});

test("after failure cooldown expires, ensureFresh retries", async () => {
  let calls = 0;
  const clock = makeClock();
  const hook = createMarketDataRefreshHook({
    refresh: async () => { calls += 1; if (calls === 1) throw new Error("nope"); },
    now: clock.now,
    cooldownMs: 5 * 60_000,
  });
  await hook.ensureFresh();
  clock.advance(5 * 60_000 + 1);
  const second = await hook.ensureFresh();
  assert.equal(calls, 2);
  assert.equal(second.status, "refreshed");
});

test("refresh that exceeds timeoutMs resolves as failure without waiting for the underlying promise", async () => {
  const clock = makeClock();
  const hook = createMarketDataRefreshHook({
    refresh: () => new Promise(() => {}), // never resolves
    now: clock.now,
    timeoutMs: 20,
  });
  const start = Date.now();
  const result = await hook.ensureFresh();
  const elapsed = Date.now() - start;
  assert.equal(result.status, "failed");
  assert.ok(elapsed < 500, `elapsed=${elapsed}ms`);
});

test("ensureFresh never rejects even if refresh throws synchronously", async () => {
  const clock = makeClock();
  const hook = createMarketDataRefreshHook({
    refresh: () => { throw new Error("sync throw"); },
    now: clock.now,
  });
  let threw = false;
  let result;
  try { result = await hook.ensureFresh(); } catch { threw = true; }
  assert.equal(threw, false);
  assert.equal(result.status, "failed");
});

test("a failed attempt does not poison the TTL — next attempt runs when cooldown expires", async () => {
  let call = 0;
  const clock = makeClock();
  const hook = createMarketDataRefreshHook({
    refresh: async () => { call += 1; if (call === 1) throw new Error("boom"); },
    now: clock.now,
    ttlMs: 30 * 60_000,
    cooldownMs: 5 * 60_000,
  });
  const first = await hook.ensureFresh();
  assert.equal(first.status, "failed");
  clock.advance(5 * 60_000 + 1);
  const second = await hook.ensureFresh();
  assert.equal(second.status, "refreshed");
});
