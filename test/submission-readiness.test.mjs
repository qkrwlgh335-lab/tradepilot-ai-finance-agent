import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { createAnalysisState } from "../js/ui.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const read = (relative) => readFile(path.join(ROOT, relative), "utf8");

test("fresh analysis state clears prior customer data while preserving loaded reference data", () => {
  const referenceData = { fx: { as_of: "fixture" } };
  const state = createAnalysisState(referenceData);

  assert.equal(state.screen, "input");
  assert.equal(state.data, referenceData);
  assert.deepEqual(state.rows, [{
    country: "",
    currency: "",
    tradeType: "",
    direction: "in",
    amount: "",
    months: "",
  }]);
  assert.deepEqual(state.company, {
    companyType: "",
    companyScale: "",
    isSme: "",
    riskAppetite: "",
    requestedPurposes: [],
    isManufacturer: "",
    supplyChainProgramEligible: "",
    partnerGuaranteeConfirmed: "",
    creditGradeMeetsThreshold: "",
    reviewChannelConfirmed: "",
    priorYearExportUsd: "",
  });
  assert.equal(state.hedgeMode, "unknown");
  assert.deepEqual(state.hedgeRows, []);
  assert.deepEqual(state.liquidityRaw, {
    openingBalanceKrw: "",
    creditLineKrw: "",
  });
  assert.equal(state.profile, null);
  assert.equal(state.selected, null);
  assert.equal(state.briefCtx, null);
});

test("results distinguish editing existing inputs from starting a clean analysis", async () => {
  const ui = await read("js/ui.js");
  assert.match(ui, /id="edit-input"[^>]*>← 입력값 수정하기/);
  assert.match(ui, /id="new-analysis"[^>]*>새 분석 시작/);
  assert.match(ui, /Object\.assign\(state,\s*createAnalysisState\(state\.data\)\)/);
  assert.doesNotMatch(ui, /id="restart"/);
});

test("Windows launcher starts the local server through npm start (readiness-probed launch)", async () => {
  const launcher = await read("START_DEMO.cmd");
  assert.match(launcher, /where node/i);
  // T30a: the .cmd is a thin wrapper — the dev-server is spawned by scripts/start-demo.mjs,
  // which probes readiness before opening the browser.
  assert.match(launcher, /npm\s+start/i);
  assert.doesNotMatch(launcher, /index\.html/i);
  const pkg = JSON.parse(await read("package.json"));
  assert.match(pkg.scripts?.start, /scripts[\\\/]start-demo\.mjs/);
});

test("submission packaging is explicit and excludes internal Superpowers documents", async () => {
  const [pkgText, pack, submission] = await Promise.all([
    read("package.json"),
    read("scripts/package.mjs"),
    read("scripts/package-submission.mjs"),
  ]);
  const pkg = JSON.parse(pkgText);
  assert.equal(pkg.scripts["package:submission"], "node scripts/package-submission.mjs");
  assert.match(pack, /"superpowers"/);
  assert.match(submission, /발표자료\.pptx/);
  assert.match(submission, /KB_TradePilot_수출입금융에이전트_제출\.zip/);
});
