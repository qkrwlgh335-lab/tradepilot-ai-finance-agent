import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createExternalIntentAdapter,
  maskScenarioText,
  validateExternalIntentProposal,
} from "../js/scenario-intent-provider.js";
import { interpretScenarioIntent } from "../js/scenario-semantic.js";
import { buildPresetPlan } from "../js/scenario-preset.js";
import { validatePlan } from "../js/scenario-plan.js";

const transactions = [
  { transaction_id: "tx-1", direction: "in", currency: "USD", amount: 200000, months: 3, country: "US" },
];
const intents = { intents: [] };

test("external intent text is masked and bounded before egress", () => {
  const masked = maskScenarioText("txn-secret 계좌 123456789012 user@example.com 수출 주문이 줄면?");
  assert.doesNotMatch(masked, /txn-secret|123456789012|user@example\.com/);
  assert.match(masked, /수출 주문이 줄면/);
  assert.ok(masked.length <= 500);
});

test("external proposal is strict type+confidence only; params, targets and extra keys fail", () => {
  assert.deepEqual(
    validateExternalIntentProposal({ type: "adverse_fx", confidence: 0.91 }),
    { ok: true, value: { type: "adverse_fx", confidence: 0.91 }, errors: [] },
  );
  for (const bad of [
    { type: "other", confidence: 0.9 },
    { type: "adverse_fx", confidence: 2 },
    { type: "adverse_fx", confidence: 0.9, params: { pct: 0.9 } },
    { type: "payment_delay", confidence: 0.9, target: { transaction_id: "tx-1" } },
  ]) assert.equal(validateExternalIntentProposal(bad).ok, false, JSON.stringify(bad));
});

test("adapter is opt-in, sends the exact masked schema and fails closed", async () => {
  let request;
  const fetchImpl = async (url, options) => {
    request = { url, ...options, body: JSON.parse(options.body) };
    return { ok: true, json: async () => ({ type: "receivable_drop", confidence: 0.94 }) };
  };
  const disabled = createExternalIntentAdapter({ approved: false, fetchImpl });
  assert.equal((await disabled.classify("수출 주문이 줄면?")).status, "unavailable");
  assert.equal(request, undefined);

  const enabled = createExternalIntentAdapter({ approved: true, fetchImpl });
  const out = await enabled.classify("회사 txn-99의 수출 주문이 줄면?");
  assert.equal(out.status, "matched");
  assert.equal(out.type, "receivable_drop");
  assert.equal(request.url, "http://127.0.0.1:8787/api/intent");
  assert.deepEqual(Object.keys(request.body).sort(), ["maskedText", "purpose"]);
  assert.equal(request.body.purpose, "scenario_intent");
  assert.doesNotMatch(request.body.maskedText, /txn-99/);

  const malicious = createExternalIntentAdapter({
    approved: true,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ type: "receivable_drop", confidence: 0.99, params: { pct: 0.99 } }),
    }),
  });
  assert.notEqual((await malicious.classify("수출 주문이 줄면?")).status, "matched");
});

test("external output still resolves the target locally and passes the unchanged T17 gate", async () => {
  const adapter = createExternalIntentAdapter({
    approved: true,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ type: "payment_delay", confidence: 0.92 }),
    }),
  });
  const interpreted = await interpretScenarioIntent(
    "미국 바이어 송금 문제가 생기면?",
    { transactions, intents },
    adapter,
  );
  assert.equal(interpreted.intent.steps[0].type, "payment_delay");
  assert.equal("params" in interpreted.intent.steps[0], false);
  const gate = validatePlan(buildPresetPlan(interpreted.intent), { transactions });
  assert.equal(gate.ok, true);
  assert.deepEqual(gate.execution, {
    scenarioId: "payment_delay_1m",
    options: { targetTransactionId: "tx-1" },
  });
});
