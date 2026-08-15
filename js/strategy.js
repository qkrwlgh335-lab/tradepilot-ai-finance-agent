import { hedgeCostLoss } from "./risk.js";
import { CalculationError, requireOptions } from "./errors.js";

// 데모 기본값. 실제 상품의 헤지 효과·수수료가 아니라 화면에 그대로 표시되는 가정이며,
// 상품별 실제 조건이 확보되면 compareStrategies(..., { assumptions })로 대체한다.
export const DEFAULT_ASSUMPTIONS = {
  hedgeEff: 0.95,
  costRate: 0.003,
  label: "데모용 예시 가정 (실제 상품 조건 아님 · 헤지효과 95% · 비용 0.3%)",
};

export const STRATEGIES = [
  { key: "안정형", hedgeRatio: 0.9, desc: "환위험을 최대한 제거" },
  { key: "균형형", hedgeRatio: 0.6, desc: "위험과 헤지비용을 절충" },
  // 옵션 프리미엄·행사가격·보장구조 없이 손실에 상한을 씌우면 위험이 계산에서 사라질 뿐이다.
  // 기회추구형의 실제 성격은 "덜 헤지해서 상방을 남기고 하방도 함께 남긴다"이다.
  // 방향 중립: 수입기업에 유리한 움직임은 수출기업과 반대이므로 "상승"이라고 쓰지 않는다.
  { key: "기회추구형", hedgeRatio: 0.3, desc: "헤지율을 낮춰 유리한 환율 움직임의 이익 가능성을 유지하지만 잔여 위험이 큼" },
];

export function compareStrategies(cfarTotal, notionalKrw, options) {
  const supplied = requireOptions(options).assumptions;
  // 생략(undefined)하면 데모 기본 가정을 쓰지만, null이나 잘못된 값을 명시적으로 넘긴 경우에는
  // 조용히 기본값으로 바꾸지 않고 거부한다 — 어떤 가정으로 계산했는지가 흐려지면 안 된다.
  if (supplied !== undefined && (supplied === null || typeof supplied !== "object")) {
    throw new CalculationError("INVALID_ASSUMPTIONS", "계산 가정(assumptions) 값이 올바르지 않습니다.", {
      value: supplied === null ? "null" : typeof supplied,
    });
  }
  const assumptions = supplied === undefined ? DEFAULT_ASSUMPTIONS : supplied;
  return STRATEGIES.map((s) => {
    const { residualCFaR, hedgeCost } = hedgeCostLoss(cfarTotal, notionalKrw, {
      hedgeRatio: s.hedgeRatio,
      hedgeEff: assumptions.hedgeEff,
      costRate: assumptions.costRate,
    });
    // 잔여 위험(위험 측정치)과 헤지 비용(확정성 비용)은 합산하지 않는다. 사용자가 두 값을
    // 직접 견주도록 두고, 자동 순위·최적 전략 선정은 하지 않는다.
    return {
      key: s.key,
      hedgeRatio: s.hedgeRatio,
      desc: s.desc,
      residualCFaR,
      hedgeCost,
      assumptionsLabel: assumptions.label,
    };
  });
}
