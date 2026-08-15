import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCountryMonitoring } from "../js/country-monitoring.js";

const intelligence = [
  {
    iso2: "US",
    status: "cached",
    indicators: [
      { code: "NY.GDP.MKTP.KD.ZG", value: 2.16, year: 2025 },
      { code: "FP.CPI.TOTL.ZG", value: 2.95, year: 2024 },
    ],
  },
  { iso2: "DE", status: "unavailable", indicators: [] },
];

test("country monitoring links actual transaction notional to official observations without a risk score", () => {
  const rows = buildCountryMonitoring({
    cashflows: [
      { country: "US", currency: "USD", amount: 200, direction: "in" },
      { country: "US", currency: "USD", amount: 100, direction: "out" },
      { country: "DE", currency: "EUR", amount: 100, direction: "out" },
    ],
    rates: { USD: 1_400, EUR: 1_500 },
    countries: { US: { name: "미국" }, DE: { name: "독일" } },
    intelligence,
  });

  assert.deepEqual(rows, [
    {
      iso2: "US", name: "미국", exposureKrw: 420_000, exposureShare: 420_000 / 570_000,
      gdpGrowth: { value: 2.16, year: 2025 }, inflation: { value: 2.95, year: 2024 },
      officialDataStatus: "cached",
    },
    {
      iso2: "DE", name: "독일", exposureKrw: 150_000, exposureShare: 150_000 / 570_000,
      gdpGrowth: null, inflation: null, officialDataStatus: "unavailable",
    },
  ]);
  assert.equal(rows.some((row) => "risk_level" in row || "score" in row || "rank" in row), false);
});

test("missing rates stay unavailable instead of becoming zero exposure", () => {
  const rows = buildCountryMonitoring({
    cashflows: [{ country: "US", currency: "USD", amount: 200, direction: "in" }],
    rates: {},
    countries: { US: { name: "미국" } },
    intelligence,
  });
  assert.equal(rows[0].exposureKrw, null);
  assert.equal(rows[0].exposureShare, null);
});

test("country monitoring is deterministic and never mutates its inputs", () => {
  const input = {
    cashflows: [{ country: "US", currency: "USD", amount: 200, direction: "in" }],
    rates: { USD: 1_400 },
    countries: { US: { name: "미국" } },
    intelligence,
  };
  const before = structuredClone(input);
  assert.deepEqual(buildCountryMonitoring(input), buildCountryMonitoring(input));
  assert.deepEqual(input, before);
});

test("malformed option containers fail closed without throwing", () => {
  for (const input of [null, "bad", 1, [], () => {}]) {
    assert.doesNotThrow(() => buildCountryMonitoring(input));
    assert.deepEqual(buildCountryMonitoring(input), []);
  }
});
