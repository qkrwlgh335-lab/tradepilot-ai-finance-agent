const GDP_GROWTH = "NY.GDP.MKTP.KD.ZG";
const INFLATION = "FP.CPI.TOTL.ZG";

const positiveFinite = (value) =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

function observation(indicators, code) {
  const item = Array.isArray(indicators)
    ? indicators.find((candidate) => candidate?.code === code)
    : null;
  return item && Number.isFinite(item.value) && Number.isInteger(item.year)
    ? { value: Number(item.value), year: Number(item.year) }
    : null;
}

// Presentation-only monitoring facts. These rows never enter CFaR, liquidity or eligibility.
// Exposure uses gross transaction notional (not net risk), and any unpriced row makes every
// share unavailable so an incomplete denominator is never presented as complete.
export function buildCountryMonitoring(options = {}) {
  const safe = options !== null && typeof options === "object" && !Array.isArray(options)
    ? options : {};
  const {
    cashflows = [],
    rates = {},
    countries = {},
    intelligence = [],
  } = safe;
  const flows = Array.isArray(cashflows) ? cashflows : [];
  const catalog = countries && typeof countries === "object" && !Array.isArray(countries)
    ? countries : {};
  const indicatorByIso = new Map(
    (Array.isArray(intelligence) ? intelligence : [])
      .filter((row) => row && typeof row.iso2 === "string")
      .map((row) => [row.iso2, row]),
  );
  const groups = new Map();

  for (const flow of flows) {
    if (!flow || typeof flow.country !== "string" || !flow.country) continue;
    const group = groups.get(flow.country) || { exposureKrw: 0, priced: true };
    const rate = rates?.[flow.currency];
    if (!positiveFinite(flow.amount) || !positiveFinite(rate)) group.priced = false;
    else group.exposureKrw += Math.abs(flow.amount) * rate;
    groups.set(flow.country, group);
  }

  const completeDenominator = [...groups.values()].every((group) => group.priced);
  const totalKrw = completeDenominator
    ? [...groups.values()].reduce((sum, group) => sum + group.exposureKrw, 0)
    : null;

  return [...groups.entries()].map(([iso2, group]) => {
    const official = indicatorByIso.get(iso2);
    const exposureKrw = group.priced ? group.exposureKrw : null;
    return {
      iso2,
      name: typeof catalog[iso2]?.name === "string" ? catalog[iso2].name : iso2,
      exposureKrw,
      exposureShare: exposureKrw !== null && positiveFinite(totalKrw)
        ? exposureKrw / totalKrw : null,
      gdpGrowth: observation(official?.indicators, GDP_GROWTH),
      inflation: observation(official?.indicators, INFLATION),
      officialDataStatus: official?.status === "cached" ? "cached" : "unavailable",
    };
  });
}
