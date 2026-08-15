import { pipeline } from "@xenova/transformers";
import { readFile, writeFile } from "node:fs/promises";
import { normalizeText, textHash } from "../js/text-hash.js";

const MODEL = "Xenova/multilingual-e5-small";
const { products } = JSON.parse(await readFile(new URL("../data/product-docs.json", import.meta.url), "utf8"));
const extractor = await pipeline("feature-extraction", MODEL);
const vectors = {};
let dimension = 0;
for (const p of products) {
  for (const c of p.chunks) {
    const currentHash = await textHash(c.text);
    if (c.text_hash !== currentHash) {
      throw new Error(`stale chunk text_hash: ${c.chunk_id}`);
    }
    const out = await extractor(`passage: ${normalizeText(c.text)}`, { pooling: "mean", normalize: true });
    const vec = Array.from(out.data);
    dimension = vec.length;
    vectors[c.chunk_id] = {
      vector: vec.map((x) => Number(x.toFixed(6))),
      text_hash: currentHash,
    };
  }
}
await writeFile(
  new URL("../data/product-embeddings.json", import.meta.url),
  `${JSON.stringify({ model: MODEL, dimension, vectors })}\n`,
);
console.log(`wrote ${Object.keys(vectors).length} vectors (dimension ${dimension})`);
