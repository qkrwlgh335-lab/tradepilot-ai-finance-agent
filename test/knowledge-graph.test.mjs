// T6.2a / T6.2a1: unified product knowledge graph + closed-world validateProductKnowledge that
// actually uses sources (registry) and rules, and DERIVES productKnowledgeStatus.
// productKnowledgeStatus is derived, not asserted from verification alone:
//   no active same-product product_terms source        -> unavailable_unverified_source
//   active source but provider/mitigates/requires/rules incomplete -> unavailable_invalid_knowledge
//   all of the above complete (rules exist)             -> available
// Before T6.3 there are no rules, so no product can be available yet.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { validateProductKnowledge } from "../js/reasoner.js";

const load = async (p) => JSON.parse(await readFile(new URL(`../${p}`, import.meta.url), "utf8"));
const graphData = () => load("data/knowledge-graph.json");
const schemaData = () => load("data/ontology-schema.json");
const sourcesData = async () => (await load("data/source-registry.json")).sources;
const rulesData = () => load("data/eligibility-rules.json");   // T6.3: real source-backed rules + gaps
const emptyRules = () => ({ rules: [] });

// ---- fixtures fed directly to the validator ----
const SCHEMA = await schemaData();
const SRC = await sourcesData();
const baseNodes = () => [
  { id: "inst:demo_bank", type: "Institution", name: "TradePilot 데모은행" },
  { id: "risk:fx_rate", type: "Risk", name: "환율 변동 위험" },
  { id: "purpose:fx_hedge", type: "Purpose", name: "환헤지" },
];
const fwd = (over = {}) => ({ id: "prod:fwd", product_id: "fwd", type: "FinancialProduct", name: "선물환", category: "환헤지", productKnowledgeStatus: "available", ...over });
const fwdEdges = () => [
  { from: "prod:fwd", rel: "providedBy", to: "inst:demo_bank" },
  { from: "prod:fwd", rel: "mitigates", to: "risk:fx_rate" },
  { from: "prod:fwd", rel: "supportsPurpose", to: "purpose:fx_hedge" },
  { from: "prod:fwd", rel: "requires", to: "rule:fwd-company-type" },
  { from: "prod:fwd", rel: "supportedBy", to: "src:demo-forward" },
];
const graph = (nodes, edges) => ({ nodes, edges });
// A fully valid rule that can activate fwd (all fields, rule: prefix, matching product, valid
// operator, required true, active same-product product_terms source that supports the field).
const completeRule = (over = {}) => ({
  rule_id: "rule:fwd-company-type", product_id: "fwd", field: "eligibility.company_type", fact_path: "company.companyType",
  operator: "in", value: ["corporation", "sole_proprietor"], required: true, failure_reason: "회사 형태 미충족", missing_info_question: "기업 형태를 선택하세요.",
  source_id: "src:demo-forward", ...over,
});
const rulesWith = (...ids) => ({ rules: ids.map((rule_id) => completeRule({ rule_id })) });
const V = (g, rules = emptyRules(), sources = SRC, schema = SCHEMA) => validateProductKnowledge(g, rules, sources, schema);
const Vr = V; // full { conforms, violations }

// =============== the real graph ===============
test("the committed knowledge graph conforms with the real rules (declared status == derived status)", async () => {
  const r = validateProductKnowledge(await graphData(), await rulesData(), await sourcesData(), await schemaData());
  assert.equal(r.conforms, true, JSON.stringify(r.violations, null, 2));
});

test("with real rules: the 4 verified products are available; fwd/export_nego stay invalid_knowledge; unsourced stay unverified", async () => {
  const g = await graphData();
  const status = Object.fromEntries(g.nodes.filter((n) => n.type === "FinancialProduct").map((n) => [n.product_id, n.productKnowledgeStatus]));
  for (const id of ["fx_insurance", "trade_loan", "ecg_pre", "import_lc"]) assert.equal(status[id], "available", id);
  for (const id of ["fwd", "export_nego"]) assert.equal(status[id], "unavailable_invalid_knowledge", id);
  for (const id of ["option", "swap", "policy_fund"]) assert.equal(status[id], "unavailable_unverified_source", id);
});

