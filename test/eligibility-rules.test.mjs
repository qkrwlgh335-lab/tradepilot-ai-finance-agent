// T6.3: source-backed eligibility rules with closed-world activation.
// Each rule's field must be a supported_field of an ACTIVE product_terms source scoped to the same
// product; fact_path is where the profile fact lives. Negative fixtures are fed straight to
// validateProductKnowledge (not asserted by walking the JSON).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { validateProductKnowledge } from "../js/reasoner.js";

const load = async (p) => JSON.parse(await readFile(new URL(`../${p}`, import.meta.url), "utf8"));
const SCHEMA = await load("data/ontology-schema.json");
const SRC = (await load("data/source-registry.json")).sources;
const RULES = await load("data/eligibility-rules.json");
const REG_FIELDS = ["rule_id", "product_id", "field", "fact_path", "operator", "required", "failure_reason", "missing_info_question", "source_id"];
const VALUE_OPS = new Set(SCHEMA.operators.filter((op) => op !== "is_true" && op !== "is_false"));

// A single-product graph (fwd) that declares available and requires one rule, so a broken rule shows up.
const fwdGraph = (requiresId, status = "available") => ({
  nodes: [
    { id: "inst:demo_bank", type: "Institution", name: "KB" },
    { id: "risk:fx_rate", type: "Risk", name: "fx" },
    { id: "purpose:fx_hedge", type: "Purpose", name: "환헤지" },
    { id: "prod:fwd", product_id: "fwd", type: "FinancialProduct", name: "선물환", category: "환헤지", productKnowledgeStatus: status },
  ],
  edges: [
    { from: "prod:fwd", rel: "providedBy", to: "inst:demo_bank" },
    { from: "prod:fwd", rel: "mitigates", to: "risk:fx_rate" },
    { from: "prod:fwd", rel: "supportsPurpose", to: "purpose:fx_hedge" },
    { from: "prod:fwd", rel: "requires", to: requiresId },
    { from: "prod:fwd", rel: "supportedBy", to: "src:demo-forward" },
  ],
});
// A fully valid rule that can activate fwd (field is a supported_field of src:demo-forward).
const okRule = (over = {}) => ({
  rule_id: "rule:fwd-x", product_id: "fwd", field: "eligibility.company_type", fact_path: "company.companyType",
  operator: "in", value: ["corporation", "sole_proprietor"], required: true,
  failure_reason: "회사 형태 미충족", missing_info_question: "기업 형태를 선택하세요.", source_id: "src:demo-forward", ...over,
});
const Vr = (graph, rules) => validateProductKnowledge(graph, rules, SRC, SCHEMA);
const conforms = (graph, rules) => Vr(graph, rules).conforms;
// fwd graph variant allowing custom edges (to test source-not-linked, extra requires, etc.)
const fwdGraphEdges = (edges, status = "available") => ({
  nodes: [
    { id: "inst:demo_bank", type: "Institution", name: "KB" },
    { id: "risk:fx_rate", type: "Risk", name: "fx" },
    { id: "purpose:fx_hedge", type: "Purpose", name: "환헤지" },
    { id: "prod:fwd", product_id: "fwd", type: "FinancialProduct", name: "선물환", category: "환헤지", productKnowledgeStatus: status },
  ],
  edges: [
    ...edges,
    ...(edges.some((edge) => edge.rel === "supportsPurpose")
      ? []
      : [{ from: "prod:fwd", rel: "supportsPurpose", to: "purpose:fx_hedge" }]),
  ],
});

