import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildProfile } from "../js/profile.js";
import { recommend } from "../js/reasoner.js";

const load = async (path) => JSON.parse(await readFile(new URL(`../${path}`, import.meta.url), "utf8"));
const [GRAPH, RULES, SOURCES, SCHEMA] = await Promise.all([
  load("data/knowledge-graph.json"),
  load("data/eligibility-rules.json"),
  load("data/source-registry.json"),
  load("data/ontology-schema.json"),
]);

const cashflows = [
  { transaction_id: "txn-export", country: "US", currency: "USD", tradeType: "export", direction: "in", amount: 500000, months: 12 },
  { transaction_id: "txn-import", country: "US", currency: "USD", tradeType: "import", direction: "out", amount: 100000, months: 2 },
];

function completeProfile(requestedPurposes = ["fx_hedge", "working_capital", "guarantee_insurance"]) {
  const profile = buildProfile({
    cashflows,
    rates: { USD: 1385.5 },
    company: {
      companyType: "corporation",
      isSme: true,
      riskAppetite: "low",
      existingHedges: [],
      requestedPurposes,
    },
  });
  Object.assign(profile.facts.company, {
    creditGradeMeetsThreshold: true,
    priorYearExportUsd: 1_000_000,
    reviewChannelConfirmed: true,
    internetBankingEnrolled: true,
  });
  return profile;
}

const fixture = (patch = {}) => ({
  profile: completeProfile(),
  graph: GRAPH,
  rules: RULES,
  sources: SOURCES.sources,
  schema: SCHEMA,
  today: "2026-07-26",
  ...patch,
});

test("no ineligible product ever appears as a candidate", () => {
  const input = fixture();
  input.profile.facts.company.priorYearExportUsd = 1_250_001;
  const output = recommend(input);
  const excluded = new Set(output.excluded.map((item) => `${item.purpose}:${item.product_id}`));
  for (const candidate of output.candidates)
    assert.ok(!excluded.has(`${candidate.purpose}:${candidate.product_id}`));
  assert.ok(output.excluded.some((item) => item.product_id === "trade_loan"));
  assert.ok(!output.candidates.some((item) => item.product_id === "trade_loan"));
});

test("a product with any unknown required fact is pending, never eligible", () => {
  const input = fixture();
  delete input.profile.facts.company.reviewChannelConfirmed;
  const output = recommend(input);
  const pending = output.pending.find((item) => item.product_id === "trade_loan");
  assert.ok(pending);
  assert.ok(pending.missingFacts.some((fact) => fact.factPath === "company.reviewChannelConfirmed"));
  assert.ok(!output.candidates.some((item) => item.product_id === "trade_loan"));
});

