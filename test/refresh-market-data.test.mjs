import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ECB_EXPECTED_CURRENCIES,
  buildEcbRequestUrl,
  deriveKrwMarketSnapshot,
  refreshMarketData,
} from "../scripts/refresh-market-data.mjs";

const csv = (rows) => [
  "KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE",
  ...rows.map(([currency, date, value]) =>
    `EXR.D.${currency}.EUR.SP00.A,D,${currency},EUR,SP00,A,${date},${value}`),
].join("\n");

test("T22 request is pinned to the official ECB host and a closed currency set", () => {
  const url = new URL(buildEcbRequestUrl());
  assert.equal(url.protocol, "https:");
  assert.equal(url.hostname, "data-api.ecb.europa.eu");
  assert.match(url.pathname, /^\/service\/data\/EXR\/D\./);
  assert.equal(url.searchParams.get("format"), "csvdata");
  assert.ok(Number(url.searchParams.get("lastNObservations")) >= 250);
  assert.ok(ECB_EXPECTED_CURRENCIES.length >= 25);
  assert.throws(() => buildEcbRequestUrl(["USD", "BAD"]));
});
test("T22 derives KRW cross-rates and annualized volatility from verified rows", () => {
  const rows = [];
  for (let day = 1; day <= 65; day += 1) {
    const date = `2026-03-${String(((day - 1) % 28) + 1).padStart(2, "0")}`;
    rows.push(["KRW", date, 1700 + day]);
    rows.push(["USD", date, 1.10 + day / 10000]);
  }
  // The fixture intentionally reuses dates, so the last row for each date wins.
  const snapshot = deriveKrwMarketSnapshot(csv(rows), {
    expectedCurrencies: ["USD"],
    minimumObservations: 20,
  });
  assert.equal(snapshot.as_of, "2026-03-28");
  assert.deepEqual(Object.keys(snapshot.rates).sort(), ["EUR", "USD"]);
  assert.ok(snapshot.rates.EUR > snapshot.rates.USD);
  assert.ok(snapshot.annual_vol.EUR > 0);
  assert.ok(snapshot.annual_vol.USD > 0);
});

test("T22 fails closed on malformed schema, bad values, or a missing expected currency", () => {
  assert.throws(() => deriveKrwMarketSnapshot("bad,data\n1,2", {
    expectedCurrencies: ["USD"],
  }));
  assert.throws(() => deriveKrwMarketSnapshot(csv([
    ["KRW", "2026-01-02", 1700],
    ["USD", "2026-01-02", -1],
  ]), { expectedCurrencies: ["USD"], minimumObservations: 1 }));
  assert.throws(() => deriveKrwMarketSnapshot(csv([
    ["KRW", "2026-01-02", 1700],
  ]), { expectedCurrencies: ["USD"], minimumObservations: 1 }));
});

test("T22 refresh validates then atomically writes cache; failure preserves existing files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tradepilot-market-"));
  const rows = [];
  const dates = ["2026-01-02", "2026-01-05", "2026-01-06"];
  for (let i = 0; i < dates.length; i += 1) {
    rows.push(["KRW", dates[i], 1700 + i * 2]);
    rows.push(["USD", dates[i], 1.10 + i / 100]);
  }
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    text: async () => csv(rows),
  });
  const now = () => new Date("2026-01-06T10:00:00.000Z");
  const result = await refreshMarketData({
    outputDir: dir,
    fetchImpl,
    now,
    expectedCurrencies: ["USD"],
    minimumObservations: 2,
  });
  assert.equal(result.status, "cached");

  const before = await readFile(join(dir, "fx.json"), "utf8");
  await assert.rejects(() => refreshMarketData({
    outputDir: dir,
    fetchImpl: async () => { throw new Error("offline"); },
    now,
    expectedCurrencies: ["USD"],
    minimumObservations: 2,
  }));
  assert.equal(await readFile(join(dir, "fx.json"), "utf8"), before);
});