// =============== data contract on data/eligibility-rules.json ===============
test("every rule has the required fields, rule: prefix, canonical product_id, and no duplicate rule_id", () => {
  const ids = RULES.rules.map((r) => r.rule_id);
  assert.equal(new Set(ids).size, ids.length, "duplicate rule_id");
  for (const r of RULES.rules) {
    for (const f of REG_FIELDS) assert.ok(r[f] !== undefined && r[f] !== "" && r[f] !== null, `${r.rule_id}.${f}`);
    assert.match(r.rule_id, /^rule:/);
    assert.match(r.product_id, /^[a-z][a-z0-9_]*$/);
    assert.equal(typeof r.required, "boolean");
    assert.ok(SCHEMA.operators.includes(r.operator), `${r.rule_id} operator`);
    if (VALUE_OPS.has(r.operator)) assert.ok(r.value !== undefined, `${r.rule_id} needs a value`);
    assert.equal(typeof r.fact_path, "string");
    assert.ok(r.missing_info_question.trim().length > 0, `${r.rule_id} needs a question so a missing fact asks, never passes`);
  }
});

test("every rule's source is an active product_terms source for the same product and supports the field", async () => {
  const { createSourceRegistry } = await import("../js/sources.js");
  const reg = createSourceRegistry(SRC);
  for (const r of RULES.rules) {
    assert.equal(reg.isActive(r.source_id), true, `${r.rule_id} inactive source`);
    const s = reg.get(r.source_id);
    assert.equal(s.source_kind, "product_terms", r.rule_id);
    assert.equal(s.product_id, r.product_id, `${r.rule_id} cross-product source`);
    assert.equal(reg.canSupport(r.source_id, r.product_id, r.field), true, `${r.rule_id} field not supported by source`);
  }
});

test("knowledge_gaps are declared for fwd/export_nego and disjoint from complete rules", () => {
  const gapIds = RULES.knowledge_gaps.map((g) => g.rule_id);
  const ruleIds = new Set(RULES.rules.map((r) => r.rule_id));
  for (const g of RULES.knowledge_gaps) {
    assert.match(g.rule_id, /^rule:/);
    assert.ok(g.reason && g.missing_info_question, g.rule_id);
    assert.ok(!ruleIds.has(g.rule_id), `${g.rule_id} cannot be both a complete rule and a gap`);
  }
  assert.ok(gapIds.some((id) => id.startsWith("rule:fwd")));
  assert.ok(gapIds.some((id) => id.startsWith("rule:export_nego")));
});

// =============== committed graph + rules ===============
test("the committed graph + real rules conforms; all verified products derive available", async () => {
  const graph = await load("data/knowledge-graph.json");
  const r = validateProductKnowledge(graph, RULES, SRC, SCHEMA);
  assert.equal(r.conforms, true, JSON.stringify(r.violations, null, 2));
});

// =============== control: a complete rule activates ===============
test("control: a fully complete same-product rule activates the product (available conforms)", () => {
  assert.equal(conforms(fwdGraph("rule:fwd-x"), { rules: [okRule()] }), true);
});

// =============== negative fixtures fed directly to the validator ===============
test("duplicate rule_id is a violation and cannot activate", () => {
  const r = Vr(fwdGraph("rule:fwd-x"), { rules: [okRule(), okRule()] });
  assert.equal(r.conforms, false);
  assert.ok(r.violations.some((x) => x.constraint === "duplicate_rule_id"));
});

test("a rule_id without the rule: prefix is rejected", () => {
  const r = Vr(fwdGraph("fwd-x"), { rules: [okRule({ rule_id: "fwd-x" })] });
  assert.equal(r.conforms, false);
  assert.ok(r.violations.some((x) => x.constraint === "rule_id_format"));
});

test("a rule for a non-existent product_id is rejected", () => {
  assert.equal(conforms(fwdGraph("rule:fwd-x"), { rules: [okRule({ product_id: "ghost" })] }), false);
});

test("a requires edge that references another product's rule is a cross_product_requires violation", () => {
  const r = Vr(fwdGraph("rule:tl"), { rules: [okRule({ rule_id: "rule:tl", product_id: "trade_loan", source_id: "src:demo-export-working-capital", field: "eligibility.requires_export", operator: "is_true", value: undefined })] });
  assert.ok(r.violations.some((x) => x.constraint === "cross_product_requires"));
});

