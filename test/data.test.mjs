import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const load = async (p) => JSON.parse(await readFile(new URL(`../${p}`, import.meta.url), "utf8"));

test("fx.json has USD/EUR rates as positive numbers", async () => {
  const fx = await load("data/fx.json");
  assert.ok(fx.rates.USD > 0);
  assert.ok(fx.rates.EUR > 0);
});

test("country-catalog.json has US/VN/DE without invented risk fields", async () => {
  const catalog = await load("data/country-catalog.json");
  for (const c of ["US", "VN", "DE"]) {
    assert.ok(catalog.countries[c], `missing ${c}`);
    assert.equal("risk_level" in catalog.countries[c], false);
  }
});

test("products.json entries each have id/category/name/match.when", async () => {
  const p = await load("data/products.json");
  assert.ok(p.products.length >= 5);
  for (const prod of p.products) {
    assert.ok(prod.id && prod.category && prod.name && prod.match && prod.match.when);
  }
});
