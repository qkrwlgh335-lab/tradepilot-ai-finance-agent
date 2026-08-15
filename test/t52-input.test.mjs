// T5.2: the input screen collects every ontology fact explicitly (no inference), surfaces missing
// facts as questions, and the confirm screen restates them as user-confirmed values.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const ui = await readFile(new URL("../js/ui.js", import.meta.url), "utf8");

test("the input screen collects every fact the ontology requires", () => {
  for (const id of ["#company-type", "#company-scale", "#risk-appetite"]) assert.ok(ui.includes(id), id);
  for (const id of ["#is-manufacturer", "#supply-chain-program", "#partner-guarantee", "#credit-grade-threshold", "#review-channel-confirmed", "#prior-year-export-usd"])
    assert.ok(ui.includes(id), id);
  // the single-field hedge inputs are gone, replaced by repeated rows
  assert.ok(!/#has-existing-hedge\b/.test(ui) && !/#existing-hedge-amount\b/.test(ui), "single hedge inputs must be gone");
  for (const marker of ["existing-hedge-row", "hedge-currency", "hedge-amount", "hedge-maturity", "hedge-none"]) assert.ok(ui.includes(marker), marker);
  assert.match(ui, /tradeType/);
  for (const p of ["환헤지", "운전자금", "수출대금 회수", "보증·보험", "정책자금"]) assert.ok(ui.includes(p), p);
});

test("the confirm screen restates the company facts, including each hedge's currency/amount/maturity", () => {
  const confirm = ui.slice(ui.indexOf("function renderConfirm"), ui.indexOf("function renderResults"));
  for (const label of ["기업 규모", "법인", "위험성향", "기존 헤지", "지원 목적", "제조기업", "데모 제휴보증", "상담채널 사전확인"]) assert.ok(confirm.includes(label), label);
  assert.match(confirm, /기존 헤지 없음|없음으로 확정/);
  assert.match(confirm, /maturityMonths|만기/);
});

test("missing facts are surfaced as questions instead of being guessed (SME is never defaulted)", () => {
  assert.match(ui, /missingFacts/);
  assert.ok(!/isSme\s*[:=]\s*true/.test(ui), "never default SME to true");
});

test("the analyze handler builds the ontology profile from explicit inputs", () => {
  assert.match(ui, /profile\.buildProfile/);
});

test("samples carry per-row tradeType so export/import is never inferred from direction", async () => {
  const { samples } = JSON.parse(await readFile(new URL("../data/samples.json", import.meta.url), "utf8"));
  for (const s of samples) for (const c of s.cashflows)
    assert.ok(["export", "import"].includes(c.tradeType), `${s.id} row missing tradeType`);
});
