import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { validateCashflows } from "../js/validate.js";

const load = async (p) => JSON.parse(await readFile(new URL(`../${p}`, import.meta.url), "utf8"));

test("every sample document has id/title/cashflows", async () => {
  const { samples } = await load("data/samples.json");
  assert.ok(samples.length >= 2);
  for (const s of samples) {
    assert.ok(s.id && s.title && Array.isArray(s.cashflows) && s.cashflows.length >= 1);
  }
});

test("every sample's cashflows pass input validation", async () => {
  const { samples } = await load("data/samples.json");
  for (const s of samples) {
    const r = validateCashflows(s.cashflows);
    assert.equal(r.ok, true, `${s.id} invalid: ${r.errors.join(", ")}`);
  }
});
