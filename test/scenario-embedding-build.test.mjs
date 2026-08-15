import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  validateScenarioEmbeddingSnapshot,
} from "../js/scenario-semantic.js";
import { createSnapshotSource } from "../js/data-source.js";

const load = async (url) => JSON.parse(await readFile(new URL(url, import.meta.url), "utf8"));

test("scenario embedding build uses multilingual E5 passage prefix and stamped output", async () => {
  const script = await readFile(new URL("../scripts/build-scenario-embeddings.mjs", import.meta.url), "utf8");
  assert.match(script, /Xenova\/multilingual-e5-small/);
  assert.match(script, /`passage: \$\{normalizeText\(row\.text\)\}`/);
  assert.match(script, /normalized_text_hash/);
  const corpus = await load("../data/scenario-intent-corpus.json");
  const embeddings = await load("../data/scenario-intent-embeddings.json");
  const checked = await validateScenarioEmbeddingSnapshot(corpus, embeddings);
  assert.equal(checked.ok, true, checked.errors.join("\n"));
});

test("snapshot source exposes the semantic corpus and embeddings", async () => {
  const responses = {
    "scenario-intent-corpus.json": { version: "1", entries: [] },
    "scenario-intent-embeddings.json": { model: "m", dimension: 1, vectors: {} },
  };
  const source = createSnapshotSource(async (url) => {
    const key = Object.keys(responses).find((item) => url.endsWith(item));
    return key
      ? { ok: true, json: async () => responses[key] }
      : { ok: false, json: async () => ({}) };
  });
  assert.equal((await source.getScenarioIntentCorpus()).version, "1");
  assert.equal((await source.getScenarioIntentEmbeddings()).model, "m");
});
