// T5 stabilization: existing-hedge validation, schema-constraint validateProfile, market-data
// fail-closed in profile.js. No silent drops, no 0-substitution.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { validateExistingHedges } from "../js/validate.js";
import { buildProfile } from "../js/profile.js";
import { validateProfile } from "../js/reasoner.js";
import { CalculationError } from "../js/errors.js";

const load = async (p) => JSON.parse(await readFile(new URL(`../${p}`, import.meta.url), "utf8"));
const rates = { USD: 1385.5, EUR: 1502.3 };
const company = { companyType: "corporation", isSme: false, riskAppetite: "low", existingHedges: [], requestedPurposes: ["fx_hedge"] };
const row = { country: "US", currency: "USD", tradeType: "export", direction: "in", amount: 100000, months: 3 };

// ---------- 1. validateExistingHedges (pure) ----------
test("existing-hedge mode: unknown asks a question, is not an error", () => {
  const r = validateExistingHedges({ mode: "unknown", rows: [] });
  assert.equal(r.ok, true);
  assert.equal(r.value, undefined);           // undefined -> buildProfile asks the question
  assert.equal(r.errors.length, 0);
});

test("existing-hedge mode: none only when the user pressed '없음' -> [] confirmed", () => {
  const r = validateExistingHedges({ mode: "none", rows: [] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, []);
});

test("existing-hedge list requires at least one row and rejects empty/partial rows (no silent filter)", () => {
  const empty = validateExistingHedges({ mode: "list", rows: [] });
  assert.equal(empty.ok, false);
  assert.ok(empty.errors.some((e) => /최소 1건|한 건/.test(e.message || e)));

  const partial = validateExistingHedges({ mode: "list", rows: [{ currency: "USD", amount: "", maturityMonths: "" }] });
  assert.equal(partial.ok, false);
  assert.ok(partial.errors.some((e) => (e.row === 1 || /1행/.test(e.message)) && /금액|만기/.test(e.message)));
});

test("existing-hedge amounts must be finite > 0 and maturity an explicit finite >= 0 (no ||0 coercion)", () => {
  for (const bad of [{ amount: "0" }, { amount: "-5" }, { amount: "abc" }]) {
    const r = validateExistingHedges({ mode: "list", rows: [{ currency: "USD", maturityMonths: "3", ...bad }] });
    assert.equal(r.ok, false, `amount=${bad.amount}`);
  }
  // blank maturity must NOT become 0
  const blankMat = validateExistingHedges({ mode: "list", rows: [{ currency: "USD", amount: "100000", maturityMonths: "" }] });
  assert.equal(blankMat.ok, false);
  assert.ok(blankMat.errors.some((e) => /만기/.test(e.message)));
  const negMat = validateExistingHedges({ mode: "list", rows: [{ currency: "USD", amount: "100000", maturityMonths: "-1" }] });
  assert.equal(negMat.ok, false);
});

test("a fully specified hedge row normalizes with an explicit maturity", () => {
  const r = validateExistingHedges({ mode: "list", rows: [{ currency: "USD", amount: "100000", maturityMonths: "0", instrumentType: "forward" }] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, [{ currency: "USD", amount: 100000, maturityMonths: 0, instrumentType: "forward" }]);
});

// ---------- 2. validateProfile enforces schema constraints ----------
test("validateProfile rejects a bad enum / string-boolean / negative hedge (not just missing fields)", async () => {
  const schema = await load("data/ontology-schema.json");

  const badEnum = buildProfile({ cashflows: [row], rates, company: { ...company, riskAppetite: "aggressive" } });
  assert.equal(validateProfile(badEnum, schema).conforms, false, "bad riskAppetite enum");

  // string boolean must not pass as isSme
  const strBool = { ...buildProfile({ cashflows: [row], rates, company }) };
  strBool.facts.company.isSme = "true";
  assert.equal(validateProfile(strBool, schema).conforms, false, "isSme must be a real boolean");

  const badCompanyType = buildProfile({ cashflows: [row], rates, company: { ...company, companyType: "llc" } });
  assert.equal(validateProfile(badCompanyType, schema).conforms, false, "bad companyType enum");

  const badPurpose = buildProfile({ cashflows: [row], rates, company: { ...company, requestedPurposes: ["make_money"] } });
  assert.equal(validateProfile(badPurpose, schema).conforms, false, "bad purpose enum");
});

test("validateProfile checks each existing hedge item (currency/amount/maturity)", async () => {
  const schema = await load("data/ontology-schema.json");
  const p = buildProfile({ cashflows: [row], rates, company: { ...company, existingHedges: [{ currency: "USD", amount: 100000, maturityMonths: 3 }] } });
  assert.equal(validateProfile(p, schema).conforms, true);
  const bad = buildProfile({ cashflows: [row], rates, company: { ...company, existingHedges: [{ currency: "USD", amount: -1, maturityMonths: 3 }] } });
  assert.equal(validateProfile(bad, schema).conforms, false, "negative hedge amount");
});

test("validateProfile validates transactions (tradeType/direction/amount/months) and rejects a bad enum", async () => {
  const schema = await load("data/ontology-schema.json");
  const p = buildProfile({ cashflows: [row], rates, company });
  assert.equal(validateProfile(p, schema).conforms, true);
  const bad = { ...p, transactions: [{ ...p.transactions[0], tradeType: "reexport" }] };
  assert.equal(validateProfile(bad, schema).conforms, false, "bad tradeType enum in a transaction");
});

test("validateProfile splits missing (missingFacts) from invalid (violations)", async () => {
  const schema = await load("data/ontology-schema.json");
  const { isSme, ...noSme } = company;
  const p = buildProfile({ cashflows: [row], rates, company: { ...noSme, riskAppetite: "aggressive" } });
  const r = validateProfile(p, schema);
  assert.equal(r.conforms, false);
  assert.ok(r.missingFacts.some((m) => m.factPath === "company.isSme"), "missing isSme -> missingFacts");
  assert.ok(r.violations.some((v) => /riskAppetite/.test(v.path)), "bad riskAppetite -> violations");
});

// ---------- 4. profile.js market-data fail-closed ----------
test("profile.js refuses to build exposures when an FX rate is missing/0/negative/NaN (no krwValue=0)", () => {
  for (const bad of [{}, { USD: 0 }, { USD: -1 }, { USD: NaN }]) {
    assert.throws(
      () => buildProfile({ cashflows: [row], rates: bad, company }),
      (e) => e instanceof CalculationError && ["MISSING_RATE", "INVALID_RATE"].includes(e.code),
      `rates=${JSON.stringify(bad)}`
    );
  }
});

test("profile.js has no silent rate fallback", async () => {
  const src = await readFile(new URL("../js/profile.js", import.meta.url), "utf8");
  assert.ok(!/rates\[[^\]]+\]\s*\|\|\s*0/.test(src), "must not use rates[...] || 0");
});

// ---------- 2b. missing vs invalid must not double-report ----------
test("an all-blank company yields exactly 5 unique questions and no duplicate violations", async () => {
  const schema = await load("data/ontology-schema.json");
  const sampleA = (await load("data/samples.json")).samples.find((s) => s.id === "a");
  const p = buildProfile({ cashflows: sampleA.cashflows, rates, company: { requestedPurposes: [] } });
  const r = validateProfile(p, schema);

  const questions = [...new Set(r.missingFacts.map((m) => m.question))];
  assert.equal(questions.length, 5, `expected 5 unique questions, got ${questions.length}: ${questions.join(" | ")}`);
  const paths = r.missingFacts.map((m) => m.factPath);
  assert.equal(new Set(paths).size, paths.length, "missingFacts must not repeat a factPath");
  for (const f of ["company.companyType", "company.isSme", "company.riskAppetite", "company.requestedPurposes", "company.existingHedges"])
    assert.ok(paths.includes(f), f);
  // 누락은 violations 로 중복 기록하지 않는다
  assert.equal(r.violations.length, 0, `missing facts must not also be violations: ${JSON.stringify(r.violations)}`);
  assert.equal(r.conforms, false);
});

test("an invalid enum is reported only as a violation, never as a missing fact", async () => {
  const schema = await load("data/ontology-schema.json");
  const p = buildProfile({ cashflows: [row], rates, company: { ...company, riskAppetite: "aggressive" } });
  const r = validateProfile(p, schema);
  assert.ok(r.violations.some((v) => v.path === "company.riskAppetite"));
  assert.ok(!r.missingFacts.some((m) => m.factPath === "company.riskAppetite"), "present-but-invalid is not missing");
});

test("transaction questions distinguish 수출/수입 from 수취/지급", async () => {
  const schema = await load("data/ontology-schema.json");
  const p = buildProfile({ cashflows: [{ ...row, tradeType: "", direction: "" }], rates, company });
  const r = validateProfile(p, schema);
  const qs = r.missingFacts.map((m) => m.question).join(" | ");
  assert.match(qs, /수출\/수입/);
  assert.match(qs, /수취\/지급/);
});

test("hasExistingHedge must be a boolean consistent with the array length", async () => {
  const schema = await load("data/ontology-schema.json");
  const p = buildProfile({ cashflows: [row], rates, company });   // [] -> hasExistingHedge false
  p.facts.company.hasExistingHedge = true;                        // 불일치 주입
  const r = validateProfile(p, schema);
  assert.ok(r.violations.some((v) => v.path === "company.hasExistingHedge"), "mismatch must be a violation");
});

// ---------- 3. the UI actually runs the reasoner ----------
test("the ontology schema is a loadable data source", async () => {
  const src = await readFile(new URL("../js/data-source.js", import.meta.url), "utf8");
  assert.match(src, /getOntologySchema/);
  assert.match(src, /ontology-schema\.json/);
});

test("the analyze handler runs reasoner.validateProfile and blocks on violations too", async () => {
  const ui = await readFile(new URL("../js/ui.js", import.meta.url), "utf8");
  assert.match(ui, /reasoner\.validateProfile/, "reasoner must be used, not just injected");
  assert.match(ui, /violations/, "violations must also block the confirm screen");
  assert.match(ui, /getOntologySchema/, "schema must be loaded as data");
});

test("the UI de-duplicates messages and separates questions from value errors", async () => {
  const ui = await readFile(new URL("../js/ui.js", import.meta.url), "utf8");
  assert.match(ui, /new Set\(/, "messages must be de-duplicated before rendering");
  assert.match(ui, /확인이 필요한 정보/, "missing-fact questions need their own heading");
  assert.match(ui, /입력값 오류/, "constraint violations need their own heading");
});

test("the analyze handler is fail-closed on market-data errors from buildProfile", async () => {
  const ui = await readFile(new URL("../js/ui.js", import.meta.url), "utf8");
  const analyze = ui.slice(ui.indexOf('root.querySelector("#analyze")'), ui.indexOf("// ---------- Screen 2"));
  assert.match(analyze, /catch/, "a CalculationError from buildProfile must be caught and shown");
});

// ---------- 5. confirm screen shows both axes ----------
test("the confirm screen shows tradeType (수출/수입) AND direction (수취/지급) for every transaction", async () => {
  const ui = await readFile(new URL("../js/ui.js", import.meta.url), "utf8");
  const confirm = ui.slice(ui.indexOf("function renderConfirm"), ui.indexOf("function renderResults"));
  assert.match(confirm, /TRADE_TYPE_LABEL/, "tradeType must be rendered per transaction");
  assert.match(confirm, /DIRECTION_LABEL/, "direction must still be rendered");
});
