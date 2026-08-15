export const COUNTER_QUESTIONS = [
  "예상과 반대로 환율이 움직이면?",
  "수출대금 입금이 한 달 늦어지면?",
  "중도 해지가 필요하면?",
  "매출이 30% 감소하면?",
  "상품 가입 조건을 충족하지 못하면?",
];

export function ruleCounterExamples(strategies) {
  // Defensive: degenerate/empty input must not throw (never-throws guarantee).
  const list = Array.isArray(strategies) ? strategies : [];
  const stable = list.find((s) => s.key === "안정형") || list[0] || { hedgeRatio: 0.9 };
  const chance = list.find((s) => s.key === "기회추구형") || list[list.length - 1] || { hedgeRatio: 0.3 };
  const stablePct = Math.round(stable.hedgeRatio * 100);
  const openPct = Math.round((1 - chance.hedgeRatio) * 100);
  return [
    { q: COUNTER_QUESTIONS[0], a: `안정형(헤지 ${stablePct}%)은 반대 변동에도 환율 변동 영향이 크게 줄지만 잔여 위험은 남습니다. 기회추구형은 미헤지 ${openPct}%만큼 영향을 받습니다.` },
    { q: COUNTER_QUESTIONS[1], a: "입금 지연 시 만기 불일치로 유동성 부족이 생길 수 있습니다. 만기를 결제일에 맞추거나 분할 헤지를 검토하세요." },
    // 옵션은 유동성 공급 수단이 아니다 — 현금이 모자라는 상황은 조달 상품으로 따로 풀어야 한다.
    { q: COUNTER_QUESTIONS[2], a: "중도 해지 가능성이 높다면 선물환(수수료는 낮지만 해지 시 시장가 정산비용 발생)과 옵션(프리미엄을 먼저 지불하는 대신 행사 여부를 선택 가능)의 비용과 유연성을 비교하세요. 현금이 부족한 상황이라면 옵션이 아니라 외화대출·무역금융 등 자금조달 수단을 별도로 검토해야 합니다." },
    { q: COUNTER_QUESTIONS[3], a: "매출 감소로 확정 노출이 줄면 기존 헤지 금액이 같은 통화·만기 버킷의 새 노출을 초과할 수 있습니다. 자동으로 과헤지라 단정하지 않고, 실제 헤지 계약을 버킷별로 다시 매핑해 과헤지 여부를 확인하세요." },
    { q: COUNTER_QUESTIONS[4], a: "가입 조건 미충족 시 자동으로 대체되는 상품은 없습니다. 규칙 엔진이 자격 조건을 다시 검증해 통과한 항목만 후보로 제시하며, 공개용 환율보호 프로그램도 별도 확인이 필요합니다." },
  ];
}
