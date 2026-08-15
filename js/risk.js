import {
  requireRate, requireVolatility, requireCashflow, requireCashflowList,
  requireRatio, requireNonNegative, requirePositiveNumber, requireOptions,
} from "./errors.js";

// CFaR is computed per (currency, maturity) bucket: FX risk scales with the square root of
// EACH exposure's own time to settlement, so a 3-month and a 9-month USD flow cannot share
// one horizon. Flows of the same currency settling on the same date net against each other.
// Missing market data is refused (see errors.js) rather than silently defaulted to 0.
export function computeCFaRBuckets(cashflows, rates, annualVol, options) {
  const { z = 1.645 } = requireOptions(options);
  requirePositiveNumber(z, "INVALID_Z", "신뢰수준 계수(z)");
  requireCashflowList(cashflows);
  const buckets = new Map();
  for (const raw of cashflows) {
    const c = requireCashflow(raw);
    const key = `${c.currency}|${c.months}`;
    const signed = (c.direction === "in" ? 1 : -1) * c.amount;
    const b = buckets.get(key) || { currency: c.currency, months: c.months, netAtMaturity: 0 };
    b.netAtMaturity += signed;
    buckets.set(key, b);
  }
  return [...buckets.values()]
    .sort((a, b) => a.currency.localeCompare(b.currency) || a.months - b.months)
    .map((b) => {
      const rate = requireRate(rates, b.currency);
      const sigma = requireVolatility(annualVol, b.currency);
      const scale = Math.sqrt(b.months / 12);
      return { ...b, rate, sigma, cfar: Math.abs(b.netAtMaturity) * rate * sigma * scale * z };
    });
}

// Summing bucket CFaRs ignores correlation and offsetting between buckets, so it can come out
// larger than the real portfolio risk. We keep that assumption on purpose (conservative) but
// label it so it is never read as a diversified portfolio VaR. A covariance model is out of scope.
export function portfolioCFaR(buckets) {
  return { total: buckets.reduce((s, b) => s + b.cfar, 0), method: "conservative_sum" };
}

// The strategies apply one hedge ratio to every bucket, so the hedged amount is the sum of the
// bucket exposures. Pricing the hedge off the per-currency net would assume a 3-month receipt
// can cover a 2-month payment; cross-maturity natural hedging and bridge financing are not
// modelled here.
export function bucketNotionalKrw(buckets) {
  return buckets.reduce((s, b) => s + Math.abs(b.netAtMaturity) * b.rate, 0);
}

// A negative cumulative FX position is only a real shortfall once the company's own cash and
// its usable credit line are exhausted, so both are part of the liquidity picture.
// cumulativeKrw stays pure FX flow; availableKrw is what is actually left to pay with.
export function liquidityTimeline(cashflows, rates, options) {
  const { openingBalanceKrw = 0, creditLineKrw = 0 } = requireOptions(options);
  requireNonNegative(openingBalanceKrw, "INVALID_BUFFER", "기초 현금잔고");
  requireNonNegative(creditLineKrw, "INVALID_BUFFER", "사용 가능 신용한도");
  const flows = requireCashflowList(cashflows).map((c) => requireCashflow(c));
  const points = [...new Set(flows.map((c) => c.months))].sort((a, b) => a - b);
  let cum = 0;
  return points.map((m) => {
    for (const c of flows.filter((c) => c.months === m)) {
      cum += (c.direction === "in" ? 1 : -1) * c.amount * requireRate(rates, c.currency);
    }
    const availableKrw = openingBalanceKrw + cum + creditLineKrw;
    return { months: m, cumulativeKrw: cum, availableKrw, shortfallKrw: Math.max(0, -availableKrw) };
  });
}

// residualCFaR: the part of the CFaR (a 95%-confidence risk measure) left unhedged — NOT an
// expected loss. hedgeCost: an assumed, near-certain cost. They are different kinds of number
// and are deliberately never added together: a combined figure reads as a single score for the
// strategy, which is exactly the comparison we do not want to make for the user.
export function hedgeCostLoss(cfar, notionalKrw, options) {
  const { hedgeRatio, hedgeEff = 0.95, costRate = 0.003 } = requireOptions(options);
  requireRatio(hedgeRatio, "INVALID_HEDGE_RATIO", "헤지 비율");
  requireRatio(hedgeEff, "INVALID_HEDGE_EFF", "헤지 효과");
  requireNonNegative(costRate, "INVALID_COST_RATE", "헤지 비용률");
  requireNonNegative(cfar, "INVALID_CFAR", "CFaR");
  requireNonNegative(notionalKrw, "INVALID_NOTIONAL", "헤지 명목금액");
  return {
    residualCFaR: cfar * (1 - hedgeRatio * hedgeEff),
    hedgeCost: notionalKrw * costRate * hedgeRatio,
  };
}
