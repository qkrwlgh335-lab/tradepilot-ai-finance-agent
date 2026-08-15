import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const read = (relativePath) =>
  readFile(path.join(ROOT, relativePath), "utf8");

test("the runnable app uses the TradePilot name consistently", async () => {
  const [index, ui] = await Promise.all([
    read("index.html"),
    read("js/ui.js"),
  ]);
  const appSource = `${index}\n${ui}`;

  assert.doesNotMatch(appSource, /TradeGuard/);
  assert.match(index, /KB TradePilot/);
});

test("the sample loader never claims that OCR or document extraction was implemented", async () => {
  const [ui, samples] = await Promise.all([
    read("js/ui.js"),
    read("data/samples.json"),
  ]);
  const sampleSource = `${ui}\n${samples}`;

  for (const forbidden of [
    /OCR/i,
    /자동 추출/,
    /문서에서 아래 거래를 추출했습니다/,
  ]) assert.doesNotMatch(sampleSource, forbidden);

  assert.match(ui, /샘플 거래 불러오기/);
  assert.match(ui, /샘플 데이터를 불러왔습니다/);
});
