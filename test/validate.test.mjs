import { test } from "node:test";
import assert from "node:assert/strict";
import { validateCashflows } from "../js/validate.js";

const good = [
  { country: "US", currency: "USD", direction: "in", amount: 300000, months: 3 },
  { country: "DE", currency: "EUR", direction: "out", amount: 80000, months: 4 },
];

test("accepts valid rows and normalizes numbers", () => {
  const r = validateCashflows(good);
  assert.equal(r.ok, true);
  assert.equal(r.errors.length, 0);
  assert.equal(r.normalized.length, 2);
  assert.equal(r.normalized[0].amount, 300000);
  assert.equal(typeof r.normalized[0].months, "number");
});

test("empty input is not ok", () => {
  const r = validateCashflows([]);
  assert.equal(r.ok, false);
  assert.ok(r.errors.length >= 1);
});

test("rejects non-positive amount and reports the row number", () => {
  const r = validateCashflows([{ country: "US", currency: "USD", direction: "in", amount: 0, months: 3 }]);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("1행") && e.includes("금액")));
});

test("rejects missing direction", () => {
  const r = validateCashflows([{ country: "US", currency: "USD", direction: "", amount: 100, months: 1 }]);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("수취/지급")));
});

test("string numbers from form inputs are coerced", () => {
  const r = validateCashflows([{ country: "US", currency: "USD", direction: "in", amount: "500000", months: "6" }]);
  assert.equal(r.ok, true);
  assert.equal(r.normalized[0].amount, 500000);
  assert.equal(r.normalized[0].months, 6);
});
