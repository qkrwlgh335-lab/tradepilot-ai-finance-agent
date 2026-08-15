import { pipeline } from "@xenova/transformers";
import { readFile, writeFile } from "node:fs/promises";
import {
  scenarioCorpusHash,
  validateScenarioCorpus,
} from "../js/scenario-semantic.js";
import { normalizeText, textHash } from "../js/text-hash.js";

const MODEL = "Xenova/multilingual-e5-small";
const corpusUrl = new URL("../data/scenario-intent-corpus.json", import.meta.url);
const outputUrl = new URL("../data/scenario-intent-embeddings.json", import.meta.url);
const corpus = JSON.parse(await readFile(corpusUrl, "utf8"));
const checked = validateScenarioCorpus(corpus);
if (!checked.ok) throw new Error(`invalid scenario corpus:\n${checked.errors.join("\n")}`);

const extractor = await pipeline("feature-extraction", MODEL);
const vectors = {};
let dimension = 0;
for (const row of checked.entries) {
  const output = await extractor(
    `passage: ${normalizeText(row.text)}`,
    { pooling: "mean", normalize: true },
  );
  const vector = Array.from(output.data);
  if (!dimension) dimension = vector.length;
  if (vector.length !== dimension || !vector.every(Number.isFinite))
    throw new Error(`invalid vector: ${row.id}`);
  vectors[row.id] = {
    vector: vector.map((value) => Number(value.toFixed(6))),
    text_hash: await textHash(row.text),
    intent_type: row.intent_type,
  };
}

const snapshot = {
  model: MODEL,
  dimension,
  normalized_text_hash: await scenarioCorpusHash(corpus),
  vector_keys: Object.keys(vectors).sort(),
  vectors,
};
await writeFile(outputUrl, `${JSON.stringify(snapshot)}\n`, "utf8");
console.log(`wrote ${snapshot.vector_keys.length} scenario vectors (dimension ${dimension})`);
