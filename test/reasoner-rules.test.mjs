import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { OPERATORS, evaluateRule, resolveFact } from "../js/reasoner.js";

const baseRule = (patch = {}) => ({
  rule_id: "rule:test",
  product_id: "brand_new",
  field: "eligibility.test",
  fact_path: "company.testValue",
  operator: "eq",
  value: "ok",
  required: true,
  failure_reason: "공식 조건을 충족하지 않습니다.",
  missing_info_question: "판정에 필요한 정보를 입력해 주세요.",
  source_id: "src:test",
  ...patch,
});

const profile = (company = {}, patch = {}) => ({
  facts: { company },
  transactions: [],
  exposures: [],
  derived: {},
  ...patch,
});

test("a missing fact yields unknown, never pass", () => {
  const result = evaluateRule(
    baseRule({
      fact_path: "company.isSme",
      operator: "is_true",
      value: undefined,
      missing_info_question: "중소기업 여부를 선택해 주세요.",
    }),
    profile({})
  );

  assert.equal(result.status, "unknown");
  assert.match(result.question, /중소기업/);
  assert.equal(result.actual, undefined);
});

test("pass and fail carry the actual value, source, and official failure reason", () => {
  const rule = baseRule({
    fact_path: "exposure.maxNetExposureUsd",
    operator: "gte",
    value: 1_000_000,
    failure_reason: "순노출이 공식 최소 거래금액 미만입니다.",
    source_id: "src:official",
  });

  const pass = evaluateRule(rule, profile({}, { derived: { maxNetExposureUsd: 1_250_000 } }));
  const fail = evaluateRule(rule, profile({}, { derived: { maxNetExposureUsd: 300_000 } }));

  assert.equal(pass.status, "pass");
  assert.equal(pass.actual, 1_250_000);
  assert.equal(pass.source_id, "src:official");
  assert.equal(fail.status, "fail");
  assert.equal(fail.actual, 300_000);
  assert.equal(fail.source_id, "src:official");
  assert.match(fail.reason, /공식 최소 거래금액/);
});

