// T17-final — the natural-language parser decides ONLY the scenario type and the target.
// Every execution number comes from a fixed preset (scenario-preset.js), never from the words.
// A sentence carrying any magnitude marker is rejected; a magnitude-free sentence is parsed and
// its params are injected by the preset adapter, then re-validated by the trusted gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseScenarioIntent, resolveReceivableCandidates, hasMagnitudeMarker } from "../js/scenario-intent.js";
import { buildPresetPlan, presetScenarioIdFor, presetLabelFor } from "../js/scenario-preset.js";
import { validatePlan } from "../js/scenario-plan.js";

const intents = JSON.parse(await readFile(new URL("../data/scenario-intents.json", import.meta.url), "utf8"));
const parserSrc = await readFile(new URL("../js/scenario-intent.js", import.meta.url), "utf8");

// mirrors real A사 data: two USD receivables (US 200k, VN 100k) + one USD payable
const txns = [
  { transaction_id: "tx-1", direction: "in",  currency: "USD", amount: 200000, months: 3, country: "US" },
  { transaction_id: "tx-2", direction: "in",  currency: "USD", amount: 100000, months: 3, country: "VN" },
  { transaction_id: "tx-3", direction: "out", currency: "USD", amount: 100000, months: 2, country: "US" },
];
const ctx = { transactions: txns, intents };

// Full pipeline: parse (intent only) → preset adapter (inject params) → trusted gate.
const run = (text, chosenTargetId) => {
  let intent = parseScenarioIntent(text, ctx);
  if (chosenTargetId && intent.steps[0]?.type === "payment_delay")
    intent = { ...intent, steps: [{ ...intent.steps[0], target: { transaction_id: chosenTargetId } }] };
  return { intent, gate: validatePlan(buildPresetPlan(intent), { transactions: txns }) };
};

// ---------------- Group A: any magnitude-bearing NL is blocked ----------------
const MAG_PREFIX = ["약", "대략", "대략적으로", "거의", "대충", "얼추", "최대", "최소", "적어도"];
const RATIO_SUFFIX = ["정도", "쯤", "가량", "내외", "전후", "미만", "이하", "초과", "이상", "안팎"];
const DELAY_SUFFIX = ["정도", "쯤", "가량", "내외", "전후", "이내", "이상", "미만", "안에", "반"];

test("A: ratio modifier matrix — every prefix/suffix around 30프로 is blocked (no NL execution)", () => {
  let n = 0;
  for (const pre of MAG_PREFIX) {
    const s = `수출 매출이 ${pre} 30프로 감소하면?`;
    assert.ok(hasMagnitudeMarker(s), s);
    const { intent, gate } = run(s);
    assert.equal(gate.ok, false, s);
    assert.equal(intent.steps.length, 0, s);
    n += 1;
  }
  for (const suf of RATIO_SUFFIX) {
    const s = `수출 매출이 30프로 ${suf} 감소하면?`;
    const { intent, gate } = run(s);
    assert.equal(gate.ok, false, s);
    assert.equal(intent.steps.length, 0, s);
    n += 1;
  }
  assert.ok(n >= 18, `ran ${n}`);
});

test("A: delay modifier matrix — every prefix/suffix around 한 달 is blocked", () => {
  let n = 0;
  for (const pre of MAG_PREFIX) {
    const s = `미국 거래처 입금이 ${pre} 한 달 늦으면?`;
    const { intent, gate } = run(s);
    assert.equal(gate.ok, false, s);
    assert.equal(intent.steps.length, 0, s);
    n += 1;
  }
  for (const suf of DELAY_SUFFIX) {
    const s = `미국 거래처 입금이 한 달 ${suf} 늦으면?`;
    const { intent, gate } = run(s);
    assert.equal(gate.ok, false, s);
    assert.equal(intent.steps.length, 0, s);
    n += 1;
  }
  assert.ok(n >= 18, `ran ${n}`);
});

test("A: explicit exact / interval / korean-numeral / multiple magnitudes are all blocked", () => {
  for (const s of [
    "수출 매출이 30% 감소하면?", "환율이 5% 불리해지면?", "미국 거래처 입금이 1개월 늦으면?",
    "미국 거래처 입금이 한 달 늦으면?", "수출 매출이 30프로 감소하면?", "수출 매출이 30퍼센트 감소하면?",
    "수출 매출이 20프로부터 30프로까지 감소하면?", "미국 거래처 입금이 한 달부터 두 달까지 늦으면?",
    "수출 매출이 이십 퍼센트 감소하면?", "미국 거래처 입금이 두 달 늦으면?", "수출 매출이 몇 프로 감소하면?",
    "미국 거래처 입금이 수개월 늦으면?", "수출 매출이 두 배 감소하면?", "수출 매출이 절반으로 감소하면?",
    "수출 매출이 반으로 감소하면?", "수출 매출이 반만큼 감소하면?", "수출 매출이 반토막 나면?",
    "수출 매출이 두 배로 감소하면?", "수출 매출이 두 배가 되면?", "수출 매출이 세배만큼 감소하면?",
    "미국 거래처 입금이 30일 늦으면?", "미국 거래처 입금이 일주일 늦으면?",
  ]) {
    const { intent, gate } = run(s);
    assert.equal(gate.ok, false, s);
    assert.equal(intent.steps.length, 0, s);
    assert.match(intent.unsupportedSegments.map((u) => u.reason).join(" "), /고정 시나리오 프리셋|숫자·기간/, s);
  }
});

