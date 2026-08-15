import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { shouldShowEligibilityQuestions } from "../js/ui.js";

const read = (relativePath) =>
  readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");

test("T36 purpose disclosure shows extra qualification questions only for working capital", () => {
  assert.equal(shouldShowEligibilityQuestions([]), false);
  assert.equal(shouldShowEligibilityQuestions(["fx_hedge"]), false);
  assert.equal(shouldShowEligibilityQuestions(["guarantee_insurance"]), false);
  assert.equal(shouldShowEligibilityQuestions(["working_capital"]), true);
  assert.equal(shouldShowEligibilityQuestions(["fx_hedge", "working_capital"]), true);
  assert.equal(shouldShowEligibilityQuestions(null), false);
});

test("T36 input keeps qualification controls in the DOM but collapses them by selected purpose", async () => {
  const ui = await read("js/ui.js");
  assert.match(ui, /class="eligibility-inputs"\s+\$\{showEligibilityQuestions \? "" : "hidden"\}/);
  assert.match(ui, /지원 목적을 선택하면 필요한 추가 자격 질문을 표시합니다/);
  assert.match(ui, /선택한 목적은 거래·기업 정보로 우선 판정합니다/);
  assert.match(ui, /root\.querySelectorAll\("\.purpose"\)[\s\S]*?addEventListener\("change"/);
});

test("T36 judge evidence is collapsed after customer calculations and before governance", async () => {
  const ui = await read("js/ui.js");
  const css = await read("css/app.css");
  const calculationsAt = ui.indexOf('<details class="results-details">');
  const verificationAt = ui.indexOf('<details class="verification-details">');
  const evaluationAt = ui.indexOf("renderEvaluationCard(state.data.evaluation)");
  const governanceAt = ui.indexOf('<details class="governance-advanced card">');
  assert.ok(calculationsAt >= 0);
  assert.ok(verificationAt > calculationsAt);
  assert.ok(evaluationAt > verificationAt);
  assert.ok(governanceAt > evaluationAt);
  assert.doesNotMatch(ui, /<details class="verification-details"\s+open/);
  assert.match(ui, /심사·검증 정보/);
  assert.match(css, /\.results-details:not\(\[open\]\)\s*>\s*:not\(summary\)/);
  assert.match(css, /\.verification-details:not\(\[open\]\)\s*>\s*:not\(summary\)/);
});

test("T36 customer screen does not advertise unfinished scenarios", async () => {
  const ui = await read("js/ui.js");
  assert.doesNotMatch(ui, /확장 예정:|future-note/);
});
