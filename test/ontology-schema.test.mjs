import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const load = async (p) => JSON.parse(await readFile(new URL(`../${p}`, import.meta.url), "utf8"));

test("ontology schema declares an operator table and the minimum classes", async () => {
  const s = await load("data/ontology-schema.json");
  assert.ok(Array.isArray(s.operators) && s.operators.length > 0);
  for (const op of ["eq", "gte", "lte", "includes_any", "is_true", "is_false"]) assert.ok(s.operators.includes(op), op);
  for (const cls of ["Company", "TradeTransaction", "Exposure", "Risk", "Purpose", "FinancialProduct",
                     "Institution", "EligibilityRule", "EvidenceSource"]) assert.ok(s.classes[cls], `class ${cls}`);
});

test("Company declares the facts that must be explicitly provided (no defaults)", async () => {
  const { classes } = await load("data/ontology-schema.json");
  const f = classes.Company.fields;
  assert.equal(f.companyType.required, true);
  assert.equal(f.isSme.required, true);
  assert.equal(f.riskAppetite.required, true);
  assert.equal(f.existingHedges.required, true);        // null=모름은 값 자체는 필수(3-state)
  assert.equal(f.requestedPurposes.required, true);
  // hasExistingHedge is derived, never an input field
  assert.ok(!("hasExistingHedge" in f), "hasExistingHedge must not be an input field");
});

test("TradeTransaction requires tradeType as its own axis, separate from direction", async () => {
  const { classes } = await load("data/ontology-schema.json");
  const f = classes.TradeTransaction.fields;
  assert.deepEqual(f.tradeType.values, ["export", "import"]);
  assert.deepEqual(f.direction.values, ["in", "out"]);
  assert.equal(f.tradeType.required, true);
});
