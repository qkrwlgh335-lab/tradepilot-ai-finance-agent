// The UI must not describe the numbers more confidently than the model actually supports:
// currency net exposure, per-maturity exposure and the conservative CFaR sum are different
// statements and the screen has to keep them apart.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { renderRagEvidenceContent, renderWhatIfResult } from "../js/ui.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const read = (p) => readFile(path.join(ROOT, p), "utf8");
const ui = await read("js/ui.js");

async function appSources() {
  const out = {};
  for (const f of await readdir(path.join(ROOT, "js"))) if (f.endsWith(".js")) out[`js/${f}`] = await read(`js/${f}`);
  out["index.html"] = await read("index.html");
  return out;
}

test("the exposure card never claims the currency net is all that must be managed", () => {
  assert.ok(!/만 관리하면 됩니다/.test(ui), "the 'only the net matters' claim must be gone");
  assert.match(ui, /총 통화 순노출/);
  assert.match(ui, /만기별 관리대상/);
  assert.match(ui, /만기가 다르므로 완전히 자연헤지되지 않습니다/);
});

test("scenario and diagnosis state which basis they are computed on", () => {
  const note = /시나리오는 통화 순노출 기준이며 만기 불일치는 CFaR·유동성에서 별도 반영/;
  const hits = ui.match(new RegExp(note.source, "g")) || [];
  assert.ok(hits.length >= 2, `the basis note must appear in both 시나리오 and 종합 진단 (found ${hits.length})`);
});

test("the CFaR total names both correlation AND offsetting across buckets, without overclaiming", () => {
  assert.match(ui, /통화·만기 버킷 간 상관관계와 상쇄효과를 반영하지 않은 보수적 단순합/);
  assert.match(ui, /실제 포트폴리오 위험보다 크게 산출될 수 있습니다/);
  assert.ok(!/실제보다 크게 잡힙니다/.test(ui), "must not assert the overstatement as a certainty");
});

test("the confirm screen shows the liquidity buffer the user is about to commit to", () => {
  const confirm = ui.slice(ui.indexOf("function renderConfirm"), ui.indexOf("function renderResults"));
  assert.match(confirm, /기초 현금잔고/);
  assert.match(confirm, /사용 가능 신용한도/);
  assert.match(confirm, /유동성 완충 합계/);
});

test("hedge cost is priced off the bucket notional in the results pipeline", () => {
  assert.match(ui, /bucketNotionalKrw/);
  assert.ok(!/notionalKrw = netRows\.reduce/.test(ui), "must not price the hedge off per-currency net");
});

// A risk measure and a cost assumption should not be added up at all — even a labelled sum
// invites reading it as a single "score" for the strategy.
test("comparisonIndex is gone from every app source", async () => {
  for (const [name, src] of Object.entries(await appSources())) {
    assert.ok(!/comparisonIndex/.test(src), `${name} still references comparisonIndex`);
  }
  assert.ok(!/비교용 위험·비용 지표/.test(ui), "the combined column must be removed from the UI");
});

test("no source overclaims natural hedging across maturities", async () => {
  for (const [name, src] of Object.entries(await appSources())) {
    assert.ok(!/상계·자연헤지 반영/.test(src), `${name}: brief heading still claims natural hedging`);
    assert.ok(!/뿐입니다 \(자연 헤지\)/.test(src), `${name}: diagnosis still claims the net is all that matters`);
    assert.ok(!/헤지 금액을 순노출 이하로 제한/.test(src), `${name}: counter-example still uses the net-only limit`);
  }
});

test("CFaR and liquidity assumptions are spelled out on screen", () => {
  for (const phrase of [
    /현재 환율 스냅샷/,
    /연환율 변동성이 기간 동안 일정하다는 가정/,
    /정규분포 기반 95% 단측 위험 참고치/,
    /현재 기준환율로 원화 환산/,
    /이자·환전 스프레드·수수료 미반영/,
    /신용한도가 해당 시점까지 유지되고 전액 사용 가능하다는 가정/,
  ]) assert.match(ui, phrase);
});

test("the UI refuses to render risk as zero when the engine cannot compute", async () => {
  assert.match(ui, /CalculationError/);
  assert.match(ui, /errorTitle\(err\)/, "the heading must come from the classified error, not be hardcoded");
  assert.match(ui, /위험을 0으로 표시하지 않습니다/);
  const errors = await read("js/errors.js");
  for (const title of [
    /필수 시장데이터가 없어 계산할 수 없습니다/,
    /입력값이 올바르지 않아 계산할 수 없습니다/,
    /계산 가정 또는 설정이 올바르지 않습니다/,
  ]) assert.match(errors, title);
});

test("the three evidence blocks are visually distinct and keep honest RAG status text", () => {
  for (const label of [
    "① 자격 규칙 근거",
    "② RAG 연결문서 근거",
    "③ 온톨로지 추론 경로",
  ]) assert.ok(ui.includes(label), label);

  for (const className of [
    "ontology-evidence",
    "rule-evidence",
    "rag-evidence",
  ]) assert.ok(ui.includes(className), className);

  assert.match(ui, /관련 근거 없음/);
  assert.match(ui, /문서 근거 검색 실패/);
});

