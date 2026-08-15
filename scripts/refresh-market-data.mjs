import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ECB_EXPECTED_CURRENCIES = Object.freeze([
  "AUD", "BRL", "CAD", "CHF", "CNY", "CZK", "DKK", "GBP", "HKD",
  "HUF", "IDR", "ILS", "INR", "ISK", "JPY", "MXN", "MYR", "NOK",
  "NZD", "PHP", "PLN", "RON", "SEK", "SGD", "THB", "TRY", "USD", "ZAR",
]);

const OFFICIAL_HOST = "data-api.ecb.europa.eu";
const ECB_PATH_PREFIX = "/service/data/EXR/";
const DATA_SOURCE_URL = "https://data.ecb.europa.eu/help/api/data";
const REAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY = /^[A-Z]{3}$/;

function isRealDate(value) {
  if (!REAL_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime())
    && parsed.toISOString().slice(0, 10) === value;
}

function validateCurrencyList(currencies) {
  if (!Array.isArray(currencies) || currencies.length === 0)
    throw new Error("expected currency list is required");
  if (new Set(currencies).size !== currencies.length
      || currencies.some((item) => !CURRENCY.test(item) || item === "KRW" || item === "EUR"))
    throw new Error("invalid expected currency list");
  const allowed = new Set(ECB_EXPECTED_CURRENCIES);
  if (currencies.some((item) => !allowed.has(item)))
    throw new Error("currency is not in the verified ECB allowlist");
  return [...currencies].sort();
}

export function buildEcbRequestUrl(currencies = ECB_EXPECTED_CURRENCIES) {
  const verified = validateCurrencyList(currencies);
  const series = ["KRW", ...verified].join("+");
  const url = new URL(`https://${OFFICIAL_HOST}${ECB_PATH_PREFIX}D.${series}.EUR.SP00.A`);
  url.searchParams.set("format", "csvdata");
  url.searchParams.set("lastNObservations", "320");
  if (url.hostname !== OFFICIAL_HOST || !url.pathname.startsWith(ECB_PATH_PREFIX))
    throw new Error("official market-data endpoint rejected");
  return url.toString();
}

function parseCsvRows(text) {
  if (typeof text !== "string" || text.length === 0 || text.length > 15_000_000)
    throw new Error("invalid ECB response body");
  const lines = text.replace(/\r\n/g, "\n").trim().split("\n");
  const header = lines.shift()?.split(",") ?? [];
  const required = [
    "KEY", "FREQ", "CURRENCY", "CURRENCY_DENOM",
    "EXR_TYPE", "EXR_SUFFIX", "TIME_PERIOD", "OBS_VALUE",
  ];
  if (required.some((name, index) => header[index] !== name))
    throw new Error("unexpected ECB CSV schema");

  return lines.map((line) => {
    // The eight fields used here precede quoted descriptive fields in the ECB CSV,
    // so commas in titles later in the row cannot affect these indices.
    const fields = line.split(",", 8);
    if (fields.length !== 8) throw new Error("malformed ECB CSV row");
    const [key, freq, currency, denom, type, suffix, date, rawValue] = fields;
    const value = Number(rawValue);
    if (key !== `EXR.D.${currency}.EUR.SP00.A`
        || freq !== "D" || denom !== "EUR" || type !== "SP00" || suffix !== "A"
        || !CURRENCY.test(currency) || !isRealDate(date)
        || !Number.isFinite(value) || value <= 0)
      throw new Error("invalid ECB observation");
    return { currency, date, value };
  });
}

function latestByDate(rows) {
  const map = new Map();
  for (const row of rows) map.set(row.date, row.value);
  return map;
}

function sampleStdDev(values) {
  if (values.length < 2) throw new Error("insufficient returns");
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0)
    / (values.length - 1);
  return Math.sqrt(variance);
}

function rounded(value, digits = 6) {
  return Number(value.toFixed(digits));
}

