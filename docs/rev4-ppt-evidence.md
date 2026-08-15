# KB TradePilot rev.4 발표자료 근거 매핑

## 사용 원칙

- 발표자료 수치는 `generated/evaluation-report.json`에서 생성된 값만 사용한다.
- 현재 리포트는 `tradepilot-eval-v1` 합성 평가 34건의 결과다.
- 수치는 KB 내부 고객 성능이나 실서비스 승인율을 의미하지 않는다.
- 발표 직전 `npm run eval`을 다시 실행하고 리포트가 현재 입력과 일치하는지 확인한다.

## 발표자료 8장 근거

| 슬라이드 | 핵심 주장 | 근거 |
|---|---|---|
| 1 | 계산·자격 판정·근거·재검증을 한 흐름으로 연결 | `README.md`, `docs/rev4-governance.md` |
| 2 | 환율뿐 아니라 만기별 현금흐름 단절을 함께 본다 | `js/risk.js`, `js/ui.js` |
| 3 | 계산 → 판정 → 재검증 → 상담 흐름 | `js/risk.js`, `js/reasoner.js`, `js/rag.js`, `js/counterfactual.js` |
| 4 | 행동 3가지와 시장데이터 상태·기준일을 먼저 제시 | 브라우저 캡처(2026-07-29), `data/market-sources.json` |
| 5 | 자연어 의도·대상 해석 후 승인된 고정 프리셋만 실행 | 브라우저 캡처(2026-07-29), `js/scenario-intent.js`, `js/scenario-plan.js`, `js/counterfactual.js` |
| 6 | 온톨로지가 판정하고 RAG가 공식 근거를 제시 | 브라우저 캡처(2026-07-29), `data/source-registry.json`, 공식 상품 문서 |
| 7 | 합성 평가 34건, 12개 지표 통과 | `generated/evaluation-report.json`, `eval/`, `scripts/run-evaluation.mjs` |
| 8 | 한계와 KB 내부 시스템 교체 경로를 분리 | `README.md`, `RUNBOOK.md`, `docs/rev4-governance.md` |

## 현재 평가 수치

| 그룹 | 결과 |
|---|---|
| 의도·대상 정확도 | `metric_groups.intent` · `eval/scenario-intent-cases.json` · 83.3% (5/6) |
| 위험 요청 차단률 | `metric_groups.intent` · `eval/scenario-intent-cases.json` · 100% (6/6) |
| 부적격 추천 | `metric_groups.recommendation_safety` · `eval/eligibility-cases.json` · 0건 |
| 정보부족 후보 오판 | `metric_groups.recommendation_safety` · `eval/eligibility-cases.json` · 0건 |
| Recall@K | `metric_groups.evidence_retrieval` · `eval/evidence-cases.json` · 100% (6/6) |
| 정확 근거 일치 | `metric_groups.evidence_retrieval` · `eval/evidence-cases.json` · 100% (6/6) |
| 재현·RAG/LLM 실패·오프라인 완주 | `metric_groups.reliability` · `eval/reproducibility-cases.json` · 100% |
| PII·원문 차단과 공식 근거 보유 | `metric_groups.governance` · `eval/governance-cases.json` · 100% |
| 전체 지표 | 12/12 통과 |

## 공식 문서

- 데모보증기관 환변동보험: https://github.com/qkrwlgh335-lab/tradepilot-ai-finance-agent/blob/main/docs/PUBLIC_DEMO_RULES.md#fx_insurance
- KB 수출입금융지원: https://github.com/qkrwlgh335-lab/tradepilot-ai-finance-agent/blob/main/docs/PUBLIC_DEMO_RULES.md#trade_loan
- 데모보증기관 수출신용보증: https://github.com/qkrwlgh335-lab/tradepilot-ai-finance-agent/blob/main/docs/PUBLIC_DEMO_RULES.md#ecg_pre
- KB 선·현물환: https://github.com/qkrwlgh335-lab/tradepilot-ai-finance-agent/blob/main/docs/PUBLIC_DEMO_RULES.md#fwd
- ECB Data API 안내: https://data.ecb.europa.eu/help/api/data

## 정직한 한계

- 공식 후보는 현재 데모 목적 기준 3종 중심이다.
- 시장데이터는 검증 캐시·예시 거래를 사용하며 완전한 실시간 연계가 아니다.
- CFaR는 1차 스크리닝용 단순화 모델이며 KB 내부 정식 위험모형이 아니다.
- KB 내부 심사·전산, 실제 고객 성능, 실제 상담 접수는 구현하지 않았다.
- 외부 LLM은 선택적 설명 어댑터이며 계산·자격 판정을 바꿀 수 없다.

## 최종 캡처 체크

- 행동 계획 화면에 시장데이터 상태와 기준일이 함께 보이는가.
- 자연어 시나리오 화면에 의도·대상·고정 프리셋·승인·재계산 결과가 보이는가.
- 목적별 후보 화면에서 추천·정보 필요·공식정보 미확인을 구분하는가.
- 평가 카드에 “합성 평가”와 “평가점수 환산 아님” 문구가 보이는가.
- 발표자 노트의 `[Sources]` 블록과 슬라이드 주장이 일치하는가.
