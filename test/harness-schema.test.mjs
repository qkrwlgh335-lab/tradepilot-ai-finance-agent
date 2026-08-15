// HARNESS: shared-schema validation across every data file + cross-references.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { textHash } from "../js/text-hash.js";
import { createSourceRegistry } from "../js/sources.js";

const load = async (p) => JSON.parse(await readFile(new URL(`../${p}`, import.meta.url), "utf8"));

test("fx.json: rates are positive numbers, has as_of + note", async () => {
  const fx = await load("data/fx.json");
  assert.ok(fx.as_of && fx.note);
  for (const [c, r] of Object.entries(fx.rates)) assert.ok(typeof r === "number" && r > 0, `${c} rate`);
});

test("fx-vol.json: annual_vol are numbers in (0,1]", async () => {
  const v = await load("data/fx-vol.json");
  for (const [c, s] of Object.entries(v.annual_vol)) assert.ok(s > 0 && s <= 1, `${c} vol`);
});

test("country-catalog.json: each country has only selection and currency-support fields", async () => {
  const catalog = await load("data/country-catalog.json");
  for (const [iso, c] of Object.entries(catalog.countries)) {
    for (const f of ["name", "currency", "notes", "currency_coverage"])
      assert.ok(c[f], `${iso}.${f}`);
    assert.deepEqual(Object.keys(c).sort(), ["currency", "currency_coverage", "name", "notes"]);
  }
});

test("product-docs.json: chunk ids are unique and public synthetic evidence is governed", async () => {
  const { products } = await load("data/product-docs.json");
  const { sources } = await load("data/source-registry.json");
  const { rules } = await load("data/eligibility-rules.json");
  const registry = createSourceRegistry(sources);
  const ruleById = new Map(rules.map((rule) => [rule.rule_id, rule]));
  const ids = [];
  for (const p of products) {
    assert.ok(p.product_id && p.name && p.category);
    for (const c of p.chunks) {
      ids.push(c.chunk_id);
      assert.equal(c.product_id, p.product_id, `${c.chunk_id} product scope`);
      assert.match(c.text_hash, /^[a-f0-9]{64}$/);
      assert.equal(c.text_hash, await textHash(c.text));
      assert.ok(["unverified_demo", "public_synthetic"].includes(c.evidence_class));
      assert.ok(Array.isArray(c.supported_rule_ids));
      if (c.evidence_class === "unverified_demo") {
        assert.equal(c.source_id, null);
        assert.equal(c.supported_rule_ids.length, 0);
      } else {
        assert.ok(registry.isActive(c.source_id), `${c.chunk_id} source inactive`);
        assert.equal(registry.get(c.source_id).product_id, p.product_id);
        assert.ok(c.supported_rule_ids.length > 0);
        for (const ruleId of c.supported_rule_ids) {
          const rule = ruleById.get(ruleId);
          assert.ok(rule, `${c.chunk_id} unknown rule ${ruleId}`);
          assert.equal(rule.product_id, p.product_id, `${c.chunk_id} cross-product rule`);
          assert.equal(rule.source_id, c.source_id, `${c.chunk_id} rule/source mismatch`);
        }
      }
    }
  }
  assert.equal(new Set(ids).size, ids.length, "chunk ids must be unique");
});

test("CROSS-REF: embedding keys exactly match chunks and carry the current hash", async () => {
  const { products } = await load("data/product-docs.json");
  const emb = await load("data/product-embeddings.json");
  const chunks = products.flatMap((p) => p.chunks);
  const chunkIds = chunks.map((c) => c.chunk_id).sort();
  const keys = Object.keys(emb.vectors).sort();
  assert.deepEqual(keys, chunkIds);
  assert.ok(emb.model && Number.isInteger(emb.dimension) && emb.dimension > 0);
  for (const chunk of chunks) {
    const stamped = emb.vectors[chunk.chunk_id];
    assert.equal(stamped.text_hash, chunk.text_hash, `${chunk.chunk_id} stale`);
    assert.equal(stamped.vector.length, emb.dimension, `${chunk.chunk_id} dimension`);
    assert.ok(stamped.vector.every(Number.isFinite));
  }
});

test("CROSS-REF: every sample cashflow currency exists in fx rates and country in country catalogue", async () => {
  const { samples } = await load("data/samples.json");
  const fx = await load("data/fx.json");
  const catalog = await load("data/country-catalog.json");
  for (const s of samples)
    for (const cf of s.cashflows) {
      assert.ok(fx.rates[cf.currency] != null, `${s.id} currency ${cf.currency}`);
      assert.ok(catalog.countries[cf.country] != null, `${s.id} country ${cf.country}`);
    }
});
