// T13 automatic integration gate.
// This is a Node pipeline test, not an automated browser E2E test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildProfile } from "../js/profile.js";
import { computeNetExposure } from "../js/exposure.js";
import {
  bucketNotionalKrw,
  computeCFaRBuckets,
  liquidityTimeline,
  portfolioCFaR,
} from "../js/risk.js";
import { compareStrategies } from "../js/strategy.js";
import { simulateScenarios } from "../js/scenario.js";
import { recommend } from "../js/reasoner.js";
import { createRag } from "../js/rag.js";
import { buildBrief } from "../js/brief.js";
import { createProvider } from "../js/llm-provider.js";
import { buildAnalysisPayload } from "../js/privacy.js";

const load = async (path) =>
  JSON.parse(await readFile(new URL(`../${path}`, import.meta.url), "utf8"));

const [
  samplesData,
  market,
  countryCatalog,
  graph,
  rules,
  sourceRegistry,
  schema,
  productDocs,
  embeddings,
] = await Promise.all([
  load("data/samples.json"),
  load("test/fixtures/golden-market.json"),
  load("data/country-catalog.json"),
  load("data/knowledge-graph.json"),
  load("data/eligibility-rules.json"),
  load("data/source-registry.json"),
  load("data/ontology-schema.json"),
  load("data/product-docs.json"),
  load("data/product-embeddings.json"),
]);

const sampleA = samplesData.samples.find((sample) => sample.id === "a");
const FIXED_NOW = new Date(2026, 6, 26, 12, 0, 0);

function buildCorePipeline() {
  const profile = buildProfile({
    cashflows: sampleA.cashflows,
    rates: market.rates,
    company: {
      companyType: "corporation",
      isSme: true,
      riskAppetite: "low",
      existingHedges: [],
      requestedPurposes: ["fx_hedge", "working_capital", "guarantee_insurance"],
    },
  });
  Object.assign(profile.facts.company, {
    companyScale: "sme",
    creditGradeMeetsThreshold: true,
    priorYearExportUsd: 1_000_000,
    reviewChannelConfirmed: true,
  });

  const buckets = computeCFaRBuckets(
    profile.transactions,
    market.rates,
    market.annual_vol,
  );
  const cfar = portfolioCFaR(buckets);
  const notionalKrw = bucketNotionalKrw(buckets);
  const liquidity = liquidityTimeline(profile.transactions, market.rates, {
    openingBalanceKrw: 100_000_000,
    creditLineKrw: 60_000_000,
  });
  const strategies = compareStrategies(cfar.total, notionalKrw);
  const netRows = computeNetExposure(profile.transactions);
  const scenarios = simulateScenarios(netRows, market.rates);
  const recommendation = recommend({
    profile,
    graph,
    rules,
    sources: sourceRegistry.sources,
    schema,
    today: "2026-07-26",
  });
  const countries = [...new Set(profile.transactions.map((item) => item.country))]
    .map((country) => countryCatalog.countries[country])
    .filter(Boolean);
  const brief = buildBrief({
    cashflows: profile.transactions,
    netRows,
    scenarios,
    countries,
    selectedProducts: recommendation.candidates,
    asOf: market.as_of,
    now: FIXED_NOW,
  });

  return {
    profile,
    buckets,
    cfar,
    notionalKrw,
    liquidity,
    strategies,
    netRows,
    scenarios,
    recommendation,
    brief,
  };
}

async function retrieveCandidateEvidence(recommendation) {
  const rag = createRag({
    docs: productDocs,
    embeddings,
    sources: sourceRegistry.sources,
    extractorFactory: () => {
      throw new Error("offline integration fixture");
    },
  });
  const evidence = {};
  for (const candidate of recommendation.candidates) {
    const product = productDocs.products.find(
      (item) => item.product_id === candidate.product_id,
    );
    const ruleIds = candidate.passedRules.map((rule) => rule.rule_id);
    const syntheticChunk = product.chunks.find(
      (chunk) =>
        chunk.evidence_class === "public_synthetic"
        && chunk.supported_rule_ids.some((ruleId) => ruleIds.includes(ruleId)),
    );
    evidence[candidate.product_id] = await rag.evidenceForCandidate({
      product_id: candidate.product_id,
      rule_ids: ruleIds,
      query: syntheticChunk.text,
    });
  }
  return { state: rag.state(), evidence };
}

