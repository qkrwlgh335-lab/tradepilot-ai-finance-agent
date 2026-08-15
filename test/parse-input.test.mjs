import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { parseCashflowsText } from "../js/parse-input.js";

const read = (relativePath) =>
  readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");

test("parses the required CSV columns including tradeType", () => {
  const result = parseCashflowsText([
    "country,currency,tradeType,direction,amount,months",
    "US,USD,export,in,300000,3",
    "DE,EUR,import,out,80000,4",
  ].join("\n"), "csv");

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.rows, [
    {
      country: "US",
      currency: "USD",
      tradeType: "export",
      direction: "in",
      amount: 300000,
      months: 3,
    },
    {
      country: "DE",
      currency: "EUR",
      tradeType: "import",
      direction: "out",
      amount: 80000,
      months: 4,
    },
  ]);
});

test("parses a JSON array and normalizes numeric strings", () => {
  const result = parseCashflowsText(JSON.stringify([{
    country: "DE",
    currency: "EUR",
    tradeType: "import",
    direction: "out",
    amount: "80000",
    months: "4",
    ignored: "not copied",
  }]), "json");

  assert.equal(result.ok, true);
  assert.deepEqual(result.rows, [{
    country: "DE",
    currency: "EUR",
    tradeType: "import",
    direction: "out",
    amount: 80000,
    months: 4,
  }]);
});

test("CSV handles UTF-8 BOM, CRLF, quoted fields and escaped quotes", () => {
  const result = parseCashflowsText(
    "\uFEFFcountry,currency,tradeType,direction,amount,months\r\n"
    + "\"US\",\"USD\",\"export\",\"in\",\"300000\",\"3\"\r\n",
    "csv",
  );

  assert.equal(result.ok, true);
  assert.equal(result.rows[0].country, "US");
  assert.equal(result.rows[0].amount, 300000);
});

test("CSV header is closed and ordered so columns cannot be reinterpreted", () => {
  for (const text of [
    "country,currency,direction,tradeType,amount,months\nUS,USD,in,export,1,1",
    "country,currency,tradeType,direction,amount\nUS,USD,export,in,1",
    "country,currency,tradeType,direction,amount,months,memo\nUS,USD,export,in,1,1,x",
  ]) {
    const result = parseCashflowsText(text, "csv");
    assert.equal(result.ok, false);
    assert.deepEqual(result.rows, []);
    assert.ok(result.errors.some((error) => error.includes("CSV 헤더")));
  }
});

test("invalid tradeType and malformed cashflow values fail closed", () => {
  for (const [text, format] of [
    ["country,currency,tradeType,direction,amount,months\nUS,USD,receive,in,1,1", "csv"],
    [JSON.stringify([{
      country: "US",
      currency: "USD",
      tradeType: "export",
      direction: "in",
      amount: 0,
      months: 1,
    }]), "json"],
  ]) {
    const result = parseCashflowsText(text, format);
    assert.equal(result.ok, false);
    assert.deepEqual(result.rows, []);
    assert.ok(result.errors.length > 0);
  }
});

test("bad input and unsupported formats report errors and never throw", () => {
  for (const [text, format] of [
    ["garbage", "csv"],
    ["{not json", "json"],
    ["[]", "json"],
    ["anything", "xml"],
    ["", "csv"],
  ]) {
    assert.doesNotThrow(() => parseCashflowsText(text, format));
    const result = parseCashflowsText(text, format);
    assert.equal(result.ok, false);
    assert.deepEqual(result.rows, []);
    assert.ok(result.errors.length > 0);
  }
});

test("malformed CSV quoting and partial row widths are rejected", () => {
  for (const text of [
    "country,currency,tradeType,direction,amount,months\n\"US,USD,export,in,1,1",
    "country,currency,tradeType,direction,amount,months\nUS,USD,export,in,1",
  ]) {
    const result = parseCashflowsText(text, "csv");
    assert.equal(result.ok, false);
    assert.deepEqual(result.rows, []);
  }
});

test("input size and row count are bounded", () => {
  const oversized = "x".repeat(256 * 1024 + 1);
  assert.equal(parseCashflowsText(oversized, "json").ok, false);

  const rows = Array.from({ length: 501 }, () => ({
    country: "US",
    currency: "USD",
    tradeType: "export",
    direction: "in",
    amount: 1,
    months: 1,
  }));
  assert.equal(parseCashflowsText(JSON.stringify(rows), "json").ok, false);
});

test("the runtime wires file upload and paste through the shared parser", async () => {
  const [main, ui] = await Promise.all([
    read("js/main.js"),
    read("js/ui.js"),
  ]);

  assert.match(main, /import \* as parseInput from "\.\/parse-input\.js"/);
  assert.match(main, /parseInput/);
  for (const marker of [
    'id="cashflow-file"',
    'accept=".csv,.json,text/csv,application/json"',
    'id="cashflow-paste"',
    'id="cashflow-format"',
    'id="import-cashflows"',
    "parseCashflowsText",
    "state.data.countryCatalog.countries",
    "state.data.fx.rates",
  ]) assert.ok(ui.includes(marker), marker);
  assert.match(ui, /사용자가 표에서 확인·수정/);
});
