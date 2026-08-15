// T4.7: bad input is rejected before it becomes a "user-confirmed value", errors are classified
// by cause, and the calculation API refuses malformed arguments with a typed error.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { CalculationError, errorTitle, ERROR_KIND } from "../js/errors.js";
import { validateLiquidity } from "../js/validate.js";
import { computeCFaRBuckets, hedgeCostLoss, liquidityTimeline } from "../js/risk.js";
import { ruleCounterExamples } from "../js/counter.js";
import { compareStrategies } from "../js/strategy.js";

const rates = { USD: 1385.5 };
const vol = { USD: 0.08 };
const flow = [{ currency: "USD", direction: "in", amount: 100000, months: 3 }];

// --- 1. liquidity is validated before the confirm screen -------------------------------------
test("negative / NaN / Infinity liquidity inputs are rejected up front", () => {
  for (const bad of ["-1", "abc", "Infinity", "-0.5"]) {
    const r = validateLiquidity({ openingBalanceKrw: bad, creditLineKrw: "0" });
    assert.equal(r.ok, false, `openingBalance=${bad}`);
    assert.ok(r.errors.some((e) => /기초 현금잔고/.test(e)));
  }
  for (const bad of ["-1", "abc", "Infinity"]) {
    const r = validateLiquidity({ openingBalanceKrw: "0", creditLineKrw: bad });
    assert.equal(r.ok, false, `creditLine=${bad}`);
    assert.ok(r.errors.some((e) => /신용한도/.test(e)));
  }
});

test("blank means 'not provided' and normalizes to 0; valid numbers pass through", () => {
  const blank = validateLiquidity({ openingBalanceKrw: "", creditLineKrw: "" });
  assert.equal(blank.ok, true);
  assert.deepEqual(blank.normalized, { openingBalanceKrw: 0, creditLineKrw: 0 });
  const ok = validateLiquidity({ openingBalanceKrw: "100000000", creditLineKrw: "60000000" });
  assert.deepEqual(ok.normalized, { openingBalanceKrw: 100000000, creditLineKrw: 60000000 });
});

// --- 2. errors are classified by cause --------------------------------------------------------
test("error titles distinguish market data, user input and calculation settings", () => {
  assert.equal(errorTitle(new CalculationError("MISSING_RATE", "x")), "필수 시장데이터가 없어 계산할 수 없습니다");
  assert.equal(errorTitle(new CalculationError("INVALID_VOLATILITY", "x")), "필수 시장데이터가 없어 계산할 수 없습니다");
  assert.equal(errorTitle(new CalculationError("INVALID_AMOUNT", "x")), "입력값이 올바르지 않아 계산할 수 없습니다");
  assert.equal(errorTitle(new CalculationError("INVALID_BUFFER", "x")), "입력값이 올바르지 않아 계산할 수 없습니다");
  assert.equal(errorTitle(new CalculationError("INVALID_HEDGE_RATIO", "x")), "계산 가정 또는 설정이 올바르지 않습니다");
  assert.equal(errorTitle(new CalculationError("INVALID_Z", "x")), "계산 가정 또는 설정이 올바르지 않습니다");
});

test("every declared code has a kind, and a user-input error is never shown as missing market data", () => {
  for (const [code, kind] of Object.entries(ERROR_KIND)) {
    assert.ok(["market_data", "user_input", "configuration"].includes(kind), `${code} -> ${kind}`);
  }
  for (const code of ["INVALID_AMOUNT", "INVALID_MONTHS", "INVALID_DIRECTION", "INVALID_BUFFER", "INVALID_CASHFLOW", "INVALID_CASHFLOWS"]) {
    assert.equal(ERROR_KIND[code], "user_input", code);
  }
});

// --- 3. calculation API defends its own arguments ---------------------------------------------
test("z must be a finite positive number", () => {
  for (const bad of [0, -1.645, NaN, Infinity, "1.645", null]) {
    assert.throws(() => computeCFaRBuckets(flow, rates, vol, { z: bad }),
      (e) => e instanceof CalculationError && e.code === "INVALID_Z", `z=${bad}`);
  }
});

test("cashflows must be an array", () => {
  for (const bad of [null, undefined, {}, "flows", 3]) {
    assert.throws(() => computeCFaRBuckets(bad, rates, vol, {}),
      (e) => e instanceof CalculationError && e.code === "INVALID_CASHFLOWS", `cashflows=${bad}`);
    assert.throws(() => liquidityTimeline(bad, rates, {}),
      (e) => e instanceof CalculationError && e.code === "INVALID_CASHFLOWS", `cashflows=${bad}`);
  }
});