test("a rule with a missing / inactive / cross-product source cannot activate", () => {
  assert.equal(conforms(fwdGraph("rule:fwd-x"), { rules: [okRule({ source_id: "src:none" })] }), false, "missing source");
  assert.equal(conforms(fwdGraph("rule:fwd-x"), { rules: [okRule({ source_id: "src:demo-export-working-capital" })] }), false, "cross-product source");
});

test("a rule whose source does not support the field cannot activate", () => {
  assert.equal(conforms(fwdGraph("rule:fwd-x"), { rules: [okRule({ field: "eligibility.min_amount_usd" })] }), false);
});

test("an unknown operator is rejected", () => {
  const r = Vr(fwdGraph("rule:fwd-x"), { rules: [okRule({ operator: "teleports" })] });
  assert.equal(r.conforms, false);
  assert.ok(r.violations.some((x) => x.constraint === "rule_operator"));
});

test("required that is not a boolean is rejected", () => {
  const r = Vr(fwdGraph("rule:fwd-x"), { rules: [okRule({ required: "true" })] });
  assert.ok(r.violations.some((x) => x.constraint === "rule_required_type"));
});

test("a missing required field is rejected", () => {
  const bad = okRule(); delete bad.failure_reason;
  const r = Vr(fwdGraph("rule:fwd-x"), { rules: [bad] });
  assert.ok(r.violations.some((x) => x.constraint === "rule_missing_field"));
});

test("a missing / non-string fact_path is rejected", () => {
  const missing = okRule(); delete missing.fact_path;
  assert.ok(Vr(fwdGraph("rule:fwd-x"), { rules: [missing] }).violations.some((x) => x.constraint === "rule_fact_path" || x.constraint === "rule_missing_field"));
  assert.ok(Vr(fwdGraph("rule:fwd-x"), { rules: [okRule({ fact_path: 123 })] }).violations.some((x) => x.constraint === "rule_fact_path"));
});

test("a value-operator without a value is rejected", () => {
  const r = Vr(fwdGraph("rule:fwd-x"), { rules: [okRule({ operator: "gte", value: undefined })] });
  assert.ok(r.violations.some((x) => x.constraint === "rule_value_missing"));
});

test("a dangling requires edge (no rule, no gap) is unresolved_requires", () => {
  const r = Vr(fwdGraph("rule:does-not-exist"), { rules: [] });
  assert.equal(r.conforms, false);
  assert.ok(r.violations.some((x) => x.constraint === "unresolved_requires"));
});

test("a rule added with no basis (non-existent product) surfaces a rule_product_id violation", () => {
  const r = Vr(fwdGraph("rule:fwd-x"), { rules: [okRule(), okRule({ rule_id: "rule:orphan", product_id: "ghost" })] });
  assert.ok(r.violations.some((x) => x.constraint === "rule_product_id"));
});

test("a missing fact never passes: every rule carries a missing_info_question so T7 asks instead", () => {
  for (const r of RULES.rules) assert.ok(r.missing_info_question && r.missing_info_question.trim().length > 0, r.rule_id);
});

// ================= T6.3a: eligibility semantics + closed-world evidence =================

test("T6.3a-1: scale rules use company.companyScale in [sme, mid_market]; companyScale is a rule fact, not a required Company input", () => {
  for (const rid of ["rule:trade_loan-scale", "rule:ecg_pre-scale"]) {
    const r = RULES.rules.find((x) => x.rule_id === rid);
    assert.equal(r.fact_path, "company.companyScale", rid);
    assert.equal(r.operator, "in", rid);
    assert.deepEqual(r.value, ["sme", "mid_market"], rid);
  }
  assert.ok(SCHEMA.ruleFactCatalog["company.companyScale"], "companyScale in ruleFactCatalog");
  assert.deepEqual(SCHEMA.ruleFactCatalog["company.companyScale"].values, ["sme", "mid_market", "other", "unknown"]);
  assert.ok(!("companyScale" in SCHEMA.classes.Company.fields), "companyScale must NOT be a required Company input");
});

