import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createSnapshotSource } from "../js/data-source.js";
import { renderRecommendationPanels } from "../js/ui.js";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

const recommendation = {
  candidates: [],
  excluded: [],
  pending: [],
  unavailable: [],
  questions: [],
  byPurpose: [{
    purpose: "fx_hedge",
    candidates: [{
      product_id: "fx_insurance",
      name: "일반수출 환율보호 프로그램(합성)",
      category: "보험",
      scope_note: "일반수출 범위",
      reasoningPath: [
        { from: "prod:fx_insurance", rel: "mitigates", to: "risk:fx_rate", basis: "knowledge-graph" },
        { from: "prod:fx_insurance", rel: "supportsPurpose", to: "purpose:fx_hedge", basis: "knowledge-graph" },
      ],
      passedRules: [{ rule_id: "rule:fx-scope", field: "eligibility.trade_scope" }],
      eligibilityEvidence: [{
        rule_id: "rule:fx-scope",
        field: "eligibility.trade_scope",
        source_id: "src:ksure",
        source: {
          institution: "TradePilot Demo",
          document_title: "공개용 합성 규칙 사양",
          url: "https://github.com/qkrwlgh335-lab/tradepilot-ai-finance-agent/blob/main/docs/PUBLIC_DEMO_RULES.md",
          verified_on: "2026-07-24",
          page_or_section: "지원대상",
        },
      }],
      source: {
        institution: "TradePilot Demo",
        document_title: "공개용 합성 규칙 사양",
        url: "https://github.com/qkrwlgh335-lab/tradepilot-ai-finance-agent/blob/main/docs/PUBLIC_DEMO_RULES.md",
        verified_on: "2026-07-24",
        page_or_section: "지원대상",
      },
    }],
    excluded: [{
      product_id: "fx_rejected",
      name: "부적격 예시",
      category: "환헤지",
      failedRules: [{ rule_id: "rule:failed", reason: "만기 조건 미충족" }],
      reasons: ["만기 조건 미충족"],
    }],
    pending: [{
      product_id: "fx_pending",
      name: "정보 필요 예시",
      category: "환헤지",
      missingFacts: [{ factPath: "company.companyScale", rule_ids: ["rule:scale"] }],
      questions: ["기업 규모를 확인해 주세요."],
    }],
    unavailable: [{
      product_id: "fwd",
      name: "선물환",
      category: "환헤지",
      productKnowledgeStatus: "unavailable_invalid_knowledge",
      reason: "근거 출처와 필수 규칙 연결이 불완전합니다.",
      knowledgeGaps: [{ reason: "개별 한도 확인 필요", missing_info_question: "한도를 확인해 주세요." }],
    }],
  }],
};

test("T7.3 renderer exposes purpose tabs and four distinct decision regions", () => {
  const html = renderRecommendationPanels(recommendation, new Set(["fx_insurance"]));
  assert.match(html, /role="tablist"/);
  for (const label of ["추천 후보", "고객 부적격", "정보 필요", "규칙정보 미확인"])
    assert.match(html, new RegExp(label));
  assert.match(html, /reasoningPath|추론 경로/);
  assert.match(html, /자격 규칙 근거/);
  assert.match(html, /TradePilot Demo/);
  assert.match(html, /github\.com\/qkrwlgh335-lab\/tradepilot-ai-finance-agent/);
  assert.match(html, /만기 조건 미충족/);
  assert.match(html, /기업 규모를 확인해 주세요/);
  assert.match(html, /개별 한도 확인 필요/);
});

test("T7.3 renderer has no automatic score or rank and only candidates are selectable", () => {
  const html = renderRecommendationPanels(recommendation, new Set(["fx_insurance"]));
  assert.doesNotMatch(html, /score-pill|score-bars|점수순|상위 3개|자동 순위/);
  assert.equal((html.match(/class="prod-check"/g) || []).length, 1);
  assert.match(html, /data-id="fx_insurance"/);
  assert.doesNotMatch(html, /class="prod-check"[^>]*data-id="fx_rejected"/);
});

test("T7.3 renderer fails closed when the recommendation contract is unavailable", () => {
  const html = renderRecommendationPanels({
    candidates: [], excluded: [], pending: [], unavailable: [],
    questions: ["상품 지식그래프 정합성을 확인할 수 없습니다."], byPurpose: [],
  });
  assert.match(html, /추천 판정을 표시할 수 없습니다/);
  assert.match(html, /상품 지식그래프 정합성을 확인할 수 없습니다/);
  assert.doesNotMatch(html, /prod-check/);
});

test("T7.3 runtime loads ontology dependencies and no longer imports matcher/select", async () => {
  const [main, ui, select, matcher] = await Promise.all([
    read("js/main.js"), read("js/ui.js"), read("js/select.js"), read("js/matcher.js"),
  ]);
  assert.doesNotMatch(main, /import\s+\*\s+as\s+(matcher|select)\b/);
  assert.doesNotMatch(ui, /\bmatcher\.|\bselect\.|scoreProducts|filterEligible|scoreBar|SCORE_LABEL/);
  assert.match(ui, /reasoner\.recommend\(/);
  assert.match(select, /@deprecated/);
  assert.match(matcher, /@deprecated/);
});

test("T7.3 snapshot source loads graph, rules and source registry", async () => {
  const payloads = {
    "knowledge-graph.json": { nodes: [], edges: [] },
    "eligibility-rules.json": { rules: [], knowledge_gaps: [] },
    "source-registry.json": { sources: [{ source_id: "src:test" }] },
  };
  const source = createSnapshotSource(async (url) => {
    const name = String(url).split("/").pop();
    return { ok: name in payloads, json: async () => payloads[name] };
  });
  assert.deepEqual(await source.getKnowledgeGraph(), payloads["knowledge-graph.json"]);
  assert.deepEqual(await source.getEligibilityRules(), payloads["eligibility-rules.json"]);
  assert.deepEqual(await source.getSourceRegistry(), payloads["source-registry.json"].sources);
});
