import { test } from "node:test";
import assert from "node:assert/strict";
import { diagnose } from "../js/diagnose.js";

const analysis = {
  netRows: [
    { currency: "EUR", receivable: 0, payable: 80000, net: -80000 },
    { currency: "USD", receivable: 300000, payable: 100000, net: 200000 },
  ],
  scenarios: [
    { delta: -0.1, totalPnl: -15691600 },
    { delta: 0, totalPnl: 0 },
    { delta: 0.05, totalPnl: 7845800 },
  ],
  countries: [
    { name: "미국", exposureKrw: 300_000_000, exposureShare: 0.75,
      gdpGrowth: { value: 2.16, year: 2025 }, inflation: { value: 2.95, year: 2024 }, officialDataStatus: "cached" },
    { name: "베트남", exposureKrw: 100_000_000, exposureShare: 0.25,
      gdpGrowth: { value: 8.02, year: 2025 }, inflation: { value: 3.31, year: 2025 }, officialDataStatus: "cached" },
  ],
  products: [{ name: "선물환(Forward)" }, { name: "수출환율 보호 프로그램(합성)" }],
};

test("mentions the largest net-exposure currency", () => {
  const t = diagnose(analysis);
  assert.match(t, /USD/);
});

// Offsetting only happens inside one (currency, maturity) bucket. A 3-month receipt does not
// neutralise a 2-month payment, and bridge financing is not modelled, so the diagnosis must not
// present the currency net as the whole management task.
test("separates the currency net from the per-maturity management task", () => {
  const t = diagnose({
    ...analysis,
    buckets: [
      { currency: "USD", months: 2, netAtMaturity: -100000 },
      { currency: "USD", months: 3, netAtMaturity: 300000 },
    ],
  });
  assert.ok(!/뿐입니다 \(자연 헤지\)/.test(t), "must not claim the net is all that matters");
  assert.match(t, /통화 총 순노출/);
  assert.match(t, /만기별 관리대상/);
  assert.match(t, /2개월/);
  assert.match(t, /3개월/);
  assert.match(t, /완전한 자연헤지가 아닙니다/);
  assert.match(t, /브리지금융/);
});

test("same-currency same-maturity flows are described as offsetting within that bucket", () => {
  const t = diagnose({
    ...analysis,
    buckets: [{ currency: "USD", months: 3, netAtMaturity: 200000 }],
  });
  assert.match(t, /동일 통화·동일 만기/);
});

test("states a loss figure for the worst scenario", () => {
  const t = diagnose(analysis);
  assert.match(t, /손실/);
});

test("names the largest transaction exposure without turning it into a country-risk rating", () => {
  const t = diagnose(analysis);
  assert.match(t, /미국/);
  assert.match(t, /75\.0%/);
  assert.match(t, /GDP 성장률 2\.16%/);
  assert.match(t, /국가위험등급이나 미래예측이 아닙니다/);
  assert.doesNotMatch(t, /가장 주의할 곳|리스크 낮음|리스크 중간|리스크 높음/);
});

test("missing official country observations are disclosed without a low-risk inference", () => {
  const t = diagnose({
    ...analysis,
    countries: [
      { name: "브라질", exposureKrw: 10, exposureShare: 0.5, gdpGrowth: null, inflation: null, officialDataStatus: "unavailable" },
      { name: "칠레", exposureKrw: 10, exposureShare: 0.5, gdpGrowth: null, inflation: null, officialDataStatus: "unavailable" },
    ],
  });
  assert.match(t, /공식 거시지표가 확인되지 않은 거래국/);
  assert.match(t, /브라질/);
  assert.match(t, /칠레/);
  assert.doesNotMatch(t, /가장 주의할 곳|리스크 낮음/);
  assert.doesNotMatch(t, /리스크 낮음/);
});

test("always ends with the non-advice disclaimer", () => {
  const t = diagnose(analysis);
  assert.match(t, /투자·금융상품 권유가 아닙니다/);
});
