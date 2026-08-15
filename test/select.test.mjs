import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRichProfile, filterEligible, scoreProducts } from "../js/select.js";

const rates = { USD: 1385.5, EUR: 1502.3 };
const netRows = [{ currency: "USD", net: 200000 }, { currency: "EUR", net: -80000 }];
const cashflows = [
  { currency: "USD", direction: "in", amount: 300000, months: 3 },
  { currency: "USD", direction: "out", amount: 100000, months: 2 },
  { currency: "EUR", direction: "out", amount: 80000, months: 4 },
];

test("buildRichProfile derives currencies, horizon, export flag, USD exposure", () => {
  const p = buildRichProfile(netRows, cashflows, rates);
  assert.ok(p.currencies.has("USD") && p.currencies.has("EUR"));
  assert.equal(p.maxHorizonMonths, 4);
  assert.equal(p.hasExport, true);
  assert.ok(p.maxNetExposureUsd >= 199999 && p.maxNetExposureUsd <= 200001);
});

test("filterEligible drops min-amount, currency, horizon, expiry, requires_* misses", () => {
  const p = buildRichProfile(netRows, cashflows, rates);
  const products = [
    { product_id: "ok", eligibility: { min_amount_usd: 10000, currencies: ["USD"], max_horizon_months: 12, requires_export: false, requires_sme: false }, effective_from: "2026-01-01", effective_to: "2026-12-31" },
    { product_id: "tooBig", eligibility: { min_amount_usd: 999999999, currencies: ["USD"], max_horizon_months: 12, requires_export: false, requires_sme: false }, effective_from: "2026-01-01", effective_to: "2026-12-31" },
    { product_id: "wrongCcy", eligibility: { min_amount_usd: 1, currencies: ["GBP"], max_horizon_months: 12, requires_export: false, requires_sme: false }, effective_from: "2026-01-01", effective_to: "2026-12-31" },
    { product_id: "expired", eligibility: { min_amount_usd: 1, currencies: ["USD"], max_horizon_months: 12, requires_export: false, requires_sme: false }, effective_from: "2020-01-01", effective_to: "2020-12-31" },
  ];
  const ids = filterEligible(products, p, { today: new Date("2026-07-22") }).map((x) => x.product_id);
  assert.deepEqual(ids, ["ok"]);
});

test("scoreProducts weights components and returns top-3 desc with breakdown", () => {
  const p = buildRichProfile(netRows, cashflows, rates);
  const mk = (id, eff, rate, liq) => ({ product_id: id, hedge_effectiveness: eff, cost: { cost_rate: rate }, liquidity_score: liq, eligibility: { max_horizon_months: 12 } });
  const out = scoreProducts([mk("a", 0.95, 0.003, 0.6), mk("b", 0.2, 0.006, 0.9), mk("c", 0.85, 0.002, 0.7)], p);
  assert.equal(out.length, 3);
  assert.equal(out[0].product_id, "c");
  assert.ok(out[0].score >= out[1].score && out[1].score >= out[2].score);
  assert.ok(out[0].breakdown.riskReduction === 0.85);
});