test("without rules (empty), the verified products would NOT conform as available (rules are required)", async () => {
  const r = validateProductKnowledge(await graphData(), emptyRules(), await sourcesData(), await schemaData());
  assert.equal(r.conforms, false, "declaring available while rules are missing must be a status_mismatch");
  assert.ok(r.violations.some((x) => x.constraint === "status_mismatch"));
});

test("all migrated product ids exist, canonical, unique, node.id === prod:<product_id>", async () => {
  const nodes = (await graphData()).nodes.filter((n) => n.type === "FinancialProduct");
  const ids = nodes.map((n) => n.product_id);
  for (const id of ["fwd", "option", "swap", "fx_insurance", "trade_loan", "export_nego", "import_lc", "policy_fund", "ecg_pre"]) assert.ok(ids.includes(id), id);
  assert.equal(new Set(ids).size, ids.length);
  for (const n of nodes) assert.equal(n.id, `prod:${n.product_id}`);
});

test("every product has exactly one explicit product-to-purpose relation", async () => {
  const g = await graphData();
  const products = g.nodes.filter((node) => node.type === "FinancialProduct");
  const expected = {
    fwd: "purpose:fx_hedge",
    option: "purpose:fx_hedge",
    swap: "purpose:fx_hedge",
    fx_insurance: "purpose:fx_hedge",
    trade_loan: "purpose:working_capital",
    export_nego: "purpose:export_receivable",
    import_lc: "purpose:working_capital",
    policy_fund: "purpose:policy_fund",
    ecg_pre: "purpose:guarantee_insurance",
  };

  for (const product of products) {
    const links = g.edges.filter((edge) => edge.from === product.id && edge.rel === "supportsPurpose");
    assert.equal(links.length, 1, product.product_id);
    assert.equal(links[0].to, expected[product.product_id], product.product_id);
  }
});

// =============== positive derivation (available IS reachable with rules) ===============
test("with the required rule present, an otherwise complete product derives to available", () => {
  const g = graph([...baseNodes(), fwd({ productKnowledgeStatus: "available" })], fwdEdges());
  assert.equal(V(g, rulesWith("rule:fwd-company-type")).conforms, true);
});

// =============== negative fixtures fed to the validator ===============
test("missing rule: active source but the required rule does not exist -> not available", () => {
  const g = graph([...baseNodes(), fwd({ productKnowledgeStatus: "available" })], fwdEdges());
  const r = V(g, emptyRules());   // rule:fwd-company-type not in rules
  assert.equal(r.conforms, false);
  assert.ok(r.violations.some((x) => x.constraint === "status_mismatch"));
});

test("missing source: supportedBy points to a non-existent source -> not available", () => {
  const edges = fwdEdges().map((e) => (e.rel === "supportedBy" ? { ...e, to: "src:does-not-exist" } : e));
  const r = V(graph([...baseNodes(), fwd({ productKnowledgeStatus: "available" })], edges), rulesWith("rule:fwd-company-type"));
  assert.equal(r.conforms, false);
  assert.ok(r.violations.some((x) => x.constraint === "status_mismatch"));
});

test("inactive source: supportedBy points to an inactive entry -> not available", () => {
  const inactive = { source_id: "src:demo-forward", product_id: "fwd", institution: "TradePilot Demo", document_title: "x", url: "https://github.com/qkrwlgh335-lab/tradepilot-ai-finance-agent/blob/main/docs/PUBLIC_DEMO_RULES.md", source_kind: "product_terms", verification_status: "unverified", verified_on: "2026-08-16", supported_fields: ["eligibility.company_type"], page_or_section: "p" };
  const r = V(graph([...baseNodes(), fwd({ productKnowledgeStatus: "available" })], fwdEdges()), rulesWith("rule:fwd-company-type"), [inactive]);
  assert.equal(r.conforms, false);
});