test("T6.3a-2: export cap is scale-aware via lte_by (sme 1.25M / mid_market 1.75M), not a flat 1.75M", () => {
  const r = RULES.rules.find((x) => x.rule_id === "rule:trade_loan-export-cap");
  assert.equal(r.operator, "lte_by");
  assert.equal(r.value.selector_fact_path, "company.companyScale");
  assert.equal(r.value.thresholds.sme, 1250000);
  assert.equal(r.value.thresholds.mid_market, 1750000);
  assert.ok(!RULES.rules.some((x) => x.rule_id !== "rule:trade_loan-export-cap" && x.operator === "lte" && x.value === 1750000));
});

test("T6.3a-2b: a malformed lte_by (missing selector / non-finite threshold / empty thresholds / selector not in catalog) is rejected", () => {
  const cap = (value) => Vr(fwdGraph("rule:fwd-x"), { rules: [okRule({ fact_path: "company.priorYearExportUsd", operator: "lte_by", value })] });
  assert.ok(cap({ thresholds: { sme: 1250000 } }).violations.some((x) => x.constraint === "rule_value_invalid"));
  assert.ok(cap({ selector_fact_path: "company.companyScale", thresholds: {} }).violations.some((x) => x.constraint === "rule_value_invalid"));
  assert.ok(cap({ selector_fact_path: "company.companyScale", thresholds: { sme: "1250000" } }).violations.some((x) => x.constraint === "rule_value_invalid"));
  assert.ok(cap({ selector_fact_path: "company.nope", thresholds: { sme: 1250000 } }).violations.some((x) => x.constraint === "unknown_selector_fact_path"));
});

test("T6.3a-3: fx_insurance is scoped to 일반수출·선물환; out-of-scope 중장기/수입 noted; no generic all-export claim", async () => {
  const g = await load("data/knowledge-graph.json");
  const node = g.nodes.find((n) => n.product_id === "fx_insurance");
  assert.match(node.name, /일반수출|선물환/);
  assert.ok(node.scope_note && /중장기|수입/.test(node.scope_note));
  assert.ok(!/모든 수출|전체 수출/.test(node.name + (node.desc || "")));
});

test("T6.3a-4: fwd internet-banking + export_nego export are real rules; individual-limit + detailed-eligibility are the gaps", () => {
  const ruleIds = new Set(RULES.rules.map((r) => r.rule_id));
  const gapIds = new Set(RULES.knowledge_gaps.map((g) => g.rule_id));
  assert.ok(ruleIds.has("rule:fwd-internet-banking-required"));
  assert.equal(RULES.rules.find((r) => r.rule_id === "rule:fwd-internet-banking-required").fact_path, "company.internetBankingEnrolled");
  assert.ok(gapIds.has("rule:fwd-individual-limit-approved"));
  assert.ok(ruleIds.has("rule:export_nego-requires-export"));
  assert.ok(gapIds.has("rule:export_nego-detailed-eligibility"));
  assert.ok(!gapIds.has("rule:fwd-internet-banking-required"));
  assert.ok(!gapIds.has("rule:export_nego-requires-export"));
});

