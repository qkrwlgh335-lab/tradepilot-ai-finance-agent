import { test } from "node:test";
import assert from "node:assert/strict";
import { buildActionPlan } from "../js/action-plan.js";

const input = {
  executiveSummary: {
    largestRisk: { currency: "USD", krwNotional: 277_100_000 },
    effect: {
      strategyKey: "안정형",
      beforeCFaR: 45_066_367,
      afterCFaR: 6_534_623,
      hedgeCost: 1_820_837,
    },
  },
  candidates: [
    { product_id: "fx_insurance", name: "일반수출 환율보호 프로그램(합성)" },
    { product_id: "ecg_pre", name: "선적전 이행보증 프로그램(합성)" },
  ],
  pending: [{ product_id: "trade_loan", name: "수출운전자금 프로그램(합성)" }],
  shortfalls: [{ months: 2, shortfallKrw: 38_550_000 }],
};

test("action plan always returns three deterministic customer actions", () => {
  const first = buildActionPlan(input);
  const second = buildActionPlan(structuredClone(input));
  assert.equal(first.actions.length, 3);
  assert.deepEqual(first, second);
  for (const action of first.actions) {
    for (const key of ["kind", "title", "reason", "expectedEffect", "nextStep", "basis"])
      assert.ok(action[key], `${action.kind}.${key}`);
  }
});

test("action plan reuses engine figures and candidates without score or rank", () => {
  const result = buildActionPlan(input);
  const text = JSON.stringify(result);
  for (const value of ["277,100,000", "45,066,367", "6,534,623", "1,820,837",
    "환율보호 프로그램", "이행보증 프로그램", "38,550,000"])
    assert.match(text, new RegExp(value));
  assert.doesNotMatch(text, /score|rank|점수|최적 상품/);
});

test("no-candidate input becomes a missing-information action, never a fabricated recommendation", () => {
  const result = buildActionPlan({
    executiveSummary: {},
    candidates: [],
    pending: [{ name: "운전자금 후보" }],
    shortfalls: [],
  });
  assert.equal(result.actions.length, 3);
  assert.match(result.actions[1].title, /정보 보완/);
  assert.match(result.actions[1].reason, /운전자금 후보/);
  assert.doesNotMatch(JSON.stringify(result), /추천합니다|최적/);
});
