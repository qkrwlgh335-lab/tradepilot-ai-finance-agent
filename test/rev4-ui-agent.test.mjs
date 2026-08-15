// T20 — natural-language scenario UI: preview + approval, wired to the existing engine.
// The pure preview renderer is unit-tested; the wiring is asserted against ui.js source.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { renderScenarioPlanPreview, shouldTryExternalIntent } from "../js/ui.js";
import { normalizeIntentText } from "../js/scenario-intent.js";

const ui = await readFile(new URL("../js/ui.js", import.meta.url), "utf8");

const okGate = {
  ok: true,
  execution: { scenarioId: "payment_delay_1m", options: { targetTransactionId: "tx-1" } },
  missingFacts: [], unsupportedSegments: [], errors: [],
};

test("approved preview shows intent + target + the FIXED preset and a preset-labelled approve button", () => {
  const html = renderScenarioPlanPreview(okGate, {
    step: { type: "payment_delay", target: { transaction_id: "tx-1" } },
    confidence: 0.9,
  });
  assert.match(html, /해석된 의도/);
  assert.match(html, /입금 지연/);
  assert.match(html, /해석된 대상/);
  assert.match(html, /tx-1/);
  assert.match(html, /고정 시나리오/);
  assert.match(html, /1개월/);
  assert.match(html, /고정 프리셋/);            // it is explicitly labelled a demo preset
  assert.match(html, /id="agent-approve"/);
  assert.match(html, /고정 1개월 시나리오로 재검증/); // button names the fixed preset
});

test("ambiguous target renders a chooser and NO approve button", () => {
  const gate = { ok: false, execution: null, missingFacts: [{ field: "target", question: "어느 수취 거래를 말하는지 선택해 주세요" }], unsupportedSegments: [], errors: [] };
  const html = renderScenarioPlanPreview(gate, {
    step: { type: "payment_delay", target: {}, params: { months: 1 } },
    receivables: [
      { transaction_id: "tx-1", currency: "USD", amount: 200000, months: 3, country: "US" },
      { transaction_id: "tx-2", currency: "USD", amount: 100000, months: 3, country: "VN" },
    ],
    confidence: 0.9,
  });
  assert.match(html, /어느 수취 거래/);
  assert.match(html, /class="agent-target"/);
  assert.match(html, /value="tx-1"/);
  assert.match(html, /value="tx-2"/);
  assert.doesNotMatch(html, /id="agent-approve"/);
});

test("unsupported request shows the reason and NO approve button", () => {
  const gate = { ok: false, execution: null, missingFacts: [], unsupportedSegments: [{ text: "", reason: "입금 지연은 고정 크기 1개월만 지원합니다. 요청한 크기는 아직 지원하지 않습니다." }], errors: [] };
  const html = renderScenarioPlanPreview(gate, { step: { type: "payment_delay", target: { transaction_id: "tx-1" }, params: { months: 2 } }, confidence: 0.9 });
  assert.match(html, /고정 크기 1개월만 지원/);
  assert.doesNotMatch(html, /id="agent-approve"/);
});

test("preview escapes user-controlled ids, currencies and reasons", () => {
  const gate = { ok: false, execution: null, missingFacts: [{ field: "target", question: "어느 수취 거래를 말하는지 선택해 주세요" }], unsupportedSegments: [{ text: "", reason: "<img src=x onerror=bad()>" }], errors: [] };
  const html = renderScenarioPlanPreview(gate, {
    step: { type: "payment_delay", target: {}, params: { months: 1 } },
    receivables: [{ transaction_id: "<script>bad()</script>", currency: "<b>USD</b>", amount: 1, months: 1, country: "US" }],
  });
  assert.doesNotMatch(html, /<script>|<img|<b>USD<\/b>/);
  assert.match(html, /&lt;script&gt;bad\(\)&lt;\/script&gt;/);
});

