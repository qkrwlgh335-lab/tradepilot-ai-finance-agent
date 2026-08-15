// T30a — the market-data badge must carry an ICON + TEXT (not color alone) for each of the
// four contracted states, using the exact user-facing wording.
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarketDataBadge } from "../js/ui.js";

const AS_OF = "2026-07-30";
const envelope = (status) => ({
  status,
  source_id: "mkt:ecb-fx-reference",
  source_url: status === "live" || status === "cached" ? "https://data-api.ecb.europa.eu/x" : null,
  as_of: AS_OF,
  fetched_at: status === "live" || status === "cached" ? "2026-07-30T00:00:00.000Z" : null,
  value: { USD: 1385.5 },
  note: `${status} 상태 설명`,
});

const bothMeta = (status) => ({ fx_rates: envelope(status), fx_volatility: envelope(status) });

test("T30a→T30b: 'live' state is a reserved future state · ECB · 기준일 YYYY-MM-DD (+ icon)", () => {
  const html = renderMarketDataBadge(bothMeta("live"));
  // T30b: live is reserved for a future KB internal direct provider; no "실시간" wording.
  assert.match(html, /직접 공식 데이터 \(예약 상태\) · ECB · 기준일 2026-07-30/);
  assert.doesNotMatch(html, /실시간/);
  assert.match(html, /class="market-icon"/);
});

test("T30a→T30b: 'cached' state → 검증된 공식 일별 데이터 캐시 · ECB · 기준일 YYYY-MM-DD (+ icon)", () => {
  const html = renderMarketDataBadge(bothMeta("cached"));
  // T30b: no "최근" — the badge only cites 기준일, never a computed freshness word.
  assert.match(html, /검증된 공식 일별 데이터 캐시 · ECB · 기준일 2026-07-30/);
  assert.doesNotMatch(html, /최근/);
  assert.match(html, /class="market-icon"/);
});

test("T30a: 'demo' state → 예시 시장데이터 · 실제 거래 전 확인 필요 (+ icon)", () => {
  const html = renderMarketDataBadge(bothMeta("demo"));
  assert.match(html, /예시 시장데이터 · 실제 거래 전 확인 필요/);
  assert.match(html, /class="market-icon"/);
});

test("T30a: 'unavailable' state → 시장데이터를 확인할 수 없어 계산을 중단했습니다 (+ icon)", () => {
  const html = renderMarketDataBadge(bothMeta("unavailable"));
  assert.match(html, /시장데이터를 확인할 수 없어 계산을 중단했습니다/);
  assert.match(html, /class="market-icon"/);
});

test("T30a: no meta at all also shows the 'unavailable' text (fail-closed)", () => {
  const html = renderMarketDataBadge();
  assert.match(html, /시장데이터를 확인할 수 없어 계산을 중단했습니다/);
});

test("T30a: banned wording is not present in ANY of the four rendered states", () => {
  for (const status of ["live", "cached", "demo", "unavailable"]) {
    const html = renderMarketDataBadge(bothMeta(status));
    for (const banned of ["실시간", "체결환율", "KB 고객 적용환율", "KB 우대환율"])
      assert.doesNotMatch(html, new RegExp(banned), `${status}: '${banned}' must not appear`);
  }
});
