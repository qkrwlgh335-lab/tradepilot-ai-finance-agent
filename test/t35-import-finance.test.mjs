import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildProfile } from "../js/profile.js";
import { createSourceRegistry } from "../js/sources.js";
import { recommend, validateProductKnowledge } from "../js/reasoner.js";
import { createRag } from "../js/rag.js";
import { renderRecommendationPanels } from "../js/ui.js";

const load = async (path) => JSON.parse(await readFile(new URL(`../${path}`, import.meta.url), "utf8"));
const [GRAPH, RULES, SOURCES, SCHEMA, DOCS, EMBEDDINGS] = await Promise.all([
  load("data/knowledge-graph.json"),
  load("data/eligibility-rules.json"),
  load("data/source-registry.json"),
  load("data/ontology-schema.json"),
  load("data/product-docs.json"),
  load("data/product-embeddings.json"),
]);

const SOURCE_ID = "src:demo-import-support";
const REQUIRED_RULES = [
  "rule:import_lc-requires-import",
  "rule:import_lc-scale",
  "rule:import_lc-manufacturer",
  "rule:import_lc-supported-industry",
  "rule:import_lc-partner-guarantee",
  "rule:import_lc-credit-grade",
  "rule:import_lc-review-channel",
  "rule:import_lc-effective",
];

function importProfile({ importTrade = true, complete = false } = {}) {
  const profile = buildProfile({
    cashflows: [{
      transaction_id: "txn-import-1",
      country: "JP",
      currency: "JPY",
      tradeType: importTrade ? "import" : "export",
      direction: importTrade ? "out" : "in",
      amount: 30_000_000,
      months: 2,
    }],
    rates: { JPY: 9.4 },
    company: {
      companyType: "corporation",
      isSme: true,
      companyScale: "sme",
      riskAppetite: "medium",
      existingHedges: [],
      requestedPurposes: ["working_capital"],
      ...(complete ? {
        isManufacturer: true,
        supplyChainProgramEligible: true,
        partnerGuaranteeConfirmed: true,
        creditGradeMeetsThreshold: true,
        reviewChannelConfirmed: true,
      } : {}),
    },
  });
  return profile;
}

const recommendation = (profile) => recommend({
  profile,
  graph: GRAPH,
  rules: RULES,
  sources: SOURCES.sources,
  schema: SCHEMA,
  today: "2026-08-02",
});

test("T35 registers one active product-scoped synthetic source for the import support program", () => {
  const registry = createSourceRegistry(SOURCES.sources);
  const source = registry.get(SOURCE_ID);
  assert.ok(source);
  assert.equal(registry.isActive(SOURCE_ID), true);
  assert.equal(source.product_id, "import_lc");
  assert.equal(source.url, "https://github.com/qkrwlgh335-lab/tradepilot-ai-finance-agent/blob/main/docs/PUBLIC_DEMO_RULES.md#import_lc");
  for (const field of [
    "eligibility.requires_import",
    "eligibility.company_scale",
    "eligibility.manufacturer",
    "eligibility.demo_supply_chain_scope",
    "eligibility.partner_guarantee",
    "eligibility.credit_grade",
    "eligibility.review_channel_confirmation",
    "product.effective_window",
  ]) assert.equal(registry.canSupport(SOURCE_ID, "import_lc", field), true, field);
});

test("T35 scopes import_lc to the public synthetic program instead of a real product", () => {
  const product = GRAPH.nodes.find((node) => node.product_id === "import_lc");
  assert.equal(product.productKnowledgeStatus, "available");
  assert.match(product.name, /합성/);
  assert.match(product.scope_note, /데모 지정 공급망 업종/);
  assert.match(product.scope_note, /실제 금융상품 조건이 아닙니다/);

  const edges = GRAPH.edges.filter((edge) => edge.from === "prod:import_lc");
  assert.deepEqual(
    edges.filter((edge) => edge.rel === "requires").map((edge) => edge.to).sort(),
    [...REQUIRED_RULES].sort(),
  );
  assert.deepEqual(
    edges.filter((edge) => edge.rel === "supportedBy").map((edge) => edge.to),
    [SOURCE_ID],
  );
});

test("T35 import eligibility rules are complete, source-backed and data-driven", () => {
  const rules = RULES.rules.filter((rule) => rule.product_id === "import_lc");
  assert.deepEqual(rules.map((rule) => rule.rule_id).sort(), [...REQUIRED_RULES].sort());
  assert.deepEqual(
    Object.fromEntries(rules.map((rule) => [rule.fact_path, rule.operator])),
    {
      "company.hasImport": "is_true",
      "company.companyScale": "in",
      "company.isManufacturer": "is_true",
      "company.supplyChainProgramEligible": "is_true",
      "company.partnerGuaranteeConfirmed": "is_true",
      "company.creditGradeMeetsThreshold": "is_true",
      "company.reviewChannelConfirmed": "is_true",
      "context.today": "date_within",
    },
  );
  assert.ok(rules.every((rule) => rule.required === true && rule.source_id === SOURCE_ID));
  assert.deepEqual(
    rules.find((rule) => rule.fact_path === "company.companyScale").value,
    ["sme", "mid_market"],
  );
  assert.deepEqual(
    rules.find((rule) => rule.fact_path === "context.today").value,
    { from: "2026-01-01", to: "2099-12-31" },
  );
});

