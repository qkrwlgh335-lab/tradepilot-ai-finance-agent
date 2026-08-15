// T30b — cached-state honesty. The ECB Node refresh path stores status:"cached", so the runtime
// UI must say exactly that — never "실시간", never "최근" (we don't measure elapsed time), never
// "live" (that state is reserved for a future KB internal real-time provider).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { renderMarketDataBadge } from "../js/ui.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

const envelope = (status, as_of = "2026-07-30") => ({
  status, source_id: "mkt:ecb-fx-reference",
  source_url: status === "cached" || status === "live" ? "https://data-api.ecb.europa.eu/x" : null,
  as_of, fetched_at: status === "cached" || status === "live" ? "2026-07-30T00:00:00.000Z" : null,
  value: { USD: 1385.5 }, note: "n",
});
const both = (status) => ({ fx_rates: envelope(status), fx_volatility: envelope(status) });

test("T30b P1-c: 'cached' badge text is '검증된 공식 일별 데이터 캐시' — no '최근'", () => {
  const html = renderMarketDataBadge(both("cached"));
  assert.match(html, /🗂️/);
  assert.match(html, /검증된 공식 일별 데이터 캐시 · ECB · 기준일 2026-07-30/);
  assert.doesNotMatch(html, /최근/);
});

test("T30b P1-a: refreshMarketData reads as 'cached' in its emitted catalog", async () => {
  const src = await readFile(new URL("../scripts/refresh-market-data.mjs", import.meta.url), "utf8");
  // The two source rows saved by a successful refresh must both carry status:"cached".
  const cachedMatches = src.match(/status:\s*"cached"/g) || [];
  assert.ok(cachedMatches.length >= 2, `expected ≥2 status:"cached" in refresh script (fx + volatility)`);
  assert.doesNotMatch(src, /status:\s*"live"/, "the ECB refresh path must never save status:live");
});

test("T30b P1-d: RUNBOOK documents that live is a reserved future state", async () => {
  const runbook = await readFile(new URL("../docs/RUNBOOK.md", import.meta.url), "utf8");
  assert.match(runbook, /live[^\n]*예약/i, "RUNBOOK must describe live as a reserved (예약) state");
});

test("T30b P1-e: banned wording never appears in ANY badge state", () => {
  for (const status of ["live", "cached", "demo", "unavailable"]) {
    const html = renderMarketDataBadge(both(status));
    for (const banned of ["실시간", "체결환율", "KB 우대환율", "KB 고객 적용환율"])
      assert.doesNotMatch(html, new RegExp(banned), `${status}: '${banned}' must not appear`);
  }
});

test("T30b P1: refresh success uses 기준일 without a stale-freshness claim (기준일 always shown)", () => {
  // Whether the cache is fresh or old, the badge shows the SAME wording tied to as_of.
  const yesterday = renderMarketDataBadge(both("cached")); // uses envelope's fixed 2026-07-30
  assert.match(yesterday, /기준일 2026-07-30/);
  const ancient = renderMarketDataBadge({
    fx_rates: envelope("cached", "2020-01-01"),
    fx_volatility: envelope("cached", "2020-01-01"),
  });
  assert.match(ancient, /기준일 2020-01-01/);
  assert.doesNotMatch(ancient, /최근/);
});
