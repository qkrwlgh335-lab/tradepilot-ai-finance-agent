import { mkdir, rename, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const DEFAULT_OUTPUT_DIR = path.join(ROOT, "data");
const API_HOST = "comtradeapi.un.org";
const PARTNER_REFERENCE_URL = "https://comtradeapi.un.org/files/v1/app/reference/partnerAreas.json";
const SOURCE_URL = "https://comtradeplus.un.org/TradeFlow";
const DOCUMENTATION_URL = "https://uncomtrade.org/docs/un-comtrade-api/";
const ISO2 = /^[A-Z]{2}$/;

const isPlainObject = (value) =>
  value !== null
  && typeof value === "object"
  && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;

function requirePeriod(period) {
  if (!Number.isInteger(period) || period < 1900 || period > 9999)
    throw new TypeError("period must be an integer year");
  return period;
}

export function buildUnComtradeRequestUrl(period) {
  const year = requirePeriod(period);
  const url = new URL("https://comtradeapi.un.org/public/v1/preview/C/A/HS");
  url.searchParams.set("period", String(year));
  url.searchParams.set("reporterCode", "410");
  url.searchParams.set("cmdCode", "TOTAL");
  url.searchParams.set("flowCode", "X,M");
  url.searchParams.set("partnerCode", "");
  url.searchParams.set("partner2Code", "0");
  url.searchParams.set("customsCode", "C00");
  url.searchParams.set("motCode", "0");
  url.searchParams.set("maxRecords", "500");
  return url.toString();
}

function validateCountries(countryIsoList) {
  if (!Array.isArray(countryIsoList) || countryIsoList.length === 0)
    throw new TypeError("countryIsoList must be a non-empty array");
  const normalized = countryIsoList.map((value) => {
    if (typeof value !== "string" || !ISO2.test(value))
      throw new TypeError("countryIsoList contains an invalid ISO2 code");
    return value;
  });
  if (new Set(normalized).size !== normalized.length)
    throw new TypeError("countryIsoList contains duplicates");
  return normalized;
}

function parsePartnerReference(payload) {
  if (!isPlainObject(payload) || !Array.isArray(payload.results) || payload.results.length === 0)
    throw new Error("invalid UN Comtrade partner reference");
  const byCode = new Map();
  for (const item of payload.results) {
    if (!isPlainObject(item) || !Number.isInteger(item.PartnerCode))
      throw new Error("invalid UN Comtrade partner row");
    if (byCode.has(item.PartnerCode)) throw new Error("duplicate UN Comtrade partner code");
    const iso2 = item.PartnerCodeIsoAlpha2;
    byCode.set(item.PartnerCode, item.isGroup === false && typeof iso2 === "string" && ISO2.test(iso2)
      ? iso2
      : null);
  }
  return byCode;
}

function validateTradePayload(payload, period, partnerByCode, requestedCountries) {
  if (!isPlainObject(payload)
      || payload.error !== ""
      || !Number.isInteger(payload.count)
      || !Array.isArray(payload.data)
      || payload.count !== payload.data.length
      || payload.count < 1
      // The keyless preview endpoint is capped at 500 rows. Exactly 500 could be
      // truncated, so it is not safe to publish as a complete all-partner cache.
      || payload.count >= 500)
    throw new Error("invalid or incomplete UN Comtrade response");

  const wanted = new Set(requestedCountries);
  const countries = {};
  const seen = new Set();
  for (const item of payload.data) {
    if (!isPlainObject(item)
        || item.typeCode !== "C"
        || item.freqCode !== "A"
        || item.refYear !== period
        || item.period !== String(period)
        || item.reporterCode !== 410
        || !["X", "M"].includes(item.flowCode)
        || !Number.isInteger(item.partnerCode)
        || item.partnerCode < 0
        || item.partner2Code !== 0
        || item.classificationSearchCode !== "HS"
        || item.cmdCode !== "TOTAL"
        || item.customsCode !== "C00"
        || item.motCode !== 0
        || typeof item.primaryValue !== "number"
        || !Number.isFinite(item.primaryValue)
        || item.primaryValue < 0
        || item.isAggregate !== true)
      throw new Error("UN Comtrade response identity or value is invalid");
    const identity = `${item.partnerCode}:${item.flowCode}`;
    if (seen.has(identity)) throw new Error("duplicate UN Comtrade partner-flow row");
    seen.add(identity);
    if (item.partnerCode === 0) continue;
    const iso2 = partnerByCode.get(item.partnerCode);
    if (!iso2 || !wanted.has(iso2)) continue;
    const field = item.flowCode === "X" ? "exports_usd" : "imports_usd";
    (countries[iso2] ??= {})[field] = item.primaryValue;
  }
  if (Object.keys(countries).length === 0)
    throw new Error("UN Comtrade response contains no requested countries");
  return countries;
}

async function fetchJson(fetchImpl, url, signal) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.hostname !== API_HOST)
    throw new Error("UN Comtrade host is not allowlisted");
  const response = await fetchImpl(url, { signal });
  if (!response?.ok || typeof response.json !== "function")
    throw new Error(`UN Comtrade request failed (${response?.status ?? "network"})`);
  return response.json();
}