test("T6.3a-5: operator value semantics are enforced (not just presence)", () => {
  const bad = (over) => Vr(fwdGraph("rule:fwd-x"), { rules: [okRule(over)] });
  assert.ok(bad({ operator: "lte", fact_path: "company.priorYearExportUsd", value: "18" }).violations.some((x) => x.constraint === "rule_value_invalid"));
  assert.ok(bad({ operator: "date_within", fact_path: "context.today", value: { from: "2026-13-01", to: "2026-12-31" } }).violations.some((x) => x.constraint === "rule_value_invalid"));
  assert.ok(bad({ operator: "date_within", fact_path: "context.today", value: { from: "2030-01-01", to: "2020-01-01" } }).violations.some((x) => x.constraint === "rule_value_invalid"));
  assert.ok(bad({ operator: "in", value: [] }).violations.some((x) => x.constraint === "rule_value_invalid"));
  assert.ok(bad({ operator: "in", value: "corporation" }).violations.some((x) => x.constraint === "rule_value_invalid"));
  assert.ok(bad({ operator: "between", fact_path: "company.priorYearExportUsd", value: [10, 5] }).violations.some((x) => x.constraint === "rule_value_invalid"));
});

test("T6.3a-5b: operator/fact type must be compatible; unknown fact_path is a violation", () => {
  assert.ok(Vr(fwdGraph("rule:fwd-x"), { rules: [okRule({ operator: "is_true", value: undefined })] }).violations.some((x) => x.constraint === "operator_fact_incompatible"));
  assert.ok(Vr(fwdGraph("rule:fwd-x"), { rules: [okRule({ fact_path: "company.notInCatalog" })] }).violations.some((x) => x.constraint === "unknown_fact_path"));
});

test("T6.3a-6a: a required rule whose source is active but NOT in the product supportedBy edges is a violation", () => {
  const g = fwdGraphEdges([
    { from: "prod:fwd", rel: "providedBy", to: "inst:demo_bank" },
    { from: "prod:fwd", rel: "mitigates", to: "risk:fx_rate" },
    { from: "prod:fwd", rel: "requires", to: "rule:fwd-x" },
  ]);
  assert.ok(Vr(g, { rules: [okRule()] }).violations.some((x) => x.constraint === "rule_source_not_linked"));
});

test("T6.3a-6b: an orphan rule (referenced by no requires edge) is a violation", () => {
  const g = fwdGraphEdges([
    { from: "prod:fwd", rel: "providedBy", to: "inst:demo_bank" },
    { from: "prod:fwd", rel: "mitigates", to: "risk:fx_rate" },
    { from: "prod:fwd", rel: "requires", to: "rule:fwd-x" },
    { from: "prod:fwd", rel: "supportedBy", to: "src:demo-forward" },
  ]);
  assert.ok(Vr(g, { rules: [okRule(), okRule({ rule_id: "rule:fwd-orphan" })] }).violations.some((x) => x.constraint === "orphan_rule"));
});

test("T6.3a-6c: an orphan knowledge_gap is a violation", () => {
  const g = fwdGraphEdges([
    { from: "prod:fwd", rel: "providedBy", to: "inst:demo_bank" },
    { from: "prod:fwd", rel: "mitigates", to: "risk:fx_rate" },
    { from: "prod:fwd", rel: "requires", to: "rule:fwd-x" },
    { from: "prod:fwd", rel: "supportedBy", to: "src:demo-forward" },
  ]);
  assert.ok(Vr(g, { rules: [okRule()], knowledge_gaps: [{ rule_id: "rule:fwd-orphan-gap", product_id: "fwd", reason: "x", missing_info_question: "q" }] }).violations.some((x) => x.constraint === "orphan_gap"));
});

test("T6.3a-6d: a malformed knowledge_gaps container is a violation, no throw", () => {
  let r; assert.doesNotThrow(() => { r = validateProductKnowledge(fwdGraph("rule:fwd-x"), { rules: [okRule()], knowledge_gaps: "oops" }, SRC, SCHEMA); });
  assert.equal(r.conforms, false);
  assert.ok(r.violations.some((x) => x.constraint === "gaps_container"));
});