test("A: half/multiple markers use token boundaries without blocking ordinary compound words", () => {
  for (const s of [
    "수출 매출이 반으로 감소하면?",
    "수출 매출이 반만큼 감소하면?",
    "수출 매출이 반토막 나면?",
    "수출 매출이 두 배로 감소하면?",
    "수출 매출이 두 배가 되면?",
    "수출 매출이 세배만큼 감소하면?",
  ]) assert.equal(hasMagnitudeMarker(s), true, s);

  for (const s of [
    "일반적으로 수출 매출이 감소하면?",
    "반도체 수출 매출이 감소하면?",
    "선배로부터 수출 매출 감소를 들으면?",
    "배로 운송한 수출 매출이 감소하면?",
  ]) assert.equal(hasMagnitudeMarker(s), false, s);
});

// ---------------- Group B: magnitude-free NL parses intent + target and runs via preset ----------------
test("B: magnitude-free sentences parse intent+target and execute the FIXED preset scenario", () => {
  const delay = run("미국 거래처 입금이 늦으면?");
  assert.equal(delay.gate.ok, true);
  assert.equal(delay.gate.execution.scenarioId, presetScenarioIdFor("payment_delay"));
  assert.equal(delay.gate.execution.scenarioId, "payment_delay_1m");
  assert.equal(delay.gate.execution.options.targetTransactionId, "tx-1");

  const drop = run("수출 매출이 감소하면?");
  assert.equal(drop.gate.ok, true);
  assert.equal(drop.gate.execution.scenarioId, "revenue_drop_30");

  const fx = run("환율이 불리해지면?");
  assert.equal(fx.gate.ok, true);
  assert.equal(fx.gate.execution.scenarioId, "adverse_fx_5");
});

test("B: the parser's intent steps carry NO magnitude params", () => {
  const intent = parseScenarioIntent("수출 매출이 감소하면?", ctx);
  assert.equal(intent.magnitudeSource, "fixed_preset");
  assert.equal(intent.steps.length, 1);
  assert.equal("params" in intent.steps[0], false);
  assert.deepEqual(Object.keys(intent.steps[0]).sort(), ["target", "type"]);
});

test("B: preset labels come from the single source and match the engine scenarios", () => {
  assert.equal(presetLabelFor("payment_delay"), "1개월");
  assert.equal(presetLabelFor("receivable_drop"), "30%");
  assert.equal(presetLabelFor("adverse_fx"), "5%");
});

