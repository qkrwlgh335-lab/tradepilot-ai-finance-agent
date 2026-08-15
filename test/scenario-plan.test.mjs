// T16 — trusted ScenarioPlan gate.
// The gate turns an UNTRUSTED candidate plan into ONLY { scenarioId, options }.
// It never produces financial `changes`/`after`/change-paths; execution is delegated
// to the existing counterfactual.runCounterfactual(scenarioId, baseInput, deps, options).
import { test } from "node:test";
import assert from "node:assert/strict";
import { validatePlan, SCENARIO_TYPES } from "../js/scenario-plan.js";

// mirrors real A사 data: two USD receivables (US 200k, VN 100k) + one USD payable
const txns = [
  { transaction_id: "tx-1", direction: "in",  currency: "USD", amount: 200000, months: 3, country: "US" },
  { transaction_id: "tx-2", direction: "in",  currency: "USD", amount: 100000, months: 3, country: "VN" },
  { transaction_id: "tx-3", direction: "out", currency: "USD", amount: 100000, months: 2, country: "US" },
];
const plan = (steps, extra = {}) =>
  ({ version: "1", steps, missingFacts: [], unsupportedSegments: [], confidence: 1, ...extra });

test("valid payment_delay(months=1) → ok, execution is ONLY {scenarioId, options}", () => {
  const r = validatePlan(plan([{ type: "payment_delay", target: { transaction_id: "tx-1" }, params: { months: 1 } }]), { transactions: txns });
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r.execution).sort(), ["options", "scenarioId"]);
  assert.equal(r.execution.scenarioId, "payment_delay_1m");
  assert.equal(r.execution.options.targetTransactionId, "tx-1");
  assert.ok(!("changes" in r.execution) && !("after" in r.execution) && !("path" in r.execution));
});

test("receivable_drop(0.30) → revenue_drop_30 ; adverse_fx(0.05) → adverse_fx_5", () => {
  const a = validatePlan(plan([{ type: "receivable_drop", target: { scope: "all_receivables" }, params: { pct: 0.30 } }]), { transactions: txns });
  assert.equal(a.ok, true);
  assert.equal(a.execution.scenarioId, "revenue_drop_30");
  const b = validatePlan(plan([{ type: "adverse_fx", target: { scope: "net_exposure" }, params: { pct: 0.05 } }]), { transactions: txns });
  assert.equal(b.ok, true);
  assert.equal(b.execution.scenarioId, "adverse_fx_5");
});

test("other magnitude is NOT executable: unsupportedSegments>=1, ok:false, no execution", () => {
  for (const step of [
    { type: "payment_delay", target: { transaction_id: "tx-1" }, params: { months: 2 } },
    { type: "receivable_drop", target: { scope: "all_receivables" }, params: { pct: 0.20 } },
    { type: "adverse_fx", target: { scope: "net_exposure" }, params: { pct: 0.10 } },
  ]) {
    const r = validatePlan(plan([step]), { transactions: txns });
    assert.equal(r.ok, false, JSON.stringify(step));
    assert.ok(r.unsupportedSegments.length >= 1);
    assert.ok(!r.execution);
  }
});

test("prototype-pollution target or extra key is rejected", () => {
  assert.equal(validatePlan(plan([{ type: "payment_delay", target: { transaction_id: "__proto__" }, params: { months: 1 } }]), { transactions: txns }).ok, false);
  const polluted = plan([{ type: "payment_delay", target: { transaction_id: "tx-1" }, params: { months: 1 } }]);
  polluted.constructor = {};
  assert.equal(validatePlan(polluted, { transactions: txns }).ok, false);
  const protoKey = plan([{ type: "payment_delay", target: { transaction_id: "tx-1", __proto__: {} }, params: { months: 1 } }]);
  assert.equal(validatePlan(protoKey, { transactions: txns }).ok, false);
});

test("out-of-allowlist type is rejected", () => {
  assert.equal(validatePlan(plan([{ type: "delete_everything", target: {}, params: {} }]), { transactions: txns }).ok, false);
});