test("T6.3a-7: the committed graph + real rules still conforms and verified products are available", async () => {
  const g = await load("data/knowledge-graph.json");
  const r = validateProductKnowledge(g, RULES, SRC, SCHEMA);
  assert.equal(r.conforms, true, JSON.stringify(r.violations, null, 2));
  const status = Object.fromEntries(g.nodes.filter((n) => n.type === "FinancialProduct").map((n) => [n.product_id, n.productKnowledgeStatus]));
  for (const id of ["fx_insurance", "trade_loan", "ecg_pre", "import_lc"]) assert.equal(status[id], "available", id);
  for (const id of ["fwd", "export_nego"]) assert.equal(status[id], "unavailable_invalid_knowledge", id);
  for (const id of ["option", "swap", "policy_fund"]) assert.equal(status[id], "unavailable_unverified_source", id);
});

// ================= T6.3b: scoped facts + value-domain closure =================

test("T6.3b-1: general-export insurance uses an export-only horizon fact, never the all-trade maximum", () => {
  const rule = RULES.rules.find((x) => x.rule_id === "rule:fx_insurance-max-horizon-export");
  assert.equal(rule.fact_path, "exposure.maxExportHorizonMonths");
  assert.ok(SCHEMA.ruleFactCatalog["exposure.maxExportHorizonMonths"]);
  assert.ok(!SCHEMA.ruleFactCatalog["exposure.maxHorizonMonths"], "ambiguous all-trade horizon fact must be removed");
});

test("T6.3b-2: enum/string `in` values must match the fact catalog domain", () => {
  const bad = (value) => Vr(fwdGraph("rule:fwd-x"), { rules: [okRule({ value })] });
  for (const value of [["bogus"], [123], ["corporation", "bogus"], ["corporation", "corporation"]]) {
    const r = bad(value);
    assert.equal(r.conforms, false, JSON.stringify(value));
    assert.ok(r.violations.some((x) => x.constraint === "rule_value_invalid"), JSON.stringify(value));
  }
  assert.equal(bad(["corporation", "sole_proprietor"]).conforms, true);
});

test("T6.3b-3: lte_by selector must be enum/string and threshold keys must belong to its domain", () => {
  const cap = (selector_fact_path, thresholds) => Vr(fwdGraph("rule:fwd-x"), {
    rules: [okRule({
      fact_path: "company.priorYearExportUsd",
      operator: "lte_by",
      value: { selector_fact_path, thresholds },
    })],
  });
  for (const [selector, thresholds] of [
    ["company.hasExport", { true: 1250000 }],
    ["company.companyScale", { bogus: 1250000 }],
    ["company.companyScale", { sme: 1250000, mid_market: 1750000, bogus: 1 }],
  ]) {
    const r = cap(selector, thresholds);
    assert.equal(r.conforms, false, selector);
    assert.ok(r.violations.some((x) => x.constraint === "rule_value_invalid" || x.constraint === "selector_fact_incompatible"), selector);
  }
  assert.equal(cap("company.companyScale", { sme: 1250000, mid_market: 1750000 }).conforms, true);
});

test("T6.3b-4: malformed operator maps and fact-catalog entries fail as schema_container", () => {
  const g = fwdGraph("rule:fwd-x");
  const rules = { rules: [okRule()] };
  const malformed = [
    { ...SCHEMA, operatorValueKinds: { ...SCHEMA.operatorValueKinds, in: "unknown_kind" } },
    { ...SCHEMA, operatorFactTypes: { ...SCHEMA.operatorFactTypes, in: "enum" } },
    { ...SCHEMA, ruleFactCatalog: { ...SCHEMA.ruleFactCatalog, "company.companyType": { type: "enum" } } },
    { ...SCHEMA, ruleFactCatalog: { ...SCHEMA.ruleFactCatalog, "company.companyType": { type: "enum", values: ["corporation", "corporation"], question: "q" } } },
  ];
  for (const schema of malformed) {
    const r = validateProductKnowledge(g, rules, SRC, schema);
    assert.equal(r.conforms, false);
    assert.ok(r.violations.some((x) => x.constraint === "schema_container"));
  }
});