test("each cashflow must be a non-null object (never a raw TypeError)", () => {
  for (const bad of [null, undefined, "USD", 42, []]) {
    assert.throws(() => computeCFaRBuckets([bad], rates, vol, {}),
      (e) => e instanceof CalculationError && e.code === "INVALID_CASHFLOW" && !(e instanceof TypeError), `row=${bad}`);
  }
});

test("hedgeCostLoss rejects a malformed options object with a typed error (not a TypeError)", () => {
  // T5.0 tightened this: an explicit null options is caught earlier as INVALID_OPTIONS
  // (more precise than the previous INVALID_HEDGE_RATIO), while a valid options object with a
  // missing hedgeRatio is still INVALID_HEDGE_RATIO.
  assert.throws(() => hedgeCostLoss(1000, 1000, null),
    (e) => e instanceof CalculationError && e.code === "INVALID_OPTIONS");
  assert.throws(() => hedgeCostLoss(1000, 1000, {}),
    (e) => e instanceof CalculationError && e.code === "INVALID_HEDGE_RATIO");
  assert.throws(() => compareStrategies(1000, 1000, { assumptions: null }),
    (e) => e instanceof CalculationError && e.code === "INVALID_ASSUMPTIONS");
});

// --- 4. counter-example wording ----------------------------------------------------------------
test("the counter-examples no longer claim a hedge freezes the outcome", async () => {
  const src = await readFile(new URL("../js/counter.js", import.meta.url), "utf8");
  assert.ok(!/손익이 거의 고정됩니다/.test(src));
  const answers = ruleCounterExamples(compareStrategies(1000000, 277100000)).map((c) => c.a).join("\n");
  assert.match(answers, /환율 변동 영향이 크게 줄지만 잔여 위험은 남습니다/);
});

test("options are compared on cost and flexibility, not offered as a liquidity fix", async () => {
  const src = await readFile(new URL("../js/counter.js", import.meta.url), "utf8");
  assert.ok(!/유동성이 필요하면 옵션/.test(src), "options must not be presented as a liquidity alternative");
  const answers = ruleCounterExamples(compareStrategies(1000000, 277100000)).map((c) => c.a).join("\n");
  assert.match(answers, /중도 해지/);
  assert.match(answers, /비용/);
  assert.match(answers, /유연성/);
  assert.match(answers, /외화대출|무역금융/);
});

test("환변동보험 is never asserted as an automatic fallback without an eligibility check", async () => {
  const src = await readFile(new URL("../js/counter.js", import.meta.url), "utf8");
  assert.ok(!/대체 상품\(환변동보험 등\)으로 폴백합니다/.test(src));
  const answers = ruleCounterExamples(compareStrategies(1000000, 277100000)).map((c) => c.a).join("\n");
  assert.match(answers, /자격/);
});

// --- T5.0: options contract (undefined=defaults; explicit null/array/non-object rejected) ------
test("T5.0: omitting options uses defaults (undefined is allowed)", () => {
  assert.doesNotThrow(() => computeCFaRBuckets(flow, rates, vol));
  assert.doesNotThrow(() => liquidityTimeline(flow, rates));
  assert.doesNotThrow(() => hedgeCostLoss(1000000, 1000000, { hedgeRatio: 0.9 }));
});

test("T5.0: explicit null / array / non-object options is INVALID_OPTIONS, never a TypeError", () => {
  const badOptions = [null, [], "x", 3, true];
  for (const bad of badOptions) {
    for (const [label, call] of [
      ["computeCFaRBuckets", () => computeCFaRBuckets(flow, rates, vol, bad)],
      ["liquidityTimeline", () => liquidityTimeline(flow, rates, bad)],
      ["hedgeCostLoss", () => hedgeCostLoss(1000, 1000, bad)],
      ["compareStrategies", () => compareStrategies(1000, 1000, bad)],
    ]) {
      assert.throws(
        call,
        (e) => e instanceof CalculationError && e.code === "INVALID_OPTIONS" && !(e instanceof TypeError),
        `${label} options=${JSON.stringify(bad)}`
      );
    }
  }
});

test("T5.0: INVALID_OPTIONS is classified as a configuration error", () => {
  assert.equal(ERROR_KIND.INVALID_OPTIONS, "configuration");
  assert.equal(errorTitle(new CalculationError("INVALID_OPTIONS", "x")), "계산 가정 또는 설정이 올바르지 않습니다");
});

test("T5.0: no calculation function uses the silent `options || {}` idiom", async () => {
  for (const f of ["risk.js", "strategy.js"]) {
    const src = await readFile(new URL(`../js/${f}`, import.meta.url), "utf8");
    assert.ok(!/options\s*\|\|\s*\{\}/.test(src), `${f} must use requireOptions, not options || {}`);
  }
});
