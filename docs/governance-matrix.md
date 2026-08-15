# KB TradePilot Governance Matrix

## 적용 범위

이 문서는 대회 프로토타입에 실제 구현된 통제와 은행 실서비스에서 새로 구축해야 할
통제를 분리합니다. 현재 앱은 합성·예시 데이터를 사용하는 로컬 1차 스크리닝 모델이며,
금융기관 운영환경의 보안·권한·보존 체계를 구현했다고 주장하지 않습니다.

## Data Governance

| 단계 | 위험 | 현재 구현 통제 | 테스트 증거 | 프로토타입 한계 | 실서비스 교체·보강 |
|---|---|---|---|---|---|
| 입력 | 거래 원문 오류, 필수값 누락, 임의 추정 | 사용자가 거래·기업정보·기존헤지를 확인하고 확정, 잘못된 값 fail-closed | `validate.test.mjs`, `t5-stabilize.test.mjs`, `parse-input.test.mjs` | CSV·JSON과 직접 입력만 지원, 기업 내부 원천시스템 미연결 | 고객 인증, 원천시스템 연계, IAM/RBAC, 입력 이력·승인 |
| 계산 | 누락 환율을 0으로 처리, 단위·만기 혼합 | ECB 공식 기준환율 검증 캐시, 29개 통화 환율·파생 변동성 검증, 통화·만기 버킷, 별도 고정 골든 | `refresh-market-data.test.mjs`, `market-data.test.mjs`, `risk.test.mjs`, `harness-golden.test.mjs` | 체결환율·실시간 시세가 아니며 상관·금리·스프레드·브리지금융 미반영 | 승인된 내부 시장데이터, 모델 검증·변경관리, 암호화 키관리 |
| 국가 범위 | 국가를 추가하며 근거 없는 등급·GDP를 생성 | 71개 선택 카탈로그와 통화 지원 상태 분리, 미확인 국가위험은 낮음으로 추정하지 않음 | `country-coverage.test.mjs`, `diagnose.test.mjs` | 공식 국가위험 데이터는 기존 5개 예시 외 미연결 | 무역통계·국가신용등급 Provider, 기준일·출처·승인 이력 |
| 온톨로지 판정 | 미확인 조건을 적격 처리, 출처와 규칙 불일치 | closed-world 검증, 공식 출처·필수 규칙·상품 관계 연결, 누락은 정보 필요 | `knowledge-graph.test.mjs`, `eligibility-rules.test.mjs`, `reasoner-recommend.test.mjs` | 검증 상품과 조건 범위가 제한됨, 수동 출처 갱신 | 상품 마스터 연계, 4-eyes 승인, 규칙 버전·효력일 관리 |
| 자연어 시나리오 | 오분류가 임의 금융 계산·대상 선택으로 이어짐 | 합성 코퍼스, 로컬 키워드+임베딩, 신뢰도·모호성 질문, 고정 프리셋·게이트 재검증 | `scenario-semantic.test.mjs`, `scenario-intent-provider.test.mjs`, `scenario-eval-contract.test.mjs` | 실제 고객 발화가 아닌 합성 데이터, 지원 의도 3종 | 승인 학습데이터, 드리프트 모니터링, 모델 레지스트리, 사람 검토 |
| RAG 근거 | 엉뚱한 상품 청크 노출, 오래된 임베딩 | 후보 제한 RAG, 규칙·출처 교집합, 임계값, `text_hash` 최신성 검사 | `rag.test.mjs`, `rag-evidence.test.mjs`, `product-docs.test.mjs` | 브라우저 로컬 코퍼스, 실시간 약관 반영 아님 | 승인 문서 저장소, 색인 파이프라인, DLP, 문서 접근권한 |
| LLM 설명 | 원본·식별정보 반출, 출력이 계산을 덮어씀 | 핵심 기능 로컬 실행, 비식별 allowlist, 사용자 승인, 서버 재검증, 규칙 폴백 | `privacy-schema.test.mjs`, `harness-security.test.mjs`, `proxy.test.mjs` | 선택적 데모 프록시이며 은행 보안 경계가 아님 | 내부 LLM Gateway, 중앙 비밀관리, DLP, 중앙 SIEM |
| 상담 브리프 | 자동 접수·계약으로 오인, 필요 이상 데이터 보존 | 사용자가 선택한 후보만 로컬 초안 생성, 비권유·비접수 문구 | `brief.test.mjs`, `ui-summary.test.mjs` | 실제 접수·전자서명·고객동의·보존 수명주기 없음 | 업무시스템 연결, 전자승인, 고객동의, 보존·삭제 정책 |

