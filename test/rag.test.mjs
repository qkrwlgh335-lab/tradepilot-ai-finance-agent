import { test } from "node:test";
import assert from "node:assert/strict";
import { cosineSim, cosineTopK, keywordScore, keywordTopK } from "../js/rag.js";

test("cosineSim of identical vectors is 1, orthogonal is 0", () => {
  assert.ok(Math.abs(cosineSim([1, 0], [1, 0]) - 1) < 1e-9);
  assert.ok(Math.abs(cosineSim([1, 0], [0, 1])) < 1e-9);
});

test("cosineTopK ranks by similarity", () => {
  const vectors = { a: [1, 0], b: [0.9, 0.1], c: [0, 1] };
  const top = cosineTopK([1, 0], vectors, 2);
  assert.deepEqual(top.map((x) => x.id), ["a", "b"]);
});

test("keyword search finds the chunk sharing terms", () => {
  const chunks = [
    { chunk_id: "x", text: "선물환은 환율을 확정한다" },
    { chunk_id: "y", text: "무역금융대출은 운전자금을 지원한다" },
  ];
  const top = keywordTopK("환율 선물환", chunks, 1);
  assert.equal(top[0].id, "x");
  assert.ok(keywordScore("환율 선물환", chunks[0].text) > 0);
});