test("every candidate carries a reasoning path, passed rules and verified official evidence", () => {
  const output = recommend(fixture());
  assert.ok(output.candidates.length >= 3);
  for (const candidate of output.candidates) {
    assert.ok(candidate.reasoningPath.length >= 4);
    assert.ok(candidate.reasoningPath.some((step) => step.rel === "matchedByRule"));
    assert.ok(candidate.reasoningPath.some((step) => step.rel === "mitigates"));
    assert.ok(candidate.passedRules.length > 0);
    assert.ok(candidate.eligibilityEvidence.length === candidate.passedRules.length);
    assert.match(candidate.source.url, /^https:\/\//);
    assert.ok(candidate.source.verified_on);
    assert.ok(candidate.source.page_or_section);
    assert.ok(!("score" in candidate) && !("rank" in candidate));
  }
});

test("every exclusion states the failed rules and official reasons", () => {
  const input = fixture({ profile: completeProfile(["fx_hedge"]) });
  input.profile.transactions.find((transaction) => transaction.tradeType === "export").months = 19;
  const output = recommend(input);
  const excluded = output.excluded.find((item) => item.product_id === "fx_insurance");
  assert.ok(excluded);
  assert.ok(excluded.failedRules.length > 0);
  assert.ok(excluded.reasons.every((reason) => typeof reason === "string" && reason.length > 0));
});

test("every pending product states the missing facts and asks unique questions", () => {
  const input = fixture({ profile: completeProfile(["working_capital", "guarantee_insurance"]) });
  delete input.profile.facts.company.isSme;
  const output = recommend(input);
  assert.ok(output.pending.length >= 2);
  for (const pending of output.pending) {
    assert.ok(pending.missingFacts.length > 0);
    assert.ok(pending.questions.length > 0);
    assert.equal(new Set(pending.questions).size, pending.questions.length);
  }
  const tradeLoan = output.pending.find((item) => item.product_id === "trade_loan");
  assert.ok(tradeLoan.missingFacts.some((fact) => fact.factPath === "company.companyScale"));
  assert.ok(!tradeLoan.missingFacts.some((fact) => fact.factPath === "company.priorYearExportUsd"));
  assert.deepEqual(tradeLoan.questions, [SCHEMA.ruleFactCatalog["company.companyScale"].question]);
});

test("results are grouped by requested purpose and identical input is byte-identical", () => {
  const input = fixture();
  const before = JSON.stringify(input);
  const first = recommend(input);
  const second = recommend(input);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(JSON.stringify(input), before, "recommend must not mutate its inputs");
  assert.deepEqual(first.byPurpose.map((group) => group.purpose), input.profile.requestedPurposes);
  for (const item of [...first.candidates, ...first.excluded, ...first.pending, ...first.unavailable])
    assert.ok(input.profile.requestedPurposes.includes(item.purpose));
});

test("unavailable product knowledge is never reported as customer ineligibility", () => {
  const output = recommend(fixture());
  assert.ok(output.unavailable.length > 0);
  const unavailableKeys = new Set(output.unavailable.map((item) => `${item.purpose}:${item.product_id}`));
  for (const excluded of output.excluded)
    assert.ok(!unavailableKeys.has(`${excluded.purpose}:${excluded.product_id}`));
  for (const item of output.unavailable) {
    assert.match(item.productKnowledgeStatus, /^unavailable_/);
    assert.ok(item.reason);
  }
});

test("a product status inconsistent with the derived graph fails the whole recommendation closed", () => {
  const graph = structuredClone(GRAPH);
  graph.nodes.find((node) => node.product_id === "fx_insurance").productKnowledgeStatus = "unavailable_invalid_knowledge";
  const output = recommend(fixture({ profile: completeProfile(["fx_hedge"]), graph }));
  assert.equal(output.candidates.length, 0);
  assert.equal(output.unavailable.length, 0);
  assert.ok(output.questions.length > 0);
});

test("recommendation uses requestedPurposes only and ignores suggestedPurposes", () => {
  const profile = completeProfile(["fx_hedge"]);
  profile.suggestedPurposes = ["working_capital", "guarantee_insurance", "policy_fund"];
  const first = recommend(fixture({ profile }));
  profile.suggestedPurposes = ["export_receivable"];
  const second = recommend(fixture({ profile }));
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.deepEqual(first.byPurpose.map((group) => group.purpose), ["fx_hedge"]);
});

test("unavailable products stay visible under their explicit requested purpose", () => {
  const policy = recommend(fixture({ profile: completeProfile(["policy_fund"]) }));
  assert.ok(policy.unavailable.some((item) => item.product_id === "policy_fund"));
  assert.match(policy.byPurpose[0].note, /확인된 근거 출처.*항목이 없/);

  const receivable = recommend(fixture({ profile: completeProfile(["export_receivable"]) }));
  assert.ok(receivable.unavailable.some((item) => item.product_id === "export_nego"));

  const workingCapital = recommend(fixture({ profile: completeProfile(["working_capital"]) }));
  assert.ok(!workingCapital.unavailable.some((item) => item.product_id === "policy_fund"));
  assert.ok(!workingCapital.unavailable.some((item) => item.product_id === "export_nego"));
});

test("malformed dependency containers fail closed without throwing or producing candidates", () => {
  for (const patch of [
    { graph: null },
    { rules: "bad" },
    { sources: null },
    { schema: [] },
    { schema: { riskToPurpose: {}, classes: { Company: {}, TradeTransaction: {} } } },
    { profile: null },
    { profile: { requestedPurposes: {}, transactions: [] } },
    { profile: { requestedPurposes: ["fx_hedge"], transactions: {} } },
  ]) {
    const output = recommend(fixture(patch));
    assert.equal(output.candidates.length, 0);
    assert.ok(output.questions.length > 0);
  }
});

test("invalid profile values and duplicate product identities fail closed", () => {
  const invalidProfile = completeProfile(["fx_hedge"]);
  invalidProfile.transactions[0].amount = -1;
  assert.equal(recommend(fixture({ profile: invalidProfile })).candidates.length, 0);

  const duplicateGraph = structuredClone(GRAPH);
  duplicateGraph.nodes.push(structuredClone(
    duplicateGraph.nodes.find((node) => node.product_id === "fx_insurance")
  ));
  const output = recommend(fixture({ graph: duplicateGraph }));
  assert.equal(output.candidates.length, 0);
  assert.ok(output.questions.length > 0);
});

test("an invalid explicit rule fact is input-invalid, never customer-ineligible", () => {
  const profile = completeProfile(["working_capital", "guarantee_insurance"]);
  profile.facts.company.isSme = false;
  profile.facts.company.companyScale = "bogus";
  const output = recommend(fixture({ profile }));

  assert.equal(output.candidates.length, 0);
  assert.equal(output.excluded.length, 0);
  assert.equal(output.pending.length, 0);
  assert.ok(output.questions.length > 0);
});

test("recommend refuses a graph that validateProductKnowledge would reject", () => {
  const graph = structuredClone(GRAPH);
  graph.edges.push({ from: "prod:fx_insurance", rel: "unknownRelation", to: "risk:fx_rate" });
  const output = recommend(fixture({ profile: completeProfile(["fx_hedge"]), graph }));

  assert.equal(output.candidates.length, 0);
  assert.ok(output.questions.length > 0);
});

test("a derived hasPurpose edge cannot rewrite a product's requested purpose", () => {
  const graph = structuredClone(GRAPH);
  graph.edges.push({ from: "risk:fx_rate", rel: "hasPurpose", to: "purpose:working_capital" });
  const output = recommend(fixture({ profile: completeProfile(["working_capital"]), graph }));

  assert.equal(output.candidates.length, 0);
  assert.ok(output.questions.length > 0);
});

test("duplicate mitigates edges do not duplicate a product result", () => {
  const graph = structuredClone(GRAPH);
  graph.edges.push(structuredClone(
    graph.edges.find((edge) => edge.from === "prod:fx_insurance" && edge.rel === "mitigates")
  ));
  const output = recommend(fixture({ profile: completeProfile(["fx_hedge"]), graph }));
  assert.equal(output.candidates.filter((item) => item.product_id === "fx_insurance").length, 1);
});

test("no result object carries an automatic score or rank at any depth", () => {
  const json = JSON.stringify(recommend(fixture()));
  assert.ok(!/"score"\s*:/.test(json));
  assert.ok(!/"rank"\s*:/.test(json));
});
