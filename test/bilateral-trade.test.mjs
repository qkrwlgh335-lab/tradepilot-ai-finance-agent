import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildBilateralTradeIntelligence,
  formatTradeUsd,
  validateBilateralTradeSnapshot,
} from "../js/bilateral-trade.js";

const snapshot = {
  schema_version: "1",
  status: "cached",
  provider: "UN Comtrade",
  reporter: { code: 410, iso2: "KR", name: "Republic of Korea" },
  period: 2025,
  fetched_at: "2026-08-01T00:00:00.000Z",
  unit: "USD",
  classification: "HS",
  commodity: "TOTAL",
  source_url: "https://comtradeplus.un.org/TradeFlow",
  documentation_url: "https://uncomtrade.org/docs/un-comtrade-api/",
  countries: {
    US: { exports_usd: 120000000000, imports_usd: 100000000000 },
    DE: { exports_usd: 8000000000 },
  },
  note: "한국 보고 기준 연간 상품 교역 참고 통계",
};

test("official bilateral trade snapshot validates strictly", () => {
  assert.deepEqual(validateBilateralTradeSnapshot(snapshot), {
    ok: true, status: "cached", provider: "UN Comtrade", period: 2025,
  });
});

test("bilateral snapshot validation fails closed on malformed or unofficial data", () => {
  for (const value of [null, undefined, [], "x", {}, { ...snapshot, status: "live" }]) {
    assert.equal(validateBilateralTradeSnapshot(value).ok, false);
  }
  for (const mutate of [
    (x) => { x.source_url = "https://example.com/fake"; },
    (x) => { x.reporter.code = 999; },
    (x) => { x.countries.US.exports_usd = -1; },
    (x) => { x.countries.US.imports_usd = Number.NaN; },
    (x) => { x.period = 0; },
  ]) {
    const invalid = structuredClone(snapshot); mutate(invalid);
    assert.equal(validateBilateralTradeSnapshot(invalid).ok, false);
  }
});

test("an empty country catalogue is unavailable, never a verified cache", () => {
  const empty = structuredClone(snapshot);
  empty.countries = {};
  assert.equal(validateBilateralTradeSnapshot(empty).ok, false);
  assert.deepEqual(buildBilateralTradeIntelligence(["US"], empty), [
    { iso2: "US", status: "unavailable" },
  ]);
});

test("country rows preserve missing flows and derive balance without mutating the snapshot", () => {
  const input = structuredClone(snapshot);
  const rows = buildBilateralTradeIntelligence(["US", "DE", "TW"], input);
  assert.deepEqual(rows[0], {
    iso2: "US", status: "cached", period: 2025,
    exportsUsd: 120000000000, importsUsd: 100000000000, balanceUsd: 20000000000,
  });
  assert.equal(rows[1].importsUsd, null);
  assert.equal(rows[1].balanceUsd, null);
  assert.equal(rows[2].status, "unavailable");
  input.countries.US.exports_usd = 1;
  assert.equal(rows[0].exportsUsd, 120000000000);
});

test("USD formatter is deterministic and never turns missing into zero", () => {
  assert.equal(formatTradeUsd(120000000000), "US$120.0B");
  assert.equal(formatTradeUsd(8500000), "US$8.5M");
  assert.equal(formatTradeUsd(0), "US$0");
  assert.equal(formatTradeUsd(null), "미확인");
});
