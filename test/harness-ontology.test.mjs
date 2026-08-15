import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildProfile } from "../js/profile.js";
import { recommend } from "../js/reasoner.js";

const load = async (path) => JSON.parse(await readFile(new URL(`../${path}`, import.meta.url), "utf8"));
const [graph, rules, registry, schema] = await Promise.all([
  load("data/knowledge-graph.json"),
  load("data/eligibility-rules.json"),
  load("data/source-registry.json"),
  load("data/ontology-schema.json"),
]);

function scenario({ purposes, exportMonths = 12, companyScale = "sme" }) {
  const profile = buildProfile({
    cashflows: [
      { transaction_id: "txn-1", country: "US", currency: "USD", tradeType: "export", direction: "in", amount: 500000, months: exportMonths },
      { transaction_id: "txn-2", country: "US", currency: "USD", tradeType: "import", direction: "out", amount: 100000, months: 2 },
    ],
    rates: { USD: 1385.5 },
    company: {
      companyType: "corporation",
      isSme: companyScale === "sme" ? true : false,
      riskAppetite: "low",
      existingHedges: [],
      requestedPurposes: purposes,
    },
  });
  Object.assign(profile.facts.company, {
    companyScale,
    creditGradeMeetsThreshold: true,
    priorYearExportUsd: 1_000_000,
    reviewChannelConfirmed: true,
    internetBankingEnrolled: true,
  });
  return { profile, graph, rules, sources: registry.sources, schema, today: "2026-07-26" };
}

test("ONTOLOGY GOLDEN: the three sourced demo purposes produce the three expected candidates", () => {
  const output = recommend(scenario({
    purposes: ["fx_hedge", "working_capital", "guarantee_insurance"],
  }));
  assert.deepEqual(
    output.candidates.map((candidate) => candidate.product_id),
    ["fx_insurance", "trade_loan", "ecg_pre"]
  );
});

test("ONTOLOGY GOLDEN: incomplete and unverified product knowledge stays unavailable", () => {
  const output = recommend(scenario({ purposes: ["fx_hedge", "working_capital"] }));
  const statuses = Object.fromEntries(output.unavailable.map((item) => [item.product_id, item.productKnowledgeStatus]));
  assert.equal(statuses.fwd, "unavailable_invalid_knowledge");
  for (const id of ["option", "swap"])
    assert.equal(statuses[id], "unavailable_unverified_source", id);
  assert.ok(output.pending.some((item) => item.product_id === "import_lc"));

  const receivable = recommend(scenario({ purposes: ["export_receivable"] }));
  assert.equal(receivable.unavailable[0].product_id, "export_nego");
  assert.equal(receivable.unavailable[0].productKnowledgeStatus, "unavailable_invalid_knowledge");

  const policy = recommend(scenario({ purposes: ["policy_fund"] }));
  assert.equal(policy.unavailable[0].product_id, "policy_fund");
  assert.equal(policy.unavailable[0].productKnowledgeStatus, "unavailable_unverified_source");
});

test("ONTOLOGY GOLDEN: an explicit non-target company scale excludes, rather than guesses SME", () => {
  const output = recommend(scenario({
    purposes: ["working_capital", "guarantee_insurance"],
    companyScale: "other",
  }));
  assert.deepEqual(output.candidates, []);
  assert.deepEqual(
    output.excluded.map((item) => item.product_id),
    ["trade_loan", "import_lc", "ecg_pre"]
  );
});

test("ONTOLOGY GOLDEN: a 19-month general export fails only the scoped insurance horizon", () => {
  const output = recommend(scenario({ purposes: ["fx_hedge"], exportMonths: 19 }));
  const item = output.excluded.find((excluded) => excluded.product_id === "fx_insurance");
  assert.ok(item);
  assert.deepEqual(item.failedRules.map((rule) => rule.rule_id), ["rule:fx_insurance-max-horizon-export"]);
});
