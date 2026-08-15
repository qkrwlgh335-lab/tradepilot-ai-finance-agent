import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { renderBilateralTradeSource } from "../js/ui.js";

const ROOT = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, ROOT), "utf8");

test("browser loads bilateral trade only from a local cache", async () => {
  const [source, ui, main, html] = await Promise.all([
    read("js/data-source.js"), read("js/ui.js"), read("js/main.js"), read("index.html"),
  ]);
  assert.match(source, /getBilateralTrade/);
  assert.match(ui, /source\.getBilateralTrade\(\)/);
  for (const text of [source, ui, main, html]) {
    assert.doesNotMatch(text, /comtradeapi\.un\.org/i);
    assert.doesNotMatch(text, /fetch\([^)]*comtrade/i);
  }
});

test("UI labels Korea-reported merchandise trade and keeps it out of decisions", async () => {
  const ui = await read("js/ui.js");
  assert.match(ui, /한국 신고 기준 연간 상품 교역/);
  assert.match(ui, /한국의 해당국 수출/);
  assert.match(ui, /한국의 해당국 수입/);
  assert.match(ui, /UN Comtrade/);
  assert.match(ui, /금융계산·상품 자격판정에 사용하지 않습니다/);
  assert.match(ui, /교역 통계 미확인/);
});

test("trade source footer uses the same validation result as the country cards", async () => {
  const snapshot = JSON.parse(await read("data/bilateral-trade.json"));
  const verified = renderBilateralTradeSource(snapshot);
  assert.match(verified, /검증된 로컬 캐시/);
  assert.match(verified, /href="https:\/\/comtradeplus\.un\.org\/TradeFlow"/);

  for (const unavailable of [
    { schema_version: "0", status: "unavailable", countries: {} },
    { ...snapshot, countries: {} },
  ]) {
    const html = renderBilateralTradeSource(unavailable);
    assert.match(html, /교역 통계 캐시 미확인/);
    assert.doesNotMatch(html, /검증된 로컬 캐시/);
    assert.doesNotMatch(html, /<a\b/);
  }
});