test("T13 integration: sample A completes input → risk → strategy → recommendation → evidence → brief", async () => {
  const output = buildCorePipeline();

  assert.equal(Math.round(output.cfar.total), 45_066_367);
  assert.equal(output.cfar.method, "conservative_sum");
  assert.equal(output.notionalKrw, 674_384_000);
  assert.deepEqual(
    output.strategies.map((strategy) => strategy.key),
    ["안정형", "균형형", "기회추구형"],
  );
  assert.ok(
    output.strategies[0].residualCFaR
      < output.strategies[1].residualCFaR,
  );
  assert.ok(
    output.strategies[1].residualCFaR
      < output.strategies[2].residualCFaR,
  );
  assert.deepEqual(
    output.recommendation.candidates.map((candidate) => candidate.product_id),
    ["fx_insurance", "trade_loan", "ecg_pre"],
  );

  const retrieved = await retrieveCandidateEvidence(output.recommendation);
  assert.equal(retrieved.state, "failed");
  for (const candidate of output.recommendation.candidates) {
    assert.ok(candidate.reasoningPath.length > 0, candidate.product_id);
    assert.ok(candidate.eligibilityEvidence.length > 0, candidate.product_id);
    assert.match(candidate.source.url, /^https:\/\//);
    assert.ok(retrieved.evidence[candidate.product_id]?.length > 0);
    assert.ok(
      retrieved.evidence[candidate.product_id].every(
        (item) =>
          item.product_id === candidate.product_id
          && item.mode === "keyword"
          && item.source.product_id === candidate.product_id,
      ),
    );
  }
  assert.match(output.brief.html, /초안 · 제출본 아님/);
  for (const candidate of output.recommendation.candidates)
    assert.ok(output.brief.html.includes(candidate.name), candidate.name);
});

test("T13 integration: missing eligibility facts never become eligible", () => {
  const output = buildCorePipeline();
  delete output.profile.facts.company.creditGradeMeetsThreshold;
  delete output.profile.facts.company.priorYearExportUsd;
  delete output.profile.facts.company.reviewChannelConfirmed;

  const result = recommend({
    profile: output.profile,
    graph,
    rules,
    sources: sourceRegistry.sources,
    schema,
    today: "2026-07-26",
  });
  assert.ok(!result.candidates.some((candidate) => candidate.product_id === "trade_loan"));
  const pending = result.pending.find((candidate) => candidate.product_id === "trade_loan");
  assert.ok(pending);
  assert.ok(pending.missingFacts.length >= 3);
  assert.ok(pending.questions.length >= 3);
});

test("T13 integration: RAG/LLM failure cannot mutate calculation or eligibility", async () => {
  const output = buildCorePipeline();
  const before = JSON.stringify({
    cfar: output.cfar,
    strategies: output.strategies,
    recommendation: output.recommendation,
  });

  const retrieved = await retrieveCandidateEvidence(output.recommendation);
  assert.ok(Object.values(retrieved.evidence).every((items) => items?.length > 0));

  const provider = createProvider("external", {
    approved: true,
    fetchImpl: async () => {
      throw new Error("proxy unavailable");
    },
  });
  const explanation = await provider.complete({
    purpose: "product_explanation",
    analysisPayload: buildAnalysisPayload({
      cfarTotal: output.cfar.total,
      strategies: output.strategies,
      products: output.recommendation.candidates,
    }),
  });
  assert.equal(explanation, null);
  assert.equal(
    JSON.stringify({
      cfar: output.cfar,
      strategies: output.strategies,
      recommendation: output.recommendation,
    }),
    before,
  );
});

test("T13 integration: fixed input produces byte-identical deterministic output", async () => {
  const first = buildCorePipeline();
  const second = buildCorePipeline();
  const firstEvidence = await retrieveCandidateEvidence(first.recommendation);
  const secondEvidence = await retrieveCandidateEvidence(second.recommendation);
  assert.equal(
    JSON.stringify({ core: first, evidence: firstEvidence }),
    JSON.stringify({ core: second, evidence: secondEvidence }),
  );
});

test("T13 documentation separates automated Node gates from manual browser checks", async () => {
  const runbook = await readFile(
    new URL("../docs/RUNBOOK.md", import.meta.url),
    "utf8",
  );
  for (const phrase of [
    "자동(Node) 통합 게이트",
    "수동 브라우저 검증 체크리스트",
    "자동 Playwright E2E가 아닙니다",
    "CSV",
    "공식 근거",
    "RAG",
    "근거 없음",
    "상담 브리프",
    "콘솔 오류 0",
  ]) assert.ok(runbook.includes(phrase), phrase);
});