// --- wiring assertions against ui.js source ---
test("ui.js wires the parser, the gate, the NL box, and approval into the engine", () => {
  assert.match(ui, /import \{ parseScenarioIntent[\s\S]*?\} from ".\/scenario-intent.js"/);
  assert.match(ui, /import \{ validatePlan \} from ".\/scenario-plan.js"/);
  assert.match(ui, /id="agent-nl-input"/);
  assert.match(ui, /maxlength="500"/);
  assert.match(ui, /id="agent-plan-btn"/);
  assert.match(ui, /renderScenarioPlanPreview/);
  // approval executes ONLY via the existing engine with the gate's {scenarioId, options}
  assert.match(ui, /execution\.scenarioId/);
  assert.match(ui, /execution\.options/);
  assert.match(ui, /scenarioIntents/);
  // T17-final: the fixed-preset adapter injects params; NL numbers never reach the engine.
  assert.match(ui, /import \{ buildPresetPlan[\s\S]*?\} from ".\/scenario-preset.js"/);
  assert.match(ui, /buildPresetPlan\(/);
});

test("ui.js loads the scenario-intents fixture as data", () => {
  assert.match(ui, /getScenarioIntents/);
  assert.match(ui, /getScenarioIntentCorpus/);
  assert.match(ui, /getScenarioIntentEmbeddings/);
  assert.match(ui, /createScenarioSemanticClassifier/);
  assert.match(ui, /interpretScenarioIntent/);
});

test("semantic UI is async, race-safe and external classification is explicit opt-in", () => {
  assert.match(ui, /id="agent-external-opt-in"/);
  assert.match(ui, /선택적 외부 AI/);
  assert.match(ui, /async function previewFromInput/);
  assert.match(ui, /agentPreviewSeq/);
  assert.match(ui, /createExternalIntentAdapter/);
  assert.match(ui, /외부 AI는 상품·계산·대상을 바꿀 수 없습니다/);
});

test("external intent may retry only a low-confidence type, never target ambiguity or not-found", () => {
  const base = {
    mode: "hybrid",
    intent: { steps: [] },
    classification: { status: "low_confidence" },
  };
  assert.equal(shouldTryExternalIntent(base, false), false);
  assert.equal(shouldTryExternalIntent(base, true), true);
  assert.equal(shouldTryExternalIntent({
    ...base,
    classification: { status: "matched" },
    intent: { steps: [], unsupportedSegments: [{ reason: "일치하는 거래 없음" }] },
  }, true), false);
  assert.equal(shouldTryExternalIntent({
    ...base,
    classification: { status: "matched" },
    intent: { steps: [{ type: "payment_delay", target: {} }] },
  }, true), false);
});

test("blocked preview never presents a numeric confidence as an input percentage", () => {
  const gate = {
    ok: false,
    missingFacts: [],
    unsupportedSegments: [{ text: "", reason: "지원하지 않는 문장" }],
    errors: [],
  };
  const html = renderScenarioPlanPreview(gate, {
    confidence: 0.3,
    mode: "keyword",
  });
  assert.doesNotMatch(html, /30%/);
  assert.match(html, /신뢰도가 낮거나/);
  assert.doesNotMatch(html, /id="agent-approve"/);
});

test("external intent connection failure is disclosed without blocking the local fallback", () => {
  const gate = {
    ok: false,
    missingFacts: [{ field: "scenario_type", question: "상황을 더 구체적으로 알려주세요." }],
    unsupportedSegments: [],
    errors: [],
  };
  const html = renderScenarioPlanPreview(gate, {
    mode: "hybrid",
    externalStatus: "unavailable",
  });
  assert.match(html, /외부 AI 연결을 사용할 수 없어 로컬 분류 결과를 유지했습니다/);
  assert.match(html, /프록시·API 키 없이도 핵심 기능은 계속 동작합니다/);
  assert.doesNotMatch(html, /id="agent-approve"/);
});

test("starting a new preview clears the previously executed scenario and explanation", () => {
  assert.match(ui, /function clearScenarioOutputForPreview\(\)/);
  assert.match(ui, /state\.lastCounterfactual = null/);
  assert.match(ui, /what-if-run[\s\S]*?aria-pressed[\s\S]*?false/);
  assert.match(ui, /새 계획은 아직 실행되지 않았습니다/);
  assert.match(ui, /시나리오의 의미와 한계를 로컬 규칙으로 설명합니다/);
  const previewAt = ui.indexOf("async function previewFromInput");
  const clearAt = ui.indexOf("clearScenarioOutputForPreview();", previewAt);
  const interpretAt = ui.indexOf("interpretScenarioIntent(", previewAt);
  assert.ok(clearAt > previewAt && clearAt < interpretAt);
});

// --- T20.1: stale preview invalidation + clean copy ---
test("T20.1: normalizeIntentText is exported and NFC/whitespace-normalizes", () => {
  assert.equal(normalizeIntentText("  미국   거래처  "), "미국 거래처");
  assert.equal(normalizeIntentText("미국".normalize("NFD")), "미국");
});

test("T20.1: ui invalidates a stale preview on input and re-checks the source text at approve", () => {
  assert.match(ui, /addEventListener\("input"/);   // editing the box invalidates the preview
  assert.match(ui, /agentPlan = null/);            // preview/approval state cleared
  assert.match(ui, /normalizeIntentText/);         // approve re-checks normalized text equality
  assert.match(ui, /입력이 변경/);                  // user is told to re-preview
});

test("T20.1: renderScenarioPlanPreview carries no awkward 은(는) josa placeholder", () => {
  const html = renderScenarioPlanPreview(okGate, { step: { type: "payment_delay", target: { transaction_id: "tx-1" }, params: { months: 1 } }, confidence: 0.9 });
  assert.doesNotMatch(html, /은\(는\)/);
  assert.doesNotMatch(html, /1개월는/);
  assert.match(html, /1개월 값은 자연어에서 추출한 값이 아니라/);
});

test("T17-final UI examples contain no magnitude that the parser must reject", () => {
  assert.match(ui, /숫자 없이 상황과 대상만 입력/);
  assert.match(ui, /미국 거래처 입금이 늦으면\?/);
  assert.match(ui, /수출 매출이 감소하면\?/);
  assert.match(ui, /환율이 불리해지면\?/);
  assert.doesNotMatch(ui, /placeholder='[^']*(?:한 달|30%|5%)[^']*'/);
});
