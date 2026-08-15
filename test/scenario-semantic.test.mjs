import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  validateScenarioCorpus,
  scenarioCorpusHash,
  classifyKeywordIntent,
  validateScenarioEmbeddingSnapshot,
  createScenarioSemanticClassifier,
  interpretScenarioIntent,
} from "../js/scenario-semantic.js";
import { buildPresetPlan } from "../js/scenario-preset.js";
import { validatePlan } from "../js/scenario-plan.js";
import { textHash } from "../js/text-hash.js";

const load = async (url) => JSON.parse(await readFile(new URL(url, import.meta.url), "utf8"));
const corpus = await load("../data/scenario-intent-corpus.json");
const holdout = await load("../eval/scenario-intent-holdout.json");
const intents = await load("../data/scenario-intents.json");
const transactions = [
  { transaction_id: "tx-1", direction: "in", currency: "USD", amount: 200000, months: 3, country: "US" },
  { transaction_id: "tx-2", direction: "in", currency: "USD", amount: 100000, months: 3, country: "VN" },
  { transaction_id: "tx-3", direction: "out", currency: "USD", amount: 100000, months: 2, country: "US" },
];
const context = { transactions, intents };

test("synthetic corpus is explicit, unique, customer-data-free and covers all intents", () => {
  const checked = validateScenarioCorpus(corpus);
  assert.equal(checked.ok, true, checked.errors.join("\n"));
  assert.equal(corpus.synthetic, true);
  assert.equal(corpus.contains_real_customer_data, false);
  assert.equal(corpus.generator_type, "external_ai_assisted");
  assert.equal(new Set(corpus.entries.map((row) => row.id)).size, corpus.entries.length);
  for (const type of ["payment_delay", "receivable_drop", "adverse_fx"])
    assert.ok(corpus.entries.filter((row) => row.intent_type === type).length >= 10, type);
});

test("holdout has no normalized exact duplicate of a training utterance", () => {
  const normalized = (text) => String(text).normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
  const training = new Set(corpus.entries.map((row) => normalized(row.text)));
  for (const row of holdout.cases)
    assert.equal(training.has(normalized(row.text)), false, row.id);
});

test("keyword classifier recognizes high-signal unseen paraphrases and asks on unrelated text", () => {
  for (const [text, expected] of [
    ["바이어 대금 회수가 자꾸 뒤로 가면?", "payment_delay"],
    ["해외 판매가 꺾이면 자금이 얼마나 부족해져?", "receivable_drop"],
    ["외환시장이 흔들려 우리에게 손해가 나는 경우", "adverse_fx"],
  ]) {
    const out = classifyKeywordIntent(text, corpus);
    assert.equal(out.status, "matched", `${text}: ${JSON.stringify(out)}`);
    assert.equal(out.type, expected, text);
  }
  assert.notEqual(classifyKeywordIntent("새 공장을 지어도 될까?", corpus).status, "matched");
});

test("embedding snapshot contract rejects stale hashes, missing keys and wrong dimensions", async () => {
  const rows = corpus.entries.slice(0, 2);
  const vectors = {};
  for (const row of rows)
    vectors[row.id] = { vector: [1, 0], text_hash: await textHash(row.text), intent_type: row.intent_type };
  const miniCorpus = { ...corpus, entries: rows };
  const ok = {
    model: "test-model",
    dimension: 2,
    normalized_text_hash: await scenarioCorpusHash(miniCorpus),
    vector_keys: rows.map((row) => row.id).sort(),
    vectors,
  };
  assert.equal((await validateScenarioEmbeddingSnapshot(miniCorpus, ok)).ok, true);
  assert.equal((await validateScenarioEmbeddingSnapshot({ ...corpus, entries: rows }, {
    ...ok,
    vectors: { ...vectors, [rows[0].id]: { ...vectors[rows[0].id], text_hash: "0".repeat(64) } },
  })).ok, false);
  assert.equal((await validateScenarioEmbeddingSnapshot(miniCorpus, {
    ...ok,
    normalized_text_hash: "0".repeat(64),
  })).ok, false);
  assert.equal((await validateScenarioEmbeddingSnapshot({ ...corpus, entries: rows }, {
    ...ok,
    vector_keys: [rows[0].id],
  })).ok, false);
  assert.equal((await validateScenarioEmbeddingSnapshot({ ...corpus, entries: rows }, {
    ...ok,
    vectors: { ...vectors, [rows[0].id]: { ...vectors[rows[0].id], vector: [1] } },
  })).ok, false);
});

