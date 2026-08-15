// HARNESS: evaluation metrics — spec §14 success criteria as executable checks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { compareStrategies } from "../js/strategy.js";
import { ruleCounterExamples } from "../js/counter.js";
import { createRag } from "../js/rag.js";
import { explainCounterExamples, NON_ADVICE } from "../js/agent.js";
import { createProvider } from "../js/llm-provider.js";

const load = async (p) => JSON.parse(await readFile(new URL(`../${p}`, import.meta.url), "utf8"));

test("EVAL: AI proposes exactly three strategies (안정형/균형형/기회추구형)", () => {
  const s = compareStrategies(1000000, 277100000);
  assert.equal(s.length, 3);
  assert.deepEqual(s.map((x) => x.key), ["안정형", "균형형", "기회추구형"]);
});

test("EVAL: five self counter-examples are produced with NO LLM/key", () => {
  const c = ruleCounterExamples([
    { key: "안정형", hedgeRatio: 0.9 },
    { key: "균형형", hedgeRatio: 0.6 },
    { key: "기회추구형", hedgeRatio: 0.3 },
  ]);
  assert.equal(c.length, 5);
  assert.ok(c.every((x) => x.q && x.a));
});

test("EVAL: RAG returns evidence + source with keyword floor (no network)", async () => {
  const docs = await load("data/product-docs.json");
  const embeddings = await load("data/product-embeddings.json");
  const sourceRegistry = await load("data/source-registry.json");
  const product = docs.products.find((item) => item.product_id === "fx_insurance");
  const chunk = product.chunks.find((item) => item.chunk_id === "fxins-synthetic-scope");
  const rag = createRag({
    docs,
    embeddings,
    sources: sourceRegistry.sources,
    extractorFactory: () => { throw new Error("offline"); },
  });
  const results = await rag.evidenceForCandidate({
    product_id: "fx_insurance",
    rule_ids: ["rule:fx_insurance-trade-scope"],
    query: chunk.text,
  });
  assert.ok(results.length >= 1);
  for (const r of results) {
    assert.ok(r.matchedText, "evidence text present");
    assert.match(r.source.url, /^https:\/\//);
    assert.equal(r.product_id, "fx_insurance");
    assert.equal(r.rule_id, "rule:fx_insurance-trade-scope");
  }
  // The injected offline loader makes this a deterministic keyword fallback.
  assert.equal(results[0].mode, "keyword");
});

test("EVAL: explanation degrades to rule fallback with no key or proxy", async () => {
  const strategies = compareStrategies(1_000_000, 277_100_000);
  const out = await explainCounterExamples(
    { strategies, counters: ruleCounterExamples(strategies) },
    { provider: createProvider("off") },
  );
  assert.match(out, /안정형|환율/);
  assert.ok(out.includes(NON_ADVICE));
});
