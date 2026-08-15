import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildWorldBankRequestUrl,
  refreshCountryIndicators,
  WDI_INDICATORS,
} from "../scripts/refresh-country-indicators.mjs";

const responseFor = (indicator) => [
  { page: 1, pages: 1, total: 2 },
  [
    { indicator: { id: indicator }, country: { id: "US", value: "United States" }, countryiso3code: "USA", date: "2024", value: indicator === "NY.GDP.MKTP.KD.ZG" ? 2.8 : 10 },
    { indicator: { id: indicator }, country: { id: "DE", value: "Germany" }, countryiso3code: "DEU", date: "2023", value: 1.5 },
  ],
];

const indicatorFromUrl = (url) => decodeURIComponent(new URL(url).pathname.split("/").at(-1));

test("World Bank URL is fixed to the official HTTPS host and allowlisted indicator", () => {
  const url = new URL(buildWorldBankRequestUrl("NY.GDP.MKTP.KD.ZG", ["US", "DE"]));
  assert.equal(url.protocol, "https:");
  assert.equal(url.hostname, "api.worldbank.org");
  assert.match(url.pathname, /\/country\/all\/indicator\/NY\.GDP\.MKTP\.KD\.ZG$/);
  assert.throws(() => buildWorldBankRequestUrl("BAD", ["US"]));
  assert.throws(() => buildWorldBankRequestUrl("NY.GDP.MKTP.KD.ZG", ["XX/evil"]));
});

test("refresh writes one validated official snapshot atomically", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tradepilot-country-"));
  try {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      const indicator = indicatorFromUrl(url);
      return { ok: true, json: async () => responseFor(indicator) };
    };
    const result = await refreshCountryIndicators({
      outputDir: dir,
      countryIsoList: ["US", "DE"],
      fetchImpl,
      now: () => new Date("2026-08-01T00:00:00.000Z"),
    });
    assert.equal(calls.length, Object.keys(WDI_INDICATORS).length);
    assert.equal(result.status, "cached");
    const written = JSON.parse(await readFile(join(dir, "country-indicators.json"), "utf8"));
    assert.equal(written.provider, "World Bank WDI");
    assert.equal(written.countries.US["NY.GDP.MKTP.KD.ZG"].value, 2.8);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("network or malformed response preserves the last-known-good cache byte-identically", async () => {
  for (const fetchImpl of [
    async () => { throw new Error("offline"); },
    async () => ({ ok: true, json: async () => ({ bad: true }) }),
  ]) {
    const dir = await mkdtemp(join(tmpdir(), "tradepilot-country-fail-"));
    const file = join(dir, "country-indicators.json");
    const original = "{\"last_known_good\":true}\n";
    try {
      await writeFile(file, original, "utf8");
      await assert.rejects(() => refreshCountryIndicators({ outputDir: dir, countryIsoList: ["US"], fetchImpl }));
      assert.equal(await readFile(file, "utf8"), original);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
});

test("null observations are missing, never coerced to zero", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tradepilot-country-null-"));
  try {
    const fetchImpl = async (url) => ({
      ok: true,
      json: async () => [
        { page: 1, pages: 1, total: 2 },
        [
          { indicator: { id: indicatorFromUrl(url) }, country: { id: "US", value: "United States" }, date: "2024", value: null },
          { indicator: { id: indicatorFromUrl(url) }, country: { id: "DE", value: "Germany" }, date: "2024", value: 1.5 },
        ],
      ],
    });
    await refreshCountryIndicators({ outputDir: dir, countryIsoList: ["US", "DE"], fetchImpl });
    const written = JSON.parse(await readFile(join(dir, "country-indicators.json"), "utf8"));
    assert.equal(written.countries.US, undefined);
    assert.equal(written.countries.DE["NY.GDP.MKTP.KD.ZG"].value, 1.5);
    assert.doesNotMatch(JSON.stringify(written), /"value":0(?:[,}])/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("non-numeric observations fail closed and preserve the existing cache", async () => {
  for (const invalidValue of ["", "0", true, false]) {
    const dir = await mkdtemp(join(tmpdir(), "tradepilot-country-type-"));
    const file = join(dir, "country-indicators.json");
    const original = "{\"last_known_good\":true}\n";
    try {
      await writeFile(file, original, "utf8");
      const fetchImpl = async (url) => ({
        ok: true,
        json: async () => [
          { page: 1, pages: 1, total: 1 },
          [{ indicator: { id: indicatorFromUrl(url) }, country: { id: "US", value: "United States" }, date: "2024", value: invalidValue }],
        ],
      });
      await assert.rejects(() => refreshCountryIndicators({ outputDir: dir, countryIsoList: ["US"], fetchImpl }));
      assert.equal(await readFile(file, "utf8"), original);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
});

test("an indicator with only null observations cannot replace the last-known-good cache", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tradepilot-country-all-null-"));
  const file = join(dir, "country-indicators.json");
  const original = "{\"last_known_good\":true}\n";
  try {
    await writeFile(file, original, "utf8");
    const fetchImpl = async (url) => ({
      ok: true,
      json: async () => [
        { page: 1, pages: 1, total: 1 },
        [{ indicator: { id: indicatorFromUrl(url) }, country: { id: "US", value: "United States" }, date: "2024", value: null }],
      ],
    });
    await assert.rejects(() => refreshCountryIndicators({ outputDir: dir, countryIsoList: ["US"], fetchImpl }));
    assert.equal(await readFile(file, "utf8"), original);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

async function assertRejectedAndCachePreserved(payloadFactory, suffix) {
  const dir = await mkdtemp(join(tmpdir(), `tradepilot-country-${suffix}-`));
  const file = join(dir, "country-indicators.json");
  const original = "{\"last_known_good\":true}\n";
  try {
    await writeFile(file, original, "utf8");
    const fetchImpl = async (url) => ({
      ok: true,
      json: async () => payloadFactory(indicatorFromUrl(url)),
    });
    await assert.rejects(() => refreshCountryIndicators({
      outputDir: dir,
      countryIsoList: ["US"],
      fetchImpl,
      now: () => new Date("2026-08-01T00:00:00.000Z"),
    }));
    assert.equal(await readFile(file, "utf8"), original);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test("response indicator identity must match the requested WDI indicator", async () => {
  for (const indicatorValue of [undefined, "WRONG.INDICATOR"]) {
    await assertRejectedAndCachePreserved((indicator) => [
      { page: 1, pages: 1, total: 1 },
      [{ indicator: indicatorValue === undefined ? {} : { id: indicatorValue }, country: { id: "US" }, date: "2024", value: 7 }],
    ], `indicator-${indicatorValue ?? "missing"}`);
  }
});

test("incomplete or inconsistent pagination cannot replace the cache", async () => {
  for (const metadata of [
    { page: 2, pages: 2, total: 1 },
    { page: 1, pages: 2, total: 1 },
    { page: 1, pages: 1, total: 2 },
    { page: "1", pages: 1, total: 1 },
  ]) {
    await assertRejectedAndCachePreserved((indicator) => [
      metadata,
      [{ indicator: { id: indicator }, country: { id: "US" }, date: "2024", value: 7 }],
    ], `pagination-${JSON.stringify(metadata).replace(/\W/g, "-")}`);
  }
});

test("observation year must be a real bounded year", async () => {
  for (const date of ["0000", "1899", "2027", "9999", "2024-01"]) {
    await assertRejectedAndCachePreserved((indicator) => [
      { page: 1, pages: 1, total: 1 },
      [{ indicator: { id: indicator }, country: { id: "US" }, date, value: 7 }],
    ], `year-${date}`);
  }
});
