import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ANALYSIS_PURPOSES,
  buildAnalysisPayload,
  validateAnalysisPayload,
} from "../js/privacy.js";

const context = {
  netRows: [{
    currency: "USD",
    net: 200_000,
    receivable: 300_000,
    secretMemo: "고객명",
  }],
  scenarios: [{ delta: -0.05, totalPnl: -10_000, byCurrency: [{ secret: true }] }],
  cfarTotal: 45_000_000,
  strategies: [{
    key: "안정형",
    hedgeRatio: 0.9,
    residualCFaR: 6_000_000,
    hedgeCost: 1_000_000,
    internalScore: 99,
  }],
  counters: [{ q: "입금이 늦으면?", a: "만기를 다시 계산합니다.", rawContract: "비밀" }],
  countries: [{ name: "미국", exposureShare: 0.75, notes: "내부메모", gdpGrowth: 2.16 }],
  products: [{
    product_id: "fx_insurance",
    name: "환변동보험",
    purpose: "fx_hedge",
    status: "candidate",
    sourceUrl: "https://example.invalid/private",
    matchedText: "원문",
  }],
  companyName: "A제조(주)",
  cashflows: [{ amount: 300_000 }],
  rawContractText: "계약서 원문",
};

test("analysis payload is rebuilt field-by-field and drops nested/raw data", () => {
  const payload = buildAnalysisPayload(context);
  assert.deepEqual(payload, {
    netRows: [{ currency: "USD", net: 200_000 }],
    scenarios: [{ delta: -0.05, totalPnl: -10_000 }],
    cfarTotal: 45_000_000,
    strategies: [{
      key: "안정형",
      hedgeRatio: 0.9,
      residualCFaR: 6_000_000,
      hedgeCost: 1_000_000,
    }],
    counters: [{ q: "입금이 늦으면?", a: "만기를 다시 계산합니다." }],
    countries: [{ name: "미국", exposureShare: 0.75 }],
    products: [{
      product_id: "fx_insurance",
      purpose: "fx_hedge",
      status: "candidate",
    }],
  });
  const serialized = JSON.stringify(payload);
  for (const forbidden of [
    "companyName",
    "cashflows",
    "rawContractText",
    "secretMemo",
    "sourceUrl",
    "matchedText",
    "internalScore",
  ]) assert.ok(!serialized.includes(forbidden), forbidden);
});

test("proxy-side validation repeats nested reconstruction and strips extras", () => {
  const result = validateAnalysisPayload({
    ...context,
    netRows: [{ currency: "USD", net: 1, secretMemo: "x" }],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.netRows, [{ currency: "USD", net: 1 }]);
  assert.equal(result.value.companyName, undefined);
});

test("malformed nested values fail closed instead of being coerced", () => {
  for (const payload of [
    { netRows: "not-an-array" },
    { netRows: [{ currency: "USD", net: "200000" }] },
    { strategies: [{ key: "안정형", hedgeRatio: 2, residualCFaR: 1, hedgeCost: 1 }] },
    { products: [{ product_id: "prod:bad", purpose: "fx_hedge", status: "candidate" }] },
    { cfarTotal: Number.NaN },
  ]) {
    const result = validateAnalysisPayload(payload);
    assert.equal(result.ok, false, JSON.stringify(payload));
    assert.ok(result.errors.length > 0);
  }
});

test("browser request purposes are a closed enum", () => {
  assert.deepEqual(ANALYSIS_PURPOSES, ["counter_examples", "product_explanation"]);
  assert.equal(Object.isFrozen(ANALYSIS_PURPOSES), true);
});
