import { test } from "node:test";
import assert from "node:assert/strict";
import { EVALUATION_SOURCE_FILES } from "../scripts/run-evaluation.mjs";

test("T35 mutable official market caches do not make the code-computed evaluation stale on app startup", () => {
  for (const mutableCache of [
    "data/fx.json",
    "data/fx-vol.json",
    "data/market-sources.json",
    "data/country-indicators.json",
    "data/bilateral-trade.json",
  ]) assert.ok(!EVALUATION_SOURCE_FILES.includes(mutableCache), mutableCache);

  for (const requiredImplementation of [
    "data/eligibility-rules.json",
    "data/knowledge-graph.json",
    "data/ontology-schema.json",
    "data/product-docs.json",
    "data/product-embeddings.json",
    "data/source-registry.json",
    "eval/eligibility-cases.json",
    "js/reasoner.js",
  ]) assert.ok(EVALUATION_SOURCE_FILES.includes(requiredImplementation), requiredImplementation);
});
