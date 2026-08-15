import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { buildProfile } from "../js/profile.js";
import { recommend } from "../js/reasoner.js";
import {
  buildCompanyInputFromState,
  createAnalysisState,
  renderRecommendationPanels,
} from "../js/ui.js";

const load = async (path) => JSON.parse(await readFile(new URL(`../${path}`, import.meta.url), "utf8"));
const [GRAPH, RULES, SOURCES, SCHEMA] = await Promise.all([
  load("data/knowledge-graph.json"),
  load("data/eligibility-rules.json"),
  load("data/source-registry.json"),
  load("data/ontology-schema.json"),
]);

const completeState = () => ({
  companyType: "corporation",
  companyScale: "sme",
  riskAppetite: "medium",
  requestedPurposes: ["working_capital"],
  isManufacturer: "true",
  supplyChainProgramEligible: "true",
  partnerGuaranteeConfirmed: "true",
  creditGradeMeetsThreshold: "true",
  reviewChannelConfirmed: "true",
  priorYearExportUsd: "",
});

const buildImportProfile = (companyState) => buildProfile({
  cashflows: [{
    transaction_id: "txn-import-ui-1",
    country: "JP",
    currency: "JPY",
    tradeType: "import",
    direction: "out",
    amount: 30_000_000,
    months: 2,
  }],
  rates: { JPY: 9.4 },
  company: buildCompanyInputFromState(companyState, []),
});

const run = (profile) => recommend({
  profile,
  graph: GRAPH,
  rules: RULES,
  sources: SOURCES.sources,
  schema: SCHEMA,
  today: "2026-08-02",
});

test("T35.1 fresh UI state keeps every bank fact explicitly unknown", () => {
  const state = createAnalysisState();
  for (const field of [
    "companyScale",
    "isManufacturer",
    "supplyChainProgramEligible",
    "partnerGuaranteeConfirmed",
    "creditGradeMeetsThreshold",
    "reviewChannelConfirmed",
    "priorYearExportUsd",
  ]) assert.equal(state.company[field], "", field);
});

test("T35.1 company input normalizes scale and tri-state facts without guessing", () => {
  const input = buildCompanyInputFromState({
    ...completeState(),
    companyScale: "mid_market",
    priorYearExportUsd: "1250000",
  }, []);
  assert.equal(input.companyScale, "mid_market");
  assert.equal(input.isSme, false);
  assert.equal(input.isManufacturer, true);
  assert.equal(input.supplyChainProgramEligible, true);
  assert.equal(input.partnerGuaranteeConfirmed, true);
  assert.equal(input.creditGradeMeetsThreshold, true);
  assert.equal(input.reviewChannelConfirmed, true);
  assert.equal(input.priorYearExportUsd, 1_250_000);

  const unknown = buildCompanyInputFromState({
    ...completeState(),
    isManufacturer: "",
  }, []);
  assert.equal(Object.hasOwn(unknown, "isManufacturer"), false);
});

test("T35.1 malformed eligibility values fail closed", () => {
  assert.throws(
    () => buildCompanyInputFromState({ ...completeState(), isManufacturer: "maybe" }, []),
    (error) => error?.code === "INVALID_COMPANY_FACT",
  );
  assert.throws(
    () => buildCompanyInputFromState({ ...completeState(), priorYearExportUsd: "not-a-number" }, []),
    (error) => error?.code === "INVALID_COMPANY_FACT",
  );
});

test("T35.1 production profile path can move import_lc pending -> candidate -> excluded", () => {
  const candidateResult = run(buildImportProfile(completeState()));
  assert.ok(candidateResult.candidates.some((item) => item.product_id === "import_lc"));

  const pendingState = { ...completeState(), partnerGuaranteeConfirmed: "" };
  const pendingResult = run(buildImportProfile(pendingState));
  assert.ok(pendingResult.pending.some((item) => item.product_id === "import_lc"));
  assert.ok(!pendingResult.candidates.some((item) => item.product_id === "import_lc"));

  const excludedState = { ...completeState(), supplyChainProgramEligible: "false" };
  const excludedResult = run(buildImportProfile(excludedState));
  assert.ok(excludedResult.excluded.some((item) => item.product_id === "import_lc"));
  assert.ok(!excludedResult.candidates.some((item) => item.product_id === "import_lc"));
});

test("T35.1 pending product shows the synthetic rule source instead of questions alone", () => {
  const result = run(buildImportProfile({ ...completeState(), reviewChannelConfirmed: "" }));
  const html = renderRecommendationPanels(result);
  assert.match(html, /TradePilot 공개용 합성 규칙 사양/);
  assert.match(html, /github\.com\/qkrwlgh335-lab\/tradepilot-ai-finance-agent\/blob\/main\/docs\/PUBLIC_DEMO_RULES\.md/);
  assert.match(html, /근거 문서 열기/);
});

test("T35.1 UI exposes eligibility controls and the confirm screen restates them", async () => {
  const ui = await readFile(new URL("../js/ui.js", import.meta.url), "utf8");
  for (const id of [
    "company-scale",
    "is-manufacturer",
    "supply-chain-program",
    "partner-guarantee",
    "credit-grade-threshold",
    "review-channel-confirmed",
    "prior-year-export-usd",
  ]) assert.match(ui, new RegExp(`id=["']${id}["']`), id);
  const confirm = ui.slice(ui.indexOf("function renderConfirm"), ui.indexOf("function renderResults"));
  for (const label of ["기업 규모", "제조기업", "데모 지정 공급망 업종", "데모 제휴보증", "합성 내부등급", "상담채널 사전확인"])
    assert.match(confirm, new RegExp(label), label);
});

test("T35.1 code-computed evaluation contains a positive import_lc candidate path", async () => {
  const fixture = await load("eval/eligibility-cases.json");
  const positive = fixture.cases.find((item) => item.expected_status?.import_lc === "candidate");
  assert.ok(positive, "positive import_lc evaluation case missing");
  assert.equal(positive.input.ruleFacts?.isManufacturer, true);
  assert.equal(positive.input.ruleFacts?.supplyChainProgramEligible, true);
  assert.equal(positive.input.ruleFacts?.partnerGuaranteeConfirmed, true);
});
