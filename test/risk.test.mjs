import { test } from "node:test";
import assert from "node:assert/strict";
import { computeCFaRBuckets, portfolioCFaR, bucketNotionalKrw, liquidityTimeline, hedgeCostLoss } from "../js/risk.js";

const rates = { USD: 1385.5, EUR: 1502.3 };
const vol = { USD: 0.08, EUR: 0.09 };

test("each (currency, maturity) bucket uses its OWN horizon: |net|*rate*sigma*sqrt(months/12)*z", () => {
  const cf = [{ currency: "USD", direction: "in", amount: 200000, months: 6 }];
  const [b] = computeCFaRBuckets(cf, rates, vol, { z: 1.645 });
  assert.equal(b.currency, "USD");
  assert.equal(b.months, 6);
  assert.equal(b.netAtMaturity, 200000);
  assert.ok(Math.abs(b.cfar - 200000 * 1385.5 * 0.08 * Math.sqrt(6 / 12) * 1.645) < 1e-6);
});

test("same currency at different maturities stays in separate buckets (longer horizon -> larger CFaR)", () => {
  const cf = [
    { currency: "USD", direction: "in", amount: 100000, months: 3 },
    { currency: "USD", direction: "in", amount: 100000, months: 9 },
  ];
  const buckets = computeCFaRBuckets(cf, rates, vol, {});
  assert.equal(buckets.length, 2);
  const b3 = buckets.find((b) => b.months === 3);
  const b9 = buckets.find((b) => b.months === 9);
  assert.ok(b9.cfar > b3.cfar, "the 9-month exposure must carry more risk than the 3-month one");
});

test("flows of the same currency AND maturity net against each other (natural hedge on the same date)", () => {
  const cf = [
    { currency: "USD", direction: "in", amount: 300000, months: 3 },
    { currency: "USD", direction: "out", amount: 100000, months: 3 },
  ];
  const buckets = computeCFaRBuckets(cf, rates, vol, {});
  assert.equal(buckets.length, 1);
  assert.equal(buckets[0].netAtMaturity, 200000);
});

test("portfolioCFaR is an explicitly labeled conservative sum (no correlation credit)", () => {
  const cf = [
    { currency: "USD", direction: "in", amount: 200000, months: 3 },
    { currency: "EUR", direction: "out", amount: 80000, months: 4 },
  ];
  const buckets = computeCFaRBuckets(cf, rates, vol, {});
  const p = portfolioCFaR(buckets);
  assert.equal(p.method, "conservative_sum");
  assert.ok(Math.abs(p.total - buckets.reduce((s, b) => s + b.cfar, 0)) < 1e-6);
});

test("liquidityTimeline accumulates KRW net and flags shortfall", () => {
  const cf = [
    { currency: "USD", direction: "out", amount: 100000, months: 2 },
    { currency: "USD", direction: "in", amount: 300000, months: 3 },
  ];
  const tl = liquidityTimeline(cf, rates);
  assert.equal(tl[0].months, 2);
  assert.ok(tl[0].cumulativeKrw < 0);
  assert.equal(tl[0].shortfallKrw, Math.abs(tl[0].cumulativeKrw));
  assert.ok(tl[1].cumulativeKrw > 0);
  assert.equal(tl[1].shortfallKrw, 0);
});

// The strategies defend every bucket at the same hedge ratio, so the hedged notional must be
// the sum of the bucket exposures — not the per-currency net, which silently assumes a
// 3-month receipt can offset a 2-month payment. Cross-maturity natural hedging and bridge
// financing are deliberately not modelled here.
test("hedged notional is summed per (currency, maturity) bucket, not per currency net", () => {
  const cf = [
    { currency: "USD", direction: "in", amount: 300000, months: 3 },
    { currency: "USD", direction: "out", amount: 100000, months: 2 },
    { currency: "EUR", direction: "out", amount: 80000, months: 4 },
  ];
  const buckets = computeCFaRBuckets(cf, rates, vol, {});
  const notional = bucketNotionalKrw(buckets);
  assert.equal(notional, 300000 * 1385.5 + 100000 * 1385.5 + 80000 * 1502.3);
  assert.equal(notional, 674_384_000);
  // the old per-currency-net basis understated it
  const perCurrencyNet = 200000 * 1385.5 + 80000 * 1502.3;
  assert.ok(notional > perCurrencyNet);
});

test("liquidity counts the opening cash balance and the usable credit line", () => {
  const cf = [{ currency: "USD", direction: "out", amount: 100000, months: 2 }];
  const bare = liquidityTimeline(cf, rates, {});
  assert.ok(bare[0].shortfallKrw > 0, "with no buffer the payment is a shortfall");

  const buffered = liquidityTimeline(cf, rates, { openingBalanceKrw: 100_000_000, creditLineKrw: 50_000_000 });
  assert.equal(buffered[0].shortfallKrw, 0, "balance + credit line covers the payment");
  assert.equal(buffered[0].cumulativeKrw, bare[0].cumulativeKrw, "FX flows themselves are unchanged");
  assert.equal(buffered[0].availableKrw, 100_000_000 + bare[0].cumulativeKrw + 50_000_000);
});

test("a buffer that is too small only reduces the shortfall, it does not hide it", () => {
  const cf = [{ currency: "USD", direction: "out", amount: 100000, months: 2 }];
  const bare = liquidityTimeline(cf, rates, {});
  const partial = liquidityTimeline(cf, rates, { openingBalanceKrw: 50_000_000 });
  assert.ok(partial[0].shortfallKrw > 0);
  assert.equal(Math.round(partial[0].shortfallKrw), Math.round(bare[0].shortfallKrw - 50_000_000));
});

test("hedgeCostLoss: higher hedge ratio lowers RESIDUAL RISK and raises hedge cost", () => {
  const a = hedgeCostLoss(1000000, 277100000, { hedgeRatio: 0.9 });
  const b = hedgeCostLoss(1000000, 277100000, { hedgeRatio: 0.3 });
  assert.ok(a.residualCFaR < b.residualCFaR);
  assert.ok(a.hedgeCost > b.hedgeCost);
});

test("residual risk and hedge cost are returned separately and are never combined", () => {
  const r = hedgeCostLoss(1000000, 277100000, { hedgeRatio: 0.9, hedgeEff: 0.95, costRate: 0.003 });
  // "expectedLoss" was financially wrong: this is a confidence-level risk measure, not an expectation.
  assert.ok(!("expectedLoss" in r), "must not be called expectedLoss");
  assert.ok(!("total" in r), "must not present a generic total/합계비용");
  // Even a labelled sum reads as one score for the strategy, so no combined figure is produced.
  assert.ok(!("comparisonIndex" in r), "must not combine a risk measure with a cost assumption");
  assert.deepEqual(Object.keys(r).sort(), ["hedgeCost", "residualCFaR"]);
});
