import { test } from "node:test";
import assert from "node:assert/strict";
import { COUNTER_QUESTIONS, ruleCounterExamples } from "../js/counter.js";

const strategies = [
  { key: "안정형", hedgeRatio: 0.9 },
  { key: "균형형", hedgeRatio: 0.6 },
  { key: "기회추구형", hedgeRatio: 0.3 },
];

test("exactly the five brainstorming counter-questions", () => {
  assert.equal(COUNTER_QUESTIONS.length, 5);
  assert.match(COUNTER_QUESTIONS[0], /환율/);
});

test("ruleCounterExamples answers all five, referencing hedge ratios", () => {
  const out = ruleCounterExamples(strategies);
  assert.equal(out.length, 5);
  assert.ok(out.every((x) => x.q && x.a));
  assert.match(out[0].a, /90%|안정형/);
});

test("ruleCounterExamples never throws on empty/undefined input", () => {
  for (const bad of [[], undefined, null]) {
    const out = ruleCounterExamples(bad);
    assert.equal(out.length, 5);
    assert.ok(out.every((x) => x.q && x.a));
  }
});

test("revenue decline does not assert over-hedging without comparing an existing hedge", () => {
  const answer = ruleCounterExamples(strategies)[3].a;
  assert.doesNotMatch(answer, /줄면 과헤지가 됩니다/);
  assert.match(answer, /초과할 수|과헤지 여부/);
  assert.match(answer, /통화·만기/);
});
