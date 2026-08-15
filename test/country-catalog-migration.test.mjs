import { test } from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";

const ROOT = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, ROOT), "utf8");

test("country catalogue has one responsibility and contains no demo risk metrics", async () => {
  const raw = await read("data/country-catalog.json");
  const catalog = JSON.parse(raw);

  assert.equal(catalog.schema_version, "3");
  assert.ok(Object.keys(catalog.countries).length >= 60);
  assert.doesNotMatch(raw, /risk_level|risk_data_status|credit_rating|fx_volatility|gdp_growth|policy_rate/);

  for (const [iso, country] of Object.entries(catalog.countries)) {
    assert.match(iso, /^[A-Z]{2}$/);
    assert.deepEqual(
      Object.keys(country).sort(),
      ["currency", "currency_coverage", "name", "notes"],
      `${iso} must be catalogue-only`,
    );
    assert.ok(typeof country.name === "string" && country.name.trim());
    assert.match(country.currency, /^[A-Z]{3}$/);
    assert.ok(["supported", "settlement_currency_only"].includes(country.currency_coverage));
    assert.ok(typeof country.notes === "string" && country.notes.trim());
  }
});

test("the misleading country-risk file and runtime API are retired", async () => {
  await assert.rejects(access(new URL("data/country-risk.json", ROOT)));
  const runtime = await Promise.all([
    read("js/data-source.js"),
    read("js/ui.js"),
    read("scripts/dev-server.mjs"),
    read("scripts/refresh-country-indicators.mjs"),
    read("scripts/refresh-bilateral-trade.mjs"),
  ]).then((parts) => parts.join("\n"));

  assert.match(runtime, /getCountryCatalog/);
  assert.doesNotMatch(runtime, /getCountryRisk|country-risk\.json|state\.data\.cr\.countries/);
});
