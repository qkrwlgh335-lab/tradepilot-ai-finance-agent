import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("customer UI, brief and egress use monitoring facts instead of demo country-risk labels", async () => {
  const [ui, brief, privacy] = await Promise.all([
    read("js/ui.js"), read("js/brief.js"), read("js/privacy.js"),
  ]);
  assert.match(ui, /buildCountryMonitoring/);
  assert.match(ui, /거래 명목 원화환산/);
  assert.doesNotMatch(ui, /기존 위험 라벨|risk_level/);
  assert.doesNotMatch(brief, /거래국 리스크|risk_level/);
  assert.doesNotMatch(privacy, /risk_level/);
  assert.match(privacy, /exposureShare/);
});