test("cross-product source: fwd linked to trade_loan's active source -> not available", () => {
  const edges = fwdEdges().map((e) => (e.rel === "supportedBy" ? { ...e, to: "src:demo-export-working-capital" } : e));
  const r = V(graph([...baseNodes(), fwd({ productKnowledgeStatus: "available" })], edges), rulesWith("rule:fwd-company-type"));
  assert.equal(r.conforms, false, "another product's source must not make fwd available");
});

test("available with no edges is rejected", () => {
  const r = V(graph([...baseNodes(), fwd({ productKnowledgeStatus: "available" })], []), rulesWith("rule:fwd-company-type"));
  assert.equal(r.conforms, false);
  assert.ok(r.violations.some((x) => x.constraint === "status_mismatch"));
});

test("duplicate node.id and duplicate product_id are rejected", () => {
  const dupNode = V(graph([...baseNodes(), fwd({ productKnowledgeStatus: "unavailable_unverified_source" }), fwd({ productKnowledgeStatus: "unavailable_unverified_source" })], []));
  assert.ok(dupNode.violations.some((x) => x.constraint === "duplicate_node_id"));
  const dupPid = V(graph([...baseNodes(), fwd({ id: "prod:fwd", productKnowledgeStatus: "unavailable_unverified_source" }), fwd({ id: "prod:fwd2", productKnowledgeStatus: "unavailable_unverified_source" })], []));
  assert.ok(dupPid.violations.some((x) => x.constraint === "duplicate_product_id"));
});

test("node.id must equal prod:<product_id>; product_id must be canonical", () => {
  const badId = V(graph([...baseNodes(), fwd({ id: "prod:wrong", productKnowledgeStatus: "unavailable_unverified_source" })], []));
  assert.ok(badId.violations.some((x) => x.constraint === "node_id_format"));
  const badPid = V(graph([...baseNodes(), fwd({ id: "prod:prod:fwd", product_id: "prod:fwd", productKnowledgeStatus: "unavailable_unverified_source" })], []));
  assert.ok(badPid.violations.some((x) => x.constraint === "product_id"));
});

test("an invalid productKnowledgeStatus enum is rejected", () => {
  const r = V(graph([...baseNodes(), fwd({ productKnowledgeStatus: "great" })], []));
  assert.ok(r.violations.some((x) => x.constraint === "status_enum"));
});

test("an assumptions field on a product is rejected", () => {
  const r = V(graph([...baseNodes(), fwd({ productKnowledgeStatus: "unavailable_unverified_source", assumptions: ["cost_rate"] })], []));
  assert.ok(r.violations.some((x) => x.constraint === "assumptions"));
});

test("an unsourced attribute is rejected", () => {
  const r = V(graph([...baseNodes(), fwd({ productKnowledgeStatus: "unavailable_unverified_source", attributes: { cost_rate: 0.003 } })], []));
  assert.ok(r.violations.some((x) => x.constraint === "attribute_source"));
});

test("an attribute whose source does not support the field (or belongs to another product) is rejected", () => {
  const notSupported = V(graph([...baseNodes(), fwd({ productKnowledgeStatus: "unavailable_unverified_source", attributes: { made_up_field: 1 }, attribute_sources: { made_up_field: "src:demo-forward" } })], []));
  assert.ok(notSupported.violations.some((x) => x.constraint === "attribute_source"), "src:demo-forward does not support made_up_field");
  const crossProduct = V(graph([...baseNodes(), fwd({ productKnowledgeStatus: "unavailable_unverified_source", attributes: { "eligibility.requires_export": 1 }, attribute_sources: { "eligibility.requires_export": "src:demo-export-working-capital" } })], []));
  assert.ok(crossProduct.violations.some((x) => x.constraint === "attribute_source"), "another product's source must not back fwd's attribute");
});