test("semantic classifier uses E5 prefixes and falls back to keywords when the model fails", async () => {
  const rows = corpus.entries.slice(0, 3);
  const vectors = {};
  for (const [index, row] of rows.entries())
    vectors[row.id] = { vector: index === 0 ? [1, 0] : [0, 1], text_hash: await textHash(row.text), intent_type: row.intent_type };
  const miniCorpus = { ...corpus, entries: rows };
  const snapshot = {
    model: "test-model",
    dimension: 2,
    normalized_text_hash: await scenarioCorpusHash(miniCorpus),
    vector_keys: rows.map((row) => row.id).sort(),
    vectors,
  };
  const calls = [];
  const semantic = createScenarioSemanticClassifier({
    corpus: miniCorpus,
    embeddings: snapshot,
    extractorFactory: async () => async (value) => {
      calls.push(value);
      return { data: [1, 0] };
    },
    minScore: 0.5,
    minMargin: 0,
  });
  const matched = await semantic.classify("대금 회수가 미뤄지면");
  assert.equal(matched.type, "payment_delay");
  assert.equal(matched.mode, "hybrid");
  assert.match(calls[0], /^query: /);

  const fallback = createScenarioSemanticClassifier({
    corpus,
    embeddings: snapshot,
    extractorFactory: async () => { throw new Error("offline"); },
  });
  const keyword = await fallback.classify("해외 판매가 위축되면?");
  assert.equal(keyword.type, "receivable_drop");
  assert.equal(keyword.mode, "keyword");
});

test("hybrid routing cannot override magnitude, negation or target ambiguity and still passes the T17 gate", async () => {
  const classifier = {
    classify: async () => ({ status: "matched", type: "receivable_drop", confidence: 0.99, mode: "test-semantic" }),
  };
  for (const text of ["수출 매출이 반감되면?", "환율이 불리하지 않으면?"]) {
    const out = await interpretScenarioIntent(text, context, classifier);
    assert.equal(out.intent.steps.length, 0, text);
    assert.equal(out.mode, "rules", text);
    assert.equal(validatePlan(buildPresetPlan(out.intent), { transactions }).ok, false, text);
  }

  const ambiguousClassifier = {
    classify: async () => ({ status: "matched", type: "payment_delay", confidence: 0.95, mode: "test-semantic" }),
  };
  const ambiguous = await interpretScenarioIntent("USD 받을 돈 회수가 미뤄지면?", context, ambiguousClassifier);
  const gate = validatePlan(buildPresetPlan(ambiguous.intent), { transactions });
  assert.equal(gate.ok, false);
  assert.ok(gate.missingFacts.length >= 1);

  const semantic = await interpretScenarioIntent("해외 판매가 위축되면?", context, classifier);
  const semanticGate = validatePlan(buildPresetPlan(semantic.intent), { transactions });
  assert.equal(semanticGate.ok, true);
  assert.equal(semanticGate.execution.scenarioId, "revenue_drop_30");
  assert.equal(semantic.intent.steps[0].params, undefined);
});

test("low confidence creates a question and never creates an executable plan", async () => {
  const classifier = { classify: async () => ({ status: "low_confidence", type: null, confidence: 0.3, mode: "keyword" }) };
  const out = await interpretScenarioIntent("새 공장을 지어도 될까?", context, classifier);
  assert.equal(out.intent.steps.length, 0);
  assert.equal(out.intent.missingFacts.length, 1);
  assert.equal(validatePlan(buildPresetPlan(out.intent), { transactions }).ok, false);
});

test("known T17 magnitude false positives/negatives are closed without growing a sentence denylist", async () => {
  const classifier = { classify: async () => ({ status: "matched", type: "payment_delay", confidence: 0.99, mode: "test-semantic" }) };
  const ship = await interpretScenarioIntent("배 운송 지연으로 미국 거래처 입금이 늦으면?", context, classifier);
  assert.equal(validatePlan(buildPresetPlan(ship.intent), { transactions }).ok, true);
  for (const text of ["수출 매출이 갑절로 감소하면?", "수출 매출이 반감되면?"]) {
    const out = await interpretScenarioIntent(text, context, classifier);
    assert.equal(out.intent.steps.length, 0, text);
    assert.equal(validatePlan(buildPresetPlan(out.intent), { transactions }).ok, false, text);
  }
});
