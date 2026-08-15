const OFFICIAL_SOURCE_HOST = "comtradeplus.un.org";
const OFFICIAL_DOCS_HOST = "uncomtrade.org";
const ISO2 = /^[A-Z]{2}$/;

const isPlainObject = (value) =>
  value !== null
  && typeof value === "object"
  && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype
    || Object.getPrototypeOf(value) === null);

function isOfficialHttpsUrl(value, expectedHost) {
  if (typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.hostname === expectedHost;
  } catch {
    return false;
  }
}

function isValidAmount(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function validateBilateralTradeSnapshot(snapshot) {
  const invalid = (reason) => ({ ok: false, status: "unavailable", reason });
  if (!isPlainObject(snapshot)) return invalid("교역 통계 스냅샷 형식이 올바르지 않습니다.");
  if (snapshot.schema_version !== "1" || snapshot.status !== "cached")
    return invalid("검증된 교역 통계 캐시가 아닙니다.");
  if (snapshot.provider !== "UN Comtrade") return invalid("공식 제공기관을 확인할 수 없습니다.");
  if (!isPlainObject(snapshot.reporter)
      || snapshot.reporter.code !== 410
      || snapshot.reporter.iso2 !== "KR"
      || snapshot.reporter.name !== "Republic of Korea")
    return invalid("신고국이 대한민국인지 확인할 수 없습니다.");
  const currentYear = new Date().getUTCFullYear();
  if (!Number.isInteger(snapshot.period) || snapshot.period < 1900 || snapshot.period > currentYear)
    return invalid("교역 통계 기준연도가 올바르지 않습니다.");
  if (typeof snapshot.fetched_at !== "string" || !Number.isFinite(Date.parse(snapshot.fetched_at)))
    return invalid("교역 통계 수집시각이 올바르지 않습니다.");
  if (snapshot.unit !== "USD" || snapshot.classification !== "HS" || snapshot.commodity !== "TOTAL")
    return invalid("교역 통계 단위나 집계범위가 올바르지 않습니다.");
  if (!isOfficialHttpsUrl(snapshot.source_url, OFFICIAL_SOURCE_HOST)
      || !isOfficialHttpsUrl(snapshot.documentation_url, OFFICIAL_DOCS_HOST))
    return invalid("공식 출처 주소를 확인할 수 없습니다.");
  if (!isPlainObject(snapshot.countries) || Object.keys(snapshot.countries).length === 0)
    return invalid("국가별 교역 통계가 비어 있거나 올바르지 않습니다.");

  for (const [iso2, row] of Object.entries(snapshot.countries)) {
    if (!ISO2.test(iso2) || !isPlainObject(row)) return invalid("국가별 교역 통계 형식이 올바르지 않습니다.");
    const keys = Object.keys(row);
    if (keys.length === 0 || keys.some((key) => !["exports_usd", "imports_usd"].includes(key)))
      return invalid("국가별 교역 통계 필드가 올바르지 않습니다.");
    if (Object.hasOwn(row, "exports_usd") && !isValidAmount(row.exports_usd))
      return invalid("수출액이 올바르지 않습니다.");
    if (Object.hasOwn(row, "imports_usd") && !isValidAmount(row.imports_usd))
      return invalid("수입액이 올바르지 않습니다.");
  }
  return {
    ok: true,
    status: "cached",
    provider: "UN Comtrade",
    period: snapshot.period,
  };
}

export function buildBilateralTradeIntelligence(isoOrder, snapshot) {
  const requested = Array.isArray(isoOrder) ? isoOrder : [];
  const validation = validateBilateralTradeSnapshot(snapshot);
  return requested.map((iso2) => {
    if (!validation.ok || !ISO2.test(iso2) || !Object.hasOwn(snapshot.countries, iso2))
      return Object.freeze({ iso2, status: "unavailable" });
    const source = snapshot.countries[iso2];
    const exportsUsd = Object.hasOwn(source, "exports_usd") ? source.exports_usd : null;
    const importsUsd = Object.hasOwn(source, "imports_usd") ? source.imports_usd : null;
    return Object.freeze({
      iso2,
      status: "cached",
      period: snapshot.period,
      exportsUsd,
      importsUsd,
      balanceUsd: exportsUsd !== null && importsUsd !== null ? exportsUsd - importsUsd : null,
    });
  });
}

export function formatTradeUsd(value) {
  if (!isValidAmount(value)) return "미확인";
  if (value === 0) return "US$0";
  if (value >= 1_000_000_000) return `US$${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `US$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `US$${(value / 1_000).toFixed(1)}K`;
  return `US$${value.toLocaleString("en-US")}`;
}
