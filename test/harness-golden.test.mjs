// HARNESS: golden dataset — canonical A사 input must always produce the same numbers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { computeNetExposure } from "../js/exposure.js";
import { computeCFaRBuckets, portfolioCFaR, bucketNotionalKrw } from "../js/risk.js";
import { compareStrategies } from "../js/strategy.js";
import { simulateScenarios } from "../js/scenario.js";
import { buildProfile } from "../js/profile.js";
import { recommend } from "../js/reasoner.js";

const load = async (p) => JSON.parse(await readFile(new URL(`../${p}`, import.meta.url), "utf8"));

// Canonical golden input (A사): USD 순 +200,000 / EUR 순 −80,000
const GOLDEN = [
  { transaction_id: "golden-usd-in-1", country: "US", currency: "USD", tradeType: "export", direction: "in", amount: 200000, months: 3 },
  { transaction_id: "golden-usd-in-2", country: "US", currency: "USD", tradeType: "export", direction: "in", amount: 100000, months: 3 },
  { transaction_id: "golden-usd-out", country: "US", currency: "USD", tradeType: "import", direction: "out", amount: 100000, months: 2 },
  { transaction_id: "golden-eur-out", country: "DE", currency: "EUR", tradeType: "import", direction: "out", amount: 80000, months: 4 },
];

async function pipeline() {
  // Financial-engine goldens use a frozen market fixture. Runtime market data is
  // allowed to refresh without rewriting the formula contract or expected numbers.
  const market = await load("test/fixtures/golden-market.json");
  const netRows = computeNetExposure(GOLDEN);
  const cfar = computeCFaRBuckets(GOLDEN, market.rates, market.annual_vol, {});
  const cfarTotal = portfolioCFaR(cfar).total;
  const notionalKrw = bucketNotionalKrw(cfar);
  const strategies = compareStrategies(cfarTotal, notionalKrw);
  const scenarios = simulateScenarios(netRows, market.rates);
  return { netRows, cfar, cfarTotal, notionalKrw, strategies, scenarios };
}

test("GOLDEN: netRows are exactly USD +200000 / EUR -80000, sorted", async () => {
  const { netRows } = await pipeline();
  assert.deepEqual(netRows, [
    { currency: "EUR", receivable: 0, payable: 80000, net: -80000 },
    { currency: "USD", receivable: 300000, payable: 100000, net: 200000 },
  ]);
});

test("GOLDEN: CFaR is positive in every (currency, maturity) bucket", async () => {
  const { cfar, cfarTotal } = await pipeline();
  // A사: USD 3개월(+300k), USD 2개월(-100k), EUR 4개월(-80k)
  assert.deepEqual(cfar.map((b) => `${b.currency}@${b.months}`), ["EUR@4", "USD@2", "USD@3"]);
  for (const b of cfar) assert.ok(b.cfar > 0, `${b.currency}@${b.months} CFaR`);
  assert.ok(cfarTotal > 0);
});

test("GOLDEN: hedge cost is priced off the bucket notional (A사 = 674,384,000)", async () => {
  const { notionalKrw, strategies } = await pipeline();
  assert.equal(notionalKrw, 674_384_000);
  const stable = strategies.find((s) => s.key === "안정형");
  assert.equal(Math.round(stable.hedgeCost), Math.round(674_384_000 * 0.003 * 0.9));
  assert.ok(!("comparisonIndex" in stable), "risk and cost must not be combined into one figure");
});

test("GOLDEN: strategy residual risk decreases and hedge cost increases with hedge ratio", async () => {
  const { strategies } = await pipeline();
  assert.deepEqual(strategies.map((s) => s.key), ["안정형", "균형형", "기회추구형"]);
  assert.ok(strategies[0].residualCFaR < strategies[1].residualCFaR);
  assert.ok(strategies[1].residualCFaR < strategies[2].residualCFaR);
  assert.ok(strategies[0].hedgeCost > strategies[1].hedgeCost);
  assert.ok(strategies[1].hedgeCost > strategies[2].hedgeCost);
});

test("GOLDEN: pipeline is reproducible (two runs byte-identical)", async () => {
  const a = await pipeline();
  const b = await pipeline();
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test("GOLDEN: A사 ontology recommendation is deterministic and carries no score/rank", async () => {
  const market = await load("test/fixtures/golden-market.json");
  const [graph, rules, registry, schema] = await Promise.all([
    load("data/knowledge-graph.json"),
    load("data/eligibility-rules.json"),
    load("data/source-registry.json"),
    load("data/ontology-schema.json"),
  ]);
  const profile = buildProfile({
    cashflows: GOLDEN,
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
    creditGradeMeetsThreshold: true,
    priorYearExportUsd: 1_000_000,
    reviewChannelConfirmed: true,
    internetBankingEnrolled: true,
  });
  const input = {
    profile, graph, rules, sources: registry.sources, schema, today: market.as_of,
  };
  const first = recommend(input);
  const second = recommend(input);
  assert.deepEqual(first.candidates.map((candidate) => candidate.product_id),
    ["fx_insurance", "trade_loan", "ecg_pre"]);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.doesNotMatch(JSON.stringify(first), /"(score|rank)"\s*:/);
});
