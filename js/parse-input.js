import { validateCashflows } from "./validate.js";

export const CASHFLOW_HEADERS = Object.freeze([
  "country",
  "currency",
  "tradeType",
  "direction",
  "amount",
  "months",
]);

export const MAX_INPUT_BYTES = 256 * 1024;
export const MAX_INPUT_ROWS = 500;

const fail = (...errors) => ({
  ok: false,
  rows: [],
  errors: errors.flat().filter(Boolean),
});

function byteLength(text) {
  return new TextEncoder().encode(text).byteLength;
}

function parseCsvRecords(text) {
  const records = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let quoteClosed = false;

  const pushRow = () => {
    row.push(field.trim());
    if (row.some((value) => value !== "")) records.push(row);
    row = [];
    field = "";
    quoteClosed = false;
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (inQuotes) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
          quoteClosed = true;
        }
      } else {
        field += character;
      }
      continue;
    }

    if (quoteClosed && character !== "," && character !== "\n" && character !== "\r")
      return fail("CSV 닫는 따옴표 뒤에는 쉼표 또는 줄바꿈만 올 수 있습니다.");

    if (character === '"') {
      if (field !== "") return fail("CSV 따옴표의 위치가 올바르지 않습니다.");
      inQuotes = true;
      continue;
    }
    if (character === ",") {
      row.push(field.trim());
      field = "";
      quoteClosed = false;
      continue;
    }
    if (character === "\n" || character === "\r") {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      pushRow();
      continue;
    }
    field += character;
  }

  if (inQuotes) return fail("CSV 따옴표가 닫히지 않았습니다.");
  if (row.length || field !== "" || quoteClosed) pushRow();
  return { ok: true, records, errors: [] };
}

function rowsFromCsv(text) {
  const parsed = parseCsvRecords(text);
  if (!parsed.ok) return parsed;
  if (!parsed.records.length) return fail("CSV 헤더와 거래 행을 입력하세요.");

  const [headers, ...records] = parsed.records;
  if (headers.length !== CASHFLOW_HEADERS.length
      || headers.some((header, index) => header !== CASHFLOW_HEADERS[index])) {
    return fail(`CSV 헤더는 ${CASHFLOW_HEADERS.join(",")} 순서여야 합니다.`);
  }
  if (!records.length) return fail("CSV에 거래를 최소 1건 입력하세요.");
  if (records.length > MAX_INPUT_ROWS)
    return fail(`거래는 최대 ${MAX_INPUT_ROWS}건까지 불러올 수 있습니다.`);

  const errors = [];
  const rows = [];
  records.forEach((record, index) => {
    if (record.length !== CASHFLOW_HEADERS.length) {
      errors.push(`${index + 2}행: 열 개수가 ${CASHFLOW_HEADERS.length}개여야 합니다.`);
      return;
    }
    rows.push(Object.fromEntries(
      CASHFLOW_HEADERS.map((header, column) => [header, record[column]]),
    ));
  });
  return errors.length ? fail(errors) : { ok: true, rows, errors: [] };
}

function rowsFromJson(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return fail("JSON 문법이 올바르지 않습니다.");
  }
  if (!Array.isArray(value)) return fail("JSON 최상위 값은 거래 객체 배열이어야 합니다.");
  if (!value.length) return fail("JSON에 거래를 최소 1건 입력하세요.");
  if (value.length > MAX_INPUT_ROWS)
    return fail(`거래는 최대 ${MAX_INPUT_ROWS}건까지 불러올 수 있습니다.`);

  const errors = [];
  const rows = [];
  value.forEach((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      errors.push(`${index + 1}행: 거래는 객체여야 합니다.`);
      return;
    }
    rows.push(Object.fromEntries(
      CASHFLOW_HEADERS.map((header) => [header, item[header]]),
    ));
  });
  return errors.length ? fail(errors) : { ok: true, rows, errors: [] };
}

function validateImportedRows(rows) {
  const tradeTypeErrors = [];
  rows.forEach((row, index) => {
    if (row.tradeType !== "export" && row.tradeType !== "import")
      tradeTypeErrors.push(`${index + 1}행: 수출/수입은 export 또는 import여야 합니다.`);
  });

  const checked = validateCashflows(rows);
  const errors = [...tradeTypeErrors, ...checked.errors];
  if (errors.length) return fail(errors);

  return {
    ok: true,
    rows: checked.normalized.map((row) => ({
      country: row.country,
      currency: row.currency,
      tradeType: row.tradeType,
      direction: row.direction,
      amount: row.amount,
      months: row.months,
    })),
    errors: [],
  };
}

export function parseCashflowsText(text, format) {
  try {
    if (typeof text !== "string") return fail("입력 내용은 문자열이어야 합니다.");
    const normalizedText = text.replace(/^\uFEFF/, "");
    if (!normalizedText.trim()) return fail("불러올 내용을 입력하세요.");
    if (byteLength(normalizedText) > MAX_INPUT_BYTES)
      return fail(`입력 파일은 ${MAX_INPUT_BYTES / 1024}KB 이하여야 합니다.`);

    let parsed;
    if (format === "csv") parsed = rowsFromCsv(normalizedText);
    else if (format === "json") parsed = rowsFromJson(normalizedText);
    else return fail("입력 형식은 csv 또는 json이어야 합니다.");

    return parsed.ok ? validateImportedRows(parsed.rows) : parsed;
  } catch {
    return fail("입력을 해석할 수 없습니다.");
  }
}
