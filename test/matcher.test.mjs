import { test } from "node:test";
import assert from "node:assert/strict";
import { buildProfile, matchProducts } from "../js/matcher.js";

const cashflows = [
  { currency: "USD", direction: "in", amount: 300000, months: 3 },
  { currency: "USD", direction: "out", amount: 100000, months: 2 },
  { currency: "EUR", direction: "out", amount: 80000, months: 4 },
];
const netRows = [
  { currency: "EUR", net: -80000 },
  { currency: "USD", net: 200000 },
];

test("buildProfile derives flags and max exposure", () => {
  const p = buildProfile(netRows, cashflows);
  assert.equal(p.isSme, true);
  assert.equal(p.hasExport, true);
  assert.equal(p.hasImport, true);
  assert.equal(p.maxNetExposure, 200000);
});

test("matchProducts applies each rule type", () => {
  const products = [
    { id: "fwd", match: { when: "net_exposure_over", value: 50000 } },
    { id: "big", match: { when: "net_exposure_over", value: 500000 } },
    { id: "ins", match: { when: "is_sme", value: true } },
    { id: "imp", match: { when: "has_import", value: true } },
    { id: "pol", match: { when: "is_sme_exporter", value: true } },
  ];
  const p = buildProfile(netRows, cashflows);
  const ids = matchProducts(products, p).map((x) => x.id);
  assert.deepEqual(ids, ["fwd", "ins", "imp", "pol"]);
});
