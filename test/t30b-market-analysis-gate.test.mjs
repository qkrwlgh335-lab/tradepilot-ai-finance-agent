// T30b — the market-data badge and the analysis gate must share ONE state judgement.
// If we say "시장데이터를 확인할 수 없어 계산을 중단했습니다" in the UI, the analyze pipeline
// must actually refuse to run — including refusing to call risk.computeCFaRBuckets or the
// strategy/liquidity engines.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { validateMarketDataForAnalysis } from "../js/market-data.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const ok = (status, as_of) => ({
  status, source_id: "mkt:x",
  source_url: status === "cached" || status === "live" ? "https://data-api.ecb.europa.eu/x" : null,
  as_of, fetched_at: status === "cached" || status === "live" ? "2026-07-30T00:00:00.000Z" : null,
  value: { USD: 1385.5 }, note: "n",
});

// --- pure judgement ---
test("T30b (a): fx_rates unavailable → analysis is not permitted", () => {
  const r = validateMarketDataForAnalysis({ fx_rates: ok("unavailable", null), fx_volatility: ok("cached", "2026-07-30") });
  assert.equal(r.ok, false);
  assert.equal(r.mode, "unavailable");
});

test("T30b (b): fx_volatility unavailable → analysis is not permitted", () => {
  const r = validateMarketDataForAnalysis({ fx_rates: ok("cached", "2026-07-30"), fx_volatility: ok("unavailable", null) });
  assert.equal(r.ok, false);
  assert.equal(r.mode, "unavailable");
});

test("T30b (c): meta null/undefined/malformed does NOT throw and is unavailable", () => {
  for (const meta of [null, undefined, {}, { fx_rates: null }, { fx_volatility: null }, "nope", 7]) {
    let threw = false, out;
    try { out = validateMarketDataForAnalysis(meta); } catch { threw = true; }
    assert.equal(threw, false, `threw for ${JSON.stringify(meta)}`);
    assert.equal(out.ok, false);
    assert.equal(out.mode, "unavailable");
  }
});

test("T30b (d): cached+cached same as_of → official, allowed", () => {
  const r = validateMarketDataForAnalysis({ fx_rates: ok("cached", "2026-07-30"), fx_volatility: ok("cached", "2026-07-30") });
  assert.equal(r.ok, true);
  assert.equal(r.mode, "official");
});

test("T30b (e): live+live same as_of → official, allowed", () => {
  const r = validateMarketDataForAnalysis({ fx_rates: ok("live", "2026-07-30"), fx_volatility: ok("live", "2026-07-30") });
  assert.equal(r.ok, true);
  assert.equal(r.mode, "official");
});

test("T30b (f): demo+demo same as_of → demo, allowed with warning", () => {
  const r = validateMarketDataForAnalysis({ fx_rates: ok("demo", "2026-07-30"), fx_volatility: ok("demo", "2026-07-30") });
  assert.equal(r.ok, true);
  assert.equal(r.mode, "demo");
});

test("T30b (g): cached+demo mixed → unavailable, blocked", () => {
  const r = validateMarketDataForAnalysis({ fx_rates: ok("cached", "2026-07-30"), fx_volatility: ok("demo", "2026-07-30") });
  assert.equal(r.ok, false);
});

test("T30b (h): mismatched as_of → unavailable, blocked", () => {
  const r = validateMarketDataForAnalysis({ fx_rates: ok("cached", "2026-07-29"), fx_volatility: ok("cached", "2026-07-30") });
  assert.equal(r.ok, false);
});

// --- UI wiring ---
test("T30b (i,j): ui.js wires the SAME gate function into the analyze handler", async () => {
  const ui = await readFile(new URL("../js/ui.js", import.meta.url), "utf8");
  assert.match(ui, /import\s*\{[^}]*validateMarketDataForAnalysis[^}]*\}\s*from\s*"\.\/market-data\.js"/,
    "ui.js must import validateMarketDataForAnalysis");
  // At least one place must call the gate and refuse before running the pipeline.
  assert.match(ui, /validateMarketDataForAnalysis\s*\(/, "ui.js must call the gate");
  // The user-facing block reason must appear in ui.js.
  assert.match(ui, /시장데이터의 출처와 기준일을 검증할 수 없어 계산을 시작하지 않았습니다/,
    "the blocked-reason wording must be present verbatim");
});

test("T30b: pure judgement never mutates its input", () => {
  const meta = { fx_rates: ok("cached", "2026-07-30"), fx_volatility: ok("cached", "2026-07-30") };
  const snapshot = JSON.stringify(meta);
  validateMarketDataForAnalysis(meta);
  assert.equal(JSON.stringify(meta), snapshot);
});
