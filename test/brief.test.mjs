import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBrief } from "../js/brief.js";

const ctx = {
  cashflows: [
    { country: "US", currency: "USD", direction: "in", amount: 300000, months: 3 },
    { country: "DE", currency: "EUR", direction: "out", amount: 80000, months: 4 },
  ],
  netRows: [
    { currency: "USD", net: 200000 },
    { currency: "EUR", net: -80000 },
  ],
  scenarios: [
    { delta: -0.1, totalPnl: -15691600 },
    { delta: 0, totalPnl: 0 },
  ],
  countries: [{ name: "미국", exposureShare: 0.75,
    gdpGrowth: { value: 2.16, year: 2025 }, inflation: { value: 2.95, year: 2024 } }],
  selectedProducts: [{ name: "선물환(Forward)", category: "환헤지" }],
  company: {
    companyType: "corporation",
    isSme: true,
    riskAppetite: "low",
    requestedPurposes: ["fx_hedge"],
    existingHedges: [],
  },
  liquidity: {
    openingBalanceKrw: 100_000_000,
    creditLineKrw: 60_000_000,
    worstShortfallKrw: 38_550_000,
  },
  cfar: {
    totalKrw: 45_066_367,
    comparisonStrategy: {
      key: "안정형",
      hedgeRatio: 0.9,
      residualCFaR: 6_534_623,
      hedgeCost: 1_820_837,
      assumptionsLabel: "데모용 예시 가정",
    },
  },
  questions: ["최근 1년 수출실적을 확인해 주세요."],
  counterfactualHighlight: {
    label: "입금 1개월 지연",
    cfarDeltaKrw: 1_000_000,
    shortfallDeltaKrw: 5_000_000,
  },
  asOf: "2026-07-18",
  now: new Date("2026-07-21T09:30:00"),
};

test("brief is a consultation application draft, not a submission", () => {
  const { html } = buildBrief(ctx);
  assert.match(html, /상담 신청서/);
  assert.match(html, /초안/);
});

test("brief lists the selected products", () => {
  const { html } = buildBrief(ctx);
  assert.match(html, /선물환\(Forward\)/);
});

test("brief includes the net exposure figure", () => {
  const { html } = buildBrief(ctx);
  assert.match(html, /200,000/);
});

test("brief always carries the non-advice disclaimer", () => {
  const { html } = buildBrief(ctx);
  assert.match(html, /투자·금융상품 권유/);
});

test("filename embeds the generation date", () => {
  const { filename } = buildBrief(ctx);
  assert.match(filename, /2026-07-21/);
});

test("brief carries company, hedge, liquidity and CFaR handoff facts", () => {
  const { html } = buildBrief(ctx);
  for (const phrase of [
    "법인", "중소기업", "안정", "기존 헤지 없음",
    "100,000,000", "60,000,000", "38,550,000",
    "45,066,367", "6,534,623", "1,820,837",
  ]) assert.match(html, new RegExp(phrase));
});

test("brief carries missing-information and counterfactual handoff notes", () => {
  const { html } = buildBrief(ctx);
  assert.match(html, /최근 1년 수출실적/);
  assert.match(html, /입금 1개월 지연/);
});

test("brief describes the worst displayed scenario without calling a fixed direction adverse", () => {
  const { html } = buildBrief(ctx);
  assert.match(html, /표시 시나리오 중 합계 손익이 가장 불리한 경우/);
  assert.doesNotMatch(html, /환율 -10% 불리 시/);
});

test("brief uses factual country monitoring and never prints a demo risk grade", () => {
  const { html } = buildBrief(ctx);
  assert.match(html, /거래국 모니터링 참고정보/);
  assert.match(html, /미국 · 거래비중 75\.0%/);
  assert.match(html, /GDP 성장률 2\.16%/);
  assert.doesNotMatch(html, /거래국 리스크|리스크 낮음|리스크 중간|가장 주의할 곳/);
});
