import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import * as ui from "../js/ui.js";

const read = (relativePath) =>
  readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");

test("executive summary chooses the largest exposure by KRW value, not foreign units", () => {
  assert.equal(typeof ui.buildExecutiveSummary, "function");

  const result = ui.buildExecutiveSummary({
    netRows: [
      { currency: "USD", net: 100, receivable: 100, payable: 0 },
      { currency: "JPY", net: 1000, receivable: 1000, payable: 0 },
    ],
    rates: { USD: 1400, JPY: 9 },
    scenarios: [
      { delta: -0.1, totalPnl: -14000 },
      { delta: 0.05, totalPnl: 7000 },
    ],
    cfarTotal: 1000,
    strategies: [
      { key: "안정형", hedgeRatio: 0.9, residualCFaR: 145, hedgeCost: 10, assumptionsLabel: "데모 가정" },
      { key: "균형형", hedgeRatio: 0.6, residualCFaR: 430, hedgeCost: 7, assumptionsLabel: "데모 가정" },
    ],
    candidates: [{ product_id: "fx_insurance" }],
    shortfalls: [],
  });

  assert.equal(result.largestRisk.currency, "USD");
  assert.equal(result.largestRisk.krwNotional, 140000);
  assert.equal(result.worstScenario.delta, -0.1);
  assert.equal(result.worstScenario.totalPnl, -14000);
});

test("executive summary has exactly three actions and keeps CFaR effect separate from cost", () => {
  const result = ui.buildExecutiveSummary({
    netRows: [{ currency: "USD", net: 200000, receivable: 300000, payable: 100000 }],
    rates: { USD: 1385.5 },
    scenarios: [{ delta: -0.1, totalPnl: -27710000 }],
    cfarTotal: 45066367,
    strategies: [{
      key: "안정형",
      hedgeRatio: 0.9,
      residualCFaR: 6534623,
      hedgeCost: 1820837,
      assumptionsLabel: "데모용 예시 가정",
    }],
    candidates: [{ product_id: "fx_insurance" }, { product_id: "trade_loan" }],
    shortfalls: [{ months: 2, shortfallKrw: 38550000 }],
  });

  assert.equal(result.actions.length, 3);
  assert.equal(result.effect.strategyKey, "안정형");
  assert.equal(result.effect.beforeCFaR, 45066367);
  assert.equal(result.effect.afterCFaR, 6534623);
  assert.equal(result.effect.reductionKrw, 38531744);
  assert.equal(result.effect.hedgeCost, 1820837);
  assert.ok(result.effect.reductionKrw > 0);
  assert.doesNotMatch(JSON.stringify(result), /예상손실|손실\s*상한|score|rank/);
});

test("results put the action plan first and keep detailed calculations collapsed by default", async () => {
  const source = await read("js/ui.js");

  for (const label of ["내 기업의 금융 액션 플랜", "가장 큰 위험", "권장 행동", "예상 효과"])
    assert.ok(source.includes(label), label);
  assert.match(source, /class="card executive-summary action-plan-hero"/);
  assert.match(source, /<details class="results-details">/);
  assert.doesNotMatch(source, /<details class="results-details"\s+open/);
  for (let section = 1; section <= 6; section += 1)
    assert.ok(source.includes(`<h2 class="step-title">${section}.`), `section ${section}`);
});

test("TradePilot naming and discarded combined-risk wording stay clean", async () => {
  const sources = await Promise.all(
    ["index.html", "js/main.js", "js/ui.js"].map(read),
  );
  const joined = sources.join("\n");

  assert.doesNotMatch(joined, /TradeGuard/);
  assert.doesNotMatch(joined, /예상손실|손실\s*상한|비교용 위험·비용 지표/);
});
