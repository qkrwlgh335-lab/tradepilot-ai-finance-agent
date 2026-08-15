import { test } from "node:test";
import assert from "node:assert/strict";
import { createSnapshotSource } from "../js/data-source.js";

function fakeFetch(map) {
  return async (url) => {
    const key = Object.keys(map).find((k) => url.includes(k));
    if (!key) throw new Error("404 " + url);
    return { ok: true, json: async () => map[key] };
  };
}

test("getProducts returns the products array and caches", async () => {
  let calls = 0;
  const f = (url) => { calls++; return fakeFetch({ "products.json": { products: [{ id: "x", match: { when: "is_sme", value: true } }] } })(url); };
  const src = createSnapshotSource(f);
  const a = await src.getProducts();
  const b = await src.getProducts();
  assert.equal(a.length, 1);
  assert.equal(a, b);
  assert.equal(calls, 1);
});

test("getFxRates returns parsed fx object", async () => {
  const src = createSnapshotSource(fakeFetch({ "fx.json": { rates: { USD: 1385.5 } } }));
  const fx = await src.getFxRates();
  assert.equal(fx.rates.USD, 1385.5);
});

test("getSamples returns the samples array", async () => {
  const src = createSnapshotSource(fakeFetch({ "samples.json": { samples: [{ id: "a", cashflows: [] }] } }));
  const s = await src.getSamples();
  assert.equal(s.length, 1);
  assert.equal(s[0].id, "a");
});

test("getProductDocs returns products array", async () => {
  const src = createSnapshotSource(fakeFetch({ "product-docs.json": { products: [{ product_id: "x", chunks: [] }] } }));
  const d = await src.getProductDocs();
  assert.equal(d.products.length, 1);
});
