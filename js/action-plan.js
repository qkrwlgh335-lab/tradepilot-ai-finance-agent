// Customer-facing action plan derived only from deterministic engine outputs.
// This module never computes finance figures or changes product eligibility.

const isFiniteNumber = (value) => typeof value === "number" && Number.isFinite(value);
const formatKrw = (value) =>
  isFiniteNumber(value) ? `₩ ${Math.round(value).toLocaleString("ko-KR")}` : "계산값 확인 필요";

const uniqueNames = (items) => [...new Set((items || [])
  .map((item) => item && item.name)
  .filter((name) => typeof name === "string" && name.trim()))];

export function buildActionPlan({
  executiveSummary = {},
  candidates = [],
  pending = [],
  shortfalls = [],
} = {}) {
  const largestRisk = executiveSummary?.largestRisk;
  const effect = executiveSummary?.effect;
  const candidateNames = uniqueNames(candidates);
  const pendingNames = uniqueNames(pending);
  const worstShortfall = [...(Array.isArray(shortfalls) ? shortfalls : [])]
    .filter((row) => isFiniteNumber(row?.months) && isFiniteNumber(row?.shortfallKrw))
    .sort((a, b) => b.shortfallKrw - a.shortfallKrw || a.months - b.months)[0] || null;

  const riskAction = largestRisk
    ? {
      kind: "risk",
      title: `${largestRisk.currency} 만기별 환노출부터 관리`,
      reason: `${largestRisk.currency} 원화 환산 노출 ${formatKrw(largestRisk.krwNotional)}이 현재 가장 큽니다.`,
      expectedEffect: effect
        ? `${effect.strategyKey} 시나리오에서는 CFaR 측정치가 ${formatKrw(effect.beforeCFaR)}에서 ${formatKrw(effect.afterCFaR)}로 변합니다. 헤지 비용 ${formatKrw(effect.hedgeCost)}은 별도입니다.`
        : "헤지 비율별 잔여 위험과 비용을 분리해 비교할 수 있습니다.",
      nextStep: "통화·만기 버킷별 금액을 기준으로 금융기관 담당자와 헤지 비율을 비교 상담하세요.",
      basis: ["largestRisk", "strategyComparison"],
    }
    : {
      kind: "risk",
      title: "통화·만기별 환노출 확인",
      reason: "계산 가능한 순노출 정보를 먼저 확인해야 합니다.",
      expectedEffect: "입력값이 완성되면 CFaR와 헤지 비율별 잔여 위험을 비교할 수 있습니다.",
      nextStep: "거래 통화·금액·결제 시점을 확인해 주세요.",
      basis: ["missingExposure"],
    };

  const productAction = candidateNames.length
    ? {
      kind: "product",
      title: `상담 후보 ${candidateNames.length}건의 실제 조건 확인`,
      reason: `${candidateNames.join(", ")}이 공개용 합성 근거가 연결된 자격 규칙을 통과했습니다.`,
      expectedEffect: "문서 유사도가 아니라 기업·거래 조건을 통과한 후보만 상담 대상으로 좁혔습니다.",
      nextStep: "아래 후보에서 적용 범위와 합성 규칙 근거를 확인한 뒤 상담 브리프에 담을 항목을 선택하세요.",
      basis: ["reasoner.candidates"],
    }
    : {
      kind: "product",
      title: "상품 판정에 필요한 정보 보완",
      reason: pendingNames.length
        ? `${pendingNames.join(", ")} 판정에 추가 정보가 필요합니다.`
        : "현재 입력과 공개용 합성 규칙 범위에서는 상담 후보가 없습니다.",
      expectedEffect: "누락 정보를 임의로 통과시키지 않아 부적합한 상품 추천을 방지합니다.",
      nextStep: "아래 ‘정보 필요’ 질문을 확인하고 담당자 상담 시 답변을 준비하세요.",
      basis: ["reasoner.pending"],
    };

  const resilienceAction = worstShortfall
    ? {
      kind: "resilience",
      title: `${worstShortfall.months}개월 유동성 부족 대비`,
      reason: `현금잔고와 신용한도를 반영한 뒤 최대 ${formatKrw(worstShortfall.shortfallKrw)}이 부족할 수 있습니다.`,
      expectedEffect: "입금 지연 시나리오로 부족 시점과 금액의 변화를 다시 확인할 수 있습니다.",
      nextStep: "운전자금 재원과 입금 지연 대응 계획을 확인한 뒤 아래 위기 시나리오를 실행하세요.",
      basis: ["liquidity.shortfall", "counterfactual"],
    }
    : {
      kind: "resilience",
      title: "위기 시나리오로 계획 재검증",
      reason: "기준 시나리오에서는 완충 반영 후 유동성 부족이 표시되지 않았습니다.",
      expectedEffect: "입금 지연·수취액 감소·불리한 환율을 적용해 결과와 후보 변화를 재계산합니다.",
      nextStep: "아래 3개 시나리오 중 실제 우려와 가까운 상황을 실행하세요.",
      basis: ["counterfactual"],
    };

  return Object.freeze({
    actions: Object.freeze([riskAction, productAction, resilienceAction]
      .map((action) => Object.freeze(action))),
  });
}
