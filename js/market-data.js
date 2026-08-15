export const MARKET_DATA_STATUSES = Object.freeze([
  "live",
  "cached",
  "demo",
  "unavailable",
]);

const STATUS_SET = new Set(MARKET_DATA_STATUSES);
const DATA_KEYS = Object.freeze(["fx_rates", "fx_volatility"]);
const OFFICIAL_MARKET_HOSTS = new Set(["data-api.ecb.europa.eu"]);

const isPlainObject = (value) =>
  value !== null
  && typeof value === "object"
  && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype
    || Object.getPrototypeOf(value) === null);

function isRealIsoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime())
    && parsed.toISOString().slice(0, 10) === value;
}

function isIsoTimestamp(value) {
  if (typeof value !== "string"
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value))
    return false;
  return Number.isFinite(Date.parse(value));
}

function isNumericMap(value) {
  if (!isPlainObject(value) || Object.keys(value).length === 0) return false;
  return Object.values(value).every((item) =>
    typeof item === "number" && Number.isFinite(item) && item > 0);
}

function isOfficialMarketUrl(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && OFFICIAL_MARKET_HOSTS.has(url.hostname)
      && url.username === ""
      && url.password === "";
  } catch {
    return false;
  }
}

function unavailableEnvelope(source = null, reason = "시장데이터를 검증할 수 없습니다.") {
  const sourceId = typeof source?.source_id === "string"
    && source.source_id.startsWith("mkt:")
    ? source.source_id
    : "mkt:unavailable";
  return {
    status: "unavailable",
    source_id: sourceId,
    source_url: null,
    as_of: isRealIsoDate(source?.as_of) ? source.as_of : null,
    fetched_at: null,
    value: null,
    note: reason,
  };
}

export function createMarketDataEnvelope(source, value) {
  if (!isPlainObject(source)
      || !STATUS_SET.has(source.status)
      || typeof source.source_id !== "string"
      || !/^mkt:[a-z0-9][a-z0-9:_-]*$/.test(source.source_id)
      || !isRealIsoDate(source.as_of)
      || typeof source.note !== "string"
      || source.note.trim() === "") {
    return unavailableEnvelope(source);
  }

  if (source.status === "unavailable") {
    return unavailableEnvelope(source, source.note.trim());
  }

  if (!isNumericMap(value)) {
    return unavailableEnvelope(source, "시장데이터 값 형식이 올바르지 않습니다.");
  }

  if (source.status === "demo") {
    return {
      status: "demo",
      source_id: source.source_id,
      source_url: null,
      as_of: source.as_of,
      fetched_at: null,
      value: structuredClone(value),
      note: source.note.trim(),
    };
  }

  const verifiedRemote = source.verification_status === "verified"
    && isOfficialMarketUrl(source.source_url)
    && isIsoTimestamp(source.fetched_at);
  if (!verifiedRemote) {
    return unavailableEnvelope(
      source,
      "검증된 공식 응답이 없어 live/cached 상태를 사용할 수 없습니다.",
    );
  }

  return {
    status: source.status,
    source_id: source.source_id,
    source_url: source.source_url,
    as_of: source.as_of,
    fetched_at: source.fetched_at,
    value: structuredClone(value),
    note: source.note.trim(),
  };
}

function sourceFor(sources, dataKey) {
  if (!Array.isArray(sources)) return null;
  const matches = sources.filter((item) =>
    isPlainObject(item) && item.data_key === dataKey);
  return matches.length === 1 ? matches[0] : null;
}

export function createMarketDataMeta({ sources, fx, volatility } = {}) {
  const fxSource = sourceFor(sources, "fx_rates");
  const volatilitySource = sourceFor(sources, "fx_volatility");
  return {
    fx_rates: createMarketDataEnvelope(fxSource, fx?.rates),
    fx_volatility: createMarketDataEnvelope(
      volatilitySource,
      volatility?.annual_vol,
    ),
  };
}

// T30b/T30c — single source of truth for market-data state. The UI badge AND the analyze gate
// consume the SAME judgement so wording and behaviour can never drift.
//   { ok, mode, displayState, asOf, reason? }
//   mode ∈ {"official", "demo", "unavailable"}
//   displayState ∈ {"live", "cached", "demo", "unavailable"} — the label the badge renders.
// When cached and live are mixed we surface "cached" (the lower-trust label) so the badge never
// over-promises. Any mismatch (unknown status, missing/invalid as_of, mismatched as_of, or a
// mix of official and demo) yields "unavailable" and blocks analysis.
const OFFICIAL_STATUSES = new Set(["cached", "live"]);
export function validateMarketDataForAnalysis(meta) {
  const fx = meta?.fx_rates;
  const vol = meta?.fx_volatility;
  const unavailable = (reason) => ({ ok: false, mode: "unavailable", displayState: "unavailable", asOf: null, reason });
  if (!isPlainObject(fx) || !isPlainObject(vol))
    return unavailable("시장데이터 메타가 없어 계산할 수 없습니다.");
  if (fx.status === "unavailable" || vol.status === "unavailable"
      || !STATUS_SET.has(fx.status) || !STATUS_SET.has(vol.status))
    return unavailable("시장데이터가 unavailable 상태입니다.");
  if (!isRealIsoDate(fx.as_of) || !isRealIsoDate(vol.as_of))
    return unavailable("시장데이터 기준일이 유효하지 않아 계산할 수 없습니다.");
  if (fx.as_of !== vol.as_of)
    return unavailable("환율·변동성 기준일이 일치하지 않아 계산할 수 없습니다.");
  const bothOfficial = OFFICIAL_STATUSES.has(fx.status) && OFFICIAL_STATUSES.has(vol.status);
  if (bothOfficial) {
    // Surface the lower-trust label when the two datums differ (live+cached → "cached").
    const displayState = fx.status === "live" && vol.status === "live" ? "live" : "cached";
    return { ok: true, mode: "official", displayState, asOf: fx.as_of };
  }
  const bothDemo = fx.status === "demo" && vol.status === "demo";
  if (bothDemo) return { ok: true, mode: "demo", displayState: "demo", asOf: fx.as_of };
  return unavailable("환율과 변동성의 데이터 등급이 달라 계산을 시작할 수 없습니다.");
}

export function validateMarketSourceCatalog(catalog) {
  if (!isPlainObject(catalog)
      || catalog.schema_version !== "1"
      || !Array.isArray(catalog.sources))
    return { ok: false, errors: ["invalid market source catalog"] };

  const keys = catalog.sources.map((item) => item?.data_key);
  const errors = [];
  for (const dataKey of DATA_KEYS) {
    if (keys.filter((key) => key === dataKey).length !== 1)
      errors.push(`${dataKey} source must exist exactly once`);
  }
  for (const item of catalog.sources) {
    if (!isPlainObject(item) || !DATA_KEYS.includes(item.data_key))
      errors.push("unknown market data source");
  }
  return { ok: errors.length === 0, errors };
}