async function atomicWriteJson(filePath, value) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
}

export async function refreshBilateralTrade(options = {}) {
  if (!isPlainObject(options)) throw new TypeError("options must be an object");
  const now = typeof options.now === "function" ? options.now : () => new Date();
  const capturedNow = now();
  if (!(capturedNow instanceof Date) || !Number.isFinite(capturedNow.getTime()))
    throw new TypeError("now must return a valid Date");
  const period = requirePeriod(options.period ?? capturedNow.getUTCFullYear() - 1);
  if (period > capturedNow.getUTCFullYear()) throw new TypeError("period cannot be in the future");
  const countryIsoList = validateCountries(options.countryIsoList ?? []);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
  const timeoutMs = options.timeoutMs ?? 5_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError("timeoutMs must be positive");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const [partnerPayload, tradePayload] = await Promise.all([
      fetchJson(fetchImpl, PARTNER_REFERENCE_URL, controller.signal),
      fetchJson(fetchImpl, buildUnComtradeRequestUrl(period), controller.signal),
    ]);
    const partnerByCode = parsePartnerReference(partnerPayload);
    const countries = validateTradePayload(tradePayload, period, partnerByCode, countryIsoList);
    const snapshot = {
      schema_version: "1",
      status: "cached",
      provider: "UN Comtrade",
      reporter: { code: 410, iso2: "KR", name: "Republic of Korea" },
      period,
      fetched_at: capturedNow.toISOString(),
      unit: "USD",
      classification: "HS",
      commodity: "TOTAL",
      source_url: SOURCE_URL,
      documentation_url: DOCUMENTATION_URL,
      countries,
      note: "한국 신고 기준 연간 상품 총교역 참고 통계이며 기업별 거래·예측값이 아닙니다.",
    };
    const outputDir = options.outputDir ?? DEFAULT_OUTPUT_DIR;
    await mkdir(outputDir, { recursive: true });
    await atomicWriteJson(path.join(outputDir, "bilateral-trade.json"), snapshot);
    return { status: "cached", period, countries: Object.keys(countries).length };
  } finally {
    clearTimeout(timeout);
  }
}

const isCli = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  const catalog = JSON.parse(await (await import("node:fs/promises")).readFile(
    path.join(DEFAULT_OUTPUT_DIR, "country-catalog.json"),
    "utf8",
  ));
  const result = await refreshBilateralTrade({ countryIsoList: Object.keys(catalog.countries) });
  console.log(`[bilateral-trade] ${result.period}년 ${result.countries}개국 검증 캐시 갱신 완료`);
}
