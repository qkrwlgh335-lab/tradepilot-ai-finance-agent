import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildProfile } from "../js/profile.js";
import { validateProfile } from "../js/reasoner.js";
import { CalculationError } from "../js/errors.js";

const load = async (p) => JSON.parse(await readFile(new URL(`../${p}`, import.meta.url), "utf8"));
const rates = { USD: 1385.5, EUR: 1502.3 };

// A fully specified company (all required facts present) used as a base.
const company = {
  companyType: "corporation",
  isSme: false,
  riskAppetite: "low",
  existingHedges: [],
  requestedPurposes: ["fx_hedge"],
};
const row = { country: "US", currency: "USD", tradeType: "export", direction: "in", amount: 100000, months: 3 };

test("export/import comes from per-row tradeType, never from direction", () => {
  const p = buildProfile({
    cashflows: [{ country: "US", currency: "USD", tradeType: "import", direction: "in", amount: 300000, months: 3 }],
    rates, company,
  });
  assert.equal(p.facts.company.hasExport, false);   // 수취(in)지만 수입 거래
  assert.equal(p.facts.company.hasImport, true);
});

test("isSme is never defaulted; omitting it produces a missingFact and a question", () => {
  const { isSme, ...noSme } = company;
  const p = buildProfile({ cashflows: [row], rates, company: noSme });
  assert.equal("isSme" in p.facts.company, false, "must not resolve to a default");
  const mf = p.missingFacts.find((m) => m.factPath === "company.isSme");
  assert.ok(mf && mf.question.length > 0);
});

test("every transaction gets a stable, deterministic, UNIQUE transaction_id", () => {
  const input = {
    cashflows: [
      { country: "US", currency: "USD", tradeType: "export", direction: "in", amount: 300000, months: 3 },
      { country: "DE", currency: "EUR", tradeType: "import", direction: "out", amount: 80000, months: 4 },
    ], rates, company,
  };
  const a = buildProfile(input), b = buildProfile(input);
  assert.ok(a.transactions.every((t) => t.transaction_id));
  assert.deepEqual(a.transactions.map((t) => t.transaction_id), b.transactions.map((t) => t.transaction_id));
});

test("two identical cashflow rows still get distinct ids (uniqueness by position)", () => {
  const dup = { cashflows: [{ ...row }, { ...row }], rates, company };
  const ids = buildProfile(dup).transactions.map((t) => t.transaction_id);
  assert.equal(new Set(ids).size, ids.length);
});

test("a caller-supplied transaction_id is preserved; a duplicate supplied id is a validation error", () => {
  const kept = buildProfile({ cashflows: [{ ...row, transaction_id: "txn-custom" }], rates, company });
  assert.equal(kept.transactions[0].transaction_id, "txn-custom");
  assert.throws(
    () => buildProfile({ cashflows: [{ ...row, transaction_id: "dup" }, { ...row, transaction_id: "dup" }], rates, company }),
    (e) => e instanceof CalculationError && e.code === "DUPLICATE_TRANSACTION_ID"
  );
});

test("existingHedges tri-state: null=unknown(question), []=confirmed none, non-empty=has hedge", () => {
  const unknown = buildProfile({ cashflows: [row], rates, company: { ...company, existingHedges: null } });
  assert.ok(unknown.missingFacts.some((m) => m.factPath === "company.existingHedges"));
  assert.equal("hasExistingHedge" in unknown.facts.company, false);

  const none = buildProfile({ cashflows: [row], rates, company: { ...company, existingHedges: [] } });
  assert.equal(none.facts.company.hasExistingHedge, false);
  assert.ok(!none.missingFacts.some((m) => m.factPath === "company.existingHedges"));

  const has = buildProfile({
    cashflows: [row], rates,
    company: { ...company, existingHedges: [{ currency: "USD", amount: 100000, maturityMonths: 3, instrumentType: "forward" }] },
  });
  assert.equal(has.facts.company.hasExistingHedge, true);
});

test("hasExistingHedge is derived only; a supplied value is ignored", () => {
  const p = buildProfile({ cashflows: [row], rates, company: { ...company, existingHedges: [], hasExistingHedge: true } });
  assert.equal(p.facts.company.hasExistingHedge, false);
});

test("requested and suggested purposes are separated; only requested is the driver", () => {
  const p = buildProfile({
    cashflows: [{ country: "US", currency: "USD", tradeType: "import", direction: "out", amount: 100000, months: 2 }],
    rates, company: { ...company, requestedPurposes: ["fx_hedge"] },
  });
  assert.deepEqual(p.requestedPurposes, ["fx_hedge"]);
  assert.ok(Array.isArray(p.suggestedPurposes));
  assert.notStrictEqual(p.suggestedPurposes, p.requestedPurposes);   // 별개 배열
});

test("exposures share the CFaR bucket axis (currency, months)", () => {
  const p = buildProfile({
    cashflows: [
      { country: "US", currency: "USD", tradeType: "export", direction: "in", amount: 300000, months: 3 },
      { country: "US", currency: "USD", tradeType: "import", direction: "out", amount: 100000, months: 2 },
    ], rates, company,
  });
  assert.deepEqual(p.exposures.map((e) => `${e.currency}@${e.months}`), ["USD@2", "USD@3"]);
  const b3 = p.exposures.find((e) => e.months === 3);
  assert.equal(b3.netAtMaturity, 300000);
  assert.equal(b3.krwValue, 300000 * 1385.5);
});

test("validateProfile reports violations and missingFacts, never silently passes", async () => {
  const schema = await load("data/ontology-schema.json");
  const r = validateProfile(
    { facts: { company: { companyType: "corporation" } }, exposures: [], requestedPurposes: [], suggestedPurposes: [], risks: [], missingFacts: [] },
    schema
  );
  assert.equal(r.conforms, false);
  assert.ok(r.missingFacts.some((m) => m.factPath === "company.isSme"));
  // 누락은 missingFacts 에만 기록된다(같은 사실을 violation 으로 중복 보고하지 않음).
  assert.equal(r.violations.length, 0, `missing facts must not also be violations: ${JSON.stringify(r.violations)}`);
  assert.ok(r.missingFacts.length >= 4, "every unset required fact is asked about");
});

test("a fully specified profile conforms", async () => {
  const schema = await load("data/ontology-schema.json");
  const p = buildProfile({ cashflows: [row], rates, company });
  const r = validateProfile(p, schema);
  assert.equal(r.conforms, true, JSON.stringify(r.violations));
});
