import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const WDI_INDICATORS = Object.freeze({
  "NY.GDP.MKTP.KD.ZG": Object.freeze({ label: "GDP 성장률", unit: "%", source_url: "https://data.worldbank.org/indicator/NY.GDP.MKTP.KD.ZG" }),
  "FP.CPI.TOTL.ZG": Object.freeze({ label: "소비자물가 상승률", unit: "%", source_url: "https://data.worldbank.org/indicator/FP.CPI.TOTL.ZG" }),
  "NE.EXP.GNFS.ZS": Object.freeze({ label: "수출 비중/GDP", unit: "%", source_url: "https://data.worldbank.org/indicator/NE.EXP.GNFS.ZS" }),
  "NE.IMP.GNFS.ZS": Object.freeze({ label: "수입 비중/GDP", unit: "%", source_url: "https://data.worldbank.org/indicator/NE.IMP.GNFS.ZS" }),
});
const HOST = "api.worldbank.org";
const DOC_URL = "https://datahelpdesk.worldbank.org/knowledgebase/articles/898581-api-basic-call-structures";
const ISO2 = /^[A-Z]{2}$/;
const YEAR = /^\d{4}$/;

function validateCountryList(list) {
  if (!Array.isArray(list) || !list.length || list.some((item) => !ISO2.test(item))) throw new Error("invalid ISO2 country list");
  return [...new Set(list)].sort();
}
export function buildWorldBankRequestUrl(indicator, countryIsoList) {
  if (!(indicator in WDI_INDICATORS)) throw new Error("indicator is not allowlisted");
  const countries = validateCountryList(countryIsoList);
  // Query the official all-country catalogue and filter locally. A few selectable trade
  // territories are not valid World Bank path IDs; putting the whole UI catalogue in the
  // path makes the API reject every otherwise-valid country with HTTP 400.
  const url = new URL(`https://${HOST}/v2/country/all/indicator/${indicator}`);
  url.searchParams.set("format", "json"); url.searchParams.set("mrnev", "1");
  url.searchParams.set("per_page", "20000");
  if (url.hostname !== HOST || url.protocol !== "https:") throw new Error("official country indicator endpoint rejected");
  return url.toString();
}
function parseWorldBankResponse(payload, allowedCountries, expectedIndicator, referenceYear) {
  if (!Array.isArray(payload) || payload.length !== 2 || !Array.isArray(payload[1])) throw new Error("unexpected World Bank response schema");
  const [metadata, observations] = payload;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)
      || metadata.page !== 1 || metadata.pages !== 1
      || !Number.isInteger(metadata.total) || metadata.total !== observations.length) {
    throw new Error("incomplete or inconsistent World Bank response");
  }
  const rows = new Map();
  for (const item of observations) {
    if (!item || typeof item !== "object" || Array.isArray(item)
        || item?.indicator?.id !== expectedIndicator) {
      throw new Error("World Bank indicator identity mismatch");
    }
    const iso2 = item?.country?.id; const year = String(item?.date ?? "");
    if (!allowedCountries.has(iso2)) continue;
    const yearNumber = Number(year);
    if (!ISO2.test(iso2) || !YEAR.test(year) || !Number.isInteger(yearNumber)
        || yearNumber < 1900 || yearNumber > referenceYear) {
      throw new Error("invalid World Bank observation");
    }
    // The WDI API uses JSON null for a missing observation. Never pass it through
    // Number(): Number(null) is 0 and would fabricate an economic value.
    if (item.value === null) continue;
    if (typeof item.value !== "number" || !Number.isFinite(item.value)) throw new Error("invalid World Bank observation");
    const value = item.value;
    if (!rows.has(iso2) || yearNumber > rows.get(iso2).year) rows.set(iso2, { year: yearNumber, value });
  }
  if (!rows.size) throw new Error("World Bank response has no supported observations");
  return rows;
}
async function writeAtomic(target, value) {
  await mkdir(dirname(target), { recursive: true });
  const temp = `${target}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8"); await rename(temp, target);
}
async function defaultCountries(outputDir) {
  const catalog = JSON.parse(await readFile(join(outputDir, "country-catalog.json"), "utf8"));
  return Object.keys(catalog.countries || {});
}
export async function refreshCountryIndicators(options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("fetch implementation is required");
  const outputDir = resolve(options.outputDir ?? fileURLToPath(new URL("../data/", import.meta.url)));
  const countries = validateCountryList(options.countryIsoList ?? await defaultCountries(outputDir));
  const refreshedAt = (options.now ?? (() => new Date()))();
  if (!(refreshedAt instanceof Date) || !Number.isFinite(refreshedAt.getTime())) throw new Error("invalid refresh timestamp");
  const referenceYear = refreshedAt.getUTCFullYear();
  const controller = new AbortController(); const timeoutMs = Number.isInteger(options.timeoutMs) ? options.timeoutMs : 8_000;
  if (timeoutMs <= 0 || timeoutMs > 60_000) throw new Error("invalid timeout");
  const timer = setTimeout(() => controller.abort(), timeoutMs); let responses;
  try {
    responses = await Promise.all(Object.keys(WDI_INDICATORS).map(async (indicator) => {
      const response = await fetchImpl(buildWorldBankRequestUrl(indicator, countries), { headers: { Accept: "application/json" }, signal: controller.signal });
      if (!response?.ok || typeof response.json !== "function") throw new Error(`official country indicator request failed (${response?.status ?? "network"})`);
      return [indicator, parseWorldBankResponse(await response.json(), new Set(countries), indicator, referenceYear)];
    }));
  } finally { clearTimeout(timer); }
  const countryData = {};
  for (const [indicator, rows] of responses) for (const [iso2, observation] of rows) {
    if (!countryData[iso2]) countryData[iso2] = {}; countryData[iso2][indicator] = observation;
  }
  const snapshot = { schema_version: "1", status: "cached", provider: "World Bank WDI",
    fetched_at: refreshedAt.toISOString(), documentation_url: DOC_URL,
    indicators: WDI_INDICATORS,
    countries: Object.fromEntries(Object.entries(countryData).sort(([a], [b]) => a.localeCompare(b))),
    note: "세계은행 WDI의 국가 단위 거시·무역 참고지표 캐시. 양국 간 교역량·국가위험등급·예측값이 아닙니다." };
  await writeAtomic(join(outputDir, "country-indicators.json"), snapshot);
  return { status: "cached", countries: Object.keys(snapshot.countries).length, indicators: Object.keys(WDI_INDICATORS).length };
}
const isCli = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) refreshCountryIndicators().then((result) => console.log(JSON.stringify(result))).catch((error) => {
  console.error(`country-indicator refresh failed; existing cache preserved: ${error.message}`); process.exitCode = 1;
});