test("wrong version / non-array steps / extra top key are rejected", () => {
  assert.equal(validatePlan({ ...plan([]), version: "9" }, { transactions: txns }).ok, false);
  assert.equal(validatePlan({ version: "1", steps: "nope", missingFacts: [], unsupportedSegments: [], confidence: 1 }, { transactions: txns }).ok, false);
  assert.equal(validatePlan({ ...plan([{ type: "adverse_fx", target: { scope: "net_exposure" }, params: { pct: 0.05 } }]), extra: 1 }, { transactions: txns }).ok, false);
});

test(">1 executable step is not ok in P0 (single-only)", () => {
  const r = validatePlan(plan([
    { type: "payment_delay", target: { transaction_id: "tx-1" }, params: { months: 1 } },
    { type: "adverse_fx", target: { scope: "net_exposure" }, params: { pct: 0.05 } }]), { transactions: txns });
  assert.equal(r.ok, false);
  assert.ok(!r.execution);
  assert.match(JSON.stringify(r), /복합|한 가지/);
});

test("zero steps is not ok", () => {
  const r = validatePlan(plan([]), { transactions: txns });
  assert.equal(r.ok, false);
  assert.ok(!r.execution);
});

test("unknown/ambiguous transaction_id → missingFacts, never auto-pick, ok:false", () => {
  const r = validatePlan(plan([{ type: "payment_delay", target: { transaction_id: "tx-nope" }, params: { months: 1 } }]), { transactions: txns });
  assert.equal(r.ok, false);
  assert.ok(r.missingFacts.length >= 1);
  assert.ok(!r.execution);
});

test("payment_delay target that is a payable (not receivable) is not executable", () => {
  const r = validatePlan(plan([{ type: "payment_delay", target: { transaction_id: "tx-3" }, params: { months: 1 } }]), { transactions: txns });
  assert.equal(r.ok, false);
  assert.ok(!r.execution);
});

test("numeric abuse (NaN/Infinity/negative/zero) is not executable", () => {
  for (const months of [-1, 0, Number.POSITIVE_INFINITY, Number.NaN]) {
    const r = validatePlan(plan([{ type: "payment_delay", target: { transaction_id: "tx-1" }, params: { months } }]), { transactions: txns });
    assert.equal(r.ok, false, `months=${months}`);
    assert.ok(!r.execution);
  }
});

test("SCENARIO_TYPES is frozen to exactly three", () => {
  assert.deepEqual([...SCENARIO_TYPES], ["payment_delay", "receivable_drop", "adverse_fx"]);
  assert.throws(() => { SCENARIO_TYPES.push("x"); });
});

// --- T16.1: fail-closed on advisory + malformed containers ---
const validStep = () => ({ type: "adverse_fx", target: { scope: "net_exposure" }, params: { pct: 0.05 } });

// --- T16.2: fail-closed on malformed context (never throw) ---
const noThrow = (fn) => { try { return { value: fn() }; } catch (err) { return { threw: err }; } };

test("T16.2: malformed context fails closed and never throws", () => {
  for (const ctx of [null, "x", 7, [], () => {}, true]) {
    const out = noThrow(() => validatePlan(plan([validStep()]), ctx));
    assert.ok(!out.threw, `threw for context=${String(ctx)}`);
    assert.equal(out.value.ok, false);
    assert.ok(!out.value.execution);
    assert.ok(out.value.errors.length >= 1);
  }
});

test("T16.2: context.transactions must be an array when present", () => {
  for (const transactions of ["x", 7, null, {}]) {
    const out = noThrow(() => validatePlan(plan([validStep()]), { transactions }));
    assert.ok(!out.threw);
    assert.equal(out.value.ok, false);
    assert.ok(out.value.errors.length >= 1);
  }
});

test("T16.2: unknown context keys and tampered prototypes fail closed", () => {
  assert.equal(validatePlan(plan([validStep()]), { transactions: [], extra: 1 }).ok, false);
  const polluted = JSON.parse('{"transactions":[], "__proto__":{"x":1}}'); // own enumerable __proto__
  const out = noThrow(() => validatePlan(plan([validStep()]), polluted));
  assert.ok(!out.threw);
  assert.equal(out.value.ok, false);
});