export function deriveKrwMarketSnapshot(csvText, options = {}) {
  const expectedCurrencies = validateCurrencyList(
    options.expectedCurrencies ?? ECB_EXPECTED_CURRENCIES,
  );
  const minimumObservations = Number.isInteger(options.minimumObservations)
    ? options.minimumObservations
    : 120;
  if (minimumObservations < 1) throw new Error("invalid observation minimum");

  const rows = parseCsvRows(csvText);
  const allowedRows = new Set(["KRW", ...expectedCurrencies]);
  if (rows.some((row) => !allowedRows.has(row.currency)))
    throw new Error("unexpected currency in ECB response");

  const series = new Map();
  for (const currency of allowedRows) {
    const map = latestByDate(rows.filter((row) => row.currency === currency));
    if (map.size < minimumObservations)
      throw new Error(`insufficient observations for ${currency}`);
    series.set(currency, map);
  }

  const commonDates = [...series.get("KRW").keys()]
    .filter((date) => expectedCurrencies.every((currency) => series.get(currency).has(date)))
    .sort();
  if (commonDates.length < minimumObservations)
    throw new Error("insufficient common ECB observation dates");
  const asOf = commonDates.at(-1);

  const rates = { EUR: rounded(series.get("KRW").get(asOf)) };
  const histories = {
    EUR: commonDates.map((date) => series.get("KRW").get(date)),
  };
  for (const currency of expectedCurrencies) {
    rates[currency] = rounded(
      series.get("KRW").get(asOf) / series.get(currency).get(asOf),
    );
    histories[currency] = commonDates.map((date) =>
      series.get("KRW").get(date) / series.get(currency).get(date));
  }

  const annualVol = {};
  for (const [currency, values] of Object.entries(histories)) {
    const returns = values.slice(1).map((value, index) =>
      Math.log(value / values[index]));
    const volatility = sampleStdDev(returns) * Math.sqrt(252);
    if (!Number.isFinite(volatility) || volatility <= 0 || volatility > 1)
      throw new Error(`invalid derived volatility for ${currency}`);
    annualVol[currency] = rounded(volatility);
  }

  return {
    as_of: asOf,
    rates,
    annual_vol: annualVol,
    observation_count: commonDates.length,
  };
}

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function writeAtomic(target, value) {
  const folder = dirname(target);
  await mkdir(folder, { recursive: true });
  const temp = `${target}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await writeFile(temp, jsonText(value), "utf8");
  await rename(temp, target);
}

export async function refreshMarketData(options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  const outputDir = resolve(
    options.outputDir ?? fileURLToPath(new URL("../data/", import.meta.url)),
  );
  const expectedCurrencies = options.expectedCurrencies ?? ECB_EXPECTED_CURRENCIES;
  if (typeof fetchImpl !== "function") throw new Error("fetch implementation is required");

  const requestUrl = buildEcbRequestUrl(expectedCurrencies);
  const controller = new AbortController();
  const timeoutMs = Number.isInteger(options.timeoutMs) ? options.timeoutMs : 15_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(requestUrl, {
      headers: { Accept: "text/csv" },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!response?.ok || typeof response.text !== "function")
    throw new Error(`official market-data request failed (${response?.status ?? "network"})`);

  const snapshot = deriveKrwMarketSnapshot(await response.text(), {
    expectedCurrencies,
    minimumObservations: options.minimumObservations,
  });
  const fetchedAt = now().toISOString();
  const fx = {
    as_of: snapshot.as_of,
    base: "KRW",
    rates: snapshot.rates,
    note: "ECB 공식 일별 기준환율을 KRW 교차환율로 환산한 캐시 — 거래 체결환율이 아닌 참고용 기준값",
  };
  const volatility = {
    as_of: snapshot.as_of,
    method: "ECB 일별 KRW 교차환율 로그수익률 표준편차 × √252",
    observation_count: snapshot.observation_count,
    annual_vol: snapshot.annual_vol,
    note: "공식 기준환율 이력에서 로컬 계산한 예시 연환율 변동성 — 은행 내부 정식 위험모형 아님",
  };
  const marketSources = {
    schema_version: "1",
    sources: [
      {
        data_key: "fx_rates",
        source_kind: "market_data",
        status: "cached",
        verification_status: "verified",
        source_id: "mkt:ecb-fx-reference",
        source_url: requestUrl,
        documentation_url: DATA_SOURCE_URL,
        as_of: snapshot.as_of,
        fetched_at: fetchedAt,
        note: "ECB 공식 일별 기준환율 캐시 — EUR 교차방식으로 KRW 환산",
      },
      {
        data_key: "fx_volatility",
        source_kind: "market_data",
        status: "cached",
        verification_status: "verified",
        source_id: "mkt:ecb-derived-volatility",
        source_url: requestUrl,
        documentation_url: DATA_SOURCE_URL,
        as_of: snapshot.as_of,
        fetched_at: fetchedAt,
        note: `ECB 공식 기준환율 ${snapshot.observation_count}개 공통 관측치에서 로컬 산출`,
      },
    ],
  };

  // Validate all three payloads before replacing any current snapshot. Metadata is
  // replaced last, so a mid-write interruption cannot relabel stale numbers as cached.
  if (Object.keys(fx.rates).length !== Object.keys(volatility.annual_vol).length
      || Object.keys(fx.rates).some((currency) =>
        !Number.isFinite(volatility.annual_vol[currency])))
    throw new Error("rate/volatility currency sets do not match");

  await writeAtomic(join(outputDir, "fx.json"), fx);
  await writeAtomic(join(outputDir, "fx-vol.json"), volatility);
  await writeAtomic(join(outputDir, "market-sources.json"), marketSources);
  return {
    status: "cached",
    as_of: snapshot.as_of,
    currencies: Object.keys(snapshot.rates).length,
    observation_count: snapshot.observation_count,
  };
}

const isCli = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  refreshMarketData()
    .then((result) => {
      console.log(JSON.stringify(result));
    })
    .catch((error) => {
      console.error(`market-data refresh failed; existing cache preserved: ${error.message}`);
      process.exitCode = 1;
    });
}
