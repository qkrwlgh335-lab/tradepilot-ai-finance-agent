import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  MARKET_DATA_STATUSES,
  createMarketDataEnvelope,
  createMarketDataMeta,
} from "../js/market-data.js";
import { createSnapshotSource } from "../js/data-source.js";
import { renderMarketDataBadge } from "../js/ui.js";

const ROOT = new URL("../", import.meta.url);
const loadJson = async (relativePath) =>
  JSON.parse(await readFile(new URL(relativePath, ROOT), "utf8"));
const loadText = (relativePath) => readFile(new URL(relativePath, ROOT), "utf8");

function response(value) {
  return {
    ok: true,
    json: async () => structuredClone(value),
  };
}

function fakeFetch(map) {
  return async (url) => {
    const key = String(url).replace(/^\.\//, "");
    if (!Object.hasOwn(map, key)) return { ok: false, json: async () => ({}) };
    return response(map[key]);
  };
}

test("T21 envelope has the closed status and required metadata shape", () => {
  assert.deepEqual(
    [...MARKET_DATA_STATUSES],
    ["live", "cached", "demo", "unavailable"],
  );
  const envelope = createMarketDataEnvelope({
    data_key: "fx_rates",
    status: "demo",
    source_id: "mkt:demo-fx",
    source_url: null,
    as_of: "2026-07-18",
    fetched_at: null,
    note: "예시 환율 스냅샷",
  }, { USD: 1385.5 });

  assert.deepEqual(Object.keys(envelope), [
    "status", "source_id", "source_url", "as_of", "fetched_at", "value", "note",
  ]);
  assert.equal(envelope.status, "demo");
  assert.equal(envelope.fetched_at, null);
  assert.deepEqual(envelope.value, { USD: 1385.5 });
});

test("T21 demo can never be relabelled live/cached and carries no fetched_at", () => {
  for (const status of ["live", "cached"]) {
    const envelope = createMarketDataEnvelope({
      data_key: "fx_rates",
      status,
      verification_status: "unverified",
      source_id: "mkt:ecos-fx",
      source_url: "https://ecos.bok.or.kr/example",
      as_of: "2026-07-18",
      fetched_at: "2026-07-18T10:00:00.000Z",
      note: "검증되지 않은 응답",
    }, { USD: 1385.5 });
    assert.equal(envelope.status, "unavailable");
    assert.equal(envelope.value, null);
    assert.equal(envelope.fetched_at, null);
  }
});

test("T22 verified cache accepts only the pinned official market-data host", () => {
  const base = {
    data_key: "fx_rates",
    status: "cached",
    verification_status: "verified",
    source_id: "mkt:official",
    as_of: "2026-07-28",
    fetched_at: "2026-07-29T00:00:00.000Z",
    note: "검증 캐시",
  };
  assert.equal(createMarketDataEnvelope({
    ...base,
    source_url: "https://data-api.ecb.europa.eu/service/data/EXR",
  }, { USD: 1 }).status, "cached");
  assert.equal(createMarketDataEnvelope({
    ...base,
    source_url: "https://evil.example/market",
  }, { USD: 1 }).status, "unavailable");
  assert.equal(createMarketDataEnvelope({
    ...base,
    source_url: "https://data-api.ecb.europa.eu.evil.example/market",
  }, { USD: 1 }).status, "unavailable");
});

test("T21 invalid definitions fail closed without throwing", () => {
  for (const source of [
    null,
    [],
    { status: "demo", source_id: "bad", as_of: "2026-02-30", note: "x" },
    { status: "other", source_id: "mkt:x", as_of: "2026-07-18", note: "x" },
  ]) {
    const envelope = createMarketDataEnvelope(source, { USD: 1 });
    assert.equal(envelope.status, "unavailable");
    assert.equal(envelope.value, null);
  }
});

test("T21 metadata map wraps rates and volatility but leaves numeric files unchanged", async () => {
  const [fx, volatility, marketSources] = await Promise.all([
    loadJson("data/fx.json"),
    loadJson("data/fx-vol.json"),
    loadJson("data/market-sources.json"),
  ]);
  const meta = createMarketDataMeta({
    sources: marketSources.sources,
    fx,
    volatility,
  });

  assert.deepEqual(meta.fx_rates.value, fx.rates);
  assert.deepEqual(meta.fx_volatility.value, volatility.annual_vol);
  assert.equal(meta.fx_rates.status, marketSources.sources.find((item) => item.data_key === "fx_rates").status);
  assert.equal(meta.fx_volatility.status, marketSources.sources.find((item) => item.data_key === "fx_volatility").status);
  assert.match(meta.fx_rates.source_url, /^https:\/\/data-api\.ecb\.europa\.eu\//);
  assert.match(meta.fx_volatility.source_url, /^https:\/\/data-api\.ecb\.europa\.eu\//);
});

test("T21 snapshot source preserves getFxRates/getFxVol and exposes getMarketDataMeta", async () => {
  const [fx, volatility, marketSources] = await Promise.all([
    loadJson("data/fx.json"),
    loadJson("data/fx-vol.json"),
    loadJson("data/market-sources.json"),
  ]);
  const src = createSnapshotSource(fakeFetch({
    "data/fx.json": fx,
    "data/fx-vol.json": volatility,
    "data/market-sources.json": marketSources,
  }));

  const [actualFx, actualVol, meta] = await Promise.all([
    src.getFxRates(),
    src.getFxVol(),
    src.getMarketDataMeta(),
  ]);
  assert.deepEqual(actualFx, fx);
  assert.deepEqual(actualVol, volatility);
  assert.deepEqual(meta.fx_rates.value, fx.rates);
  assert.deepEqual(meta.fx_volatility.value, volatility.annual_vol);
});

test("T21 missing metadata degrades to unavailable without breaking numeric data", async () => {
  const [fx, volatility] = await Promise.all([
    loadJson("data/fx.json"),
    loadJson("data/fx-vol.json"),
  ]);
  const src = createSnapshotSource(fakeFetch({
    "data/fx.json": fx,
    "data/fx-vol.json": volatility,
  }));

  const [actualFx, actualVol, meta] = await Promise.all([
    src.getFxRates(),
    src.getFxVol(),
    src.getMarketDataMeta(),
  ]);
  assert.deepEqual(actualFx, fx);
  assert.deepEqual(actualVol, volatility);
  assert.equal(meta.fx_rates.status, "unavailable");
  assert.equal(meta.fx_volatility.status, "unavailable");
  assert.equal(meta.fx_rates.value, null);
  assert.equal(meta.fx_volatility.value, null);
});

test("T21 engine boundary keeps metadata out of financial calls", async () => {
  const ui = await loadText("js/ui.js");
  assert.match(ui, /risk\.computeCFaRBuckets\(cashflows,\s*fx\.rates,\s*annualVol/);
  assert.match(ui, /const annualVol = state\.data\.fxVol\.annual_vol/);
  assert.doesNotMatch(ui, /computeCFaRBuckets\([^;]*marketDataMeta/);
  assert.doesNotMatch(ui, /liquidityTimeline\([^;]*marketDataMeta/);
});

test("T21 UI badge states the verified cache + as-of and exposes per-datum metadata", async () => {
  const [fx, volatility, marketSources] = await Promise.all([
    loadJson("data/fx.json"),
    loadJson("data/fx-vol.json"),
    loadJson("data/market-sources.json"),
  ]);
  const meta = createMarketDataMeta({
    sources: marketSources.sources,
    fx,
    volatility,
  });
  const html = renderMarketDataBadge(meta);
  // T30b: the 'cached' state reads as "검증된 공식 일별 데이터 캐시 · ECB · 기준일 YYYY-MM-DD"
  // (no "최근" — we don't measure elapsed time; only the 기준일 is cited).
  assert.match(html, /검증된 공식 일별 데이터 캐시 · ECB · 기준일 /);
  assert.match(html, new RegExp(fx.as_of));
  assert.match(html, /class="market-icon"/);
  assert.doesNotMatch(html, /최근/);
  assert.match(html, /환율: cached/);          // per-datum metadata still exposed in the title
  assert.match(html, /변동성: cached/);
  assert.doesNotMatch(html, /실시간 연동 완료/); // banned wording never appears
  assert.doesNotMatch(html, /실시간/);
  assert.match(html, /mkt:ecb-fx-reference/);
});

test("T21 market sources stay separate from product-term source registry", async () => {
  const [marketSources, productRegistry] = await Promise.all([
    loadJson("data/market-sources.json"),
    loadJson("data/source-registry.json"),
  ]);
  assert.ok(marketSources.sources.length >= 2);
  assert.ok(marketSources.sources.every((item) => item.source_id.startsWith("mkt:")));
  assert.ok(marketSources.sources.every((item) => !Object.hasOwn(item, "product_id")));
  assert.ok(productRegistry.sources.every((item) => item.source_id.startsWith("src:")));
  assert.ok(productRegistry.sources.every((item) => item.source_kind === "product_terms"));
});

test("T21 browser modules contain no env access or official API request", async () => {
  const source = [
    await loadText("js/market-data.js"),
    await loadText("js/data-source.js"),
    await loadText("js/ui.js"),
  ].join("\n");
  assert.doesNotMatch(source, /process\.env|import\.meta\.env|ANTHROPIC_API_KEY/);
  assert.doesNotMatch(source, /fetch\(\s*["']https?:\/\//);
});