test("RAG updates only its body so a miss or failure cannot erase the evidence heading", () => {
  assert.match(ui, /class="rag-evidence-body\b/);
  assert.match(ui, /querySelector\(`\.rag-evidence-body\[data-id=/);
  assert.match(ui, /querySelectorAll\("\.rag-evidence-body"\)/);
  assert.doesNotMatch(
    ui,
    /querySelectorAll\("\.evidence"\).*box\.innerHTML/s,
    "a RAG failure must not replace whole evidence blocks",
  );
});

test("RAG body renderer distinguishes no match from a search failure", () => {
  assert.match(renderRagEvidenceContent([]), /관련 근거 없음/);
  assert.doesNotMatch(renderRagEvidenceContent([]), /검색 실패/);

  const failed = renderRagEvidenceContent([], { failed: true });
  assert.match(failed, /문서 근거 검색 실패/);
  assert.doesNotMatch(failed, /관련 근거 없음/);
});

test("RAG body renderer escapes document text and source labels", () => {
  const html = renderRagEvidenceContent([{
    matchedText: "<script>bad()</script>",
    source: {
      document_title: "<공식문서>",
      institution: "TradePilot Demo",
    },
  }]);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.match(html, /&lt;공식문서&gt;/);
  assert.match(html, /TradePilot Demo/);
});

test("T8.5b wires the deterministic counterfactual engine into a visible what-if panel", () => {
  for (const label of ["위기 시나리오로 다시 검증", "변경된 입력", "전/후 비교", "추천 변화", "계산 한계"])
    assert.ok(ui.includes(label), label);
  assert.match(ui, /counterfactual\.runCounterfactual/);
  assert.match(ui, /counterfactual\.SCENARIOS/);
  assert.match(ui, /what-if-run/);
  assert.match(ui, /SCENARIOS\.filter\(\(scenarioItem\) => scenarioItem\.implemented\)/);
  assert.doesNotMatch(ui, /확장 예정/);
});

test("what-if results keep scenario PnL separate from CFaR and escape user-controlled ids", () => {
  const html = renderWhatIfResult({
    scenario: {
      id: "payment_delay_1m",
      label: "<script>bad()</script>",
      targetScopeLabel: "거래 <b>client</b>",
    },
    changedInputs: [{
      path: "transactions.id~0061.months",
      before: 3,
      after: 4,
    }],
    before: {
      cfar: { total: 100 },
      liquidity: {
        worstShortfallKrw: 200,
        timeline: [{ months: 2, cumulativeKrw: -200, shortfallKrw: 200 }],
      },
    },
    after: {
      cfar: { total: 120 },
      liquidity: {
        worstShortfallKrw: 240,
        timeline: [{ months: 2, cumulativeKrw: -240, shortfallKrw: 240 }],
      },
      scenarioPnL: -50,
    },
    deltas: {
      cfarTotalKrw: 20,
      worstShortfallKrw: 40,
      scenarioPnlKrw: -50,
      byBucket: [],
    },
    affectedRecommendations: {
      added: [{ purpose: "fx_hedge", product_id: "safe" }],
      removed: [],
      movedToPending: [],
    },
    explanationFacts: [],
    limitations: ["한계 <img src=x onerror=bad()>"],
  });

  for (const label of ["변경된 입력", "전/후 비교", "만기별 유동성 변화", "추천 변화", "계산 한계", "시나리오 손익"])
    assert.match(html, new RegExp(label));
  assert.doesNotMatch(html, /<script>|<img/);
  assert.match(html, /&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.match(html, /CFaR/);
});

test("T9 UI has no browser key path and exposes mock/external/internal honestly", async () => {
  const [main, index] = await Promise.all([read("js/main.js"), read("index.html")]);
  const browserSource = `${main}\n${index}\n${ui}`;
  for (const forbidden of [
    "keyStore",
    "key-modal",
    "key-input",
    "anthropic-dangerous-direct-browser-access",
  ]) assert.doesNotMatch(browserSource, new RegExp(forbidden), forbidden);
  assert.match(ui, /로컬 설명 \(기본 · 키\/네트워크 불필요\)/);
  assert.match(ui, /금융기관 내부 AI \(실서비스 교체점 · 현재 미구현\)/);
  assert.match(ui, /value="internal" disabled/);
  assert.match(ui, /window\.sessionStorage/);
  assert.match(ui, /sessionStorage\.getItem\("kb_llm_mode"\)/);
  assert.doesNotMatch(ui, /localStorage\.(getItem|setItem)\("kb_llm_mode"/);
  assert.match(ui, /감사로그 삭제/);
  assert.match(ui, /purpose,\s*analysisPayload/);
  assert.match(ui, /createProvider\(mode\)/, "mock/off must not be audited as approved egress");
});