test("T35 committed product knowledge remains closed-world conformant", () => {
  const result = validateProductKnowledge(GRAPH, RULES, SOURCES.sources, SCHEMA);
  assert.equal(result.conforms, true, JSON.stringify(result.violations, null, 2));
});

test("T35 importer with unknown synthetic facts is pending and asks instead of auto-passing", () => {
  const output = recommendation(importProfile());
  const pending = output.pending.find((item) => item.product_id === "import_lc");
  assert.ok(pending);
  assert.ok(!output.candidates.some((item) => item.product_id === "import_lc"));
  assert.deepEqual(
    pending.missingFacts.map((fact) => fact.factPath).sort(),
    [
      "company.creditGradeMeetsThreshold",
      "company.isManufacturer",
      "company.partnerGuaranteeConfirmed",
      "company.reviewChannelConfirmed",
      "company.supplyChainProgramEligible",
    ],
  );
  assert.equal(pending.questions.length, 5);
});

test("T35 eligible importer becomes a candidate with traceable synthetic evidence", () => {
  const output = recommendation(importProfile({ complete: true }));
  const candidate = output.candidates.find((item) => item.product_id === "import_lc");
  assert.ok(candidate);
  assert.equal(candidate.passedRules.length, REQUIRED_RULES.length);
  assert.ok(candidate.eligibilityEvidence.every((item) => item.source_id === SOURCE_ID));
  assert.equal(candidate.source.url, "https://github.com/qkrwlgh335-lab/tradepilot-ai-finance-agent/blob/main/docs/PUBLIC_DEMO_RULES.md#import_lc");
  assert.ok(candidate.reasoningPath.some((step) => step.rel === "matchedByRule"));
});

test("T35 non-import or unsupported-industry profiles are excluded, never recommended", () => {
  const nonImport = recommendation(importProfile({ importTrade: false, complete: true }));
  assert.ok(nonImport.excluded.some((item) => item.product_id === "import_lc"));
  assert.ok(!nonImport.candidates.some((item) => item.product_id === "import_lc"));

  const unsupported = importProfile({ complete: true });
  unsupported.facts.company.supplyChainProgramEligible = false;
  const result = recommendation(unsupported);
  assert.ok(result.excluded.some((item) => item.product_id === "import_lc"));
  assert.ok(!result.candidates.some((item) => item.product_id === "import_lc"));
});

test("T35 synthetic retrieval text is scoped and linked only to import_lc rules", () => {
  const product = DOCS.products.find((item) => item.product_id === "import_lc");
  const synthetic = product.chunks.filter((chunk) => chunk.evidence_class === "public_synthetic");
  assert.ok(synthetic.length >= 1);
  assert.ok(synthetic.every((chunk) => chunk.source_id === SOURCE_ID));
  assert.ok(synthetic.every((chunk) => chunk.supported_rule_ids.length > 0));
  assert.ok(synthetic.every((chunk) => chunk.supported_rule_ids.every((id) => REQUIRED_RULES.includes(id))));
  assert.match(synthetic.map((chunk) => chunk.text).join(" "), /데모 지정 공급망 업종/);
});

test("T35 candidate-scoped RAG retrieves synthetic import evidence without widening the product", async () => {
  const rag = createRag({
    docs: DOCS,
    embeddings: EMBEDDINGS,
    sources: SOURCES.sources,
    extractorFactory: async () => { throw new Error("offline test"); },
  });
  const evidence = await rag.evidenceForCandidate({
    product_id: "import_lc",
    rule_ids: REQUIRED_RULES,
    query: "데모 지정 공급망 업종 제조 수입기업",
    minScore: 0,
  });
  assert.ok(evidence?.length);
  assert.ok(evidence.every((item) => item.product_id === "import_lc"));
  assert.ok(evidence.every((item) => item.source.source_id === SOURCE_ID));
  assert.ok(evidence.every((item) => REQUIRED_RULES.includes(item.rule_id)));
});

test("T35 pending UI shows the limited program scope before a customer pursues it", () => {
  const output = recommendation(importProfile());
  const html = renderRecommendationPanels(output);
  assert.match(html, /공급망 수입금융 프로그램\(합성\)/);
  assert.match(html, /실제 금융상품 조건이 아닙니다/);
  assert.doesNotMatch(html, /eligibility\.(requires_import|manufacturer|demo_supply_chain_scope|partner_guarantee)/);
});
