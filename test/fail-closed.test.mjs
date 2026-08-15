// The engine must refuse to compute rather than substitute 0. Showing "위험 ₩0" because a rate
// or a volatility was missing is worse than showing nothing: it reads as "you are safe".
import { test } from "node:test";
import assert from "node:assert/strict";
import { CalculationError } from "../js/errors.js";
import { computeCFaRBuckets, liquidityTimeline, hedgeCostLoss } from "../js/risk.js";
import { compareStrategies } from "../js/strategy.js";

const rates = { USD: 1385.5 };
const vol = { USD: 0.08 };
const flow = [{ currency: "USD", direction: "in", amount: 100000, months: 3 }];
const isCalcError = (code) => (err) => err instanceof CalculationError && err.code === code;

test("missing / zero / negative / NaN FX rate is refused, never treated as 0", () => {
  assert.throws(() => computeCFaRBuckets(flow, {}, vol, {}), isCalcError("MISSING_RATE"));
  for (const bad of [0, -1385.5, NaN, "1385.5", null]) {
    assert.throws(() => computeCFaRBuckets(flow, { USD: bad }, vol, {}), (e) =>
      e instanceof CalculationError && ["MISSING_RATE", "INVALID_RATE"].includes(e.code), `rate=${bad}`);
  }
});

test("missing / negative / NaN volatility is refused (zero volatility stays legal)", () => {
  assert.throws(() => computeCFaRBuckets(flow, rates, {}, {}), isCalcError("MISSING_VOLATILITY"));
  for (const bad of [-0.08, NaN, "0.08"]) {
    assert.throws(() => computeCFaRBuckets(flow, rates, { USD: bad }, {}), (e) =>
      e instanceof CalculationError && ["MISSING_VOLATILITY", "INVALID_VOLATILITY"].includes(e.code), `vol=${bad}`);
  }
  assert.equal(computeCFaRBuckets(flow, rates, { USD: 0 }, {})[0].cfar, 0);
});

test("non-positive or non-finite amounts are refused", () => {
  for (const bad of [0, -1, NaN, Infinity, "100000", undefined]) {
    assert.throws(() => computeCFaRBuckets([{ ...flow[0], amount: bad }], rates, vol, {}),
      isCalcError("INVALID_AMOUNT"), `amount=${bad}`);
  }
});

test("negative or non-finite maturities are refused", () => {
  for (const bad of [-1, NaN, Infinity, "3", undefined]) {
    assert.throws(() => computeCFaRBuckets([{ ...flow[0], months: bad }], rates, vol, {}),
      isCalcError("INVALID_MONTHS"), `months=${bad}`);
  }
});

test("an unrecognised direction is refused instead of being read as an outflow", () => {
  for (const bad of ["IN", "inbound", "", undefined]) {
    assert.throws(() => computeCFaRBuckets([{ ...flow[0], direction: bad }], rates, vol, {}),
      isCalcError("INVALID_DIRECTION"), `direction=${bad}`);
  }
});

test("hedge ratio outside 0..1 is refused (a 150% hedge is not a hedge)", () => {
  for (const bad of [1.5, -0.1, NaN, "0.9", undefined]) {
    assert.throws(() => hedgeCostLoss(1000000, 1000000, { hedgeRatio: bad }),
      isCalcError("INVALID_HEDGE_RATIO"), `hedgeRatio=${bad}`);
  }
  assert.ok(hedgeCostLoss(1000000, 1000000, { hedgeRatio: 0 }).residualCFaR > 0);
  assert.equal(hedgeCostLoss(1000000, 1000000, { hedgeRatio: 1, hedgeEff: 1 }).residualCFaR, 0);
});

test("hedge effectiveness outside 0..1 and negative/NaN cost rates are refused", () => {
  for (const bad of [1.2, -0.1, NaN]) {
    assert.throws(() => hedgeCostLoss(1000000, 1000000, { hedgeRatio: 0.9, hedgeEff: bad }),
      isCalcError("INVALID_HEDGE_EFF"), `hedgeEff=${bad}`);
  }
  for (const bad of [-0.003, NaN, "0.003"]) {
    assert.throws(() => hedgeCostLoss(1000000, 1000000, { hedgeRatio: 0.9, costRate: bad }),
      isCalcError("INVALID_COST_RATE"), `costRate=${bad}`);
  }
});

test("compareStrategies propagates the same refusal for bad assumptions", () => {
  assert.throws(() => compareStrategies(1000000, 1000000, { assumptions: { hedgeEff: 2, costRate: 0.003, label: "x" } }),
    isCalcError("INVALID_HEDGE_EFF"));
});

test("negative or NaN liquidity buffers are refused", () => {
  for (const bad of [-1, NaN, "100", Infinity]) {
    assert.throws(() => liquidityTimeline(flow, rates, { openingBalanceKrw: bad }),
      isCalcError("INVALID_BUFFER"), `opening=${bad}`);
    assert.throws(() => liquidityTimeline(flow, rates, { creditLineKrw: bad }),
      isCalcError("INVALID_BUFFER"), `credit=${bad}`);
  }
});

test("liquidity refuses a missing rate too (no silent zero conversion)", () => {
  assert.throws(() => liquidityTimeline(flow, {}, {}), isCalcError("MISSING_RATE"));
});

test("a CalculationError carries a code and a user-facing Korean reason", () => {
  try {
    computeCFaRBuckets(flow, {}, vol, {});
    assert.fail("should have thrown");
  } catch (e) {
    assert.ok(e instanceof CalculationError);
    assert.equal(e.code, "MISSING_RATE");
    assert.match(e.message, /환율/);
    assert.equal(e.details.currency, "USD");
  }
});
