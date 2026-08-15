const ISO2 = /^[A-Z]{2}$/;
const YEAR = /^\d{4}$/;
const INDICATOR = /^[A-Z0-9.]+$/;
const HTTPS = /^https:\/\//;
const OFFICIAL_HOSTS = new Set(["data.worldbank.org", "datahelpdesk.worldbank.org"]);

function isOfficialUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && OFFICIAL_HOSTS.has(url.hostname);
  } catch { return false; }
}

function unavailable(reason) {
  return { ok: false, status: "unavailable", reason };
}

export function validateCountryIndicatorSnapshot(snapshot) {
  try {
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return unavailable("국가 지표 캐시가 없습니다.");
    if (snapshot.schema_version !== "1" || snapshot.status !== "cached") return unavailable("검증된 국가 지표 캐시가 아닙니다.");
    if (snapshot.provider !== "World Bank WDI" || typeof snapshot.fetched_at !== "string"
        || !Number.isFinite(Date.parse(snapshot.fetched_at)) || typeof snapshot.documentation_url !== "string"
        || !HTTPS.test(snapshot.documentation_url) || !isOfficialUrl(snapshot.documentation_url)) return unavailable("국가 지표 출처 메타데이터가 올바르지 않습니다.");
    if (!snapshot.indicators || typeof snapshot.indicators !== "object" || Array.isArray(snapshot.indicators)
        || !Object.keys(snapshot.indicators).length) return unavailable("국가 지표 정의가 없습니다.");
    for (const [code, meta] of Object.entries(snapshot.indicators)) {
      if (!INDICATOR.test(code) || !meta || typeof meta !== "object" || typeof meta.label !== "string"
          || !meta.label.trim() || typeof meta.unit !== "string" || !meta.unit.trim()
          || typeof meta.source_url !== "string" || !HTTPS.test(meta.source_url)
          || !isOfficialUrl(meta.source_url)) return unavailable("국가 지표 정의가 올바르지 않습니다.");
    }
    if (!snapshot.countries || typeof snapshot.countries !== "object" || Array.isArray(snapshot.countries)) return unavailable("국가별 관측값이 없습니다.");
    for (const [iso2, observations] of Object.entries(snapshot.countries)) {
      if (!ISO2.test(iso2) || !observations || typeof observations !== "object" || Array.isArray(observations)) return unavailable("국가별 관측값 형식이 올바르지 않습니다.");
      for (const [code, observation] of Object.entries(observations)) {
        if (!(code in snapshot.indicators) || !observation || typeof observation !== "object"
            || !YEAR.test(String(observation.year)) || !Number.isFinite(observation.value)) return unavailable("국가별 관측값이 올바르지 않습니다.");
      }
    }
    return { ok: true, status: "cached", provider: snapshot.provider };
  } catch { return unavailable("국가 지표를 검증할 수 없습니다."); }
}

export function buildCountryIntelligence(isoList, snapshot) {
  const validation = validateCountryIndicatorSnapshot(snapshot);
  const indicators = validation.ok ? Object.entries(snapshot.indicators) : [];
  return [...(Array.isArray(isoList) ? isoList : [])].map((iso2) => {
    const observations = validation.ok ? snapshot.countries[iso2] : null;
    return {
      iso2,
      status: observations ? "cached" : "unavailable",
      indicators: indicators.map(([code, meta]) => {
        const observation = observations?.[code];
        return { code, label: meta.label, unit: meta.unit, source_url: meta.source_url,
          year: observation ? Number(observation.year) : null, value: observation ? Number(observation.value) : null };
      }),
    };
  });
}
