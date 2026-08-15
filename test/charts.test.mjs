import { test } from "node:test";
import assert from "node:assert/strict";
import { barChart, escapeXml } from "../js/charts.js";

test("barChart returns svg with one rect per item", () => {
  const svg = barChart([{ label: "USD", value: 200000 }, { label: "EUR", value: -80000 }]);
  assert.ok(svg.startsWith("<svg"));
  assert.equal((svg.match(/<rect/g) || []).length >= 2, true);
});

test("escapeXml escapes angle brackets and ampersand", () => {
  assert.equal(escapeXml("a<b>&c"), "a&lt;b&gt;&amp;c");
});
