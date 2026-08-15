import { test } from "node:test";
import assert from "node:assert/strict";
import { simulateScenarios, formatKRW } from "../js/scenario.js";

const rates = { USD: 1385.5, EUR: 1502.3 };
const netRows = [
  { currency: "USD", net: 200000 },
  { currency: "EUR", net: -80000 },
];

test("computes per-currency pnl at each delta", () => {
  const out = simulateScenarios(netRows, rates, [-0.1, 0]);
  const drop = out.find((s) => s.delta === -0.1);
  const usd = drop.byCurrency.find((c) => c.currency === "USD");
  assert.equal(Math.round(usd.pnl), Math.round(200000 * 1385.5 * -0.1));
  const eur = drop.byCurrency.find((c) => c.currency === "EUR");
  assert.ok(eur.pnl > 0);
});

test("delta 0 yields zero pnl", () => {
  const out = simulateScenarios(netRows, rates, [0]);
  assert.equal(out[0].totalPnl, 0);
});

test("skips currencies without a rate", () => {
  const out = simulateScenarios([{ currency: "GBP", net: 100 }], rates, [-0.1]);
  assert.equal(out[0].byCurrency.length, 0);
});

test("formatKRW rounds and separates thousands", () => {
  assert.equal(formatKRW(27000000), "₩ 27,000,000");
  assert.equal(formatKRW(-1234.6), "₩ -1,235");
});