test("unknown relation, wrong domain and wrong range are flagged", () => {
  const unknownRel = V(graph([...baseNodes(), fwd({ productKnowledgeStatus: "unavailable_unverified_source" })], [{ from: "prod:fwd", rel: "teleports", to: "inst:demo_bank" }]));
  assert.ok(unknownRel.violations.some((x) => x.constraint === "relation"));
  const wrongRange = V(graph([...baseNodes(), fwd({ productKnowledgeStatus: "unavailable_unverified_source" })], [{ from: "prod:fwd", rel: "mitigates", to: "inst:demo_bank" }]));
  assert.ok(wrongRange.violations.some((x) => x.constraint === "range"));
  const wrongDomain = V(graph([...baseNodes(), fwd({ productKnowledgeStatus: "unavailable_unverified_source" })], [{ from: "risk:fx_rate", rel: "providedBy", to: "inst:demo_bank" }]));
  assert.ok(wrongDomain.violations.some((x) => x.constraint === "domain"));
});

test("derived relations cannot be asserted inside the static knowledge graph", () => {
  const g = graph([...baseNodes(), fwd({ productKnowledgeStatus: "unavailable_unverified_source" })], [
    { from: "risk:fx_rate", rel: "hasPurpose", to: "purpose:fx_hedge" },
  ]);
  const r = V(g);
  assert.equal(r.conforms, false);
  assert.ok(r.violations.some((x) => x.constraint === "derived_relation_asserted"));
});

test("malformed graph containers fail closed without throwing", () => {
  for (const bad of [null, undefined, {}, { nodes: "x", edges: [] }, { nodes: [], edges: "y" }, { nodes: [null], edges: [null] }]) {
    let r;
    assert.doesNotThrow(() => { r = V(bad); });
    assert.equal(r.conforms, false, JSON.stringify(bad));
  }
});

test("validateProductKnowledge actually uses the schema relations (not a private constant)", async () => {
  const src = await readFile(new URL("../js/reasoner.js", import.meta.url), "utf8");
  assert.ok(!/const\s+KG_RELATIONS\s*=/.test(src), "the relation contract must come from ontology-schema, not a private KG_RELATIONS");
  // Empty schema.relations is itself an invalid schema and must fail closed.
  const emptyRelSchema = { ...SCHEMA, relations: {} };
  const r = validateProductKnowledge(graph([...baseNodes(), fwd({ productKnowledgeStatus: "unavailable_unverified_source" })], fwdEdges()), emptyRules(), SRC, emptyRelSchema);
  assert.equal(r.conforms, false);
  assert.ok(r.violations.some((x) => x.constraint === "schema_container"));
});

// ================= T6.2a2: supportedBy edge validity, rule completeness, dependency & node id =================

// --- 1. supportedBy edge itself must be valid, even when status is unavailable ---
test("T6.2a2-1: an unavailable product with a supportedBy to a MISSING source is a violation", () => {
  const g = graph([...baseNodes(), fwd({ productKnowledgeStatus: "unavailable_unverified_source" })],
    [{ from: "prod:fwd", rel: "supportedBy", to: "src:does-not-exist" }]);
  const r = Vr(g);
  assert.equal(r.conforms, false);
  assert.ok(r.violations.some((x) => x.constraint === "evidence_edge"), "bad supportedBy must be flagged even when unavailable");
});

test("T6.2a2-1b: an unavailable product with a supportedBy to another product's source is a violation", () => {
  const g = graph([...baseNodes(), fwd({ productKnowledgeStatus: "unavailable_invalid_knowledge" })],
    [...fwdEdges().filter((e) => e.rel !== "supportedBy"), { from: "prod:fwd", rel: "supportedBy", to: "src:demo-export-working-capital" }]);
  assert.ok(Vr(g, rulesWith("rule:fwd-company-type")).violations.some((x) => x.constraint === "evidence_edge"));
});

test("T6.2a2-1c: an unavailable product with a supportedBy to an INACTIVE source is a violation", () => {
  const inactive = { source_id: "src:demo-forward", product_id: "fwd", institution: "TradePilot Demo", document_title: "x", url: "https://github.com/qkrwlgh335-lab/tradepilot-ai-finance-agent/blob/main/docs/PUBLIC_DEMO_RULES.md", source_kind: "product_terms", verification_status: "unverified", verified_on: "2026-08-16", supported_fields: ["eligibility.company_type"], page_or_section: "p" };
  const g = graph([...baseNodes(), fwd({ productKnowledgeStatus: "unavailable_unverified_source" })], [{ from: "prod:fwd", rel: "supportedBy", to: "src:demo-forward" }]);
  assert.ok(Vr(g, emptyRules(), [inactive]).violations.some((x) => x.constraint === "evidence_edge"));
});

