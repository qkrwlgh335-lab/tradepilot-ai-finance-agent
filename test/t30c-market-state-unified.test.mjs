// T30c-A — one and only one function judges market-data state; the badge and the analyze gate
// consume the SAME judgement so wording and behaviour cannot drift again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { validateMarketDataForAnalysis } from "../js/market-data.js";
import { renderMarketDataBadge } from "../js/ui.js";

const env = (status, as_of) => ({
  status, source_id: "mkt:x",
  source_url: status === "cached" || status === "live" ? "https://data-api.ecb.europa.eu/x" : null,
  as_of, fetched_at: status === "cached" || status === "live" ? "2026-07-30T00:00:00.000Z" : null,
  value: { USD: 1385.5 }, note: "n",
});
const meta = (fx, vol) => ({ fx_rates: fx, fx_volatility: vol });

const uiSrc = await readFile(new URL("../js/ui.js", import.meta.url), "utf8");
// Extract the badge's rendered tone (status-verified / status-demo / status-unavailable).
const toneOf = (html) => (html.match(/status-(verified|demo|unavailable)/) || [])[0] || "";

// ---- extended return contract: { ok, mode, displayState, asOf, reason? } ----
test("T30c-A: judgement returns {ok, mode, displayState, asOf}", () => {
  const r = validateMarketDataForAnalysis(meta(env("cached", "2026-07-30"), env("cached", "2026-07-30")));
  assert.equal(r.ok, true);
  assert.equal(r.mode, "official");
  assert.equal(r.displayState, "cached");
  assert.equal(r.asOf, "2026-07-30");
});

// ---- (a) cached with mismatched as_of ----
test("T30c-A (a): cached + cached with mismatched as_of → unavailable AND badge is status-unavailable", () => {
  const m = meta(env("cached", "2026-07-29"), env("cached", "2026-07-30"));
  const gate = validateMarketDataForAnalysis(m);
  assert.equal(gate.ok, false);
  assert.equal(gate.displayState, "unavailable");
  const html = renderMarketDataBadge(m);
  assert.equal(toneOf(html), "status-unavailable");
  assert.match(html, /시장데이터를 확인할 수 없어 계산을 중단했습니다/);
  assert.doesNotMatch(html, /status-verified/);
});

// ---- (b) cached + demo mix ----
test("T30c-A (b): cached + demo → unavailable AND badge is status-unavailable", () => {
  const m = meta(env("cached", "2026-07-30"), env("demo", "2026-07-30"));
  assert.equal(validateMarketDataForAnalysis(m).ok, false);
  assert.equal(toneOf(renderMarketDataBadge(m)), "status-unavailable");
});

// ---- (c) malformed meta ----
test("T30c-A (c): malformed meta → unavailable AND badge is status-unavailable", () => {
  for (const m of [null, undefined, {}, { fx_rates: null }, "nope", 7]) {
    const gate = validateMarketDataForAnalysis(m);
    assert.equal(gate.ok, false);
    assert.equal(gate.displayState, "unavailable");
    assert.equal(toneOf(renderMarketDataBadge(m)), "status-unavailable");
  }
});

// ---- (d) cached + cached same date ----
test("T30c-A (d): cached + cached same date → ok/official/cached + verified badge", () => {
  const m = meta(env("cached", "2026-07-30"), env("cached", "2026-07-30"));
  const gate = validateMarketDataForAnalysis(m);
  assert.equal(gate.ok, true);
  assert.equal(gate.mode, "official");
  assert.equal(gate.displayState, "cached");
  const html = renderMarketDataBadge(m);
  assert.equal(toneOf(html), "status-verified");
  assert.match(html, /검증된 공식 일별 데이터 캐시/);
});

// ---- (e) live + live ----
test("T30c-A (e): live + live same date → ok/official/live + verified badge with reserved wording", () => {
  const m = meta(env("live", "2026-07-30"), env("live", "2026-07-30"));
  const gate = validateMarketDataForAnalysis(m);
  assert.equal(gate.ok, true);
  assert.equal(gate.mode, "official");
  assert.equal(gate.displayState, "live");
  const html = renderMarketDataBadge(m);
  assert.equal(toneOf(html), "status-verified");
  assert.match(html, /직접 공식 데이터 \(예약 상태\)/);
});

// ---- (f) mixed cached + live ----
test("T30c-A (f): cached + live → ok/official/cached (surface the lower-trust label)", () => {
  const m = meta(env("cached", "2026-07-30"), env("live", "2026-07-30"));
  const gate = validateMarketDataForAnalysis(m);
  assert.equal(gate.ok, true);
  assert.equal(gate.mode, "official");
  assert.equal(gate.displayState, "cached");
  assert.match(renderMarketDataBadge(m), /검증된 공식 일별 데이터 캐시/);
});

// ---- (g) demo + demo ----
test("T30c-A (g): demo + demo → ok/demo/demo + demo badge", () => {
  const m = meta(env("demo", "2026-07-30"), env("demo", "2026-07-30"));
  const gate = validateMarketDataForAnalysis(m);
  assert.equal(gate.ok, true);
  assert.equal(gate.mode, "demo");
  assert.equal(gate.displayState, "demo");
  assert.match(renderMarketDataBadge(m), /예시 시장데이터 · 실제 거래 전 확인 필요/);
});

// ---- (h) badge displayState always equals gate displayState across all fixtures ----
test("T30c-A (h): badge tone corresponds to gate.displayState for every fixture", () => {
  const cases = [
    { m: meta(env("cached", "2026-07-30"), env("cached", "2026-07-30")), tone: "status-verified" },
    { m: meta(env("live", "2026-07-30"), env("live", "2026-07-30")), tone: "status-verified" },
    { m: meta(env("cached", "2026-07-30"), env("live", "2026-07-30")), tone: "status-verified" },
    { m: meta(env("live", "2026-07-30"), env("cached", "2026-07-30")), tone: "status-verified" },
    { m: meta(env("demo", "2026-07-30"), env("demo", "2026-07-30")), tone: "status-demo" },
    { m: meta(env("cached", "2026-07-29"), env("cached", "2026-07-30")), tone: "status-unavailable" },
    { m: meta(env("cached", "2026-07-30"), env("demo", "2026-07-30")), tone: "status-unavailable" },
    { m: null, tone: "status-unavailable" },
    { m: undefined, tone: "status-unavailable" },
  ];
  for (const { m, tone } of cases) assert.equal(toneOf(renderMarketDataBadge(m)), tone, JSON.stringify(m));
});

// ---- (i) ui.js has NO independent resolveJointState function ----
test("T30c-A (i): ui.js no longer defines its own resolveJointState (single-source contract)", () => {
  assert.doesNotMatch(uiSrc, /function\s+resolveJointState/, "ui.js must not carry its own state resolver");
  assert.doesNotMatch(uiSrc, /\bresolveJointState\b/, "no references to the removed function");
  // The badge must call the single shared judgement.
  assert.match(uiSrc, /validateMarketDataForAnalysis/);
});

// ---- (j) judgement never mutates its input ----
test("T30c-A (j): validateMarketDataForAnalysis never mutates the input meta", () => {
  const m = meta(env("cached", "2026-07-30"), env("cached", "2026-07-30"));
  const snap = JSON.stringify(m);
  validateMarketDataForAnalysis(m);
  renderMarketDataBadge(m);
  assert.equal(JSON.stringify(m), snap);
});
