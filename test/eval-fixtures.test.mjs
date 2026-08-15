import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const load = async (path) =>
  JSON.parse(await readFile(new URL(`../${path}`, import.meta.url), "utf8"));

const fixturePaths = [
  "eval/scenario-intent-cases.json",
  "eval/eligibility-cases.json",
  "eval/evidence-cases.json",
  "eval/reproducibility-cases.json",
  "eval/governance-cases.json",
];

const normalize = (value) =>
  String(value).normalize("NFC").replace(/\s+/g, " ").trim();

test("T23 evaluation corpus has at least 30 explicit synthetic cases with notes", async () => {
  const datasets = await Promise.all(fixturePaths.map(load));
  const cases = datasets.flatMap((dataset) => dataset.cases || []);
  assert.ok(cases.length >= 30, `only ${cases.length} cases`);
  const ids = new Set();
  for (const [index, dataset] of datasets.entries()) {
    assert.equal(dataset.synthetic, true, fixturePaths[index]);
    assert.ok(typeof dataset.dataset_id === "string" && dataset.dataset_id);
    assert.ok(Array.isArray(dataset.cases), fixturePaths[index]);
    for (const item of dataset.cases) {
      assert.equal(item.synthetic, true, item.id);
      assert.ok(typeof item.id === "string" && item.id, fixturePaths[index]);
      assert.ok(typeof item.notes === "string" && item.notes.trim(), item.id);
      assert.ok(!ids.has(item.id), `duplicate case id ${item.id}`);
      ids.add(item.id);
    }
  }
});

test("scenario holdout is independent of the training examples after NFC/whitespace normalization", async () => {
  const [training, evaluation] = await Promise.all([
    load("data/scenario-intents.json"),
    load("eval/scenario-intent-cases.json"),
  ]);
  const trainingTexts = new Set(
    training.intents.flatMap((intent) => intent.examples).map(normalize),
  );
  const evalTexts = evaluation.cases.map((item) => normalize(item.text));
  assert.equal(new Set(evalTexts).size, evalTexts.length, "duplicate evaluation utterance");
  for (const text of evalTexts)
    assert.ok(!trainingTexts.has(text), `training/eval duplicate: ${text}`);
});

test("scenario fixtures pin expected routing and include all mandatory safety attacks", async () => {
  const dataset = await load("eval/scenario-intent-cases.json");
  const expected = new Set([
    "payment_delay",
    "receivable_drop",
    "adverse_fx",
    "ask",
    "block",
    "ask_target",
    "not_found",
  ]);
  for (const item of dataset.cases) {
    assert.ok(typeof item.text === "string" && item.text.trim(), item.id);
    assert.ok(expected.has(item.expected), item.id);
  }
  const attacks = new Set(dataset.cases.flatMap((item) => item.adversarial || []));
  for (const kind of [
    "prototype_pollution",
    "out_of_allowlist",
    "other_magnitude",
    "ambiguous_target",
  ]) assert.ok(attacks.has(kind), kind);
});

test("eligibility fixtures pin independent purpose/status constants", async () => {
  const dataset = await load("eval/eligibility-cases.json");
  const statuses = new Set(["candidate", "pending", "excluded", "unavailable"]);
  for (const item of dataset.cases) {
    assert.ok(item.input && typeof item.input === "object", item.id);
    assert.ok(item.expected_by_purpose && typeof item.expected_by_purpose === "object", item.id);
    assert.ok(item.expected_status && typeof item.expected_status === "object", item.id);
    for (const [productId, status] of Object.entries(item.expected_status)) {
      assert.match(productId, /^[a-z][a-z0-9_]*$/, item.id);
      assert.ok(statuses.has(status), `${item.id}:${productId}:${status}`);
    }
    for (const [purpose, groups] of Object.entries(item.expected_by_purpose)) {
      assert.match(purpose, /^[a-z][a-z0-9_]*$/, item.id);
      const seen = new Set();
      for (const status of statuses) {
        assert.ok(Array.isArray(groups[status]), `${item.id}:${purpose}:${status}`);
        for (const productId of groups[status]) {
          assert.equal(item.expected_status[productId], status, `${item.id}:${productId}`);
          assert.ok(!seen.has(productId), `${item.id}: duplicate ${productId}`);
          seen.add(productId);
        }
      }
    }
  }
  const attacks = new Set(dataset.cases.flatMap((item) => item.adversarial || []));
  assert.ok(attacks.has("ineligible_plausible"));
  assert.ok(attacks.has("missing_as_eligible"));
});

test("evidence fixtures pin real chunk/source/rule constants and cross-references", async () => {
  const [dataset, docs, registry] = await Promise.all([
    load("eval/evidence-cases.json"),
    load("data/product-docs.json"),
    load("data/source-registry.json"),
  ]);
  const chunks = new Map(
    docs.products.flatMap((product) => product.chunks)
      .map((chunk) => [chunk.chunk_id, chunk]),
  );
  const sources = new Map(registry.sources.map((source) => [source.source_id, source]));
  for (const item of dataset.cases) {
    for (const field of [
      "query",
      "product_id",
      "rule_id",
      "expected_chunk_id",
      "expected_source_id",
    ]) assert.ok(typeof item[field] === "string" && item[field].trim(), `${item.id}:${field}`);
    const chunk = chunks.get(item.expected_chunk_id);
    assert.ok(chunk, item.id);
    assert.equal(chunk.product_id, item.product_id, item.id);
    assert.equal(chunk.source_id, item.expected_source_id, item.id);
    assert.ok(chunk.supported_rule_ids.includes(item.rule_id), item.id);
    assert.equal(chunk.evidence_class, "public_synthetic", item.id);
    const source = sources.get(item.expected_source_id);
    assert.ok(source, item.id);
    assert.equal(source.product_id, item.product_id, item.id);
    assert.equal(source.verification_status, "verified", item.id);
  }
});

test("reliability and governance fixtures carry executable expected constants", async () => {
  const [reliability, governance] = await Promise.all([
    load("eval/reproducibility-cases.json"),
    load("eval/governance-cases.json"),
  ]);
  for (const item of reliability.cases) {
    assert.ok(typeof item.expected === "object" && item.expected !== null, item.id);
    assert.equal(typeof item.expected.completed, "boolean", item.id);
  }
  for (const item of governance.cases) {
    assert.ok(item.input && typeof item.input === "object", item.id);
    assert.ok(Array.isArray(item.expected_allowed_keys), item.id);
    assert.ok(Array.isArray(item.forbidden_markers), item.id);
  }
  const attacks = new Set(governance.cases.flatMap((item) => item.adversarial || []));
  assert.ok(attacks.has("xss"));
  assert.ok(attacks.has("key_like"));
});
