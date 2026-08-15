import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRag, EVIDENCE_MIN_SCORE } from "../js/rag.js";

const load = async (path) =>
  JSON.parse(await readFile(new URL(`../${path}`, import.meta.url), "utf8"));

const source = {
  source_id: "src:demo-forward",
  product_id: "fwd",
  institution: "TradePilot 공개용 데모",
  document_title: "TradePilot 공개용 합성 규칙 사양",
  url: "https://github.com/qkrwlgh335-lab/tradepilot-ai-finance-agent/blob/main/docs/PUBLIC_DEMO_RULES.md",
  source_kind: "product_terms",
  verification_status: "verified",
  verified_on: "2026-07-24",
  supported_fields: ["company_type", "internet_banking_enrolled"],
  page_or_section: "이용대상·선물환",
};

const fixtureDocs = {
  products: [
    {
      product_id: "fwd",
      name: "선물환",
      chunks: [
        {
          chunk_id: "fwd-synthetic",
          product_id: "fwd",
          text: "선물환은 인터넷뱅킹에 가입한 법인 또는 개인사업자가 이용할 수 있습니다.",
          source_id: "src:demo-forward",
          supported_rule_ids: ["rule:fwd-internet-banking-required", "rule:fwd-company-type"],
          evidence_class: "public_synthetic",
          text_hash: "hash-fwd",
        },
        {
          chunk_id: "fwd-demo",
          product_id: "fwd",
          text: "인터넷뱅킹 가입 없이도 언제나 선물환을 이용할 수 있다는 데모 문장",
          source_id: null,
          supported_rule_ids: ["rule:fwd-internet-banking-required"],
          evidence_class: "unverified_demo",
          text_hash: "hash-demo",
        },
      ],
    },
    {
      product_id: "other",
      name: "다른 상품",
      chunks: [
        {
          chunk_id: "other-synthetic",
          product_id: "other",
          text: "인터넷뱅킹 가입 조건",
          source_id: "src:demo-forward",
          supported_rule_ids: ["rule:fwd-internet-banking-required"],
          evidence_class: "public_synthetic",
          text_hash: "hash-other",
        },
      ],
    },
  ],
};

const keywordOnly = () => {
  throw new Error("offline");
};

test("evidence stays inside the candidate and chunk/request rule intersection", async () => {
  const rag = createRag({
    docs: fixtureDocs,
    embeddings: { model: "test", dimension: 2, vectors: {} },
    sources: [source],
    extractorFactory: keywordOnly,
  });
  const evidence = await rag.evidenceForCandidate({
    product_id: "fwd",
    rule_ids: ["rule:fwd-internet-banking-required", "rule:not-in-chunk"],
    query: "인터넷뱅킹 가입 선물환",
    minScore: 0,
  });

  assert.ok(evidence?.length);
  assert.ok(evidence.every((item) => item.product_id === "fwd"));
  assert.deepEqual(
    [...new Set(evidence.map((item) => item.rule_id))],
    ["rule:fwd-internet-banking-required"],
  );
});

test("unrelated rules, demo-only chunks, and cross-product sources never become evidence", async () => {
  const rag = createRag({
    docs: fixtureDocs,
    embeddings: { model: "test", dimension: 2, vectors: {} },
    sources: [source],
    extractorFactory: keywordOnly,
  });
  assert.equal(await rag.evidenceForCandidate({
    product_id: "fwd",
    rule_ids: ["rule:unrelated"],
    query: "인터넷뱅킹",
    minScore: 0,
  }), null);
  assert.equal(await rag.evidenceForCandidate({
    product_id: "other",
    rule_ids: ["rule:fwd-internet-banking-required"],
    query: "인터넷뱅킹",
    minScore: 0,
  }), null);
});

