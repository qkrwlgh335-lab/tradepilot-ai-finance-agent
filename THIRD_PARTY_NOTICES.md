# Third-Party Notices

TradePilot은 공개 데이터와 오픈 모델을 참고하거나 캐시합니다. 기관별 상품 안내와
상세 자격조건은 공개 저장소에 포함하지 않고 합성 규칙으로 교체했습니다. 이 문서는
출처와 이용 경계를 명확히 하기 위한 것으로, 각 자료의 최신 조건은 원 제공자의 정책이
우선합니다.

## 공개 데이터

| 제공자 | 사용 범위 | 출처·조건 |
|---|---|---|
| European Central Bank (ECB) | 기준환율 및 파생 변동성 캐시 | [ECB Data Portal](https://data.ecb.europa.eu/), [ECB statistics reuse policy](https://www.ecb.europa.eu/stats/ecb_statistics/governance_and_quality_framework/html/usage_policy.en.html) |
| World Bank | 국가 거시지표 캐시 | [World Development Indicators](https://databank.worldbank.org/source/world-development-indicators), [World Bank data licensing](https://datacatalog.worldbank.org/public-licenses) |
| UN Comtrade | 대한민국 신고 기준 양국간 연간 상품 총교역 캐시 | [UN Comtrade](https://comtradeplus.un.org/), [UN Comtrade usage policy](https://comtradeplus.un.org/UsagePolicy) |

캐시된 값은 시연 재현성을 위한 공개 시점 스냅샷입니다. 체결환율, 실시간 시장데이터,
기업별 거래자료 또는 금융기관 내부 자료가 아닙니다. 상품 조건은 변경될 수 있으므로 실제
업무에서는 원문과 담당자 확인이 필요합니다.

## 모델과 라이브러리

- `Xenova/multilingual-e5-small`: 로컬 임베딩 생성에 선택적으로 사용합니다.
  모델의 라이선스와 모델 카드는 [Hugging Face 저장소](https://huggingface.co/Xenova/multilingual-e5-small)를
  확인하세요.
- `@xenova/transformers`: 사전 임베딩 생성 스크립트에서만 사용하는 개발 의존성입니다.
  패키지와 라이선스는 [npm](https://www.npmjs.com/package/@xenova/transformers)에서 확인할 수 있습니다.
- Anthropic API: 사용자가 직접 키를 설정한 경우 선택적 자연어 설명·의도 분류 실험에만
  사용하며, 키와 실제 응답은 이 저장소에 포함하지 않습니다.

## 상표와 비제휴 고지

대회명, 기관명과 관련 상표는 각 권리자에게 귀속됩니다. 이 저장소는 대회 출품작의
포트폴리오 공개본이며 어떤 금융기관도 운영·보증·승인한 서비스가 아닙니다. 공개본의
상품 규칙과 임계값은 모두 합성이며 실제 상품조건을 나타내지 않습니다.

## 저장소 자체 코드

별도 라이선스 파일이 없으므로 저장소 자체 코드에 오픈소스 이용허락이 부여된 것은
아닙니다. 제3자 자료에는 각 제공자의 이용조건이 별도로 적용됩니다.
