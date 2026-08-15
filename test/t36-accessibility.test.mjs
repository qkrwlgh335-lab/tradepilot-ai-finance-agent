import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (relativePath) =>
  readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");

test("T36 transaction row controls expose row-specific accessible names", async () => {
  const ui = await read("js/ui.js");
  for (const label of [
    "행 거래국",
    "행 통화",
    "행 수출·수입 구분",
    "행 수취·지급 구분",
    "행 외화 금액",
    "행 결제 시점(개월)",
    "행 거래 삭제",
  ]) {
    assert.ok(
      ui.includes(`aria-label="${"${i + 1}"}${label}"`),
      `${label} must include its row number in the accessible name`,
    );
  }
});

test("T36 interactive controls have a visible keyboard focus contract", async () => {
  const css = await read("css/app.css");
  assert.match(css, /:focus-visible\s*\{/);
  assert.match(css, /outline:\s*3px solid var\(--focus-ring\)/);
  assert.match(css, /outline-offset:\s*2px/);
});