test("T6.2a2-1d: an unverified product has NO supportedBy edge (a valid graph)", () => {
  const g = graph([...baseNodes(), fwd({ productKnowledgeStatus: "unavailable_unverified_source" })],
    [{ from: "prod:fwd", rel: "providedBy", to: "inst:demo_bank" }, { from: "prod:fwd", rel: "mitigates", to: "risk:fx_rate" }]);
  const r = Vr(g);
  assert.ok(!r.violations.some((x) => x.constraint === "evidence_edge"), "no supportedBy -> no evidence_edge violation");
  assert.equal(r.conforms, true);
});

// --- 2. available needs COMPLETE rules, not just rule_id existence ---
test("T6.2a2-2 control: a fully complete rule + valid source + edges reaches available", () => {
  assert.equal(V(graph([...baseNodes(), fwd()], fwdEdges()), { rules: [completeRule()] }).conforms, true);
});

test("T6.2a2-2a: a skeleton rule {rule_id} cannot make a product available", () => {
  const skeleton = { rules: [{ rule_id: "rule:fwd-company-type" }] };
  const r = Vr(graph([...baseNodes(), fwd()], fwdEdges()), skeleton);
  assert.equal(r.conforms, false);
  assert.ok(r.violations.some((x) => x.constraint === "status_mismatch"));
});

test("T6.2a2-2b: a rule whose product_id differs cannot activate", () => {
  assert.equal(V(graph([...baseNodes(), fwd()], fwdEdges()), { rules: [completeRule({ product_id: "trade_loan" })] }).conforms, false);
});

test("T6.2a2-2c: a rule with an unknown operator cannot activate", () => {
  assert.equal(V(graph([...baseNodes(), fwd()], fwdEdges()), { rules: [completeRule({ operator: "teleports" })] }).conforms, false);
});

test("T6.2a2-2d: a rule with required !== true cannot activate", () => {
  assert.equal(V(graph([...baseNodes(), fwd()], fwdEdges()), { rules: [completeRule({ required: "true" })] }).conforms, false);
  assert.equal(V(graph([...baseNodes(), fwd()], fwdEdges()), { rules: [completeRule({ required: false })] }).conforms, false);
});

test("T6.2a2-2e: a rule whose source is inactive / cross-product / does-not-support-field cannot activate", () => {
  assert.equal(V(graph([...baseNodes(), fwd()], fwdEdges()), { rules: [completeRule({ source_id: "src:demo-export-working-capital" })] }).conforms, false, "cross-product rule source");
  assert.equal(V(graph([...baseNodes(), fwd()], fwdEdges()), { rules: [completeRule({ source_id: "src:does-not-exist" })] }).conforms, false, "missing rule source");
  assert.equal(V(graph([...baseNodes(), fwd()], fwdEdges()), { rules: [completeRule({ field: "eligibility.min_amount_usd" })] }).conforms, false, "source does not support the field");
});

test("T6.2a2-2e2: rule text fields must be non-empty strings", () => {
  const g = graph([...baseNodes(), fwd()], fwdEdges());
  for (const patch of [
    { failure_reason: 123 },
    { missing_info_question: 456 },
    { failure_reason: "  " },
    { missing_info_question: "" },
  ])
    assert.equal(V(g, { rules: [completeRule(patch)] }).conforms, false, JSON.stringify(patch));
});

test("T6.2a2-2f: a duplicate rule_id is a violation and cannot activate", () => {
  const r = Vr(graph([...baseNodes(), fwd()], fwdEdges()), { rules: [completeRule(), completeRule()] });
  assert.equal(r.conforms, false);
  assert.ok(r.violations.some((x) => x.constraint === "duplicate_rule_id"));
});

