import { test } from "node:test";
import assert from "node:assert/strict";
import { computeNetExposure, A_SA_CASHFLOWS } from "../js/exposure.js";

test("nets receivables against payables per currency", () => {
  const rows = computeNetExposure([
    { currency: "USD", direction: "in", amount: 300000, months: 3 },
    { currency: "USD", direction: "out", amount: 100000, months: 2 },
    { currency: "EUR", direction: "out", amount: 80000, months: 4 },
  ]);
  const usd = rows.find((r) => r.currency === "USD");
  assert.equal(usd.receivable, 300000);
  assert.equal(usd.payable, 100000);
  assert.equal(usd.net, 200000);
  const eur = rows.find((r) => r.currency === "EUR");
  assert.equal(eur.net, -80000);
});

test("returns rows sorted by currency", () => {
  const rows = computeNetExposure([
    { currency: "USD", direction: "in", amount: 1, months: 1 },
    { currency: "EUR", direction: "in", amount: 1, months: 1 },
  ]);
  assert.deepEqual(rows.map((r) => r.currency), ["EUR", "USD"]);
});

test("A_SA_CASHFLOWS matches the spec persona", () => {
  const rows = computeNetExposure(A_SA_CASHFLOWS);
  assert.equal(rows.find((r) => r.currency === "USD").net, 200000);
  assert.equal(rows.find((r) => r.currency === "EUR").net, -80000);
});

test("empty input returns empty array", () => {
  assert.deepEqual(computeNetExposure([]), []);
});