test("T16.2: omitted context and a normal {transactions} context still work", () => {
  assert.equal(validatePlan(plan([validStep()])).ok, true);             // undefined -> {}
  assert.equal(validatePlan(plan([validStep()]), {}).ok, true);
  assert.equal(validatePlan(plan([validStep()]), { transactions: txns }).ok, true);
});

test("T16.1: a valid step with incoming unsupportedSegments is NOT ok (fail-closed)", () => {
  const r = validatePlan(plan([validStep()], { unsupportedSegments: [{ text: "x", reason: "leftover" }] }), { transactions: txns });
  assert.equal(r.ok, false);
  assert.ok(!r.execution);
});

test("T16.1: a valid step with incoming missingFacts is NOT ok (fail-closed)", () => {
  const r = validatePlan(plan([validStep()], { missingFacts: [{ field: "x", question: "무엇을 말하는지?" }] }), { transactions: txns });
  assert.equal(r.ok, false);
  assert.ok(!r.execution);
  assert.ok(r.missingFacts.length >= 1);
});

test("T16.1: malformed missingFacts / unsupportedSegments containers fail-closed with errors", () => {
  const a = validatePlan(plan([validStep()], { missingFacts: "nope" }), { transactions: txns });
  assert.equal(a.ok, false);
  assert.ok(a.errors.length >= 1);
  const b = validatePlan(plan([validStep()], { missingFacts: [{ field: "x" }] }), { transactions: txns }); // no question
  assert.equal(b.ok, false);
  assert.ok(b.errors.length >= 1);
  const c = validatePlan(plan([validStep()], { unsupportedSegments: [{ text: "x" }] }), { transactions: txns }); // no reason
  assert.equal(c.ok, false);
  assert.ok(c.errors.length >= 1);
});

test("T16.1: confidence must be a finite number in [0,1]", () => {
  for (const confidence of [5, -0.1, NaN, Number.POSITIVE_INFINITY, "1", null, undefined]) {
    const r = validatePlan(plan([validStep()], { confidence }), { transactions: txns });
    assert.equal(r.ok, false, `confidence=${String(confidence)}`);
    assert.ok(!r.execution);
    assert.ok(r.errors.length >= 1);
  }
});

test("T20.1: wrong-magnitude reason reads cleanly (no 은(는) josa) and names the scenario", () => {
  const r = validatePlan(plan([{ type: "receivable_drop", target: { scope: "all_receivables" }, params: { pct: 0.20 } }]), { transactions: txns });
  assert.equal(r.ok, false);
  const reason = r.unsupportedSegments.map((u) => u.reason).join(" ");
  assert.doesNotMatch(reason, /은\(는\)/);
  assert.match(reason, /매출·수취액 감소/);
});

test("T20.1: the generic empty-scenario reason is not duplicated when a specific reason exists", () => {
  const r = validatePlan(plan([], { unsupportedSegments: [{ text: "", reason: "부정형 조건은 지원하지 않습니다." }] }), { transactions: txns });
  assert.equal(r.ok, false);
  assert.equal(r.unsupportedSegments.length, 1);
  assert.match(r.unsupportedSegments[0].reason, /부정형/);
});

test("T16.1: a clean valid plan still passes (regression) and messages are not duplicated", () => {
  const r = validatePlan(plan([validStep()]), { transactions: txns });
  assert.equal(r.ok, true);
  assert.equal(r.missingFacts.length, 0);
  assert.equal(r.unsupportedSegments.length, 0);
  // unknown target: classify's missingFact must not be duplicated with an identical incoming one
  const dup = validatePlan(plan(
    [{ type: "payment_delay", target: { transaction_id: "tx-nope" }, params: { months: 1 } }],
    { missingFacts: [{ field: "target", question: "어느 수취 거래를 말하는지 선택해 주세요" }] },
  ), { transactions: txns });
  assert.equal(dup.ok, false);
  assert.equal(dup.missingFacts.filter((m) => /어느 수취 거래/.test(m.question)).length, 1);
});
