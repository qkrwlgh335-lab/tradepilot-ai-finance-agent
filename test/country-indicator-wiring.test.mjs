import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const ROOT = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, ROOT), "utf8");

test("browser loads country indicators locally and never calls World Bank directly", async () => {
  const [source, ui, main, html] = await Promise.all([
    read("js/data-source.js"), read("js/ui.js"), read("js/main.js"), read("index.html"),
  ]);
  assert.match(source, /getCountryIndicators/);
  assert.match(ui, /source\.getCountryIndicators\(\)/);
  for (const text of [source, ui, main, html]) {
    assert.doesNotMatch(text, /api\.worldbank\.org/i);
    assert.doesNotMatch(text, /fetch\([^)]*worldbank/i);
  }
});

test("UI separates official indicators from demo risk and disclaims decision use", async () => {
  const ui = await read("js/ui.js");
  assert.match(ui, /거래국 경제·무역 지표/);
  assert.match(ui, /World Bank WDI/);
  assert.match(ui, /금융계산·상품 자격판정에 사용하지 않습니다/);
  assert.match(ui, /공식 지표 미확인/);
  assert.match(ui, /noopener noreferrer/);
});
