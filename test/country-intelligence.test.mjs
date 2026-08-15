import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCountryIntelligence,
  validateCountryIndicatorSnapshot,
} from "../js/country-intelligence.js";

const snapshot = {
  schema_version: "1",
  status: "cached",
  provider: "World Bank WDI",
  fetched_at: "2026-08-01T00:00:00.000Z",
  documentation_url: "https://datahelpdesk.worldbank.org/knowledgebase/articles/898581-api-basic-call-structures",
  indicators: {
    "NY.GDP.MKTP.KD.ZG": { label: "GDP 성장률", unit: "%", source_url: "https://data.worldbank.org/indicator/NY.GDP.MKTP.KD.ZG" },
    "FP.CPI.TOTL.ZG": { label: "소비자물가 상승률", unit: "%", source_url: "https://data.worldbank.org/indicator/FP.CPI.TOTL.ZG" },
  },
  countries: {
    US: { "NY.GDP.MKTP.KD.ZG": { year: 2024, value: 2.8 } },
    DE: { "FP.CPI.TOTL.ZG": { year: 2024, value: 2.3 } },
  },
};

test("country indicator snapshot validates official cached observations", () => {
  const result = validateCountryIndicatorSnapshot(snapshot);
  assert.equal(result.ok, true);
  assert.equal(result.status, "cached");
});

test("country indicator validation fails closed without throwing", () => {
  for (const value of [null, undefined, [], "x", {}, { ...snapshot, status: "live" }]) {
    const result = validateCountryIndicatorSnapshot(value);
    assert.equal(result.ok, false);
    assert.equal(result.status, "unavailable");
  }
  const bad = structuredClone(snapshot);
  bad.countries.US["NY.GDP.MKTP.KD.ZG"].value = Number.NaN;
  assert.equal(validateCountryIndicatorSnapshot(bad).ok, false);
  const evil = structuredClone(snapshot);
  evil.indicators["NY.GDP.MKTP.KD.ZG"].source_url = "https://example.com/fake";
  assert.equal(validateCountryIndicatorSnapshot(evil).ok, false);
});

test("country intelligence preserves missing observations as unknown and never invents risk scores", () => {
  const rows = buildCountryIntelligence(["US", "DE", "ZZ"], snapshot);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].iso2, "US");
  assert.equal(rows[0].indicators[0].value, 2.8);
  assert.equal(rows[0].indicators[1].value, null);
  assert.equal(rows[2].status, "unavailable");
  assert.equal("risk_level" in rows[0], false);
  assert.equal("score" in rows[0], false);
});

test("country intelligence output is immutable from source mutation", () => {
  const input = structuredClone(snapshot);
  const rows = buildCountryIntelligence(["US"], input);
  input.countries.US["NY.GDP.MKTP.KD.ZG"].value = 99;
  assert.equal(rows[0].indicators[0].value, 2.8);
});
