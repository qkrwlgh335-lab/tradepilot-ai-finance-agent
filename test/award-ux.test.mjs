import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("award journey puts actions, candidates and counterfactuals before technical details", async () => {
  const ui = await read("js/ui.js");
  const actionAt = ui.indexOf("내 기업의 금융 액션 플랜");
  const productAt = ui.indexOf("지금 검토할 금융상품");
  const whatIfAt = ui.indexOf("위기 시나리오로 다시 검증");
  const detailsAt = ui.indexOf('<details class="results-details">');
  assert.ok(actionAt >= 0);
  assert.ok(productAt > actionAt);
  assert.ok(whatIfAt > productAt);
  assert.ok(detailsAt > whatIfAt);
});

test("customer cards hide raw graph paths behind an explicit evidence disclosure", async () => {
  const ui = await read("js/ui.js");
  assert.match(ui, /판정 근거 자세히 보기/);
  assert.match(ui, /class="decision-evidence-details"/);
  assert.doesNotMatch(ui, /<h5>① 온톨로지 추론 경로<\/h5>\s*<ol>/);
});

test("customer evidence numbering follows its visual disclosure order", async () => {
  const ui = await read("js/ui.js");
  const ruleAt = ui.indexOf("<h5>① 자격 규칙 근거</h5>");
  const ragAt = ui.indexOf("<h5>② RAG 연결문서 근거</h5>");
  const ontologyAt = ui.indexOf("<h5>③ 온톨로지 추론 경로</h5>");
  assert.ok(ruleAt >= 0);
  assert.ok(ragAt > ruleAt);
  assert.ok(ontologyAt > ragAt);
});

test("advanced external AI controls are below the result details and collapsed", async () => {
  const ui = await read("js/ui.js");
  const detailsAt = ui.indexOf('<details class="results-details">');
  const governanceAt = ui.indexOf('<details class="governance-advanced card">');
  assert.ok(detailsAt >= 0);
  assert.ok(governanceAt > detailsAt);
  assert.doesNotMatch(ui, /<details class="governance-advanced[^"]*"\s+open/);
});

test("T26 hero explains the complete five-step customer journey in order", async () => {
  const [html, css] = await Promise.all([read("index.html"), read("css/app.css")]);
  assert.match(html, /aria-label="이용 5단계"/);
  const labels = ["거래 분석", "위험 계산", "자격 판정", "위기 재검증", "상담 연결"];
  let previous = -1;
  for (const label of labels) {
    const at = html.indexOf(label);
    assert.ok(at > previous, `${label} must appear once in journey order`);
    previous = at;
  }
  assert.equal((html.match(/class="flow-num"/g) || []).length, 5);
  assert.doesNotMatch(html, /이용 3단계/);
  assert.match(
    css,
    /@media \(max-width: 640px\)[\s\S]*?\.hero-flow\s*\{\s*grid-template-columns:\s*repeat\(2,/,
  );
  assert.match(
    css,
    /@media \(max-width: 640px\)[\s\S]*?\.status-legend\s*\{\s*grid-template-columns:\s*repeat\(2,/,
  );
  assert.match(
    css,
    /@media \(min-width: 641px\) and \(max-width: 900px\)[\s\S]*?\.hero-flow\s*\{\s*grid-template-columns:\s*repeat\(3,/,
  );
});

test("T26 recommendation legend uses icon, text and the same four state color tokens", async () => {
  const [ui, css] = await Promise.all([read("js/ui.js"), read("css/app.css")]);
  const states = [
    ["candidate", "✓", "추천 후보", "#2f9e44"],
    ["excluded", "×", "고객 부적격", "#8c2f2f"],
    ["pending", "?", "정보 필요", "#8a5a00"],
    ["unavailable", "–", "규칙정보 미확인", "#666666"],
  ];

  for (const [state, icon, label, color] of states) {
    assert.match(
      ui,
      new RegExp(
        `legend-item legend-${state}[\\s\\S]*?legend-icon[\\s\\S]*?>${icon === "?" ? "\\?" : icon}<` +
        `[\\s\\S]*?${label}`,
      ),
    );
    assert.match(css, new RegExp(`--state-${state}:\\s*${color}`, "i"));
    assert.match(
      css,
      new RegExp(`\\.legend-${state}\\s+\\.legend-icon\\s*\\{[^}]*var\\(--state-${state}\\)`, "i"),
    );
  }
  assert.match(ui, /aria-label="판정 상태 안내"/);
  assert.doesNotMatch(ui, /aria-label="판정 상태 색상 안내"/);
});

test("mobile hero copy wraps inside the viewport instead of clipping highlighted phrases", async () => {
  const css = await read("css/app.css");
  assert.match(css, /\.hero-value\s*\{[^}]*word-break:\s*keep-all[^}]*overflow-wrap:\s*break-word/s);
  assert.match(css, /\.hero-value strong\s*\{[^}]*white-space:\s*normal/s);
});
