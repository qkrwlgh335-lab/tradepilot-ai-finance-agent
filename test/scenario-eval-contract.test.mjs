import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const load = async (url) => JSON.parse(await readFile(new URL(url, import.meta.url), "utf8"));

test("independent scenario holdout has at least 30 cases and safety cases", async () => {
  const holdout = await load("../eval/scenario-intent-holdout.json");
  assert.ok(holdout.cases.length >= 30);
  assert.equal(new Set(holdout.cases.map((row) => row.id)).size, holdout.cases.length);
  for (const expected of [
    "payment_delay", "receivable_drop", "adverse_fx",
    "ask", "block", "ask_target", "not_found",
  ]) assert.ok(holdout.cases.some((row) => row.expected === expected), expected);
});

test("evaluation script enforces recall and unsafe-execution gates", async () => {
  const source = await readFile(new URL("../scripts/evaluate-scenario-intent.mjs", import.meta.url), "utf8");
  assert.match(source, /intent_type_recall < 0\.80/);
  assert.match(source, /unsafe_execution_count !== 0/);
  assert.match(source, /interpretScenarioIntent/);
  assert.match(source, /validatePlan\(buildPresetPlan/);
});
