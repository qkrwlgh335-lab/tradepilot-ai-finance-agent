import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { STRATEGIES, DEFAULT_ASSUMPTIONS, compareStrategies } from "../js/strategy.js";

const src = (p) => readFile(new URL(`../${p}`, import.meta.url), "utf8");

test("three fixed strategies with hedge ratios 0.9/0.6/0.3", () => {
  assert.deepEqual(STRATEGIES.map((s) => s.hedgeRatio), [0.9, 0.6, 0.3]);
  assert.deepEqual(STRATEGIES.map((s) => s.key), ["안정형", "균형형", "기회추구형"]);
});

test("compareStrategies returns a row per strategy with residual risk and hedge cost kept apart", () => {
  const rows = compareStrategies(1000000, 277100000);
  assert.equal(rows.length, 3);
  assert.ok(rows[0].residualCFaR < rows[2].residualCFaR);
  assert.ok(rows[0].hedgeCost > rows[2].hedgeCost);
  // no combined score: the user weighs the two numbers themselves
  for (const r of rows) assert.ok(!("comparisonIndex" in r), `${r.key} must not carry a combined figure`);
});

// A loss cap without an option premium, a strike and a payoff structure is not a hedge —
// it just deletes risk from the arithmetic. The claim and the flag are both gone.
test("no loss-cap flag, logic, or wording survives in the strategy module", async () => {
  const code = await src("js/strategy.js");
  assert.ok(!/lossCap/i.test(code), "no lossCap flag or field");
  assert.ok(!/손실\s?상한/.test(code), "no 손실 상한 wording");
  for (const s of STRATEGIES) assert.ok(!("lossCap" in s), `${s.key} must not carry a lossCap flag`);
  for (const r of compareStrategies(1000000, 277100000)) {
    assert.ok(!("lossCapKrw" in r), "no capped-loss field");
    assert.ok(!("expectedLoss" in r) && !("total" in r), "no expectedLoss / generic total");
  }
});

test("the UI shows risk and cost as separate columns and offers no combined score", async () => {
  const ui = await src("js/ui.js");
  assert.match(ui, /잔여 위험/);
  assert.match(ui, /헤지 비용/);
  assert.ok(!/comparisonIndex/.test(ui), "no combined figure in the UI");
  assert.match(ui, /합산하지 않습니다/);
  assert.match(ui, /최적 전략” 선정은 제공하지 않으며|자동 순위/);
});

test("the opportunistic strategy is described by its real trade-off, not by a fake cap", () => {
  const opp = STRATEGIES.find((s) => s.key === "기회추구형");
  // direction-neutral: an importer's "favourable" move is the opposite of an exporter's
  assert.equal(opp.desc, "헤지율을 낮춰 유리한 환율 움직임의 이익 가능성을 유지하지만 잔여 위험이 큼");
  assert.ok(!/상승/.test(opp.desc), "must not assume the rate goes up");
});

test("a lower hedge ratio really does leave more residual risk (nothing flattens it)", () => {
  const rows = compareStrategies(100_000_000, 500_000_000);
  const [stable, balanced, opp] = rows;
  assert.ok(stable.residualCFaR < balanced.residualCFaR);
  assert.ok(balanced.residualCFaR < opp.residualCFaR);
});

test("hedge effectiveness and cost are declared demo assumptions, surfaced on every row", () => {
  assert.equal(DEFAULT_ASSUMPTIONS.hedgeEff, 0.95);
  assert.equal(DEFAULT_ASSUMPTIONS.costRate, 0.003);
  assert.match(DEFAULT_ASSUMPTIONS.label, /데모용 예시 가정/);
  assert.match(DEFAULT_ASSUMPTIONS.label, /실제 상품 조건 아님/);
  for (const r of compareStrategies(1000000, 277100000)) assert.equal(r.assumptionsLabel, DEFAULT_ASSUMPTIONS.label);
});

test("caller-supplied assumptions override the demo defaults", () => {
  const rows = compareStrategies(1000000, 277100000, {
    assumptions: { hedgeEff: 0.8, costRate: 0.005, label: "상품별 실제 조건" },
  });
  assert.equal(rows[0].assumptionsLabel, "상품별 실제 조건");
  assert.equal(Math.round(rows[0].hedgeCost), Math.round(277100000 * 0.005 * 0.9));
});

test("the UI never uses the discarded loss wording and always surfaces the assumptions", async () => {
  const ui = await src("js/ui.js");
  assert.ok(!/예상손실/.test(ui), "no 예상손실 in the UI");
  assert.ok(!/손실\s?상한/.test(ui), "no 손실 상한 in the UI");
  assert.match(ui, /데모용 예시 가정|assumptionsLabel/);
});
