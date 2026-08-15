export function buildRichProfile(netRows, cashflows, rates, { isSme = true } = {}) {
  const currencies = new Set(netRows.map((r) => r.currency));
  const usd = rates.USD || 1;
  const maxNetExposureUsd = netRows.reduce((m, r) => {
    const krw = Math.abs(r.net) * (rates[r.currency] || 0);
    return Math.max(m, krw / usd);
  }, 0);
  return {
    currencies,
    maxNetExposureUsd,
    maxHorizonMonths: cashflows.reduce((m, c) => Math.max(m, c.months), 0),
    hasExport: cashflows.some((c) => c.direction === "in"),
    isSme,
  };
}

export function filterEligible(products, profile, { today = new Date() } = {}) {
  const t = today instanceof Date ? today : new Date(today);
  return products.filter((p) => {
    const e = p.eligibility;
    if (profile.maxNetExposureUsd < e.min_amount_usd) return false;
    if (![...profile.currencies].some((c) => e.currencies.includes(c))) return false;
    if (profile.maxHorizonMonths > e.max_horizon_months) return false;
    if (e.requires_export && !profile.hasExport) return false;
    if (e.requires_sme && !profile.isSme) return false;
    if (t < new Date(p.effective_from) || t > new Date(p.effective_to)) return false;
    return true;
  });
}

export function scoreProducts(eligible, profile, { weights = { risk: 0.4, cost: 0.25, liq: 0.2, fit: 0.15 } } = {}) {
  if (!eligible.length) return [];
  const rates = eligible.map((p) => p.cost.cost_rate);
  const minR = Math.min(...rates), maxR = Math.max(...rates);
  return eligible
    .map((p) => {
      const riskReduction = p.hedge_effectiveness;
      const costEfficiency = 1 - (p.cost.cost_rate - minR) / (maxR - minR + 1e-9);
      const liquidity = p.liquidity_score;
      const eligibilityFit = Math.max(0, Math.min(1, 1 - profile.maxHorizonMonths / (p.eligibility.max_horizon_months || 1)));
      const score = weights.risk * riskReduction + weights.cost * costEfficiency + weights.liq * liquidity + weights.fit * eligibilityFit;
      return { ...p, score, breakdown: { riskReduction, costEfficiency, liquidity, eligibilityFit } };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}
/** @deprecated T7.3부터 런타임 추천은 온톨로지 reasoner가 담당한다. T15b 승인 전 호환 테스트용으로만 보존. */
