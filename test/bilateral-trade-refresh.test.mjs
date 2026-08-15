import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildUnComtradeRequestUrl,
  refreshBilateralTrade,
} from "../scripts/refresh-bilateral-trade.mjs";

const partners = {
  results: [
    { PartnerCode: 840, PartnerCodeIsoAlpha2: "US", isGroup: false },
    { PartnerCode: 276, PartnerCodeIsoAlpha2: "DE", isGroup: false },
  ],
};

const row = (partnerCode, flowCode, primaryValue, overrides = {}) => ({
  typeCode: "C",
  freqCode: "A",
  refYear: 2025,
  period: "2025",
  reporterCode: 410,
  flowCode,
  partnerCode,
  partner2Code: 0,
  classificationSearchCode: "HS",
  cmdCode: "TOTAL",
  customsCode: "C00",
  motCode: 0,
  primaryValue,
  isAggregate: true,
  legacyEstimationFlag: 0,
  ...overrides,
});

const tradePayload = (rows) => ({ elapsedTime: "0.01 secs", count: rows.length, data: rows, error: "" });

function successfulFetch(rows) {
  return async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("/partnerAreas.json")) return { ok: true, json: async () => partners };
    return { ok: true, json: async () => tradePayload(rows) };
  };
}

test("UN Comtrade URL is a fixed keyless official annual Korea total-trade query", () => {
  const url = new URL(buildUnComtradeRequestUrl(2025));
  assert.equal(url.protocol, "https:");
  assert.equal(url.hostname, "comtradeapi.un.org");
  assert.equal(url.pathname, "/public/v1/preview/C/A/HS");
  assert.equal(url.searchParams.get("reporterCode"), "410");
  assert.equal(url.searchParams.get("period"), "2025");
  assert.equal(url.searchParams.get("cmdCode"), "TOTAL");
  assert.equal(url.searchParams.get("flowCode"), "X,M");
  assert.equal(url.searchParams.get("maxRecords"), "500");
  assert.equal(url.searchParams.has("subscription-key"), false);
  assert.throws(() => buildUnComtradeRequestUrl(1899));
  assert.throws(() => buildUnComtradeRequestUrl("2025"));
});

test("refresh writes a validated Korea-partner merchandise snapshot atomically", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tradepilot-bilateral-"));
  try {
    const result = await refreshBilateralTrade({
      outputDir: dir,
      countryIsoList: ["US", "DE"],
      period: 2025,
      now: () => new Date("2026-08-01T00:00:00.000Z"),
      fetchImpl: successfulFetch([
        row(840, "X", 120), row(840, "M", 100),
        row(276, "X", 80), row(276, "M", 90),
        row(0, "X", 999),
      ]),
    });
    assert.deepEqual(result, { status: "cached", period: 2025, countries: 2 });
    const written = JSON.parse(await readFile(join(dir, "bilateral-trade.json"), "utf8"));
    assert.equal(written.provider, "UN Comtrade");
    assert.equal(written.reporter.code, 410);
    assert.equal(written.countries.US.exports_usd, 120);
    assert.equal(written.countries.US.imports_usd, 100);
    assert.equal(written.countries.DE.exports_usd, 80);
    assert.equal(written.countries["0"], undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("missing trade direction stays missing and is never fabricated as zero", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tradepilot-bilateral-missing-"));
  try {
    await refreshBilateralTrade({
      outputDir: dir,
      countryIsoList: ["US"],
      period: 2025,
      now: () => new Date("2026-08-01T00:00:00.000Z"),
      fetchImpl: successfulFetch([row(840, "X", 0)]),
    });
    const written = JSON.parse(await readFile(join(dir, "bilateral-trade.json"), "utf8"));
    assert.equal(written.countries.US.exports_usd, 0);
    assert.equal("imports_usd" in written.countries.US, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

async function assertRejectedAndPreserved(rowsOrPayload, suffix, partnerPayload = partners) {
  const dir = await mkdtemp(join(tmpdir(), `tradepilot-bilateral-${suffix}-`));
  const file = join(dir, "bilateral-trade.json");
  const original = '{"last_known_good":true}\n';
  try {
    await writeFile(file, original, "utf8");
    const fetchImpl = async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("/partnerAreas.json")) return { ok: true, json: async () => partnerPayload };
      const payload = Array.isArray(rowsOrPayload) ? tradePayload(rowsOrPayload) : rowsOrPayload;
      return { ok: true, json: async () => payload };
    };
    await assert.rejects(() => refreshBilateralTrade({
      outputDir: dir,
      countryIsoList: ["US", "DE"],
      period: 2025,
      now: () => new Date("2026-08-01T00:00:00.000Z"),
      fetchImpl,
    }));
    assert.equal(await readFile(file, "utf8"), original);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test("wrong response identity, incomplete count, duplicates and invalid values fail closed", async () => {
  await assertRejectedAndPreserved([row(840, "X", 1, { reporterCode: 999 })], "reporter");
  await assertRejectedAndPreserved([row(840, "X", 1, { period: "2024", refYear: 2024 })], "period");
  await assertRejectedAndPreserved([row(840, "X", 1, { cmdCode: "01" })], "commodity");
  await assertRejectedAndPreserved([row(840, "X", -1)], "negative");
  await assertRejectedAndPreserved([row(840, "X", 1), row(840, "X", 2)], "duplicate");
  await assertRejectedAndPreserved({ count: 2, data: [row(840, "X", 1)], error: "" }, "count");
  await assertRejectedAndPreserved({
    count: 500,
    data: Array.from({ length: 500 }, (_, index) => row(index + 1, index % 2 ? "M" : "X", 1)),
    error: "",
  }, "preview-limit");
});

test("malformed or duplicate partner reference mapping fails closed", async () => {
  await assertRejectedAndPreserved([row(840, "X", 1)], "partner-duplicate", {
    results: [
      { PartnerCode: 840, PartnerCodeIsoAlpha2: "US", isGroup: false },
      { PartnerCode: 840, PartnerCodeIsoAlpha2: "ZZ", isGroup: false },
    ],
  });
});
