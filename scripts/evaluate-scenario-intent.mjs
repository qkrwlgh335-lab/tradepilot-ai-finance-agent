import { pipeline } from "@xenova/transformers";
import { readFile } from "node:fs/promises";
import {
  createScenarioSemanticClassifier,
  interpretScenarioIntent,
} from "../js/scenario-semantic.js";
import { buildPresetPlan } from "../js/scenario-preset.js";
import { validatePlan } from "../js/scenario-plan.js";

const load = async (url) => JSON.parse(await readFile(new URL(url, import.meta.url), "utf8"));
const corpus = await load("../data/scenario-intent-corpus.json");
const embeddings = await load("../data/scenario-intent-embeddings.json");
const holdout = await load("../eval/scenario-intent-holdout.json");
const intents = await load("../data/scenario-intents.json");
const samples = await load("../data/samples.json");
const sample = samples.samples.find((row) => row.id === "a") || samples.samples[0];
const transactions = sample.cashflows.map((row, index) => ({
  ...row,
  transaction_id: row.transaction_id || `eval-${index + 1}`,
}));
const extractor = await pipeline("feature-extraction", embeddings.model);
const classifier = createScenarioSemanticClassifier({
  corpus,
  embeddings,
  extractorFactory: async () => extractor,
});

const intentTypes = new Set(["payment_delay", "receivable_drop", "adverse_fx"]);
const rows = [];
for (const item of holdout.cases) {
  const interpreted = await interpretScenarioIntent(
    item.text,
    { transactions, intents },
    classifier,
  );
  const gate = validatePlan(buildPresetPlan(interpreted.intent), { transactions });
  rows.push({
    id: item.id,
    expected: item.expected,
    predicted_type: interpreted.intent.steps[0]?.type || null,
    executable: gate.ok,
    asks_question: gate.missingFacts.length > 0,
    mode: interpreted.mode,
  });
}

const intentRows = rows.filter((row) => intentTypes.has(row.expected));
// Intent recall measures whether the type was identified. A payment-delay
// sentence can be correctly classified yet remain non-executable until the
// deterministic target resolver receives an unambiguous transaction.
const correctIntent = intentRows.filter((row) =>
  row.predicted_type === row.expected).length;
const safetyRows = rows.filter((row) =>
  ["ask", "block", "ask_target", "not_found"].includes(row.expected));
const unsafeExecutions = safetyRows.filter((row) => row.executable).length;
const report = {
  dataset_id: holdout.dataset_id,
  training_dataset_id: corpus.dataset_id,
  cases: rows.length,
  intent_cases: intentRows.length,
  intent_type_recall: correctIntent / intentRows.length,
  unsafe_execution_count: unsafeExecutions,
  safety_cases: safetyRows.length,
  model: embeddings.model,
  dimension: embeddings.dimension,
  results: rows,
};

console.log(JSON.stringify(report, null, 2));
if (report.intent_type_recall < 0.80 || report.unsafe_execution_count !== 0)
  process.exitCode = 1;
