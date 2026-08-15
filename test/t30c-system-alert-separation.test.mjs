// T30c-B — a market-data outage is a SYSTEM alert, not a user input error. It must not appear
// as "입력을 확인해 주세요 (N건)" or "입력값 오류"; those are reserved for actual user typos.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { renderMarketDataAlert } from "../js/ui.js";

const uiSrc = await readFile(new URL("../js/ui.js", import.meta.url), "utf8");

// ---- pure renderer ----
test("T30c-B (a,f): renderMarketDataAlert has the exact system-alert wording and role", () => {
  const html = renderMarketDataAlert();
  assert.match(html, /시장데이터 확인 필요/);
  assert.match(html, /거래 입력의 문제가 아닙니다\. 시장데이터의 출처와 기준일을 검증할 수 없어 계산을 시작하지 않았습니다\. 네트워크를 확인하거나 검증된 캐시를 복구한 뒤 다시 시도하세요\./);
  assert.match(html, /role="alert"/);
  assert.match(html, /class="[^"]*market-data-alert/);
});

test("T30c-B (b,c,d,e): the system alert HTML never carries user-input-error phrasing", () => {
  const html = renderMarketDataAlert();
  assert.doesNotMatch(html, /입력을 확인해 주세요/);
  assert.doesNotMatch(html, /빨간색으로 표시된 항목/);
  assert.doesNotMatch(html, /입력값 오류/);
  assert.doesNotMatch(html, /\(\d+건\)/, "no error-count parenthesis");
});

// ---- ui.js wiring: the analyze handler must route unavailable meta to renderMarketDataAlert ----
test("T30c-B: ui.js exposes renderMarketDataAlert and wires it into the analyze fail-closed path", () => {
  assert.match(uiSrc, /export\s+function\s+renderMarketDataAlert/);
  assert.match(uiSrc, /renderMarketDataAlert\s*\(/);
  // The unavailable branch must NOT route the market-data reason through the user-input error list.
  // Specifically: the block message text must appear once — inside renderMarketDataAlert — and
  // the analyze handler must not add it to `renderInput([{section:"general", kind:"error", …}])`.
  assert.doesNotMatch(
    uiSrc,
    /renderInput\(\[\{[^}]*시장데이터의 출처와 기준일을 검증할 수 없어/,
    "analyze must not push the market-data error into the user-input error list"
  );
});

test("T30c-B: the block message body lives ONLY in the alert renderer (single source)", () => {
  // The exact system-alert body sentence must appear exactly once in ui.js — in renderMarketDataAlert.
  const bodyMatches = uiSrc.match(/거래 입력의 문제가 아닙니다\. 시장데이터의 출처와 기준일을 검증할 수 없어 계산을 시작하지 않았습니다\./g) || [];
  assert.equal(bodyMatches.length, 1, `expected the alert body sentence exactly once, got ${bodyMatches.length}`);
});

test("T30c-B: normal user-input errors are still routed to renderInput (regression)", () => {
  // The generic user-input alert wording still lives in ui.js for real input errors.
  assert.match(uiSrc, /입력을 확인해 주세요/);
  assert.match(uiSrc, /입력값 오류/);
});
