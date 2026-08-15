import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { renderEvaluationCard } from "../js/ui.js";

const root = new URL("../", import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, root), "utf8");
}

async function loadReport() {
  return JSON.parse(await read("generated/evaluation-report.json"));
}

test("T27 card highlights report-derived values and group case counts", async () => {
  const report = await loadReport();
  const html = renderEvaluationCard({ status: "current", report });

  for (const [label, value] of [
    ["의도·대상 정확도", "83.3%"],
    ["부적격 추천", "0건"],
    ["정확 근거 일치", "100.0%"],
    ["오프라인 완주율", "100.0%"],
  ]) {
    assert.match(html, new RegExp(label));
    assert.match(html, new RegExp(value));
  }

  for (const [group, count] of [
    ["의도 해석", report.case_counts.scenario_intent],
    ["추천 안전성", report.case_counts.eligibility],
    ["근거 검색", report.case_counts.evidence],
    ["신뢰성", report.case_counts.reliability],
    ["거버넌스", report.case_counts.governance],
  ]) {
    assert.match(
      html,
      new RegExp(`${group}[\\s\\S]*?합성 ${count}건`),
      `${group} 카드가 실제 case_counts를 표시해야 한다`,
    );
  }
});

test("T27 card does not hardcode evaluation values", async () => {
  const report = await loadReport();
  report.metric_groups.intent.metrics.scenario_intent_accuracy.value = 0.5;
  report.metric_groups.intent.metrics.scenario_intent_accuracy.numerator = 3;
  report.metric_groups.recommendation_safety.metrics
    .ineligible_product_recommendations.value = 2;
  report.metric_groups.evidence_retrieval.metrics.exact_evidence_match.value = 0.75;
  report.metric_groups.reliability.metrics.offline_completion.value = 0.25;

  const html = renderEvaluationCard({ status: "current", report });
  assert.match(html, /의도·대상 정확도[\s\S]*?50\.0%/);
  assert.match(html, /부적격 추천[\s\S]*?2건/);
  assert.match(html, /정확 근거 일치[\s\S]*?75\.0%/);
  assert.match(html, /오프라인 완주율[\s\S]*?25\.0%/);

  const source = await read("js/ui.js");
  assert.doesNotMatch(source, /83\.3%|100\.0%/);
});

test("T27 card distinguishes measured technical evidence from unmeasured criteria", async () => {
  const report = await loadReport();
  const html = renderEvaluationCard({ status: "current", report });

  assert.match(html, /예선 기술 항목에 활용할 수 있는 실행 근거/);
  assert.match(html, /기술 적정성/);
  assert.match(html, /기술 실현 가능성/);
  assert.match(html, /평가점수 환산이 아닙니다/);
  assert.match(html, /문제 정의·활용 가능성·창의성·개발 계획은 이 합성 평가가 측정하지 않습니다/);
});

test("T27 PPT evidence map ties all metric groups to report paths and honest claims", async () => {
  const doc = await read("docs/rev4-ppt-evidence.md");

  for (const path of [
    "metric_groups.intent",
    "metric_groups.recommendation_safety",
    "metric_groups.evidence_retrieval",
    "metric_groups.reliability",
    "metric_groups.governance",
  ]) assert.match(doc, new RegExp(path.replaceAll(".", "\\.")));

  for (const fixture of [
    "eval/scenario-intent-cases.json",
    "eval/eligibility-cases.json",
    "eval/evidence-cases.json",
    "eval/reproducibility-cases.json",
    "eval/governance-cases.json",
  ]) assert.ok(doc.includes(fixture));

  assert.match(doc, /합성 평가 34건/);
  assert.match(doc, /KB 내부 고객 성능이나 실서비스 승인율을 의미하지 않는다/);
  assert.match(doc, /공식 후보는 현재 데모 목적 기준 3종 중심/);
  assert.match(doc, /KB 내부 심사·전산, 실제 고객 성능, 실제 상담 접수는 구현하지 않았다/);
});