test("operators are table-driven and the reasoner has no product-specific branch", async () => {
  const source = await readFile(new URL("../js/reasoner.js", import.meta.url), "utf8");
  for (const operator of [
    "eq", "neq", "gt", "gte", "lt", "lte", "in", "not_in",
    "includes_any", "subset_of", "between", "is_true", "is_false",
    "date_within", "lte_by",
  ]) assert.equal(typeof OPERATORS[operator], "function", operator);

  assert.ok(
    !/["'](prod:)?(fwd|option|swap|trade_loan|fx_insurance|export_nego|import_lc|policy_fund|ecg_pre)["']/.test(source),
    "reasoner must not branch on a product id"
  );
});

test("a brand-new product rule works from data without a code change", () => {
  const rule = baseRule({
    rule_id: "rule:brand-new-minimum",
    product_id: "brand_new",
    fact_path: "exposure.maxNetExposureUsd",
    operator: "gte",
    value: 1_000,
  });
  const result = evaluateRule(rule, profile({}, { derived: { maxNetExposureUsd: 300_000 } }));
  assert.equal(result.status, "pass");
});

test("export-only horizon ignores longer import transactions and never infers from direction", () => {
  const value = resolveFact(profile({}, {
    transactions: [
      { tradeType: "export", direction: "in", months: 12 },
      { tradeType: "import", direction: "out", months: 24 },
      { tradeType: "import", direction: "in", months: 36 },
    ],
  }), "exposure.maxExportHorizonMonths");

  assert.equal(value, 12);
  assert.equal(resolveFact(profile({}, {
    transactions: [{ tradeType: "import", direction: "in", months: 36 }],
  }), "exposure.maxExportHorizonMonths"), undefined);
});

test("companyScale derives only SME=true; false and explicit unknown stay unknown", () => {
  assert.equal(resolveFact(profile({ isSme: true }), "company.companyScale"), "sme");
  assert.equal(resolveFact(profile({ isSme: false }), "company.companyScale"), undefined);
  assert.equal(resolveFact(profile({ companyScale: "mid_market" }), "company.companyScale"), "mid_market");
  assert.equal(resolveFact(profile({ companyScale: "unknown" }), "company.companyScale"), undefined);
});

test("context and product paths are resolved without inventing defaults", () => {
  const input = profile({}, {
    context: { today: "2026-07-26" },
    product: { effective: true },
  });
  assert.equal(resolveFact(input, "context.today"), "2026-07-26");
  assert.equal(resolveFact(input, "product.effective"), true);
  assert.equal(resolveFact(input, "context.missing"), undefined);
  assert.equal(resolveFact({}, "context.today"), undefined);
});

test("lte_by resolves its selector fact and returns unknown when selector is unavailable", () => {
  const rule = baseRule({
    fact_path: "company.priorYearExportUsd",
    operator: "lte_by",
    value: {
      selector_fact_path: "company.companyScale",
      thresholds: { sme: 1_250_000, mid_market: 1_750_000 },
    },
  });

  assert.equal(evaluateRule(rule, profile({
    priorYearExportUsd: 1_250_000,
    companyScale: "sme",
  })).status, "pass");
  assert.equal(evaluateRule(rule, profile({
    priorYearExportUsd: 1_250_001,
    companyScale: "sme",
  })).status, "fail");
  assert.equal(evaluateRule(rule, profile({
    priorYearExportUsd: 1_600_000,
    isSme: false,
  })).status, "unknown");
  assert.equal(evaluateRule(rule, profile({
    priorYearExportUsd: 1_600_000,
    isSme: false,
  })).missing_fact_path, "company.companyScale");
});

test("all operator families have deterministic pass/fail semantics", () => {
  const cases = [
    ["eq", "A", "A", true],
    ["neq", "A", "B", true],
    ["gt", 3, 2, true],
    ["gte", 2, 2, true],
    ["lt", 1, 2, true],
    ["lte", 2, 2, true],
    ["in", "sme", ["sme", "mid_market"], true],
    ["not_in", "other", ["sme", "mid_market"], true],
    ["includes_any", ["USD", "EUR"], ["JPY", "EUR"], true],
    ["subset_of", ["USD"], ["USD", "EUR"], true],
    ["between", 5, [1, 5], true],
    ["is_true", true, undefined, true],
    ["is_false", false, undefined, true],
    ["date_within", "2026-07-26", { from: "2026-01-01", to: "2099-12-31" }, true],
  ];

  for (const [operator, actual, expected, shouldPass] of cases) {
    const rule = baseRule({ operator, value: expected });
    const result = evaluateRule(rule, profile({ testValue: actual }));
    assert.equal(result.status, shouldPass ? "pass" : "fail", operator);
  }
});

test("malformed or unsupported rules fail closed as unknown and never throw", () => {
  for (const rule of [
    null,
    {},
    baseRule({ operator: "made_up" }),
    baseRule({ fact_path: "" }),
  ]) {
    const result = evaluateRule(rule, profile({ testValue: "ok" }));
    assert.equal(result.status, "unknown");
    assert.equal(result.configuration_error, true);
  }
});

test("a malformed actual fact is unknown, not a false customer rejection", () => {
  const cases = [
    baseRule({ fact_path: "company.testValue", operator: "lte", value: 10 }),
    baseRule({ fact_path: "company.testValue", operator: "is_true", value: undefined }),
    baseRule({
      fact_path: "company.testValue",
      operator: "date_within",
      value: { from: "2025-01-01", to: "2030-01-01" },
    }),
    baseRule({ fact_path: "company.testValue", operator: "includes_any", value: ["USD"] }),
  ];
  const malformed = ["10", "true", "2026-99-99", "USD"];

  cases.forEach((rule, index) => {
    const result = evaluateRule(rule, profile({ testValue: malformed[index] }));
    assert.equal(result.status, "unknown");
  });
});
