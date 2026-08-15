import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  countryOptionLabel,
  suggestedCurrencyForCountry,
} from "../js/ui.js";

const ROOT = new URL("../", import.meta.url);
const loadJson = async (relativePath) =>
  JSON.parse(await readFile(new URL(relativePath, ROOT), "utf8"));

test("country catalog covers at least 60 major trade countries without inventing risk metrics", async () => {
  const catalog = await loadJson("data/country-catalog.json");
  const entries = Object.entries(catalog.countries);
  assert.ok(entries.length >= 60, `only ${entries.length} countries`);

  for (const [iso, country] of entries) {
    assert.match(iso, /^[A-Z]{2}$/);
    assert.ok(typeof country.name === "string" && country.name.trim());
    assert.match(country.currency, /^[A-Z]{3}$/);
    assert.ok(["supported", "settlement_currency_only"].includes(country.currency_coverage));
    assert.ok(typeof country.notes === "string" && country.notes.trim());
    assert.deepEqual(Object.keys(country).sort(), ["currency", "currency_coverage", "name", "notes"]);
  }
});
test("every locally supported country currency has both an FX rate and volatility", async () => {
  const [catalog, fx, vol] = await Promise.all([
    loadJson("data/country-catalog.json"),
    loadJson("data/fx.json"),
    loadJson("data/fx-vol.json"),
  ]);
  assert.deepEqual(
    Object.keys(fx.rates).sort(),
    Object.keys(vol.annual_vol).sort(),
    "rate/volatility currency sets must match exactly",
  );
  assert.ok(Object.keys(fx.rates).length >= 25, "expanded market-data coverage");

  for (const [iso, country] of Object.entries(catalog.countries)) {
    if (country.currency_coverage === "supported") {
      assert.ok(fx.rates[country.currency] > 0, `${iso}/${country.currency} rate`);
      assert.ok(vol.annual_vol[country.currency] > 0, `${iso}/${country.currency} volatility`);
    }
  }
});

test("country labels expose ISO code and currency suggestion is fail-closed", () => {
  assert.equal(
    countryOptionLabel("US", { name: "미국", currency: "USD", currency_coverage: "supported" }),
    "미국 (US) · USD",
  );
  assert.equal(
    countryOptionLabel("VN", { name: "베트남", currency: "VND", currency_coverage: "settlement_currency_only" }),
    "베트남 (VN) · 현지통화 미지원",
  );
  assert.equal(
    suggestedCurrencyForCountry(
      { currency: "USD", currency_coverage: "supported" },
      { USD: 1 },
    ),
    "USD",
  );
  assert.equal(
    suggestedCurrencyForCountry(
      { currency: "VND", currency_coverage: "settlement_currency_only" },
      { USD: 1 },
    ),
    null,
  );
  assert.equal(suggestedCurrencyForCountry(null, { USD: 1 }), null);
});