test("below-threshold search returns null instead of a forced representative chunk", async () => {
  const rag = createRag({
    docs: fixtureDocs,
    embeddings: { model: "test", dimension: 2, vectors: {} },
    sources: [source],
    extractorFactory: keywordOnly,
  });
  assert.equal(await rag.evidenceForCandidate({
    product_id: "fwd",
    rule_ids: ["rule:fwd-company-type"],
    query: "은하 천체 관측",
    minScore: EVIDENCE_MIN_SCORE,
  }), null);
});

test("semantic query uses the E5 query prefix", async () => {
  const calls = [];
  const extractor = async (input) => {
    calls.push(input);
    return { data: [1, 0] };
  };
  const semanticDocs = {
    products: [{
      product_id: "fwd",
      name: "선물환",
      chunks: [fixtureDocs.products[0].chunks[0]],
    }],
  };
  const rag = createRag({
    docs: semanticDocs,
    embeddings: {
      model: "test-e5",
      dimension: 2,
      vectors: {
        "fwd-synthetic": { vector: [1, 0], text_hash: "hash-fwd" },
      },
    },
    sources: [source],
    extractorFactory: async () => extractor,
  });
  const evidence = await rag.evidenceForCandidate({
    product_id: "fwd",
    rule_ids: ["rule:fwd-internet-banking-required"],
    query: "인터넷뱅킹",
    minScore: 0,
  });

  assert.equal(calls[0], "query: 인터넷뱅킹");
  assert.equal(evidence[0].mode, "semantic");
});

test("stale vectors fall back without widening candidate scope", async () => {
  const calls = [];
  const extractor = async (input) => {
    calls.push(input);
    return { data: [1, 0] };
  };
  const embeddings = {
    model: "test-e5",
    dimension: 2,
    vectors: {
      "fwd-synthetic": { vector: [1, 0], text_hash: "stale" },
      "fwd-demo": { vector: [0, 1], text_hash: "hash-demo" },
      "other-synthetic": { vector: [1, 0], text_hash: "hash-other" },
    },
  };
  const rag = createRag({
    docs: fixtureDocs,
    embeddings,
    sources: [source],
    extractorFactory: async () => extractor,
  });
  const evidence = await rag.evidenceForCandidate({
    product_id: "fwd",
    rule_ids: ["rule:fwd-internet-banking-required"],
    query: "인터넷뱅킹",
    minScore: 0,
  });

  assert.ok(evidence?.every((item) => item.product_id === "fwd"));
  assert.equal(calls.length, 0, "stale embeddings must not be queried");
  assert.equal(evidence[0].mode, "keyword");
});

test("build and query code use E5 prefixes and stamped embedding format", async () => {
  const [build, ragSource] = await Promise.all([
    readFile(new URL("../scripts/build-embeddings.mjs", import.meta.url), "utf8"),
    readFile(new URL("../js/rag.js", import.meta.url), "utf8"),
  ]);
  assert.match(build, /passage:\s/);
  assert.match(ragSource, /query:\s/);

  const [docs, embeddings] = await Promise.all([
    load("data/product-docs.json"),
    load("data/product-embeddings.json"),
  ]);
  const chunks = docs.products.flatMap((product) => product.chunks);
  assert.ok(embeddings.model && Number.isInteger(embeddings.dimension));
  assert.deepEqual(
    Object.keys(embeddings.vectors).sort(),
    chunks.map((chunk) => chunk.chunk_id).sort(),
  );
  for (const chunk of chunks) {
    assert.match(chunk.text_hash, /^[a-f0-9]{64}$/);
    assert.equal(embeddings.vectors[chunk.chunk_id].text_hash, chunk.text_hash);
    assert.equal(embeddings.vectors[chunk.chunk_id].vector.length, embeddings.dimension);
  }
});

test("reasoner never imports or calls RAG", async () => {
  const sourceText = await readFile(new URL("../js/reasoner.js", import.meta.url), "utf8");
  assert.doesNotMatch(sourceText, /from\s+["'][^"']*rag\.js|evidenceForCandidate|createRag/);
});