test("T6.2a2-2g: a requires edge resolved to a knowledge gap keeps the product invalid_knowledge, never available", () => {
  const gapRules = { rules: [], knowledge_gaps: [{ rule_id: "rule:fwd-company-type", product_id: "fwd", reason: "공식 출처 미확정", missing_info_question: "영업점 확인 필요" }] };
  assert.equal(Vr(graph([...baseNodes(), fwd({ productKnowledgeStatus: "unavailable_invalid_knowledge" })], fwdEdges()), gapRules).conforms, true, "gap-resolved requires -> invalid_knowledge is consistent");
  assert.equal(Vr(graph([...baseNodes(), fwd({ productKnowledgeStatus: "available" })], fwdEdges()), gapRules).conforms, false, "cannot be available when a required condition is a gap");
});

// --- 3. dependency containers fail closed ---
test("T6.2a2-3: malformed rules / sources / schema containers are violations (no throw)", () => {
  const g = graph([...baseNodes(), fwd({ productKnowledgeStatus: "unavailable_unverified_source" })], []);
  for (const badRules of ["x", 3, true, [1, 2, "not-a-rule-object-is-ok-here"]].slice(0, 3)) {
    let r; assert.doesNotThrow(() => { r = validateProductKnowledge(g, badRules, SRC, SCHEMA); });
    assert.equal(r.conforms, false); assert.ok(r.violations.some((x) => x.constraint === "rules_container"));
  }
  for (const badSources of ["x", {}, null, 3]) {
    let r; assert.doesNotThrow(() => { r = validateProductKnowledge(g, emptyRules(), badSources, SCHEMA); });
    assert.equal(r.conforms, false); assert.ok(r.violations.some((x) => x.constraint === "sources_container"));
  }
  for (const badSchema of [null, "x", [], {}, { relations: {}, graphNodeClasses: "no", externalRangePrefix: {}, operators: [] }, { relations: [], graphNodeClasses: [], externalRangePrefix: {}, operators: [] }]) {
    let r; assert.doesNotThrow(() => { r = validateProductKnowledge(g, emptyRules(), SRC, badSchema); });
    assert.equal(r.conforms, false); assert.ok(r.violations.some((x) => x.constraint === "schema_container"));
  }
});

test("T6.2a2-3a: malformed schema element types are violations", () => {
  const g = graph([...baseNodes(), fwd({ productKnowledgeStatus: "unavailable_unverified_source" })], []);
  const malformed = [
    { ...SCHEMA, graphNodeClasses: ["Institution", 42] },
    { ...SCHEMA, operators: ["is_true", 3] },
    { ...SCHEMA, externalRangePrefix: { EligibilityRule: 3, EvidenceSource: "src:" } },
    { ...SCHEMA, relations: { broken: { domain: [], range: "Risk", kind: "asserted" } } },
    { ...SCHEMA, relations: { broken: { domain: ["FinancialProduct"], range: "", kind: "asserted" } } },
    { ...SCHEMA, relations: { broken: { domain: ["FinancialProduct"], range: "Risk", kind: "unknown" } } },
  ];
  for (const badSchema of malformed) {
    const r = validateProductKnowledge(g, emptyRules(), SRC, badSchema);
    assert.equal(r.conforms, false);
    assert.ok(r.violations.some((x) => x.constraint === "schema_container"));
  }
});

test("T6.2a2-3b: {rules: array} and a bare array are both accepted rule containers", () => {
  const g = graph([...baseNodes(), fwd()], fwdEdges());
  assert.equal(V(g, { rules: [completeRule()] }).conforms, true);
  assert.equal(V(g, [completeRule()]).conforms, true);
});

// --- 4. every node needs a valid id + type ---
test("T6.2a2-4: a node with a missing/empty id is a violation (Institution/Risk/Purpose too)", () => {
  const noId = graph([{ type: "Institution", name: "no id" }, ...baseNodes(), fwd({ productKnowledgeStatus: "unavailable_unverified_source" })], []);
  assert.ok(Vr(noId).violations.some((x) => x.constraint === "node_id"));
  const emptyId = graph([{ id: "  ", type: "Risk", name: "blank" }, fwd({ productKnowledgeStatus: "unavailable_unverified_source" })], []);
  assert.ok(Vr(emptyId).violations.some((x) => x.constraint === "node_id"));
});
