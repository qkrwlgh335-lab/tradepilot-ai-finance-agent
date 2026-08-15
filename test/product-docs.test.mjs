import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const load = async (p) => JSON.parse(await readFile(new URL(`../${p}`, import.meta.url), "utf8"));

test("product-docs is retrieval-only and carries no legacy recommendation/scoring facts", async () => {
  const { products } = await load("data/product-docs.json");
  assert.ok(products.length >= 6);
  for (const p of products) {
    assert.ok(p.product_id && p.name && p.category);
    for (const legacyField of [
      "eligibility", "cost", "hedge_effectiveness", "liquidity_score",
      "early_termination", "documents", "effective_from", "effective_to",
      "source", "source_url",
    ]) assert.equal(legacyField in p, false, `${p.product_id}.${legacyField}`);
    assert.ok(Array.isArray(p.chunks) && p.chunks.length >= 1);
    for (const c of p.chunks) assert.ok(c.chunk_id && c.text);
  }
});

test("chunk ids are unique across the whole KB", async () => {
  const { products } = await load("data/product-docs.json");
  const ids = products.flatMap((p) => p.chunks.map((c) => c.chunk_id));
  assert.equal(new Set(ids).size, ids.length);
});