// ---------------- Group C: invariants ----------------
test("C: the parser source never builds params (pct/months) and hardcodes no preset numbers", () => {
  assert.doesNotMatch(parserSrc, /params\s*:\s*\{\s*pct/);
  assert.doesNotMatch(parserSrc, /params\s*:\s*\{\s*months/);
  assert.doesNotMatch(parserSrc, /0\.30|0\.05/);
});

test("C: the preset adapter only ever emits allowlisted params from the fixed presets", () => {
  const intent = parseScenarioIntent("수출 매출이 감소하면?", ctx);
  const plan = buildPresetPlan(intent);
  assert.deepEqual(plan.steps[0].params, { pct: 0.30 });
  assert.deepEqual(buildPresetPlan(parseScenarioIntent("환율이 불리해지면?", ctx)).steps[0].params, { pct: 0.05 });
  assert.deepEqual(buildPresetPlan(parseScenarioIntent("미국 거래처 입금이 늦으면?", ctx)).steps[0].params, { months: 1 });
});

test("C: no preset id → no execution; parsing is deterministic (byte-identical)", () => {
  // an unmatched sentence yields no step → the adapter emits no runnable plan
  assert.equal(run("오늘 날씨 어때?").gate.ok, false);
  for (const s of ["미국 거래처 입금이 늦으면?", "수출 매출이 30% 감소하면?", "USD 수취 거래가 지연되면?"])
    assert.equal(JSON.stringify(parseScenarioIntent(s, ctx)), JSON.stringify(parseScenarioIntent(s, ctx)), s);
});

// ---------------- Group D: target resolution, negation, context, chooser ----------------
test("D: target resolution — single / ambiguous / not-found / conflict (magnitude-free)", () => {
  assert.equal(run("미국 거래처 입금이 늦으면?").gate.execution.options.targetTransactionId, "tx-1");

  const ambiguous = run("USD 수취 거래가 지연되면?");
  assert.equal(ambiguous.gate.ok, false);
  assert.ok(ambiguous.gate.missingFacts.length >= 1);
  // picking a candidate then runs the fixed preset on that target
  assert.equal(run("USD 수취 거래가 지연되면?", "tx-2").gate.execution.options.targetTransactionId, "tx-2");

  const none = run("독일 EUR 수취 거래 입금이 늦으면?");
  assert.equal(none.gate.ok, false);
  assert.equal(none.gate.missingFacts.length, 0);
  assert.match(none.gate.unsupportedSegments.map((u) => u.reason).join(" "), /일치하는 수취 거래가 없습니다/);

  assert.equal(run("미국 베트남 수취 거래 입금이 늦으면?").gate.ok, false);
});

test("D: resolveReceivableCandidates applies country/currency before 가장 큰; only matching are shown", () => {
  assert.equal(resolveReceivableCandidates("독일 EUR 중 가장 큰 수취 거래", txns).status, "none");
  assert.equal(resolveReceivableCandidates("미국 USD 중 가장 큰 수취 거래", txns).transaction_id, "tx-1");
  assert.equal(resolveReceivableCandidates("USD 중 가장 큰 수취 거래", txns).transaction_id, "tx-1");
  const usd = resolveReceivableCandidates("USD 수취 거래가 지연되면?", txns);
  assert.equal(usd.status, "many");
  assert.deepEqual(usd.candidates.map((c) => c.transaction_id).sort(), ["tx-1", "tx-2"]);
});

test("D: expanded country aliases resolve a matching receivable without hardcoded country branches", () => {
  const brazil = [
    { transaction_id: "br-1", direction: "in", currency: "BRL", amount: 100000, country: "BR", months: 3 },
    { transaction_id: "us-1", direction: "in", currency: "USD", amount: 200000, country: "US", months: 3 },
  ];
  const countryAliases = { 브라질: "BR", 미국: "US" };
  const resolved = resolveReceivableCandidates(
    "브라질 거래처 입금이 늦으면?",
    brazil,
    countryAliases,
  );
  assert.equal(resolved.status, "one");
  assert.equal(resolved.transaction_id, "br-1");

  const intent = parseScenarioIntent("브라질 거래처 입금이 늦으면?", {
    transactions: brazil,
    intents,
    countryAliases,
  });
  assert.equal(intent.steps[0].target.transaction_id, "br-1");
});

test("D: malformed country alias catalogs fail closed without throwing", () => {
  for (const countryAliases of [
    [],
    { 브라질: "bad" },
    { "": "BR" },
    { 브라질: 1 },
  ]) {
    const output = parseScenarioIntent("입금이 늦으면?", {
      transactions: txns,
      intents,
      countryAliases,
    });
    assert.equal(output.steps.length, 0);
    assert.ok(output.unsupportedSegments.length > 0);
  }
});

test("D: negations and unmatched sentences are fail-closed", () => {
  for (const s of ["수출 매출이 감소하지 않으면?", "입금이 늦지 않으면?", "환율이 불리하지 않으면?"]) {
    const { intent, gate } = run(s);
    assert.equal(gate.ok, false, s);
    assert.equal(intent.steps.length, 0, s);
  }
  assert.equal(run("금리를 올리면 대출이자가 얼마야?").gate.ok, false);
});

test("D: date/compound words are NOT magnitude markers and stay magnitude-free", () => {
  for (const s of ["미국 거래처 입금일이 지연되면?", "미국 거래처 결제일이 지연되면?", "미국 거래처 약정 입금이 늦으면?"]) {
    assert.equal(hasMagnitudeMarker(s), false, s);
    assert.equal(run(s).gate.ok, true, s);
  }
  assert.equal(hasMagnitudeMarker("프로그램 도입 후 매출이 감소하면?"), false);
  assert.equal(run("프로그램 도입 후 매출이 감소하면?").gate.ok, true);
  // 일본 is a country (no receivable here), not a period
  const jp = [{ transaction_id: "j1", direction: "in", currency: "JPY", amount: 1000000, country: "JP", months: 2 }];
  const r = validatePlan(buildPresetPlan(parseScenarioIntent("일본 거래처 입금이 늦으면?", { transactions: jp, intents })), { transactions: jp });
  assert.equal(r.ok, true);
  assert.equal(r.execution.options.targetTransactionId, "j1");
});

test("D: parseScenarioIntent fails closed on malformed context (never throws)", () => {
  for (const bad of [null, "x", 7, [], () => {}, true]) {
    let out, threw = false;
    try { out = parseScenarioIntent("입금이 늦으면?", bad); } catch { threw = true; }
    assert.ok(!threw, `threw for ${String(bad)}`);
    assert.equal(out.steps.length, 0);
    assert.ok(out.unsupportedSegments.length >= 1);
  }
  assert.equal(parseScenarioIntent("입금이 늦으면?", { transactions: "nope", intents }).steps.length, 0);
});

test("fixtures cover the three types with example utterances", () => {
  const types = new Set(intents.intents.map((i) => i.type));
  for (const t of ["payment_delay", "receivable_drop", "adverse_fx"]) assert.ok(types.has(t), t);
  for (const i of intents.intents) {
    assert.ok(Array.isArray(i.keywords) && i.keywords.length >= 1, `${i.type} keywords`);
    assert.ok(Array.isArray(i.examples) && i.examples.length >= 1, `${i.type} examples`);
    for (const example of i.examples)
      assert.equal(hasMagnitudeMarker(example), false, `${i.type} fixture must be magnitude-free: ${example}`);
  }
});