## AI Governance

| 단계 | 위험 | 현재 구현 통제 | 테스트 증거 | 프로토타입 한계 | 실서비스 교체·보강 |
|---|---|---|---|---|---|
| 입력 | 모델이 입력 사실을 추정 | LLM이 프로파일을 작성하지 않으며 사용자가 사실을 확정 | `profile.test.mjs`, `t52-input.test.mjs` | 비정형 문서 해석 모델 없음 | 승인된 문서처리 모델, 사람 검수, 품질 모니터링 |
| 계산 | 생성모델의 산술 오류·수치 변조 | 순수함수 계산과 고정 가정, LLM에 계산 변경 권한 없음 | `harness-golden.test.mjs`, `strategy.test.mjs` | 내부 리스크 승인모형이 아닌 간이 측정 | 독립 검증, 백테스트, 모델 위험관리 |
| 온톨로지 판정 | 유사도나 LLM이 부적격 상품을 되살림 | 코드 규칙만 판정, unknown과 fail 분리, 상품 ID별 임의 분기 차단 | `harness-ontology.test.mjs`, `reasoner-rules.test.mjs` | 규칙 작성·검토 워크플로가 수동 | 규칙 승인 워크플로, 책임자 지정, 변경 감사 |
| 자연어 시나리오 | LLM이 숫자·대상·복합 시나리오를 생성 | 분류기는 type만 제안, 대상은 로컬 규칙, 숫자는 고정 프리셋, 모든 결과 게이트 재검증 | `scenario-semantic.test.mjs`, `scenario-intent-provider.test.mjs`, `scenario-plan.test.mjs` | 임의 크기·복합 시나리오 미지원, 외부 어댑터는 선택 실험 | 내부 모델 Gateway, 승인 분류 모델, 실사용 발화 평가·승인 |
| RAG 근거 | 검색 문장이 판정 근거처럼 오용 | RAG는 판정 후 증명만 수행하고 실패 시 판정 불변 | `rag-evidence.test.mjs`, `harness-eval.test.mjs` | 검색 품질 운영지표·드리프트 모니터링 없음 | 검색 평가셋, 품질 임계값 승인, 코퍼스 수명주기 |
| LLM 설명 | 환각, 프롬프트 조작, 모델 장애 | 서버측 프롬프트, 목적 enum, 32KB·30초 제한, 승인 후 호출, 폴백 | `agent-v2.test.mjs`, `harness-governance.test.mjs`, `proxy.test.mjs` | `internal`은 현재 미구현, 로컬 감사로그는 세션 범위 | 내부 LLM Gateway, 모델 레지스트리, 중앙 SIEM, 출력 필터 |
| 상담 브리프 | 생성 문장을 공식 자문으로 오인 | 결정론 템플릿과 면책, 담당자 상담·심사 필수 | `brief.test.mjs`, `ui-consistency.test.mjs` | 적합성 설명 책임자 승인·민원 대응 체계 없음 | 준법 검토, 설명가능성 기록, 민원·이의제기 절차 |

## 현재 구현하지 않은 실서비스 통제

다음은 프로토타입이 제공하는 기능이 아니라 **실서비스 교체 대상**입니다.

- 전사 IAM/RBAC와 고객·직원 인증
- 네트워크·문서·프롬프트 DLP
- HSM/KMS 기반 암호화 키관리와 중앙 비밀관리
- 변조방지 중앙 SIEM 및 장기 감사 보관
- KB 내부 LLM Gateway와 승인 모델 레지스트리
- 법규·업무정책에 따른 데이터 보존·삭제 정책
- 실시간 상품 마스터·시장데이터·상담 업무시스템 연계

현재의 loopback 프록시와 CORS 설정만으로 금융권 실서비스 보안이 완성된다고 보지
않습니다. 또한 이 경량 검증기는 특정 온톨로지 표준의 완전 호환 구현이 아닙니다.
