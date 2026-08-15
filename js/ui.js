// KB TradePilot UI — end-to-end flow:
// 샘플 거래 불러오기(선택) → 거래 입력 → 확인(human-in-the-loop) → 결과 → 상품 선택 → 상담 신청서/브리프
// Deterministic modules compute all numbers; diagnosis is rule-based (no key). Claude key is an optional upgrade.

import { CalculationError, errorTitle } from "./errors.js";
import * as counterfactual from "./counterfactual.js";
import { buildActionPlan } from "./action-plan.js";
import { validateMarketDataForAnalysis } from "./market-data.js";
import { parseScenarioIntent, normalizeIntentText, resolveReceivableCandidates } from "./scenario-intent.js";
import { validatePlan } from "./scenario-plan.js";
import { buildPresetPlan, presetLabelFor } from "./scenario-preset.js";
import {
  createScenarioSemanticClassifier,
  interpretScenarioIntent,
} from "./scenario-semantic.js";
import { createExternalIntentAdapter } from "./scenario-intent-provider.js";
import { buildCountryIntelligence } from "./country-intelligence.js";
import { buildCountryMonitoring } from "./country-monitoring.js";
import {
  buildBilateralTradeIntelligence,
  formatTradeUsd,
  validateBilateralTradeSnapshot,
} from "./bilateral-trade.js";

// Human-facing labels for the three whitelisted scenario types (display only).
const SCENARIO_TYPE_LABEL = { payment_delay: "입금 지연", receivable_drop: "매출·수취액 감소", adverse_fx: "불리한 환율" };
const SCENARIO_MODE_LABEL = {
  rules: "결정론 규칙",
  keyword: "로컬 키워드",
  hybrid: "로컬 키워드+임베딩",
  external: "선택적 외부 AI → T17 재검증",
};

export function shouldTryExternalIntent(interpreted, optedIn = false) {
  const status = interpreted?.classification?.status;
  return optedIn === true
    && interpreted?.mode !== "rules"
    && interpreted?.intent?.steps?.length === 0
    && (status === "low_confidence" || status === "ambiguous");
}

// Pure preview renderer (T17-final). Natural language decides only the intent + target; the
// execution number is a FIXED preset (shown explicitly, never extracted from the words).
// gate = validatePlan(presetPlan) output; opts = { step, receivables, confidence }.
export function renderScenarioPlanPreview(gate, opts = {}) {
  const {
    step = null,
    receivables = [],
    confidence = null,
    mode = "rules",
    externalStatus = null,
  } = opts;
  const type = step?.type;
  const modeLabel = SCENARIO_MODE_LABEL[mode] || mode;
  const modeLine = `<p class="hint">해석 방식: ${esc(modeLabel)} · 숫자·대상·금융 계산은 기존 규칙과 게이트가 결정합니다.</p>`;
  const externalLine = externalStatus === "unavailable"
    ? '<p class="hint external-fallback-note">외부 AI 연결을 사용할 수 없어 로컬 분류 결과를 유지했습니다. 프록시·API 키 없이도 핵심 기능은 계속 동작합니다.</p>'
    : externalStatus === "low_confidence"
      ? '<p class="hint external-fallback-note">외부 AI도 충분한 신뢰도로 분류하지 못해 실행하지 않습니다.</p>'
      : "";
  const confLine = gate?.ok && typeof confidence === "number"
    ? `<p class="hint">의도 분류 신뢰도 ${Math.round(confidence * 100)}% · 이 값은 금융 위험 확률이 아닙니다.</p>`
    : "";

  if (gate && gate.ok && gate.execution) {
    const label = SCENARIO_TYPE_LABEL[type] || esc(String(type ?? ""));
    const preset = presetLabelFor(type);
    const targetLabel = type === "payment_delay"
      ? `거래 ${esc(gate.execution.options.targetTransactionId)}`
      : type === "receivable_drop" ? "전체 수취 거래" : "통화별 순노출";
    return `<div class="agent-plan-card ok" role="status">
      <p><strong>해석된 의도</strong>: ${esc(label)}</p>
      <p><strong>해석된 대상</strong>: ${targetLabel}</p>
      <p><strong>실행할 고정 시나리오</strong>: ${esc(preset)}</p>
      ${modeLine}
      ${externalLine}
      ${confLine}
      <p class="hint">${esc(preset)} 값은 자연어에서 추출한 값이 아니라 <strong>데모용 고정 프리셋</strong>이며, 아래 프리셋 버튼과 같은 결정론 엔진으로 전/후를 재계산합니다.</p>
      <button type="button" id="agent-approve" class="btn-primary">고정 ${esc(preset)} 시나리오로 재검증 →</button>
    </div>`;
  }

  const parts = ['<div class="agent-plan-card blocked" role="status">'];
  parts.push('<p><strong>이 문장은 바로 실행할 수 없습니다.</strong></p>');
  parts.push(modeLine);
  parts.push(externalLine);
  parts.push('<p class="hint">분류 신뢰도가 낮거나 대상이 모호하면 실행하지 않고 추가 정보를 묻습니다.</p>');
  if (gate?.missingFacts?.length) {
    parts.push(`<p>${esc(gate.missingFacts[0].question || "추가 정보가 필요합니다")}</p>`);
    if (receivables.length) {
      parts.push('<div class="agent-target-chooser">'
        + receivables.map((r) => `<label><input type="radio" name="agent-target" class="agent-target" value="${esc(r.transaction_id)}">
          ${esc(r.country || "")} ${esc(r.currency)} ${Number(r.amount).toLocaleString()} · ${esc(r.months)}개월</label>`).join("")
        + '</div>');
    }
  }
  for (const seg of (gate?.unsupportedSegments || [])) {
    if (seg && seg.reason) parts.push(`<p class="hint">• ${esc(seg.reason)}</p>`);
  }
  parts.push('</div>');
  return parts.join("");
}

const DIRECTION_LABEL = { in: "수취(받음)", out: "지급(냄)" };
const TRADE_TYPE_LABEL = { export: "수출", import: "수입" };

function emptyRow() {
  return { country: "", currency: "", tradeType: "", direction: "in", amount: "", months: "" };
}

// A fresh customer analysis keeps only the already-loaded reference datasets.
// This is exported so the reset contract can be regression-tested without a browser.
export function createAnalysisState(data = null) {
  return {
    screen: "input",
    rows: [emptyRow()],
    data,
    cashflows: null,
    loadedSample: null,
    importDraft: "",
    importFormat: "csv",
    importNotice: null,
    company: {
      companyType: "",
      companyScale: "",
      isSme: "",
      riskAppetite: "",
      requestedPurposes: [],
      isManufacturer: "",
      supplyChainProgramEligible: "",
      partnerGuaranteeConfirmed: "",
      creditGradeMeetsThreshold: "",
      reviewChannelConfirmed: "",
      priorYearExportUsd: "",
    },
    hedgeMode: "unknown",
    hedgeRows: [],
    profile: null,
    liquidity: { openingBalanceKrw: 0, creditLineKrw: 0 },
    liquidityRaw: { openingBalanceKrw: "", creditLineKrw: "" },
    selected: null,
    briefCtx: null,
    lastCounterfactual: null,
  };
}

const COMPANY_SCALE_VALUES = new Set(["sme", "mid_market", "other"]);
const OPTIONAL_BOOLEAN_COMPANY_FACTS = Object.freeze([
  "isManufacturer",
  "supplyChainProgramEligible",
  "partnerGuaranteeConfirmed",
  "creditGradeMeetsThreshold",
  "reviewChannelConfirmed",
]);

function optionalBoolean(value, field) {
  if (value === "" || value === undefined || value === null) return undefined;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new CalculationError("INVALID_COMPANY_FACT", `${field} 값은 확인 필요·예·아니오 중 하나여야 합니다.`, { field, value });
}

// UI 원문을 온톨로지 입력으로 바꾸는 단일 경계. 모름은 키를 만들지 않고,
// 명시적으로 고른 값만 보존한다.
export function buildCompanyInputFromState(companyState = {}, hedgeValue) {
  if (!companyState || typeof companyState !== "object" || Array.isArray(companyState))
    throw new CalculationError("INVALID_COMPANY_FACT", "기업 정보 입력을 확인할 수 없습니다.");
  const company = {};
  if (companyState.companyType) company.companyType = companyState.companyType;
  if (companyState.riskAppetite) company.riskAppetite = companyState.riskAppetite;
  company.requestedPurposes = Array.isArray(companyState.requestedPurposes)
    ? [...companyState.requestedPurposes]
    : [];

  const scale = companyState.companyScale;
  if (scale) {
    if (!COMPANY_SCALE_VALUES.has(scale))
      throw new CalculationError("INVALID_COMPANY_FACT", "기업 규모 값이 올바르지 않습니다.", { field: "companyScale", value: scale });
    company.companyScale = scale;
    company.isSme = scale === "sme";
  } else if (companyState.isSme === "true" || companyState.isSme === "false"
      || companyState.isSme === true || companyState.isSme === false) {
    // 이전 저장 상태와의 호환. false는 중견/기타를 추정하지 않으므로 companyScale을 만들지 않는다.
    company.isSme = companyState.isSme === true || companyState.isSme === "true";
  }

  for (const field of OPTIONAL_BOOLEAN_COMPANY_FACTS) {
    const normalized = optionalBoolean(companyState[field], field);
    if (normalized !== undefined) company[field] = normalized;
  }

  const exportUsd = companyState.priorYearExportUsd;
  if (exportUsd !== "" && exportUsd !== undefined && exportUsd !== null) {
    const normalized = typeof exportUsd === "number" ? exportUsd : Number(exportUsd);
    if (!Number.isFinite(normalized) || normalized < 0)
      throw new CalculationError("INVALID_COMPANY_FACT", "최근 1년 수출실적은 0 이상의 숫자여야 합니다.", { field: "priorYearExportUsd", value: exportUsd });
    company.priorYearExportUsd = normalized;
  }

  if (hedgeValue !== undefined) company.existingHedges = hedgeValue;
  return company;
}

const PURPOSES = [
  ["fx_hedge", "환헤지"],
  ["working_capital", "운전자금"],
  ["export_receivable", "수출대금 회수"],
  ["guarantee_insurance", "보증·보험"],
  ["policy_fund", "정책자금"],
];

export function shouldShowEligibilityQuestions(purposes) {
  return Array.isArray(purposes) && purposes.includes("working_capital");
}

function esc(s) {
  return String(s).replace(/[<>&"']/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function renderBilateralTradeSource(snapshot) {
  const validation = validateBilateralTradeSnapshot(snapshot);
  if (!validation.ok) {
    return `<p class="src">교역 출처: 교역 통계 캐시 미확인 · 공식 통계를 확인한 뒤 다시 시도하세요.</p>`;
  }
  return `<p class="src">교역 출처: <a href="${esc(snapshot.source_url)}" target="_blank" rel="noopener noreferrer">UN Comtrade 공식 교역통계</a> · 검증된 로컬 캐시 · 한국 신고 기준 · ${esc(snapshot.note || "")}</p>`;
}

export function countryOptionLabel(iso, country = {}) {
  const name = typeof country.name === "string" && country.name.trim()
    ? country.name.trim()
    : iso;
  if (country.currency_coverage === "supported"
      && typeof country.currency === "string")
    return `${name} (${iso}) · ${country.currency}`;
  return `${name} (${iso}) · 현지통화 미지원`;
}

export function suggestedCurrencyForCountry(country, rates = {}) {
  if (!country || country.currency_coverage !== "supported") return null;
  const currency = country.currency;
  return typeof currency === "string"
    && typeof rates?.[currency] === "number"
    && Number.isFinite(rates[currency])
    && rates[currency] > 0
    ? currency
    : null;
}

function disclaimerBanner() {
  return `<div class="disclaimer no-print">⚠️ 본 서비스는 <strong>참고용 정보</strong>이며 투자·금융상품 권유가 아닙니다.
    실제 거래 전 <strong>금융기관 상담 및 심사</strong>가 필요합니다. 상품 판정은 공개용 합성 규칙이며, 공식 출처가 표시된 시장지표만 검증 캐시입니다.</div>`;
}

// T30a — the four contracted market-data states, each with an ICON + TEXT (not colour alone).
// The wording is fixed by the T30a spec; sourceLabel ("ECB") is included when the datum carries
// a verified official source, and the date is attached when both fx & volatility share it.
const MARKET_STATE_ICONS = { live: "🛰️", cached: "🗂️", demo: "🧪", unavailable: "⛔" };
const MARKET_STATE_TONE = { live: "status-verified", cached: "status-verified", demo: "status-demo", unavailable: "status-unavailable" };

function marketStateText(state, { sourceLabel = "", asOf = "" } = {}) {
  const withSource = (label) => sourceLabel ? `${label} · ${sourceLabel}` : label;
  const withDate = (label) => asOf ? `${label} · 기준일 ${asOf}` : label;
  // T30b: "live" is reserved for a future KB internal direct provider — the ECB Node refresh
  // path always emits status:"cached". Banned wording ("실시간" 등) never appears in the badge.
  if (state === "live") return withDate(withSource("직접 공식 데이터 (예약 상태)"));
  // T30b: no "최근" — we don't compute elapsed time; the badge just cites 기준일.
  if (state === "cached") return withDate(withSource("검증된 공식 일별 데이터 캐시"));
  if (state === "demo") return "예시 시장데이터 · 실제 거래 전 확인 필요";
  return "시장데이터를 확인할 수 없어 계산을 중단했습니다";
}

// T30c: the badge consumes the SAME judgement as the analyze gate — no independent state
// resolver lives here. That guarantees wording and behaviour stay aligned across the codebase.
export function renderMarketDataBadge(meta) {
  const judgement = validateMarketDataForAnalysis(meta);
  const state = judgement.displayState;
  const sourceLabel = state === "live" || state === "cached" ? "ECB" : "";
  const label = marketStateText(state, { sourceLabel, asOf: judgement.asOf || "" });
  const icon = MARKET_STATE_ICONS[state];
  const tone = MARKET_STATE_TONE[state];
  const fx = meta?.fx_rates;
  const volatility = meta?.fx_volatility;
  const detail = [
    ["환율", fx], ["변동성", volatility],
  ].filter(([, item]) => item).map(([name, item]) =>
    `${name}: ${item.status} · ${item.source_id || "-"} · 기준일 ${item.as_of || "미확인"} · ${item.note || ""}`)
    .join("\n");
  return `<span class="market-data-badge ${tone}" title="${esc(detail)}">`
    + `<span class="market-icon" aria-hidden="true">${icon}</span>`
    + ` ${esc(label)}`
    + `</span>`;
}

// T30c: system alert for a market-data outage. Distinct from the user-input-error UI so that a
// server-side failure never appears as "입력을 확인해 주세요 (N건) / 입력값 오류" — those are
// reserved for actual user typos. Body wording is fixed by the T30c spec.
export function renderMarketDataAlert() {
  return `<div class="errors market-data-alert" role="alert">`
    + `<strong>시장데이터 확인 필요</strong>`
    + `<div>거래 입력의 문제가 아닙니다. 시장데이터의 출처와 기준일을 검증할 수 없어 계산을 시작하지 않았습니다. 네트워크를 확인하거나 검증된 캐시를 복구한 뒤 다시 시도하세요.</div>`
    + `</div>`;
}

const EVALUATION_GROUP_LABELS = {
  intent: "의도 해석",
  recommendation_safety: "추천 안전성",
  evidence_retrieval: "근거 검색",
  reliability: "신뢰성",
  governance: "거버넌스",
};
const EVALUATION_METRIC_LABELS = {
  scenario_intent_accuracy: "의도·대상 정확도",
  unsafe_execution_block_rate: "위험 요청 차단율",
  ineligible_product_recommendations: "부적격 추천",
  missing_info_as_eligible: "정보누락 후보 오판",
  recall_at_k: "Recall@K",
  exact_evidence_match: "정확 근거 일치",
  reproducibility: "동일 입력 재현율",
  failure_completion: "RAG·LLM 실패 시 완주율",
  offline_completion: "오프라인 완주율",
  pii_raw_egress_block_rate: "PII·원문 반출 차단율",
  candidate_rule_evidence_coverage: "후보 규칙근거 보유율",
  candidate_source_coverage: "후보 근거출처 보유율",
};
const EVALUATION_COUNT_METRICS = new Set([
  "ineligible_product_recommendations",
  "missing_info_as_eligible",
]);
const EVALUATION_GROUP_CASE_KEYS = {
  intent: "scenario_intent",
  recommendation_safety: "eligibility",
  evidence_retrieval: "evidence",
  reliability: "reliability",
  governance: "governance",
};
const EVALUATION_HIGHLIGHTS = [
  ["intent", "scenario_intent_accuracy"],
  ["recommendation_safety", "ineligible_product_recommendations"],
  ["evidence_retrieval", "exact_evidence_match"],
  ["reliability", "offline_completion"],
];

function evaluationMetricValue(key, metric) {
  if (EVALUATION_COUNT_METRICS.has(key))
    return `${Number(metric?.value || 0).toLocaleString("ko-KR")}건`;
  const value = Number(metric?.value);
  return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "측정 불가";
}

export function renderEvaluationCard(envelope = {}) {
  const report = envelope?.report;
  if (envelope?.status !== "current" || !report) {
    const stale = envelope?.status === "stale";
    return `<section class="card evaluation-card evaluation-unavailable" aria-labelledby="evaluation-title">
      <div class="section-heading">
        <div>
          <div class="summary-kicker">CODE-COMPUTED EVALUATION</div>
          <h2 id="evaluation-title">${stale ? "평가 리포트가 최신 코드와 불일치합니다" : "평가 미실행"}</h2>
        </div>
        <span class="evaluation-status status-warn">${stale ? "재평가 필요" : "결과 없음"}</span>
      </div>
      <p class="hint">${stale
        ? "이전 수치는 숨겼습니다. npm run eval로 현재 코드 기준 리포트를 다시 생성해 주세요."
        : "정량 평가 리포트가 없거나 검증할 수 없어 성능 수치를 표시하지 않습니다."}</p>
    </section>`;
  }

  const passed = report.overall?.passed === true;
  const groups = Object.entries(report.metric_groups || {});
  const groupHtml = groups.map(([groupKey, group]) => {
    const metrics = Object.entries(group?.metrics || {});
    const caseKey = EVALUATION_GROUP_CASE_KEYS[groupKey];
    const caseCount = Number(report.case_counts?.[caseKey] || 0);
    return `<article class="evaluation-group ${metrics.every(([, item]) => item?.passed) ? "group-pass" : "group-fail"}">
      <h3>
        <span>${esc(EVALUATION_GROUP_LABELS[groupKey] || group?.label || groupKey)}</span>
        <span class="evaluation-case-count">합성 ${caseCount.toLocaleString("ko-KR")}건</span>
      </h3>
      <ul>${metrics.map(([key, item]) => `<li>
        <span>${item?.passed ? "✓" : "!"} ${esc(EVALUATION_METRIC_LABELS[key] || key)}</span>
        <strong>${esc(evaluationMetricValue(key, item))}</strong>
      </li>`).join("")}</ul>
      ${groupKey === "governance"
        ? `<p class="hint">후보가 없었던 판정 케이스 ${Number(group.no_candidate || 0).toLocaleString("ko-KR")}건은 근거 보유율 분모에서 제외했습니다.</p>`
        : ""}
    </article>`;
  }).join("");
  const highlights = EVALUATION_HIGHLIGHTS.map(([groupKey, metricKey]) => {
    const metric = report.metric_groups?.[groupKey]?.metrics?.[metricKey];
    const numerator = Number(metric?.numerator);
    const denominator = Number(metric?.denominator);
    const basis = Number.isFinite(numerator) && Number.isFinite(denominator)
      ? `${numerator.toLocaleString("ko-KR")}/${denominator.toLocaleString("ko-KR")}`
      : `합성 ${Number(report.case_counts?.[EVALUATION_GROUP_CASE_KEYS[groupKey]] || 0).toLocaleString("ko-KR")}건`;
    return `<article class="evaluation-highlight">
      <span>${esc(EVALUATION_METRIC_LABELS[metricKey] || metricKey)}</span>
      <strong>${esc(evaluationMetricValue(metricKey, metric))}</strong>
      <small>평가 기준 ${esc(basis)}</small>
    </article>`;
  }).join("");
  const revision = String(report.evaluated_revision || "unknown");
  const sourceDigest = String(report.source_digest || "");
  const resultsDigest = String(report.results_digest || "");

  return `<section class="card evaluation-card" aria-labelledby="evaluation-title">
    <div class="section-heading">
      <div>
        <div class="summary-kicker">CODE-COMPUTED EVALUATION · 합성 평가 ${Number(report.case_counts?.total || 0).toLocaleString("ko-KR")}건</div>
        <h2 id="evaluation-title">AI·추천 안전성 정량 검증</h2>
      </div>
      <span class="evaluation-status ${passed ? "status-pass" : "status-fail"}">${passed ? "평가 통과" : "평가 기준 미통과"}</span>
    </div>
    <p class="hint">아래 값은 화면용 문구가 아니라 고정된 합성 케이스로 현재 의도 분류·자격 판정·RAG·폴백·반출 통제를 실행해 계산한 결과입니다.</p>
    <div class="evaluation-highlights" aria-label="핵심 평가 결과">${highlights}</div>
    <div class="evaluation-scope">
      <div class="evaluation-scope-heading">
        <strong>예선 기술 항목에 활용할 수 있는 실행 근거</strong>
        <span>평가점수 환산이 아닙니다</span>
      </div>
      <div class="evaluation-scope-items">
        <p><strong>기술 적정성</strong><span>의도 해석 → 자격 판정 → 연결 근거 검색 계약</span></p>
        <p><strong>기술 실현 가능성</strong><span>동일 입력 재현·장애 폴백·오프라인 완주</span></p>
        <p><strong>운영 통제 근거</strong><span>PII·원문 반출 차단과 추천 근거 보유</span></p>
      </div>
      <p class="evaluation-scope-limit">문제 정의·활용 가능성·창의성·개발 계획은 이 합성 평가가 측정하지 않습니다. 해당 항목은 기획안과 발표자료에서 별도 증명해야 합니다.</p>
    </div>
    <div class="evaluation-grid">${groupHtml}</div>
    <details class="evaluation-basis">
      <summary>평가 기준·재현 정보</summary>
      <ul>
        <li>데이터 버전: <code>${esc(report.data_version || "unknown")}</code></li>
        <li>평가 기준 리비전: <code>${esc(revision)}</code></li>
        <li>입력 소스 SHA-256: <code>${esc(sourceDigest.slice(0, 12))}…</code></li>
        <li>결과 SHA-256: <code>${esc(resultsDigest.slice(0, 12))}…</code></li>
      </ul>
      <p class="hint">합성 평가 결과이며 실제 금융기관 심사 성능이나 전체 고객 모집단 성능을 의미하지 않습니다.</p>
    </details>
  </section>`;
}

export function buildExecutiveSummary({
  netRows = [],
  rates = {},
  scenarios = [],
  cfarTotal,
  strategies = [],
  candidates = [],
  shortfalls = [],
} = {}) {
  const largestRisk = netRows
    .map((row) => ({
      currency: row.currency,
      net: row.net,
      direction: row.net >= 0 ? "수취" : "지급",
      krwNotional: Math.abs(row.net * rates[row.currency]),
    }))
    .filter((row) => row.currency && Number.isFinite(row.net) && Number.isFinite(row.krwNotional))
    .sort((left, right) =>
      right.krwNotional - left.krwNotional
      || String(left.currency).localeCompare(String(right.currency)))[0] || null;

  const worstScenario = scenarios
    .filter((row) => Number.isFinite(row?.delta) && Number.isFinite(row?.totalPnl))
    .map((row) => ({ delta: row.delta, totalPnl: row.totalPnl }))
    .sort((left, right) => left.totalPnl - right.totalPnl || left.delta - right.delta)[0] || null;

  const comparisonStrategy = strategies
    .filter((row) =>
      Number.isFinite(row?.hedgeRatio)
      && Number.isFinite(row?.residualCFaR)
      && Number.isFinite(row?.hedgeCost))
    .sort((left, right) =>
      right.hedgeRatio - left.hedgeRatio
      || String(left.key).localeCompare(String(right.key)))[0] || null;

  const beforeCFaR = Number.isFinite(cfarTotal) ? cfarTotal : null;
  const afterCFaR = comparisonStrategy?.residualCFaR;
  const reductionKrw = beforeCFaR !== null && Number.isFinite(afterCFaR)
    ? Math.max(0, beforeCFaR - afterCFaR)
    : null;

  const worstShortfall = shortfalls
    .filter((row) => Number.isFinite(row?.months) && Number.isFinite(row?.shortfallKrw))
    .sort((left, right) =>
      right.shortfallKrw - left.shortfallKrw || left.months - right.months)[0] || null;

  const actions = [
    largestRisk
      ? `${largestRisk.currency} 만기별 노출과 헤지 비율을 금융기관 담당자와 비교 상담`
      : "통화·만기별 노출 정보를 확인한 뒤 헤지 필요성을 상담",
    candidates.length
      ? `공개용 합성 자격을 통과한 상담 후보 ${candidates.length}건의 조건 확인`
      : "부족한 자격정보를 보완한 뒤 상담 후보를 다시 판정",
    worstShortfall
      ? `${worstShortfall.months}개월 시점 최대 유동성 부족 ₩ ${Math.round(worstShortfall.shortfallKrw).toLocaleString("ko-KR")}에 대비한 재원 계획 확인`
      : "입금 지연·매출 감소·불리한 환율 자기반례로 계획을 재검증",
  ];

  return {
    largestRisk,
    worstScenario,
    actions,
    effect: comparisonStrategy && beforeCFaR !== null && reductionKrw !== null
      ? {
        strategyKey: comparisonStrategy.key,
        hedgeRatio: comparisonStrategy.hedgeRatio,
        beforeCFaR,
        afterCFaR,
        reductionKrw,
        reductionRate: beforeCFaR > 0 ? reductionKrw / beforeCFaR : 0,
        hedgeCost: comparisonStrategy.hedgeCost,
        assumptionsLabel: comparisonStrategy.assumptionsLabel,
      }
      : null,
  };
}

const PURPOSE_LABEL = Object.fromEntries(PURPOSES);

const formatWhatIfKrw = (value) =>
  Number.isFinite(value) ? `₩ ${Math.round(value).toLocaleString("ko-KR")}` : "계산 불가";

const formatWhatIfValue = (value) =>
  typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString("ko-KR")
    : String(value ?? "—");

// 검증 메시지를 실제 비어 있는/잘못된 입력 칸(섹션) 옆에 표시하기 위한 매핑.
// 헤지는 company.existingHedges 로 오므로 company 프리픽스보다 먼저 판별한다.
export function sectionForPath(path = "") {
  const p = String(path);
  if (/hedge/i.test(p) || p.startsWith("company.existingHedges")) return "hedge";
  if (p.startsWith("company")) return "company";
  if (p.startsWith("transaction") || p.startsWith("cashflow")) return "transactions";
  if (p.startsWith("liquidity")) return "liquidity";
  return "general";
}

// 반사실 changedInputs.path 는 충돌 방지용 내부 표현(transactions.id~<hex>.<field> / rates.<CCY>).
// 화면에는 사람이 읽는 라벨로 변환한다(데이터·검증용 path 자체는 그대로 유지).
const WHATIF_FIELD_LABEL = { months: "만기(개월)", amount: "금액" };
function formatChangePath(path) {
  const txn = /^transactions\.id~((?:[0-9a-f]{4})+)\.(\w+)$/.exec(String(path));
  if (txn) {
    let id = "";
    for (let i = 0; i < txn[1].length; i += 4) id += String.fromCharCode(parseInt(txn[1].slice(i, i + 4), 16));
    return `거래 ${id} · ${WHATIF_FIELD_LABEL[txn[2]] || txn[2]}`;
  }
  const rate = /^rates\.(\w+)$/.exec(String(path));
  if (rate) return `${rate[1]} 기준환율`;
  return String(path);
}

function renderRecommendationChanges(changes = {}) {
  const rows = [
    ["후보 추가", changes.added],
    ["후보 제외", changes.removed],
    ["정보 필요로 이동", changes.movedToPending],
  ].flatMap(([label, items]) =>
    (Array.isArray(items) ? items : []).map((item) =>
      `<li><strong>${esc(label)}</strong> · ${esc(PURPOSE_LABEL[item.purpose] || item.purpose)}
        · <code>${esc(item.product_id)}</code></li>`));
  return rows.length
    ? `<ul>${rows.join("")}</ul>`
    : `<p class="hint">이 시나리오에서 추천 상태 변화가 없습니다.</p>`;
}

export function renderWhatIfResult(result) {
  if (!result || typeof result !== "object")
    return `<div class="errors">반사실 계산 결과를 표시할 수 없습니다.</div>`;

  const changes = Array.isArray(result.changedInputs) ? result.changedInputs : [];
  const facts = Array.isArray(result.explanationFacts) ? result.explanationFacts : [];
  const limitations = Array.isArray(result.limitations) ? result.limitations : [];
  const beforeCfar = result.before?.cfar?.total;
  const afterCfar = result.after?.cfar?.total;
  const beforeShortfall = result.before?.liquidity?.worstShortfallKrw;
  const afterShortfall = result.after?.liquidity?.worstShortfallKrw;
  const recommendationChangeCount = ["added", "removed", "movedToPending"]
    .reduce((sum, key) => sum + (Array.isArray(result.affectedRecommendations?.[key])
      ? result.affectedRecommendations[key].length
      : 0), 0);
  const hasScenarioPnl = Number.isFinite(result.after?.scenarioPnL);
  const beforeTimeline = Array.isArray(result.before?.liquidity?.timeline)
    ? result.before.liquidity.timeline
    : [];
  const afterTimeline = Array.isArray(result.after?.liquidity?.timeline)
    ? result.after.liquidity.timeline
    : [];
  const timelineAt = (timeline, months) =>
    [...timeline].filter((point) => point.months <= months).sort((a, b) => a.months - b.months).at(-1)
      || { cumulativeKrw: 0, shortfallKrw: 0 };
  const liquidityChanges = [...new Set([
    ...beforeTimeline.map((point) => point.months),
    ...afterTimeline.map((point) => point.months),
  ])].sort((a, b) => a - b).map((months) => {
    const before = timelineAt(beforeTimeline, months);
    const after = timelineAt(afterTimeline, months);
    return { months, before, after };
  }).filter(({ before, after }) =>
    before.cumulativeKrw !== after.cumulativeKrw
    || before.shortfallKrw !== after.shortfallKrw);

  return `<article class="what-if-result-card">
    <h3>${esc(result.scenario?.label || result.scenario?.id || "반사실 시나리오")}</h3>
    ${result.scenario?.targetScopeLabel
      ? `<p class="hint">적용 대상: ${esc(result.scenario.targetScopeLabel)}</p>`
      : ""}
    <div class="what-if-kpi-grid">
      <div><span>CFaR</span><strong>${formatWhatIfKrw(beforeCfar)} → ${formatWhatIfKrw(afterCfar)}</strong></div>
      <div><span>최대 유동성 부족액</span><strong>${formatWhatIfKrw(beforeShortfall)} → ${formatWhatIfKrw(afterShortfall)}</strong></div>
      <div><span>상담 후보 상태 변화</span><strong>${recommendationChangeCount}건</strong></div>
    </div>

    <details class="what-if-details">
      <summary>변경된 입력·버킷·계산 한계 자세히 보기</summary>
    <section class="what-if-block">
      <h4>변경된 입력</h4>
      ${facts.length
        ? `<ul>${facts.map((fact) => `<li>${esc(fact.text)}</li>`).join("")}</ul>`
        : ""}
      ${changes.length
        ? `<div class="table-wrap"><table class="what-if-table"><thead><tr>
            <th>변경 항목</th><th>이전</th><th>이후</th>
          </tr></thead><tbody>${changes.map((change) => `<tr>
            <td>${esc(formatChangePath(change.path))}</td>
            <td>${esc(formatWhatIfValue(change.before))}</td>
            <td>${esc(formatWhatIfValue(change.after))}</td>
          </tr>`).join("")}</tbody></table></div>`
        : `<p class="hint">변경된 입력이 없습니다.</p>`}
    </section>

    <section class="what-if-block">
      <h4>전/후 비교</h4>
      <div class="table-wrap"><table class="what-if-table"><thead><tr>
        <th>지표</th><th>이전</th><th>이후</th><th>변화</th>
      </tr></thead><tbody>
        <tr><td>CFaR</td><td>${formatWhatIfKrw(beforeCfar)}</td>
          <td>${formatWhatIfKrw(afterCfar)}</td>
          <td>${formatWhatIfKrw(result.deltas?.cfarTotalKrw)}</td></tr>
        <tr><td>최대 유동성 부족액</td><td>${formatWhatIfKrw(beforeShortfall)}</td>
          <td>${formatWhatIfKrw(afterShortfall)}</td>
          <td>${formatWhatIfKrw(result.deltas?.worstShortfallKrw)}</td></tr>
        ${hasScenarioPnl
          ? `<tr><td>시나리오 손익</td><td>—</td>
              <td>${formatWhatIfKrw(result.after.scenarioPnL)}</td>
              <td>${formatWhatIfKrw(result.deltas?.scenarioPnlKrw)}</td></tr>`
          : ""}
      </tbody></table></div>
      ${hasScenarioPnl
        ? `<p class="hint">시나리오 손익과 CFaR는 서로 다른 지표이며 합산하지 않습니다.</p>`
        : ""}
      ${liquidityChanges.length
        ? `<h5>만기별 유동성 변화</h5>
          <div class="table-wrap"><table class="what-if-table"><thead><tr>
            <th>시점</th><th>누적 현금흐름 이전(원화 환산)</th><th>누적 현금흐름 이후(원화 환산)</th>
            <th>부족액 이전</th><th>부족액 이후</th>
          </tr></thead><tbody>${liquidityChanges.map(({ months, before, after }) => `<tr>
            <td>${esc(months)}개월</td>
            <td>${formatWhatIfKrw(before.cumulativeKrw)}</td>
            <td>${formatWhatIfKrw(after.cumulativeKrw)}</td>
            <td>${formatWhatIfKrw(before.shortfallKrw)}</td>
            <td>${formatWhatIfKrw(after.shortfallKrw)}</td>
          </tr>`).join("")}</tbody></table></div>`
        : `<p class="hint">만기별 유동성 경로 변화가 없습니다.</p>`}
    </section>

    <section class="what-if-block">
      <h4>추천 변화</h4>
      ${renderRecommendationChanges(result.affectedRecommendations)}
    </section>

    <section class="what-if-block">
      <h4>계산 한계</h4>
      ${limitations.length
        ? `<ul>${limitations.map((item) => `<li>${esc(item)}</li>`).join("")}</ul>`
        : `<p class="hint">표시할 계산 한계가 없습니다.</p>`}
    </section>
    </details>
  </article>`;
}

function renderEmpty(message) {
  return `<p class="empty-state">${esc(message)}</p>`;
}

function renderSource(source) {
  if (!source) return renderEmpty("연결된 근거 출처를 표시할 수 없습니다.");
  return `<div class="official-source">
    <strong>${esc(source.institution)}</strong> · ${esc(source.document_title)}
    <div><a href="${esc(source.url)}" target="_blank" rel="noopener noreferrer">근거 문서 열기</a></div>
    <div class="hint">확인일 ${esc(source.verified_on)} · ${esc(source.page_or_section)}</div>
  </div>`;
}

const EVIDENCE_FIELD_LABEL = Object.freeze({
  "eligibility.trade_scope": "대상 거래 범위",
  "eligibility.max_horizon_months_export": "일반수출 만기",
  "eligibility.limit_basis": "실헤지 수요",
  "eligibility.requires_export": "수출기업 여부",
  "eligibility.requires_import": "수입거래 여부",
  "eligibility.manufacturer": "제조기업 여부",
  "eligibility.demo_supply_chain_scope": "지원대상 업종",
  "eligibility.partner_guarantee": "데모 제휴보증 확인",
  "eligibility.company_scale": "기업 규모",
  "eligibility.credit_grade": "신용등급 기준",
  "eligibility.export_record_cap": "수출실적 기준",
  "eligibility.review_channel_confirmation": "상담채널 사전확인",
  "eligibility.effective_window": "운영 기간",
  "product.effective_window": "운영 기간",
  "eligibility.purpose.guarantee": "보증 목적",
  "eligibility.company_type": "기업 형태",
  "eligibility.internet_banking_enrolled": "인터넷뱅킹 가입",
});

function evidenceLabel(entry) {
  return EVIDENCE_FIELD_LABEL[entry?.field] || entry?.field || "합성 자격 조건";
}

export function renderRagEvidenceContent(matches, { failed = false } = {}) {
  if (failed) {
    return `<span class="hint evidence-status evidence-error">문서 근거 검색 실패</span>`;
  }
  if (!Array.isArray(matches) || !matches.length) {
    return `<span class="hint evidence-status evidence-empty">관련 근거 없음</span>`;
  }
  return `<details><summary>근거 보기</summary>${matches.map((match) =>
    `<p>${esc(match.matchedText)}</p><p class="src">[출처: ${esc(match.source?.document_title)} · ${esc(match.source?.institution)}]</p>`
  ).join("")}</details>`;
}

function renderCandidates(items, selectedIds) {
  if (!items.length) return renderEmpty("현재 입력으로 추천 가능한 후보가 없습니다.");
  return `<div class="recommendation-grid">${items.map((item) => {
    const checked = selectedIds.has(item.product_id);
    const purpose = PURPOSE_LABEL[item.purpose] || item.purpose;
    const passedLabels = [...new Set((item.eligibilityEvidence || []).map(evidenceLabel))];
    const paths = (item.reasoningPath || []).map((step) =>
      `<li><code>${esc(step.from)}</code> —${esc(step.rel)}→ <code>${esc(step.to)}</code>
        <span class="hint">(${esc(step.basis)})</span></li>`).join("");
    const evidence = (item.eligibilityEvidence || []).map((entry) =>
      `<li><strong>${esc(evidenceLabel(entry))}</strong>
        ${renderSource(entry.source)}</li>`).join("");
    return `<article class="product-card candidate-card ${checked ? "selected" : ""}" data-id="${esc(item.product_id)}">
      <div class="candidate-heading">
        <div>
          <div class="cat">${esc(item.category)} · ${esc(purpose)}</div>
          <h4>${esc(item.name)}</h4>
        </div>
        <span class="eligibility-badge">자격 규칙 통과</span>
      </div>
      <div class="candidate-summary">
        <p><strong>추천 이유</strong><br>${esc(purpose)} 목적과 연결되고 공개용 합성 자격 규칙
          ${(item.passedRules || []).length}건을 통과한 상담 후보입니다.</p>
        <p><strong>확인된 자격</strong><br>${passedLabels.length
          ? esc(passedLabels.join(" · "))
          : "합성 규칙 통과 내역"}</p>
        <p><strong>주의사항</strong><br>${item.scope_note
          ? esc(item.scope_note)
          : "실제 한도·비용·심사 결과는 금융기관 담당자 확인이 필요합니다."}</p>
        <p><strong>다음 행동</strong><br>실제 조건은 금융기관에서 다시 확인하고 한도·비용·심사를 문의하세요.</p>
      </div>
      <label class="product-select">
        <input type="checkbox" class="prod-check" data-id="${esc(item.product_id)}" ${checked ? "checked" : ""}>
        상담 브리프에 이 후보 포함
      </label>
      <details class="decision-evidence-details">
        <summary>판정 근거 자세히 보기</summary>
        <div class="evidence-block rule-evidence">
          <h5>① 자격 규칙 근거</h5>
          <ul>${evidence}</ul>
        </div>
        <div class="evidence-block rag-evidence">
          <h5>② RAG 연결문서 근거</h5>
          <div class="rag-evidence-body evidence" data-id="${esc(item.product_id)}">
            <span class="hint evidence-status evidence-loading">근거 검색 중…</span>
          </div>
        </div>
        <div class="evidence-block ontology-evidence reasoningPath">
          <h5>③ 온톨로지 추론 경로</h5>
          <p class="hint">고객 입력에서 목적·위험·상품으로 이어진 판정 경로입니다.</p>
          <ol>${paths}</ol>
        </div>
      </details>
    </article>`;
  }).join("")}</div>`;
}

function renderExcluded(items) {
  if (!items.length) return renderEmpty("고객 입력으로 부적격 판정된 상품이 없습니다.");
  return `<div class="recommendation-grid">${items.map((item) => `<article class="product-card excluded-card">
    <div class="cat">${esc(item.category)}</div><strong>${esc(item.name)}</strong>
    <ul>${(item.failedRules || []).map((rule) =>
      `<li><strong>${esc(rule.rule_id)}</strong>: ${esc(rule.reason || "합성 자격 조건 미충족")}</li>`).join("")}</ul>
  </article>`).join("")}</div>`;
}

function renderPending(items) {
  if (!items.length) return renderEmpty("추가 확인이 필요한 상품이 없습니다.");
  return `<div class="recommendation-grid">${items.map((item) => `<article class="product-card pending-card">
    <div class="cat">${esc(item.category)}</div><strong>${esc(item.name)}</strong>
    ${item.scope_note ? `<p><strong>적용 범위</strong><br>${esc(item.scope_note)}</p>` : ""}
    <ul>${(item.questions || []).map((question) => `<li>${esc(question)}</li>`).join("")}</ul>
    ${item.source ? `<div class="pending-source"><strong>질문의 합성 규칙 기준</strong>${renderSource(item.source)}</div>` : ""}
  </article>`).join("")}</div>`;
}

function renderUnavailable(items) {
  if (!items.length) return renderEmpty("규칙정보 미확인 상품이 없습니다.");
  return `<div class="recommendation-grid">${items.map((item) => `<article class="product-card unavailable-card">
    <div class="cat">${esc(item.category)}</div><strong>${esc(item.name)}</strong>
    <p>${esc(item.reason)}</p>
    ${(item.knowledgeGaps || []).length
      ? `<ul>${item.knowledgeGaps.map((gap) =>
          `<li>${esc(gap.reason)}${gap.missing_info_question ? ` · ${esc(gap.missing_info_question)}` : ""}</li>`).join("")}</ul>`
      : ""}
  </article>`).join("")}</div>`;
}

export function renderRecommendationPanels(recommendation, selectedIds = new Set()) {
  const groups = recommendation && Array.isArray(recommendation.byPurpose)
    ? recommendation.byPurpose
    : [];
  if (!groups.length) {
    const questions = recommendation && Array.isArray(recommendation.questions)
      ? recommendation.questions
      : [];
    return `<div class="errors recommendation-error">
      <strong>추천 판정을 표시할 수 없습니다.</strong>
      ${questions.length ? `<ul>${questions.map((question) => `<li>${esc(question)}</li>`).join("")}</ul>` : ""}
    </div>`;
  }
  const selected = selectedIds instanceof Set ? selectedIds : new Set();
  const uniqueDecisions = (items) => [...new Map(items
    .filter(Boolean)
    .map((item) => [`${item.purpose || ""}:${item.product_id}`, item])).values()];
  const allCandidates = uniqueDecisions([
    ...(Array.isArray(recommendation.candidates) ? recommendation.candidates : []),
    ...groups.flatMap((group) => Array.isArray(group.candidates) ? group.candidates : []),
  ]);
  const allPending = uniqueDecisions([
    ...(Array.isArray(recommendation.pending) ? recommendation.pending : []),
    ...groups.flatMap((group) => Array.isArray(group.pending) ? group.pending : []),
  ]);
  const tabs = groups.map((group, index) =>
    `<button type="button" class="purpose-tab" role="tab" data-purpose="${esc(group.purpose)}"
      aria-selected="${index === 0 ? "true" : "false"}">${esc(PURPOSE_LABEL[group.purpose] || group.purpose)}</button>`).join("");
  const panels = groups.map((group, index) => `<section class="purpose-panel" role="tabpanel"
      data-purpose="${esc(group.purpose)}" ${index === 0 ? "" : "hidden"}>
    <h3>${esc(PURPOSE_LABEL[group.purpose] || group.purpose)}</h3>
    ${group.note ? `<p class="purpose-note">${esc(group.note)}</p>` : ""}
    <div class="decision-region candidate-region"><h4>추천 후보</h4>
      ${(group.candidates || []).length
        ? `<p>${(group.candidates || []).map((item) => esc(item.name)).join(", ")} · 상단 상담 후보 카드에서 선택·근거 확인</p>`
        : renderEmpty("이 목적에서 자격을 통과한 후보가 없습니다.")}</div>
    <div class="decision-region excluded-region"><h4>고객 부적격</h4>${renderExcluded(group.excluded || [])}</div>
    <div class="decision-region pending-region"><h4>정보 필요</h4>${renderPending(group.pending || [])}</div>
    <div class="decision-region unavailable-region"><h4>규칙정보 미확인</h4>${renderUnavailable(group.unavailable || [])}</div>
  </section>`).join("");
  return `<div class="candidate-showcase">
      <h3>상담 후보</h3>
      ${renderCandidates(allCandidates, selected)}
    </div>
    ${allPending.length ? `<div class="pending-showcase">
      <h3>정보 추가 시 검토 가능</h3>
      ${renderPending(allPending)}
    </div>` : ""}
    <details class="other-decisions">
      <summary>목적별 전체 판정 상태 보기</summary>
      <div class="purpose-tabs" role="tablist" aria-label="추천 목적">${tabs}</div>${panels}
    </details>`;
}

export function renderApp(root, deps) {
  const {
    source, exposure, scenario, agent, charts, diagnose, validate, brief,
    risk, strategy, counter, rag, profile, reasoner, privacy, audit, parseInput,
    createProvider, resolveMode,
  } = deps;
  // 기업정보·헤지·유동성은 명시 입력이며 새 분석에서는 모두 초기화한다.
  // data만 비동기 로딩 후 채우고, 이후 "새 분석 시작"에서도 같은 참조 데이터를 재사용한다.
  const state = createAnalysisState();
  let scenarioClassifier = null;

  root.innerHTML = `<section class="card"><p>데이터 로딩 중…</p></section>`;

  Promise.all([
    source.getFxRates(),
    source.getCountryCatalog(),
    source.getSamples(),
    source.getFxVol(),
    source.getProductDocs(),
    source.getProductEmbeddings(),
    source.getOntologySchema(),
    source.getKnowledgeGraph(),
    source.getEligibilityRules(),
    source.getSourceRegistry(),
    source.getScenarioIntents(),
    source.getScenarioIntentCorpus(),
    source.getScenarioIntentEmbeddings(),
    source.getEvaluationReport(),
    source.getMarketDataMeta(),
    source.getCountryIndicators(),
    source.getBilateralTrade(),
  ])
    .then(([fx, countryCatalog, samples, fxVol, productDocs, productEmbeddings, ontologySchema,
      knowledgeGraph, eligibilityRules, sourceRegistry, scenarioIntents,
      scenarioIntentCorpus, scenarioIntentEmbeddings, evaluation, marketDataMeta,
      countryIndicators, bilateralTrade]) => {
      state.data = {
        fx, countryCatalog, samples, fxVol, productDocs, productEmbeddings, ontologySchema,
        knowledgeGraph, eligibilityRules, sourceRegistry, scenarioIntents,
        scenarioIntentCorpus, scenarioIntentEmbeddings, evaluation, marketDataMeta,
        countryIndicators, bilateralTrade,
      };
      scenarioClassifier = createScenarioSemanticClassifier({
        corpus: scenarioIntentCorpus,
        embeddings: scenarioIntentEmbeddings,
      });
      render();
    })
    .catch((err) => {
      root.innerHTML = `<section class="card"><p>데이터 로드 실패: ${esc(err.message)}</p></section>`;
    });

  function readRowsFromDom() {
    const rowEls = [...root.querySelectorAll(".cf-row")];
    if (!rowEls.length) return;
    state.rows = rowEls.map((el) => ({
      country: el.querySelector(".f-country").value,
      currency: el.querySelector(".f-currency").value,
      tradeType: el.querySelector(".f-tradetype").value,
      direction: el.querySelector(".f-direction").value,
      amount: el.querySelector(".f-amount").value,
      months: el.querySelector(".f-months").value,
    }));
  }

  function readCompanyFromDom() {
    const val = (sel) => { const el = root.querySelector(sel); return el ? el.value : ""; };
    state.company.companyType = val("#company-type");
    state.company.companyScale = val("#company-scale");
    state.company.isSme = state.company.companyScale === "sme"
      ? "true"
      : state.company.companyScale ? "false" : "";
    state.company.riskAppetite = val("#risk-appetite");
    state.company.isManufacturer = val("#is-manufacturer");
    state.company.supplyChainProgramEligible = val("#supply-chain-program");
    state.company.partnerGuaranteeConfirmed = val("#partner-guarantee");
    state.company.creditGradeMeetsThreshold = val("#credit-grade-threshold");
    state.company.reviewChannelConfirmed = val("#review-channel-confirmed");
    state.company.priorYearExportUsd = val("#prior-year-export-usd");
    state.company.requestedPurposes = [...root.querySelectorAll(".purpose:checked")].map((el) => el.value);
  }

  function readHedgesFromDom() {
    if (state.hedgeMode !== "list") return;
    state.hedgeRows = [...root.querySelectorAll(".existing-hedge-row")].map((el) => ({
      currency: el.querySelector(".hedge-currency").value,
      amount: el.querySelector(".hedge-amount").value,
      maturityMonths: el.querySelector(".hedge-maturity").value,
      instrumentType: el.querySelector(".hedge-instrument").value,
    }));
  }

  function readImportFromDom() {
    const draft = root.querySelector("#cashflow-paste");
    const format = root.querySelector("#cashflow-format");
    if (draft) state.importDraft = draft.value;
    if (format) state.importFormat = format.value;
  }

  // 재렌더 전에 화면의 모든 입력을 state로 읽어 사용자 입력이 사라지지 않게 한다.
  function readAllInputs() {
    readRowsFromDom();
    readCompanyFromDom();
    readHedgesFromDom();
    readImportFromDom();
    state.liquidityRaw = readLiquidityRaw();
  }

  // DOM에서 읽은 원문(문자열). 검증 전에는 state에 확정값으로 넣지 않는다.
  function readLiquidityRaw() {
    const val = (sel) => {
      const el = root.querySelector(sel);
      return el ? el.value : "";
    };
    return { openingBalanceKrw: val("#opening-balance"), creditLineKrw: val("#credit-line") };
  }

  function render() {
    if (state.screen === "input") renderInput();
    else if (state.screen === "confirm") renderConfirm();
    else if (state.screen === "brief") renderBrief();
    else renderResults();
  }

  // ---------- Screen 1: 입력 ----------
  function hedgeStateLabel() {
    if (state.hedgeMode === "none") return "✅ 기존 헤지 없음으로 확정됨.";
    if (state.hedgeMode === "list") return `기존 헤지 ${state.hedgeRows.length}건 입력 중.`;
    return "⚠️ 아직 모름 — 헤지를 추가하거나 '없음'을 확정해 주세요(비워두면 질문합니다).";
  }

  function hedgeRowHtml(h, i) {
    const currencies = Object.keys(state.data.fx.rates);
    return `<div class="existing-hedge-row" data-i="${i}">
      <select class="hedge-currency"><option value="">통화</option>
        ${currencies.map((c) => `<option value="${c}" ${h.currency === c ? "selected" : ""}>${c}</option>`).join("")}
      </select>
      <input class="hedge-amount" type="number" min="0" step="1000" placeholder="금액" value="${esc(h.amount ?? "")}">
      <input class="hedge-maturity" type="number" min="0" step="1" placeholder="만기(개월)" value="${esc(h.maturityMonths ?? "")}">
      <select class="hedge-instrument">
        ${["forward", "option", "swap", "기타"].map((t) => `<option value="${t}" ${h.instrumentType === t ? "selected" : ""}>${t}</option>`).join("")}
      </select>
      <button class="hedge-del" data-i="${i}" title="이 헤지 삭제">✕</button>
    </div>`;
  }

  // errors = 값이 잘못된 입력 오류, questions = 아직 확정되지 않은 정보에 대한 질문.
  // 같은 문장이 두 번 보이지 않도록 각각 중복 제거하고, 질문에 이미 있는 문장은 오류에서 뺀다.
  // issues: [{ section, kind: "error"|"question", text }] — 각 메시지를 해당 입력 칸 옆에 배치한다.
  // T30c: systemAlert.html is a pre-rendered role="alert" panel for SYSTEM problems (e.g. a
  // market-data outage). It is rendered separately from user-input errors so that "입력을 확인해
  // 주세요 (N건) / 입력값 오류" — which only make sense for user typos — is not shown.
  function renderInput(issues = [], _questionsIgnored = [], systemAlert = null) {
    const norm = (Array.isArray(issues) ? issues : []).filter((x) => x && x.text);
    const sectionBlock = (section) => {
      const questions = [...new Set(norm.filter((x) => x.section === section && x.kind === "question").map((x) => x.text))];
      const errors = [...new Set(norm.filter((x) => x.section === section && x.kind !== "question").map((x) => x.text))];
      if (!questions.length && !errors.length) return "";
      return `<div class="field-issues">
        ${questions.length ? `<div class="errors"><strong>확인이 필요한 정보</strong>
          ${questions.map((q) => `<div>• ${esc(q)}</div>`).join("")}</div>` : ""}
        ${errors.length ? `<div class="errors"><strong>입력값 오류</strong>
          ${errors.map((e) => `<div>• ${esc(e)}</div>`).join("")}</div>` : ""}
      </div>`;
    };
    const systemAlertHtml = systemAlert && typeof systemAlert.html === "string" ? systemAlert.html : "";
    const issueSummary = norm.length
      ? `<div class="errors input-issue-summary" role="alert"><strong>입력을 확인해 주세요 (${norm.length}건)</strong>
          <div class="hint">아래 빨간색으로 표시된 항목을 확인·선택한 뒤 다시 [분석하기]를 눌러 주세요.</div></div>`
      : "";
    const { fx, countryCatalog, samples } = state.data;
    const showEligibilityQuestions = shouldShowEligibilityQuestions(state.company.requestedPurposes);
    const eligibilityGuide = !state.company.requestedPurposes.length
      ? "지원 목적을 선택하면 필요한 추가 자격 질문을 표시합니다."
      : showEligibilityQuestions
        ? "공개용 합성 운전자금 규칙에 필요한 항목입니다. 모르면 확인 필요로 두세요."
        : "선택한 목적은 거래·기업 정보로 우선 판정합니다. 현재 추가 자격 질문은 없습니다.";
    const currencies = Object.keys(fx.rates);
    const countries = Object.entries(countryCatalog.countries)
      .sort(([, a], [, b]) => String(a.name).localeCompare(String(b.name), "ko"));
    const importNoticeHtml = state.importNotice
      ? `<div class="import-notice ${state.importNotice.kind === "error" ? "errors" : "loaded-note"}"
          role="${state.importNotice.kind === "error" ? "alert" : "status"}">
          <strong>${esc(state.importNotice.title)}</strong>
          ${state.importNotice.messages?.length
            ? `<ul>${state.importNotice.messages.map((message) => `<li>${esc(message)}</li>`).join("")}</ul>`
            : ""}
        </div>`
      : "";

    const rowHtml = (row, i) => `
      <tr class="cf-row" data-i="${i}">
        <td><select class="f-country" aria-label="${i + 1}행 거래국"><option value="">거래국</option>
          ${countries.map(([iso, c]) => `<option value="${iso}" ${row.country === iso ? "selected" : ""}>${esc(countryOptionLabel(iso, c))}</option>`).join("")}
        </select></td>
        <td><select class="f-currency" aria-label="${i + 1}행 통화"><option value="">통화</option>
          ${currencies.map((c) => `<option value="${c}" ${row.currency === c ? "selected" : ""}>${c}</option>`).join("")}
        </select></td>
        <td><select class="f-tradetype" aria-label="${i + 1}행 수출·수입 구분"><option value="">수출/수입</option>
          <option value="export" ${row.tradeType === "export" ? "selected" : ""}>수출</option>
          <option value="import" ${row.tradeType === "import" ? "selected" : ""}>수입</option>
        </select></td>
        <td><select class="f-direction" aria-label="${i + 1}행 수취·지급 구분">
          <option value="in" ${row.direction === "in" ? "selected" : ""}>수취(받음)</option>
          <option value="out" ${row.direction === "out" ? "selected" : ""}>지급(냄)</option>
        </select></td>
        <td><input class="f-amount" type="number" min="0" step="1000" placeholder="금액" value="${esc(row.amount)}" aria-label="${i + 1}행 외화 금액"></td>
        <td><input class="f-months" type="number" min="0" step="1" placeholder="개월" value="${esc(row.months)}" aria-label="${i + 1}행 결제 시점(개월)"></td>
        <td><button class="row-del" data-i="${i}" title="이 행 삭제" aria-label="${i + 1}행 거래 삭제">✕</button></td>
      </tr>`;

    root.innerHTML = `
      ${disclaimerBanner()}
      ${systemAlertHtml}
      ${issueSummary}
      ${sectionBlock("general")}
      <section class="card">
        <h2 class="step-title">샘플 거래 불러오기 <span class="hint">(선택)</span></h2>
        <p class="hint">실제 문서 업로드·자동 인식 기능은 현재 구현되어 있지 않습니다. 아래 예시 데이터를 불러와 입력 흐름을 확인할 수 있습니다.</p>
        <div class="sample-btns">
          ${samples.map((s) => `<button class="sample-btn btn-ghost" data-id="${s.id}">📄 ${esc(s.title)}</button>`).join("")}
        </div>
        ${state.loadedSample ? `<p class="loaded-note">📄 <strong>${esc(state.loadedSample)}</strong> 샘플 데이터를 불러왔습니다. 확인 후 수정하세요.</p>` : ""}
      </section>

      <details class="card import-card"${state.importDraft ? " open" : ""}>
        <summary class="step-title">CSV/JSON 거래 불러오기 <span class="hint">(선택 — 대량 입력용, 펼치기)</span></summary>
        <p class="hint">넣는 데이터는 <strong>외화 수취/지급 거래(cashflow)</strong>입니다. 불러온 뒤 <strong>사용자가 표에서 확인·수정</strong>하고 분석하며, 형식이 어긋나면 행별 오류를 표시하고 분석하지 않습니다. 임의 형식은 지원하지 않습니다(최대 500건).</p>
        <div class="import-legend">
          <p class="hint"><strong>CSV 헤더(정확히 이 순서)</strong>: <code>country,currency,tradeType,direction,amount,months</code></p>
          <ul class="hint">
            <li><code>country</code> 거래국 코드 — 선택 목록 괄호 안의 ISO 2자리 코드 (${countries.length}개)</li>
            <li><code>currency</code> 통화 — ${currencies.join("·")} <em>(${currencies.length}개 공식 캐시 계산 지원)</em></li>
            <li>‘현지통화 미지원’ 국가는 USD 등 실제 계약의 지원 결제통화를 직접 선택해야 합니다.</li>
            <li><code>tradeType</code> <code>export</code>(수출) / <code>import</code>(수입)</li>
            <li><code>direction</code> <code>in</code>(수취) / <code>out</code>(지급)</li>
            <li><code>amount</code> 0보다 큰 숫자 · <code>months</code> 0 이상 정수(개월)</li>
          </ul>
          <details class="import-example">
            <summary class="hint">예시 보기 (CSV · JSON)</summary>
<pre>CSV
country,currency,tradeType,direction,amount,months
US,USD,export,in,300000,3
DE,EUR,import,out,80000,4

JSON
[
  { "country": "US", "currency": "USD", "tradeType": "export", "direction": "in", "amount": 300000, "months": 3 },
  { "country": "DE", "currency": "EUR", "tradeType": "import", "direction": "out", "amount": 80000, "months": 4 }
]</pre>
          </details>
        </div>
        <div class="import-grid">
          <label class="file-import">CSV/JSON 파일
            <input id="cashflow-file" type="file" accept=".csv,.json,text/csv,application/json">
          </label>
          <label>붙여넣기 형식
            <select id="cashflow-format">
              <option value="csv" ${state.importFormat === "csv" ? "selected" : ""}>CSV</option>
              <option value="json" ${state.importFormat === "json" ? "selected" : ""}>JSON</option>
            </select>
          </label>
        </div>
        <textarea id="cashflow-paste" rows="6"
          placeholder="예) CSV: country,currency,tradeType,direction,amount,months / US,USD,export,in,300000,3">${esc(state.importDraft)}</textarea>
        <div class="row-actions">
          <button id="import-cashflows" type="button" class="btn-ghost">붙여넣기 내용 불러오기</button>
        </div>
        ${importNoticeHtml}
      </details>

      <section class="card">
        <h2 class="step-title">거래 정보</h2>
        <p class="hint"><strong>받을 외화(수취)</strong>와 <strong>낼 외화(지급)</strong>를 통화·금액·시점(개월)으로 입력하세요.</p>
        ${sectionBlock("transactions")}
        <div class="table-wrap">
          <table class="cf-table">
            <thead><tr><th>거래국</th><th>통화</th><th>수출/수입</th><th>구분</th><th>금액</th><th>시점(개월)</th><th></th></tr></thead>
            <tbody>${state.rows.map(rowHtml).join("")}</tbody>
          </table>
        </div>
        <div class="row-actions">
          <button id="add-row" class="btn-ghost">+ 거래 추가</button>
        </div>
      </section>

      <section class="card">
        <h2 class="step-title">기업 정보 <span class="hint">(추정하지 않습니다 — 직접 선택)</span></h2>
        ${sectionBlock("company")}
        <div class="company-grid">
          <label>기업 형태
            <select id="company-type">
              <option value="">선택</option>
              <option value="corporation" ${state.company.companyType === "corporation" ? "selected" : ""}>법인</option>
              <option value="sole_proprietor" ${state.company.companyType === "sole_proprietor" ? "selected" : ""}>개인사업자</option>
            </select></label>
          <label>기업 규모
            <select id="company-scale">
              <option value="">선택</option>
              <option value="sme" ${state.company.companyScale === "sme" || (!state.company.companyScale && state.company.isSme === "true") ? "selected" : ""}>중소기업</option>
              <option value="mid_market" ${state.company.companyScale === "mid_market" ? "selected" : ""}>중견기업</option>
              <option value="other" ${state.company.companyScale === "other" ? "selected" : ""}>그 외</option>
            </select></label>
          <label>위험성향
            <select id="risk-appetite">
              <option value="">선택</option>
              <option value="low" ${state.company.riskAppetite === "low" ? "selected" : ""}>안정</option>
              <option value="medium" ${state.company.riskAppetite === "medium" ? "selected" : ""}>중립</option>
              <option value="high" ${state.company.riskAppetite === "high" ? "selected" : ""}>공격</option>
            </select></label>
        </div>
        <fieldset class="purposes">
          <legend>지원 목적 <span class="hint">(복수 선택 — 추천은 선택한 목적만 대상으로 합니다)</span></legend>
          ${PURPOSES.map(([v, label]) => `<label><input type="checkbox" class="purpose" value="${v}" ${state.company.requestedPurposes.includes(v) ? "checked" : ""}> ${label}</label>`).join("")}
        </fieldset>
        <p class="eligibility-guide hint" role="status">${eligibilityGuide}</p>
        <div class="eligibility-inputs" ${showEligibilityQuestions ? "" : "hidden"}>
          <h3 class="step-title">상품 자격 확인 정보</h3>
          <p class="hint">확인하지 못한 항목은 <strong>모름·확인 필요</strong>로 두세요. 모름을 자격 충족으로 추정하지 않으며, 공개본의 항목은 모두 합성 규칙입니다.</p>
          <div class="company-grid">
            <label>제조기업 여부
              <select id="is-manufacturer">
                <option value="" ${state.company.isManufacturer === "" ? "selected" : ""}>모름·확인 필요</option>
                <option value="true" ${state.company.isManufacturer === "true" ? "selected" : ""}>예</option>
                <option value="false" ${state.company.isManufacturer === "false" ? "selected" : ""}>아니오</option>
              </select></label>
            <label>데모 지정 공급망 업종 해당 여부
              <select id="supply-chain-program">
                <option value="" ${state.company.supplyChainProgramEligible === "" ? "selected" : ""}>모름·확인 필요</option>
                <option value="true" ${state.company.supplyChainProgramEligible === "true" ? "selected" : ""}>해당</option>
                <option value="false" ${state.company.supplyChainProgramEligible === "false" ? "selected" : ""}>해당하지 않음</option>
              </select></label>
            <label>데모 제휴보증 확인 여부
              <select id="partner-guarantee">
                <option value="" ${state.company.partnerGuaranteeConfirmed === "" ? "selected" : ""}>모름·확인 필요</option>
                <option value="true" ${state.company.partnerGuaranteeConfirmed === "true" ? "selected" : ""}>가능 확인</option>
                <option value="false" ${state.company.partnerGuaranteeConfirmed === "false" ? "selected" : ""}>불가 확인</option>
              </select></label>
            <label>합성 내부등급 기준 충족 여부
              <select id="credit-grade-threshold">
                <option value="" ${state.company.creditGradeMeetsThreshold === "" ? "selected" : ""}>모름·확인 필요</option>
                <option value="true" ${state.company.creditGradeMeetsThreshold === "true" ? "selected" : ""}>기준 이상 확인</option>
                <option value="false" ${state.company.creditGradeMeetsThreshold === "false" ? "selected" : ""}>기준 미달 확인</option>
              </select></label>
            <label>상담채널 사전확인 여부
              <select id="review-channel-confirmed">
                <option value="" ${state.company.reviewChannelConfirmed === "" ? "selected" : ""}>모름·확인 필요</option>
                <option value="true" ${state.company.reviewChannelConfirmed === "true" ? "selected" : ""}>추천 확인</option>
                <option value="false" ${state.company.reviewChannelConfirmed === "false" ? "selected" : ""}>추천 대상 아님 확인</option>
              </select></label>
            <label>최근 1년 수출실적 (USD, 선택)
              <input id="prior-year-export-usd" type="number" min="0" step="1000" placeholder="모르면 비워두기" value="${esc(state.company.priorYearExportUsd)}">
            </label>
          </div>
        </div>
      </section>

      <section class="card">
        <h2 class="step-title">기존 헤지 <span class="hint">(있으면 통화·금액·만기 입력, 없으면 '없음' 확정)</span></h2>
        ${sectionBlock("hedge")}
        <p class="hint" id="hedge-state">${hedgeStateLabel()}</p>
        <div id="hedge-rows">${state.hedgeMode === "list" ? state.hedgeRows.map(hedgeRowHtml).join("") : ""}</div>
        <div class="row-actions">
          <button id="hedge-add" class="btn-ghost">+ 헤지 추가</button>
          <button id="hedge-none" class="btn-ghost">기존 헤지 없음으로 확정</button>
        </div>
      </section>

      <section class="card">
        <h2 class="step-title">유동성 완충 <span class="hint">(선택 — 비워두면 0)</span></h2>
        ${sectionBlock("liquidity")}
        <p class="hint">지급 시점에 쓸 수 있는 <strong>기초 현금잔고</strong>와 <strong>사용 가능한 신용한도</strong>입니다. 부족액은 이 둘을 모두 쓴 뒤에도 모자라는 금액으로 계산됩니다.</p>
        <div class="buffer-grid">
          <label>기초 현금잔고 (원)
            <input id="opening-balance" type="number" min="0" step="1000000" placeholder="0" value="${esc(state.liquidityRaw.openingBalanceKrw)}">
          </label>
          <label>사용 가능 신용한도 (원)
            <input id="credit-line" type="number" min="0" step="1000000" placeholder="0" value="${esc(state.liquidityRaw.creditLineKrw)}">
          </label>
        </div>
        <button id="analyze" class="btn-primary">분석하기 →</button>
      </section>`;

    // 검증에 걸린 첫 항목으로 스크롤해 사용자가 어디를 고쳐야 하는지 바로 보이게 한다.
    if (norm.length) {
      const firstIssue = root.querySelector(".field-issues") || root.querySelector(".input-issue-summary");
      firstIssue?.scrollIntoView({ behavior: "smooth", block: "center" });
    }

    root.querySelectorAll(".sample-btn").forEach((b) =>
      b.addEventListener("click", () => {
        readAllInputs();
        const s = state.data.samples.find((x) => x.id === b.dataset.id);
        if (!s) return;
        state.rows = s.cashflows.map((r) => ({ ...r }));
        state.loadedSample = s.title;
        state.importNotice = null;
        render();
      })
    );

    function applyImportedText(text, format, sourceLabel) {
      const result = parseInput.parseCashflowsText(text, format);
      if (!result.ok) {
        state.importNotice = {
          kind: "error",
          title: `${sourceLabel} 데이터를 불러오지 못했습니다.`,
          messages: result.errors,
        };
        renderInput();
        return;
      }
      const catalogErrors = result.rows.flatMap((row, index) => {
        const errors = [];
        if (!Object.hasOwn(state.data.countryCatalog.countries, row.country)) {
          errors.push(`${index + 1}행: 현재 데모에서 지원하지 않는 거래국입니다.`);
        }
        if (!Object.hasOwn(state.data.fx.rates, row.currency)) {
          errors.push(`${index + 1}행: 현재 데모에서 환율을 제공하지 않는 통화입니다.`);
        }
        return errors;
      });
      if (catalogErrors.length) {
        state.importNotice = {
          kind: "error",
          title: `${sourceLabel} 데이터를 불러오지 못했습니다.`,
          messages: catalogErrors,
        };
        renderInput();
        return;
      }
      state.rows = result.rows.map((row) => ({ ...row }));
      state.loadedSample = null;
      state.importNotice = {
        kind: "success",
        title: `${sourceLabel} 거래 ${result.rows.length}건을 불러왔습니다. 표에서 확인·수정하세요.`,
        messages: [],
      };
      render();
    }

    root.querySelector("#import-cashflows").addEventListener("click", () => {
      readAllInputs();
      applyImportedText(state.importDraft, state.importFormat, "붙여넣기");
    });

    root.querySelector("#cashflow-file").addEventListener("change", async (event) => {
      readAllInputs();
      const file = event.target.files?.[0];
      if (!file) return;
      const lowerName = file.name.toLowerCase();
      const format = lowerName.endsWith(".csv")
        ? "csv"
        : lowerName.endsWith(".json")
          ? "json"
          : null;
      if (!format) {
        state.importNotice = {
          kind: "error",
          title: "파일을 불러오지 못했습니다.",
          messages: ["확장자가 .csv 또는 .json인 파일만 사용할 수 있습니다."],
        };
        renderInput();
        return;
      }
      if (file.size > parseInput.MAX_INPUT_BYTES) {
        state.importNotice = {
          kind: "error",
          title: "파일을 불러오지 못했습니다.",
          messages: [`입력 파일은 ${parseInput.MAX_INPUT_BYTES / 1024}KB 이하여야 합니다.`],
        };
        renderInput();
        return;
      }
      try {
        const text = await file.text();
        state.importDraft = text;
        state.importFormat = format;
        applyImportedText(text, format, file.name);
      } catch {
        state.importNotice = {
          kind: "error",
          title: "파일을 불러오지 못했습니다.",
          messages: ["파일을 읽는 중 오류가 발생했습니다."],
        };
        renderInput();
      }
    });

    root.querySelector("#add-row").addEventListener("click", () => {
      readAllInputs();
      state.rows.push(emptyRow());
      render();
    });
    root.querySelector("#hedge-add").addEventListener("click", () => {
      readAllInputs();
      state.hedgeMode = "list";
      state.hedgeRows.push({ currency: "", amount: "", maturityMonths: "", instrumentType: "forward" });
      render();
    });
    root.querySelector("#hedge-none").addEventListener("click", () => {
      readAllInputs();
      state.hedgeMode = "none";
      state.hedgeRows = [];
      render();
    });
    root.querySelectorAll(".hedge-del").forEach((b) =>
      b.addEventListener("click", () => {
        readAllInputs();
        state.hedgeRows.splice(Number(b.dataset.i), 1);
        if (!state.hedgeRows.length) state.hedgeMode = "unknown";
        render();
      })
    );
    root.querySelectorAll(".row-del").forEach((b) =>
      b.addEventListener("click", () => {
        readAllInputs();
        state.rows.splice(Number(b.dataset.i), 1);
        if (!state.rows.length) state.rows.push(emptyRow());
        render();
      })
    );
    root.querySelectorAll(".f-country").forEach((countrySelect) =>
      countrySelect.addEventListener("change", () => {
        const row = countrySelect.closest(".cf-row");
        const currencySelect = row?.querySelector(".f-currency");
        if (!currencySelect || currencySelect.value) return;
        const country = state.data.countryCatalog.countries[countrySelect.value];
        const suggested = suggestedCurrencyForCountry(country, state.data.fx.rates);
        if (suggested) currencySelect.value = suggested;
      })
    );
    root.querySelectorAll(".purpose").forEach((purposeInput) =>
      purposeInput.addEventListener("change", () => {
        readAllInputs();
        renderInput();
      })
    );
    root.querySelector("#analyze").addEventListener("click", () => {
      readAllInputs();
      // T30b/T30c: fail-closed BEFORE any financial computation if the market-data snapshot
      // cannot be verified. Because a market-data outage is a SYSTEM problem — not a user typo —
      // route it through renderMarketDataAlert (a dedicated role="alert" panel), NOT the user-
      // input-error UI ("입력을 확인해 주세요 / 입력값 오류"). Same judgement drives the badge.
      const marketGate = validateMarketDataForAnalysis(state.data.marketDataMeta);
      if (!marketGate.ok) {
        state.profile = null;                                     // stale results are not reused
        renderInput([], [], { html: renderMarketDataAlert() });
        return;
      }
      const cf = validate.validateCashflows(state.rows);
      const lq = validate.validateLiquidity(state.liquidityRaw);
      // 기존 헤지: 미완성 행을 조용히 버리지 않고 행 번호별 오류로 차단한다(원문은 state에 유지).
      const hedges = validate.validateExistingHedges({ mode: state.hedgeMode, rows: state.hedgeRows });
      // 잘못된 값이 확인 화면에 "확정값"으로 넘어가지 않도록 여기서 막는다.
      if (!cf.ok || !lq.ok || !hedges.ok)
        return renderInput([
          ...cf.errors.map((text) => ({ section: "transactions", kind: "error", text })),
          ...lq.errors.map((text) => ({ section: "liquidity", kind: "error", text })),
          ...hedges.errors.map((e) => ({ section: "hedge", kind: "error", text: e.message })),
        ]);

      let companyInput;
      let prof;
      try {
        companyInput = buildCompanyInputFromState(state.company, hedges.value);
        // 온톨로지 프로파일 생성. 시장데이터(환율) 누락은 여기서 fail-closed로 던진다.
        prof = profile.buildProfile({ cashflows: cf.normalized, rates: state.data.fx.rates, company: companyInput });
      } catch (err) {
        if (err instanceof CalculationError) return renderInput([{ section: "general", kind: "error", text: `${errorTitle(err)}: ${err.message}` }]);
        throw err;
      }
      // 스키마 제약까지 실제로 검증 — 누락(missingFacts)뿐 아니라 잘못된 값(violations)도 차단.
      const check = reasoner.validateProfile(prof, state.data.ontologySchema);
      if (!check.conforms)
        return renderInput([
          ...check.violations.map((v) => ({ section: sectionForPath(v.path), kind: "error", text: `${v.path}: ${v.message}` })),
          ...check.missingFacts.map((m) => ({ section: sectionForPath(m.factPath), kind: "question", text: m.question })),
        ]);

      state.liquidity = lq.normalized;
      state.cashflows = cf.normalized;
      state.company = { ...state.company, resolved: companyInput };
      state.profile = prof;
      state.selected = null; // reset selection for a fresh analysis
      state.screen = "confirm";
      render();
    });
  }

  // ---------- Screen 2: 확인 ----------
  function renderConfirm() {
    const { countryCatalog } = state.data;
    // 확인 화면 라벨 매핑 — 사용자 확정값을 그대로 되읽어 표시(중소기업/법인/위험성향/기존 헤지 만기 포함).
    const COMPANY_TYPE_LABEL = { corporation: "법인", sole_proprietor: "개인사업자" };
    const SCALE_LABEL = { sme: "중소기업", mid_market: "중견기업", other: "그 외" };
    const APPETITE_LABEL = { low: "안정", medium: "중립", high: "공격" };
    const PURPOSE_LABEL = Object.fromEntries(PURPOSES);
    const FACT_STATUS = { true: "충족 확인", false: "미충족 확인" };
    const companyConfirm = () => {
      const c = (state.company && state.company.resolved) || {};
      const items = [];
      items.push(`<li>기업 형태: <strong>${COMPANY_TYPE_LABEL[c.companyType] || "-"}</strong></li>`);
      items.push(`<li>기업 규모: <strong>${SCALE_LABEL[c.companyScale] || "확인 필요"}</strong></li>`);
      items.push(`<li>위험성향: <strong>${APPETITE_LABEL[c.riskAppetite] || "-"}</strong></li>`);
      const purposes = (c.requestedPurposes || []).map((p) => PURPOSE_LABEL[p] || p).join(", ") || "-";
      items.push(`<li>지원 목적: <strong>${esc(purposes)}</strong></li>`);
      for (const [field, label] of [
        ["isManufacturer", "제조기업 여부"],
        ["supplyChainProgramEligible", "데모 지정 공급망 업종 여부"],
        ["partnerGuaranteeConfirmed", "데모 제휴보증 확인 여부"],
        ["creditGradeMeetsThreshold", "합성 내부등급 기준 충족 여부"],
        ["reviewChannelConfirmed", "상담채널 사전확인 여부"],
      ]) items.push(`<li>${label}: <strong>${FACT_STATUS[String(c[field])] || "확인 필요"}</strong></li>`);
      items.push(`<li>최근 1년 수출실적: <strong>${Number.isFinite(c.priorYearExportUsd)
        ? `USD ${c.priorYearExportUsd.toLocaleString("ko-KR")}`
        : "확인 필요"}</strong></li>`);
      // 기존 헤지: 각 헤지의 통화·금액·만기(maturityMonths) 표시, 없으면 "기존 헤지 없음"
      const hedges = c.existingHedges;
      if (Array.isArray(hedges) && hedges.length) {
        const detail = hedges.map((h) => `${esc(h.currency)} ${Number(h.amount).toLocaleString()} · 만기 ${h.maturityMonths}개월${h.instrumentType ? ` · ${esc(h.instrumentType)}` : ""}`).join(" / ");
        items.push(`<li>기존 헤지: <strong>${detail}</strong></li>`);
      } else {
        items.push(`<li>기존 헤지: <strong>기존 헤지 없음</strong> <span class="hint">(없음으로 확정)</span></li>`);
      }
      return items.join("");
    };
    const rows = state.cashflows
      .map((c) => {
        const ctry = countryCatalog.countries[c.country];
        // 수출/수입(tradeType)과 수취/지급(direction)은 서로 다른 축이므로 둘 다 표시한다.
        return `<li>${esc(ctry ? ctry.name : c.country)} · <strong>${c.currency}</strong>
          · <strong>${esc(TRADE_TYPE_LABEL[c.tradeType] || "수출/수입 미선택")}</strong> · ${DIRECTION_LABEL[c.direction]}
          · ${c.amount.toLocaleString()} · ${c.months}개월 후</li>`;
      })
      .join("");

    root.innerHTML = `
      ${disclaimerBanner()}
      <section class="card">
        <h2 class="step-title">입력 내용 확인</h2>
        <p class="hint">분석 전에 입력값을 확인해주세요. (거버넌스: 금액·통화·시점·기업 정보·상품 자격 확인 정보·유동성 완충은 사용자가 직접 확정합니다)</p>
        <ul class="confirm-list">${rows}</ul>
        <h3 class="step-title">기업 정보</h3>
        <ul class="confirm-list">${companyConfirm()}</ul>
        <h3 class="step-title">유동성 완충</h3>
        <ul class="confirm-list">
          <li>기초 현금잔고: <strong>${scenario.formatKRW(state.liquidity.openingBalanceKrw)}</strong></li>
          <li>사용 가능 신용한도: <strong>${scenario.formatKRW(state.liquidity.creditLineKrw)}</strong></li>
          <li>유동성 완충 합계: <strong>${scenario.formatKRW(state.liquidity.openingBalanceKrw + state.liquidity.creditLineKrw)}</strong>
            ${state.liquidity.openingBalanceKrw + state.liquidity.creditLineKrw === 0 ? '<span class="hint">(입력하지 않아 0으로 확정됩니다)</span>' : ""}</li>
        </ul>
        <div class="row-actions">
          <button id="back-input" class="btn-ghost">← 수정하기</button>
          <button id="run" class="btn-primary">이 내용으로 분석 실행 →</button>
        </div>
      </section>`;

    root.querySelector("#back-input").addEventListener("click", () => { state.screen = "input"; render(); });
    root.querySelector("#run").addEventListener("click", () => { state.screen = "results"; render(); });
  }

  // ---------- Screen 3: 결과 ----------
  // 시장데이터·입력이 부족하면 0으로 채운 결과를 보여주지 않고 계산 불가를 표시한다(fail-closed).
  function renderResults() {
    try {
      renderResultsInner();
    } catch (err) {
      if (err instanceof CalculationError) return renderCalcError(err);
      throw err;
    }
  }

  function renderCalcError(err) {
    root.innerHTML = `
      ${disclaimerBanner()}
      <section class="card">
        <h2 class="step-title">계산할 수 없습니다</h2>
        <div class="errors">
          <div><strong>${esc(errorTitle(err))}.</strong></div>
          <div>사유: ${esc(err.message)} <span class="hint">(코드 ${esc(err.code)})</span></div>
        </div>
        <p class="hint">위험을 0으로 표시하지 않습니다. 위 사유를 확인한 뒤 다시 시도하세요.</p>
        <div class="row-actions">
          <button id="back-input" class="btn-primary">← 입력 수정하기</button>
        </div>
      </section>`;
    root.querySelector("#back-input").addEventListener("click", () => { state.screen = "input"; render(); });
  }

  function renderResultsInner() {
    const { fx, countryCatalog } = state.data;
    const cashflows = state.cashflows;
    const netRows = exposure.computeNetExposure(cashflows);
    const scenarios = scenario.simulateScenarios(netRows, fx.rates);

    const isoOrder = [...new Set(cashflows.map((c) => c.country))];
    const involved = isoOrder.map((iso) => countryCatalog.countries[iso]).filter(Boolean);
    const countryIndicators = buildCountryIntelligence(isoOrder, state.data.countryIndicators);
    const bilateralTrade = buildBilateralTradeIntelligence(isoOrder, state.data.bilateralTrade);
    const countryMonitoring = buildCountryMonitoring({
      cashflows,
      rates: fx.rates,
      countries: countryCatalog.countries,
      intelligence: countryIndicators,
    });

    // ---- CFaR / 전략 비교 / 자기반례 / 폐쇄형 온톨로지 추천 ----
    const annualVol = state.data.fxVol.annual_vol;
    const cfarBuckets = risk.computeCFaRBuckets(cashflows, fx.rates, annualVol, {});
    const cfarPortfolio = risk.portfolioCFaR(cfarBuckets);
    const cfarTotal = cfarPortfolio.total;
    // 전략은 모든 버킷을 동일 헤지율로 방어하므로 헤지 명목도 버킷 합계 기준이다.
    const notionalKrw = risk.bucketNotionalKrw(cfarBuckets);
    const strategies = strategy.compareStrategies(cfarTotal, notionalKrw);
    const counters = counter.ruleCounterExamples(strategies);
    const liquidityRows = risk.liquidityTimeline(cashflows, fx.rates, state.liquidity);
    const shortfalls = liquidityRows.filter((t) => t.shortfallKrw > 0);
    const bufferKrw = state.liquidity.openingBalanceKrw + state.liquidity.creditLineKrw;
    const recommendation = reasoner.recommend({
      profile: state.profile,
      graph: state.data.knowledgeGraph,
      rules: state.data.eligibilityRules,
      sources: state.data.sourceRegistry,
      schema: state.data.ontologySchema,
      today: fx.as_of,
    });
    const candidates = recommendation.candidates || [];
    const executiveSummary = buildExecutiveSummary({
      netRows,
      rates: fx.rates,
      scenarios,
      cfarTotal,
      strategies,
      candidates,
      shortfalls,
    });
    const actionPlan = buildActionPlan({
      executiveSummary,
      candidates,
      pending: recommendation.pending || [],
      shortfalls,
    });
    let latestEvidence = []; // populated asynchronously by loadEvidence()

    if (state.selected === null) {
      // 점수·순위 없이 자격을 통과한 후보만 상담 대상으로 기본 선택한다.
      state.selected = new Set(candidates.map((candidate) => candidate.product_id));
    }

    // Governance: analysis is de-identified aggregates only — raw cashflow rows
    // (transaction amounts/counterparties) are NOT included and never leave the browser.
    // (Task 8 replaces the AI button with the full provider + approval + audit flow.)
    const analysis = {
      netRows,
      // 만기별 관리대상을 진단이 알 수 있게 전달 — 통화 순노출만으로 자연헤지를 단정하지 않기 위함
      buckets: cfarBuckets.map((b) => ({ currency: b.currency, months: b.months, netAtMaturity: b.netAtMaturity })),
      scenarios: scenarios.map((s) => ({ delta: s.delta, totalPnl: Math.round(s.totalPnl) })),
      countries: countryMonitoring,
      products: candidates.map((candidate) => ({ category: candidate.category, name: candidate.name })),
    };
    const ruleText = diagnose.diagnose(analysis);
    const summaryRiskHtml = executiveSummary.largestRisk
      ? `<p class="summary-primary">
          <strong>${esc(executiveSummary.largestRisk.currency)}</strong>
          순${esc(executiveSummary.largestRisk.direction)}
          ${Math.abs(executiveSummary.largestRisk.net).toLocaleString()}
          ${esc(executiveSummary.largestRisk.currency)}
        </p>
        <p>원화 환산 노출: <strong>${scenario.formatKRW(executiveSummary.largestRisk.krwNotional)}</strong></p>
        ${executiveSummary.worstScenario
          ? `<p class="hint">표시된 시나리오 중 ${(executiveSummary.worstScenario.delta * 100).toFixed(0)}%에서
              손익 영향 ${scenario.formatKRW(executiveSummary.worstScenario.totalPnl)}</p>`
          : '<p class="hint">표시할 환율 시나리오가 없습니다.</p>'}`
      : '<p class="hint">계산 가능한 통화 노출이 없습니다.</p>';
    const summaryEffectHtml = executiveSummary.effect
      ? `<p><strong>${esc(executiveSummary.effect.strategyKey)} · 헤지 ${Math.round(executiveSummary.effect.hedgeRatio * 100)}%</strong>
          적용 시 데모 가정상 CFaR 측정치</p>
        <p>${scenario.formatKRW(executiveSummary.effect.beforeCFaR)}
          → <strong>${scenario.formatKRW(executiveSummary.effect.afterCFaR)}</strong></p>
        <p class="summary-effect">측정치 감소분
          <strong>${scenario.formatKRW(executiveSummary.effect.reductionKrw)}
          (${(executiveSummary.effect.reductionRate * 100).toFixed(1)}%)</strong></p>
        <figure class="mini-chart" role="img"
          aria-label="헤지 전 CFaR ${scenario.formatKRW(executiveSummary.effect.beforeCFaR)}에서 헤지 후 잔여 CFaR ${scenario.formatKRW(executiveSummary.effect.afterCFaR)}로 감소">
          ${charts.barChart([
            { label: "헤지 전", value: executiveSummary.effect.beforeCFaR, color: "#d64545" },
            { label: "헤지 후", value: executiveSummary.effect.afterCFaR, color: "#2f9e44" },
          ], { height: 150 })}
          <figcaption class="hint">헤지 전 CFaR → 헤지 후 잔여 CFaR (값이 낮을수록 위험 감소)</figcaption>
        </figure>
        <p class="hint">헤지 비용은 별도 ${scenario.formatKRW(executiveSummary.effect.hedgeCost)}이며 합산하지 않습니다.
          ${esc(executiveSummary.effect.assumptionsLabel || "데모 가정")} · 실제 상품 효과를 보장하지 않습니다.</p>`
      : '<p class="hint">예상 효과를 계산할 전략 정보가 없습니다.</p>';

    function buildGovernedContext() {
      return {
        strategies,
        counters,
        netRows,
        cfarTotal,
        scenarios: analysis.scenarios,
        countries: countryMonitoring
          .filter((country) => Number.isFinite(country.exposureShare))
          .map((country) => ({ name: country.name, exposureShare: country.exposureShare })),
        products: candidates.map((candidate) => {
          const ev = latestEvidence.find((e) => e.product_id === candidate.product_id);
          return {
            product_id: candidate.product_id,
            purpose: candidate.purpose,
            status: "candidate",
            name: candidate.name,
            category: candidate.category,
            source: candidate.source ? candidate.source.document_title : "근거 출처 미표시",
            matchedText: ev ? ev.matchedText : "",
          };
        }),
      };
    }

    root.innerHTML = `
      ${disclaimerBanner()}
      <div class="principle no-print">🔒 숫자(순노출·시나리오·매칭)는 <strong>결정론적으로 계산</strong>되며, AI는 그 결과를 <strong>해석·설명만</strong> 합니다.</div>

      <section class="card executive-summary action-plan-hero" aria-labelledby="executive-summary-title">
        <div class="summary-heading">
          <div>
            <div class="summary-kicker">권장 행동 3개 · 결정론 분석</div>
            <h2 id="executive-summary-title">내 기업의 금융 액션 플랜</h2>
          </div>
          <div class="summary-badge-stack">
            <span class="summary-badge">결정론 계산</span>
            ${renderMarketDataBadge(state.data.marketDataMeta)}
          </div>
        </div>
        <div class="action-plan-grid">
          ${actionPlan.actions.map((action, index) => `<article class="action-card action-${esc(action.kind)}">
            <div class="action-number">${index + 1}</div>
            <div>
              <h3>${esc(action.title)}</h3>
              <p><strong>왜 필요한가</strong><br>${esc(action.reason)}</p>
              <p><strong>예상 효과</strong><br>${esc(action.expectedEffect)}</p>
              <p class="action-next"><strong>다음 행동</strong><br>${esc(action.nextStep)}</p>
            </div>
          </article>`).join("")}
        </div>
        <details class="summary-metrics">
          <summary>가장 큰 위험과 예상 효과 수치 확인</summary>
          <div class="summary-grid">
            <article class="summary-block summary-risk">
              <h3>가장 큰 위험</h3>
              ${summaryRiskHtml}
            </article>
            <article class="summary-block summary-effect-block">
              <h3>예상 효과</h3>
              ${summaryEffectHtml}
            </article>
          </div>
        </details>
        <p class="summary-disclaimer">이 요약은 자동 최적화나 상품 권유가 아닙니다. 실제 조건은 금융기관 담당자에게 확인하세요.</p>
      </section>

      <section class="card recommendation-hero" aria-labelledby="recommendation-title">
        <div class="section-heading">
          <div>
            <div class="summary-kicker">공개용 합성 자격 규칙 기반 상담 후보</div>
            <h2 id="recommendation-title">지금 검토할 금융상품</h2>
          </div>
          <span class="summary-badge">${candidates.length}건 후보</span>
        </div>
        <p class="hint">상품 유사도 순위가 아닙니다. 요청 목적과 공개용 합성 자격 규칙을 통과한 후보만 표시합니다.</p>
        <ul class="status-legend" aria-label="판정 상태 안내">
          <li class="legend-item legend-candidate">
            <span class="legend-icon" aria-hidden="true">✓</span>
            <span class="legend-copy"><strong>추천 후보</strong><span class="hint">자격 규칙 통과</span></span>
          </li>
          <li class="legend-item legend-excluded">
            <span class="legend-icon" aria-hidden="true">×</span>
            <span class="legend-copy"><strong>고객 부적격</strong><span class="hint">규칙 불충족</span></span>
          </li>
          <li class="legend-item legend-pending">
            <span class="legend-icon" aria-hidden="true">?</span>
            <span class="legend-copy"><strong>정보 필요</strong><span class="hint">확인 시 재판정</span></span>
          </li>
          <li class="legend-item legend-unavailable">
            <span class="legend-icon" aria-hidden="true">–</span>
            <span class="legend-copy"><strong>규칙정보 미확인</strong><span class="hint">근거 미확보</span></span>
          </li>
        </ul>
        ${renderRecommendationPanels(recommendation, state.selected)}
        <p class="src">공개용 합성 규칙에서 확인된 범위만 판정합니다. 미확인 상품은 고객 부적격과 분리합니다.
          <span class="search-badge">문서 검색 준비 중</span></p>
        <div class="local-explanation">
          <div class="ai-box" id="products-ai-box">버튼을 누르면 계산·판정을 바꾸지 않는 로컬 설명을 생성합니다.</div>
          <button id="products-ai-btn" class="btn-ghost">선택 후보 설명 보기</button>
        </div>
        <button id="make-brief" class="btn-primary" ${candidates.length ? "" : "disabled"}>
          선택한 후보로 상담 브리프 만들기 →
        </button>
        <p class="errors brief-warning" id="brief-warning" hidden>상담할 상품을 1개 이상 선택하세요.</p>
      </section>

      <section class="card what-if-panel what-if-hero" aria-labelledby="what-if-title">
        <div class="section-heading">
          <div>
            <div class="summary-kicker">SELF-CHALLENGE · 결정론 재계산</div>
            <h2 id="what-if-title">위기 시나리오로 다시 검증</h2>
          </div>
          <span class="summary-badge">전후 비교</span>
        </div>
        <p class="hint">입금 지연·수취액 감소·불리한 환율을 적용해 같은 금융 엔진과 자격 규칙을 다시 실행합니다.</p>
        <div class="agent-nl">
          <label for="agent-nl-input" class="hint">숫자 없이 상황과 대상만 입력해 주세요 — 로컬 키워드·임베딩 분류기는 문장을 <strong>정해진 시나리오 종류</strong>로만 바꿉니다. 기간·비율은 아래 고정 프리셋에서 선택합니다.</label>
          <div class="agent-nl-row">
            <textarea id="agent-nl-input" class="agent-nl-input" rows="2" maxlength="500"
              placeholder='예) "미국 거래처 입금이 늦으면?" · "수출 매출이 감소하면?" · "환율이 불리해지면?"'></textarea>
            <button type="button" id="agent-plan-btn" class="btn-ghost">계획 미리보기</button>
          </div>
          <details class="agent-external-option">
            <summary>선택적 외부 AI 실험 어댑터</summary>
            <label>
              <input type="checkbox" id="agent-external-opt-in">
              로컬 분류가 확신하지 못할 때 비식별 문장을 외부 AI로 한 번 더 분류
            </label>
            <p class="hint">기본은 꺼짐입니다. 사용자 승인·로컬 프록시·API 키가 모두 있을 때만 호출하며,
              외부 AI는 상품·계산·대상을 바꿀 수 없습니다. 결과도 기존 T17 게이트를 다시 통과합니다.</p>
          </details>
          <div id="agent-plan-preview" class="agent-plan-preview" aria-live="polite"></div>
        </div>
        <p class="hint">또는 프리셋으로 바로 재검증:</p>
        <div class="what-if-actions">
          ${counterfactual.SCENARIOS.filter((scenarioItem) => scenarioItem.implemented).map((scenarioItem) => `<button
            type="button"
            class="btn-ghost what-if-run"
            data-scenario="${esc(scenarioItem.id)}">
            ${esc(scenarioItem.label)}
          </button>`).join("")}
        </div>
        <div id="what-if-result" class="what-if-result" aria-live="polite">
          <p class="hint">시나리오를 선택하면 CFaR·유동성·상담 후보의 전후 변화를 먼저 보여줍니다.</p>
        </div>
        <div class="local-explanation">
          <div class="ai-box" id="counter-ai-box">버튼을 누르면 시나리오의 의미와 한계를 로컬 규칙으로 설명합니다.</div>
          <button id="counter-ai-btn" class="btn-ghost">시나리오 설명 보기</button>
        </div>
      </section>

      <details class="results-details">
        <summary>
          <span><strong>상세 계산·분석</strong> 펼쳐서 확인</span>
          <span class="detail-toggle-hint">환노출·국가·환율 시나리오·CFaR·헤지 전략·종합 진단</span>
        </summary>
        <div class="result-detail-stack">
      <section class="card">
        <h2 class="step-title">1. 환노출 진단</h2>
        <p class="hint">입력하신 거래 기준 통화별 순노출입니다.</p>
        ${charts.barChart(netRows.map((r) => ({ label: r.currency, value: r.net })))}
        ${netRows.map((r) => {
          const bs = cfarBuckets.filter((b) => b.currency === r.currency);
          return `<div class="exposure-highlight">
            💡 <strong>${esc(r.currency)}</strong> 총 통화 순노출:
            <u>${r.net >= 0 ? "+" : "−"}${Math.abs(r.net).toLocaleString()} ${esc(r.currency)}</u>
            <span class="hint">(수취 ${r.receivable.toLocaleString()} − 지급 ${r.payable.toLocaleString()})</span>
            <div>만기별 관리대상: ${bs.map((b) =>
              `${b.months}개월 ${b.netAtMaturity >= 0 ? "수취" : "지급"} ${Math.abs(b.netAtMaturity).toLocaleString()}`).join(" / ")}</div>
            ${bs.length > 1
              ? `<div class="hint">결제 만기가 다르므로 완전히 자연헤지되지 않습니다. 헤지 명목과 유동성은 만기별로 따로 관리해야 합니다.</div>`
              : ""}
          </div>`;
        }).join("")}
        <p class="src">출처: 예시 환율 스냅샷 · 기준일 ${fx.as_of} · ${esc(fx.note)}</p>
      </section>

      <section class="card">
        <h2 class="step-title">2. 거래국 경제·무역 지표</h2>
        <p class="hint">세계은행의 국가 단위 거시·무역 참고지표입니다. 양국 간 교역량·국가위험등급·예측값이 아니며, 금융계산·상품 자격판정에 사용하지 않습니다.</p>
        <div class="grid">
          ${involved.map((c, index) => {
            const intelligence = countryIndicators[index];
            const trade = bilateralTrade[index];
            const monitoring = countryMonitoring[index];
            const metrics = intelligence?.indicators || [];
            return `<div class="risk-card country-indicator-card">
              <div><strong>${esc(c.name)}</strong> <span class="country-code">${esc(isoOrder[index])}</span></div>
              ${metrics.some((metric) => metric.value !== null)
                ? `<dl class="indicator-list">${metrics.map((metric) => `<div><dt><a href="${esc(metric.source_url)}" target="_blank" rel="noopener noreferrer">${esc(metric.label)}</a></dt><dd>${metric.value === null ? "공식 지표 미확인" : `${Number(metric.value).toLocaleString("ko-KR", { maximumFractionDigits: 2 })}${esc(metric.unit)} <small>(${metric.year})</small>`}</dd></div>`).join("")}</dl>`
                : `<p class="hint">공식 지표 미확인</p>`}
              <div class="bilateral-trade-block">
                <strong>한국 신고 기준 연간 상품 교역</strong>
                ${trade?.status === "cached"
                  ? `<dl class="indicator-list">
                      <div><dt>한국의 해당국 수출</dt><dd>${esc(formatTradeUsd(trade.exportsUsd))} <small>(${trade.period})</small></dd></div>
                      <div><dt>한국의 해당국 수입</dt><dd>${esc(formatTradeUsd(trade.importsUsd))} <small>(${trade.period})</small></dd></div>
                    </dl>`
                  : `<p class="hint">교역 통계 미확인</p>`}
                <p class="hint">UN Comtrade의 한국 신고 기준 연간 상품 총교역 참고값입니다. 기업별 거래·전망·국가위험등급이 아니며, 금융계산·상품 자격판정에 사용하지 않습니다.</p>
              </div>
              <p class="country-monitoring-fact"><strong>거래 명목 원화환산:</strong>
                ${Number.isFinite(monitoring?.exposureKrw)
                  ? `${scenario.formatKRW(monitoring.exposureKrw)} · 전체 ${(monitoring.exposureShare * 100).toFixed(1)}%`
                  : "지원 환율이 없어 비중 미확인"}
              </p>
              <p class="hint">입력 거래규모와 공식 관측값을 연결한 모니터링 참고정보이며 국가위험등급·예측값이 아닙니다.</p>
            </div>`;
          }).join("")}
        </div>
        <p class="src">출처: World Bank WDI 공식 국가지표 캐시 · 지표별 최신 공표연도 표시 · ${esc(state.data.countryIndicators.note || "")}</p>
        ${renderBilateralTradeSource(state.data.bilateralTrade)}
      </section>

      <section class="card">
        <h2 class="step-title">3. 환헤지 시나리오</h2>
        <p class="hint">순노출에 대해 환율이 변동하면 원화 손익이 어떻게 되는지입니다. (−손실 / +이익)<br>
          ※ 시나리오는 통화 순노출 기준이며 만기 불일치는 CFaR·유동성에서 별도 반영합니다.</p>
        <div class="table-wrap">
          <table class="scn">
            <thead><tr><th>시나리오</th>${netRows.map((r) => `<th>${r.currency}</th>`).join("")}<th>합계</th></tr></thead>
            <tbody>
              ${scenarios.map((s) => `<tr>
                <td>${(s.delta * 100).toFixed(0)}%</td>
                ${netRows.map((r) => {
                  const c = s.byCurrency.find((x) => x.currency === r.currency);
                  return `<td>${c ? scenario.formatKRW(c.pnl) : "-"}</td>`;
                }).join("")}
                <td><strong>${scenario.formatKRW(s.totalPnl)}</strong></td>
              </tr>`).join("")}
            </tbody>
          </table>
        </div>
      </section>

      <section class="card">
        <h2 class="step-title">4. CFaR(현금흐름위험) · 유동성</h2>
        <p class="hint">95% 신뢰수준 기준, 통화별·만기별로 각 노출의 결제 시점까지 환율이 변동할 때 발생 가능한 손실 규모(CFaR)입니다.</p>
        <p>합계 CFaR: <strong>${scenario.formatKRW(cfarTotal)}</strong>
          <span class="hint">— 통화·만기 버킷 간 상관관계와 상쇄효과를 반영하지 않은 보수적 단순합이라
          실제 포트폴리오 위험보다 크게 산출될 수 있습니다.</span></p>
        <details class="assumptions">
          <summary>CFaR 계산 가정</summary>
          <ul>
            <li>현재 환율 스냅샷(기준일 ${esc(fx.as_of)})을 사용합니다.</li>
            <li>연환율 변동성이 기간 동안 일정하다는 가정입니다.</li>
            <li>정규분포 기반 95% 단측 위험 참고치입니다(z = 1.645).</li>
            <li>통화·만기 버킷 간 상관·상쇄 미반영(보수적 단순합)입니다.</li>
          </ul>
        </details>
        <ul class="cfar-list">
          ${cfarBuckets.map((b) => `<li>${esc(b.currency)} · ${b.months}개월 (순 ${b.netAtMaturity.toLocaleString()} ${esc(b.currency)}): ${scenario.formatKRW(b.cfar)}</li>`).join("")}
        </ul>
        <p class="hint">유동성 완충: 기초 현금잔고 ${scenario.formatKRW(state.liquidity.openingBalanceKrw)}
          + 신용한도 ${scenario.formatKRW(state.liquidity.creditLineKrw)} = ${scenario.formatKRW(bufferKrw)}
          ${bufferKrw === 0 ? "<em>(입력하지 않아 0으로 계산)</em>" : ""}</p>
        ${shortfalls.length
          ? `<div class="exposure-highlight">⚠️ 유동성 부족 예상: ${shortfalls.map((t) => `${t.months}개월 후 ${scenario.formatKRW(t.shortfallKrw)}`).join(", ")}
             <div class="hint">완충(잔고+한도)을 모두 사용한 뒤에도 모자라는 금액입니다.</div></div>`
          : `<p class="hint">✅ 유동성 부족 없음 (완충 반영 후 현금흐름 시점 기준)</p>`}
        <details class="assumptions">
          <summary>유동성 계산 가정</summary>
          <ul>
            <li>현재 기준환율로 원화 환산합니다(미래 환율 변동 미반영).</li>
            <li>이자·환전 스프레드·수수료 미반영입니다.</li>
            <li>신용한도가 해당 시점까지 유지되고 전액 사용 가능하다는 가정입니다.</li>
          </ul>
        </details>
      </section>

      <section class="card">
        <h2 class="step-title">5. 헤지 전략 비교</h2>
        <p class="hint">CFaR 합계를 기준으로 세 가지 헤지 전략을 비교합니다.
          <strong>잔여 위험</strong>은 95% 신뢰수준의 위험 측정치이고, <strong>헤지 비용</strong>은 가정에 따른 확정성 비용입니다.
          성격이 다르므로 각각 따로 보십시오.</p>
        <div class="table-wrap">
          <table class="strategy-table">
            <thead><tr>
              <th>전략</th><th>헤지율</th><th>잔여 위험 (CFaR)</th><th>헤지 비용 (가정)</th>
            </tr></thead>
            <tbody>
              ${strategies.map((s) => `<tr>
                <td><strong>${esc(s.key)}</strong><div class="hint">${esc(s.desc)}</div></td>
                <td>${Math.round(s.hedgeRatio * 100)}%</td>
                <td>${scenario.formatKRW(s.residualCFaR)}</td>
                <td>${scenario.formatKRW(s.hedgeCost)}</td>
              </tr>`).join("")}
            </tbody>
          </table>
        </div>
        <div class="dual-chart">
          <figure class="mini-chart" role="img" aria-label="전략별 잔여 위험 CFaR 비교">
            <figcaption class="chart-title">잔여 위험 (CFaR)</figcaption>
            ${charts.barChart(strategies.map((s) => ({ label: s.key, value: s.residualCFaR, color: "#d64545" })), { height: 160 })}
          </figure>
          <figure class="mini-chart" role="img" aria-label="전략별 헤지 비용 비교">
            <figcaption class="chart-title">헤지 비용 (가정)</figcaption>
            ${charts.barChart(strategies.map((s) => ({ label: s.key, value: s.hedgeCost, color: "#1c7ed6" })), { height: 160 })}
          </figure>
        </div>
        <p class="hint">위 두 그래프는 <strong>축이 다른 별개의 값</strong>입니다. 왼쪽은 95% 위험 측정치, 오른쪽은 가정상 비용이며 한 그래프로 합치지 않습니다.</p>
        <p class="hint">※ 잔여 위험과 헤지 비용은 <strong>성격이 다른 값이라 합산하지 않습니다.</strong>
          두 값을 각각 보고 위험과 비용의 trade-off를 직접 비교하십시오.
          자동 순위나 “최적 전략” 선정은 제공하지 않으며, 선택은 기업의 현금흐름·위험 감내 수준에 따라 담당자와 상담해 결정하십시오.</p>
        <p class="src">가정: ${esc(strategies[0] ? strategies[0].assumptionsLabel : "")}</p>
      </section>

      <section class="card">
        <h2 class="step-title">6. 종합 진단</h2>
        <div class="ai-box" id="ai-box">${esc(ruleText)}</div>
        <p class="hint">※ 시나리오는 통화 순노출 기준이며 만기 불일치는 CFaR·유동성에서 별도 반영합니다.</p>
        <p class="hint">위 진단은 <strong>키 없이 규칙으로 자동 생성</strong>됩니다. 상단 설명 버튼도 기본적으로 로컬 규칙 설명을 사용합니다.</p>
      </section>
        </div>
      </details>

      <details class="verification-details">
        <summary>
          <span><strong>심사·검증 정보</strong> 펼쳐서 확인</span>
          <span class="detail-toggle-hint">AI·추천 안전성 정량평가 · 재현 기준 · 평가 범위</span>
        </summary>
        <div class="verification-body">
          ${renderEvaluationCard(state.data.evaluation)}
        </div>
      </details>

      <div class="row-actions">
        <button id="edit-input" class="btn-ghost">← 입력값 수정하기</button>
        <button id="new-analysis" class="btn-ghost">새 분석 시작</button>
      </div>
      <p class="src">분석 기준: 결정론 계산 엔진 · 데이터 기준일 ${fx.as_of} · 이 결과는 입력값과 예시 데이터로 재현 가능합니다.</p>

      <details class="governance-advanced card">
        <summary>고급 설정: 외부 AI 설명·전송 기록</summary>
        <div class="governance-body">
          <p class="hint">핵심 계산·자격판정·RAG는 외부 AI 없이 로컬에서 동작합니다.
            외부 AI는 로컬 프록시가 준비된 경우에만 사용자 승인 후 설명을 보강하며, 실패하면 로컬 규칙 설명으로 돌아갑니다.</p>
          <p class="hint">회사명과 원본 거래를 제외해도 집계된 금융정보는 민감할 수 있습니다. 실제 전송 항목을 확인한 뒤 승인하세요.</p>
          <label class="hint">설명 모드
            <select class="llm-mode">
              <option value="mock">로컬 설명 (기본 · 키/네트워크 불필요)</option>
              <option value="external">외부 AI 설명 (선택 · 로컬 프록시+승인 필요)</option>
              <option value="internal" disabled>금융기관 내부 AI (실서비스 교체점 · 현재 미구현)</option>
              <option value="off">설명 끄기</option>
            </select>
          </label>
          <details class="audit-log">
            <summary>외부 전송 감사 로그</summary>
            <div class="audit-log-body"></div>
            <button type="button" class="btn-ghost clear-audit">감사로그 삭제</button>
          </details>
        </div>
      </details>

      <dialog class="approval-modal">
        <h3>외부 AI로 전송할 내용 미리보기</h3>
        <p class="hint">회사명·계약원문·계좌·원본 거래는 전송되지 않지만, 집계된 금융정보도 민감할 수 있습니다.</p>
        <p><strong>전송 목적</strong>: 선택한 결과에 대한 설명 생성</p>
        <details class="payload-details">
          <summary>실제 전송 JSON 확인</summary>
          <pre class="payload-preview"></pre>
        </details>
        <menu>
          <button type="button" class="btn-ghost approval-cancel">취소</button>
          <button type="button" class="btn-primary approval-ok">승인 후 전송</button>
        </menu>
      </dialog>

      <dialog class="reset-modal">
        <h3>새 분석을 시작할까요?</h3>
        <p class="hint">현재 거래·기업정보·헤지·유동성 입력을 모두 지우고 처음부터 다시 시작합니다.
          <br>입력만 수정하려면 [입력값 수정하기]를 사용하세요.</p>
        <menu>
          <button type="button" class="btn-ghost reset-cancel">취소</button>
          <button type="button" class="btn-primary reset-ok">새 분석 시작</button>
        </menu>
      </dialog>`;

    const counterfactualDeps = {
      engines: { risk, strategy, profile, reasoner },
      graph: state.data.knowledgeGraph,
      rules: state.data.eligibilityRules,
      sources: state.data.sourceRegistry,
      schema: state.data.ontologySchema,
      today: fx.as_of,
    };
    const counterfactualBaseInput = {
      // 프로파일 생성 과정에서 부여·검증된 transaction_id를 사용한다.
      transactions: state.profile.transactions,
      rates: fx.rates,
      annualVol,
      liquidity: state.liquidity,
      company: state.company.resolved,
      today: fx.as_of,
    };

    root.querySelectorAll(".what-if-run").forEach((button) =>
      button.addEventListener("click", () => {
        if (button.disabled) return;
        const box = root.querySelector("#what-if-result");
        if (!box) return;
        agentPreviewSeq++;
        agentPlan = null;
        if (agentPreviewBox) agentPreviewBox.innerHTML = "";
        root.querySelectorAll(".what-if-run").forEach((item) =>
          item.setAttribute("aria-pressed", String(item === button)));
        const counterBox = root.querySelector("#counter-ai-box");
        if (counterBox)
          counterBox.textContent = "버튼을 누르면 시나리오의 의미와 한계를 로컬 규칙으로 설명합니다.";
        try {
          const result = counterfactual.runCounterfactual(
            button.dataset.scenario,
            counterfactualBaseInput,
            counterfactualDeps,
          );
          state.lastCounterfactual = {
            label: result.scenario?.label || button.textContent.trim(),
            cfarDeltaKrw: result.deltas?.cfarTotalKrw,
            shortfallDeltaKrw: result.deltas?.worstShortfallKrw,
          };
          box.innerHTML = renderWhatIfResult(result);
        } catch (err) {
          box.innerHTML = `<div class="errors"><strong>시나리오를 계산할 수 없습니다.</strong>
            <div>${esc(err?.message || "알 수 없는 오류")}</div></div>`;
        }
      })
    );

    // T20: 자연어 → 계획 미리보기 → 승인 → 기존 엔진 재계산.
    // AI/파서는 계획만 제안하고, 게이트를 통과한 {scenarioId, options}만 실행된다.
    const agentInput = root.querySelector("#agent-nl-input");
    const agentPreviewBox = root.querySelector("#agent-plan-preview");
    const agentPlanBtn = root.querySelector("#agent-plan-btn");
    const agentExternalOptIn = root.querySelector("#agent-external-opt-in");
    let agentPlan = null; // { gate, step, confidence }
    let agentPreviewSeq = 0;

    function clearScenarioOutputForPreview() {
      state.lastCounterfactual = null;
      root.querySelectorAll(".what-if-run").forEach((item) =>
        item.setAttribute("aria-pressed", "false"));
      const box = root.querySelector("#what-if-result");
      if (box)
        box.innerHTML = '<p class="hint">새 계획은 아직 실행되지 않았습니다. 미리보기를 확인한 뒤 승인하면 전/후 결과가 표시됩니다.</p>';
      const counterBox = root.querySelector("#counter-ai-box");
      if (counterBox)
        counterBox.textContent = "버튼을 누르면 시나리오의 의미와 한계를 로컬 규칙으로 설명합니다.";
    }

    function renderAgentPreview() {
      if (!agentPreviewBox) return;
      if (!agentPlan) { agentPreviewBox.innerHTML = ""; return; }
      agentPreviewBox.innerHTML = renderScenarioPlanPreview(agentPlan.gate, {
        step: agentPlan.step,
        receivables: agentPlan.candidates || [],
        confidence: agentPlan.confidence,
        mode: agentPlan.mode,
        externalStatus: agentPlan.externalStatus,
      });
      const approve = agentPreviewBox.querySelector("#agent-approve");
      if (approve) approve.addEventListener("click", runAgentScenario);
      agentPreviewBox.querySelectorAll(".agent-target").forEach((radio) =>
        radio.addEventListener("change", () => previewFromInput(radio.value)));
    }

    async function previewFromInput(chosenTargetId) {
      const requestSeq = ++agentPreviewSeq;
      const text = agentInput ? agentInput.value : "";
      const sourceText = normalizeIntentText(text);
      clearScenarioOutputForPreview();
      const interpretationContext = {
        transactions: counterfactualBaseInput.transactions,
        intents: state.data.scenarioIntents,
        countryAliases: Object.fromEntries(
          Object.entries(state.data.countryCatalog.countries).map(([iso, country]) => [country.name, iso]),
        ),
      };
      if (agentPreviewBox)
        agentPreviewBox.innerHTML = '<div class="agent-plan-card loading" role="status"><p>로컬 의미 분류기를 확인하는 중…</p></div>';
      if (agentPlanBtn) agentPlanBtn.disabled = true;

      // Deterministic parser first. Only an unmatched type may use the local
      // semantic classifier; magnitude/negation/target rules cannot be overridden.
      let interpreted = await interpretScenarioIntent(
        text,
        interpretationContext,
        scenarioClassifier,
      );
      if (requestSeq !== agentPreviewSeq
          || sourceText !== normalizeIntentText(agentInput ? agentInput.value : ""))
        return;

      // Optional experiment: only after explicit opt-in and only when the local
      // classifier did not produce a step. The proxy returns type+confidence only.
      let externalStatus = null;
      if (shouldTryExternalIntent(interpreted, agentExternalOptIn?.checked === true)) {
        const external = createExternalIntentAdapter({ approved: true });
        const externalResult = await interpretScenarioIntent(
          text,
          interpretationContext,
          external,
        );
        if (requestSeq !== agentPreviewSeq
            || sourceText !== normalizeIntentText(agentInput ? agentInput.value : ""))
          return;
        externalStatus = externalResult.classification?.status || "unavailable";
        if (externalResult.intent.steps.length) interpreted = externalResult;
      }

      const intent = interpreted.intent;
      let intentToUse = intent;
      if (chosenTargetId && intent.steps.length === 1 && intent.steps[0].type === "payment_delay")
        intentToUse = { ...intent, steps: [{ ...intent.steps[0], target: { transaction_id: chosenTargetId } }] };
      const gate = validatePlan(buildPresetPlan(intentToUse), { transactions: counterfactualBaseInput.transactions });
      // Only condition-matching receivables are offered in the chooser (never unrelated ones).
      const candidates = intentToUse.steps[0]?.type === "payment_delay"
        ? resolveReceivableCandidates(
          text,
          counterfactualBaseInput.transactions,
          interpretationContext.countryAliases,
        ).candidates
        : [];
      // Remember the exact sentence this preview was built from, to reject stale approvals.
      agentPlan = {
        gate,
        step: intentToUse.steps[0] || null,
        confidence: intent.confidence,
        candidates,
        sourceText,
        mode: interpreted.mode,
        externalStatus,
      };
      if (agentPlanBtn) agentPlanBtn.disabled = false;
      renderAgentPreview();
    }

    function runAgentScenario() {
      const box = root.querySelector("#what-if-result");
      if (!box || !agentPlan?.gate?.ok) return;
      // Re-check that the box still holds the sentence this plan was previewed from.
      if (normalizeIntentText(agentInput ? agentInput.value : "") !== agentPlan.sourceText) {
        agentPlan = null;
        if (agentPreviewBox)
          agentPreviewBox.innerHTML = `<div class="agent-plan-card blocked" role="status"><p>입력이 변경되었습니다. [계획 미리보기]를 다시 눌러 주세요.</p></div>`;
        return;
      }
      try {
        const result = counterfactual.runCounterfactual(
          agentPlan.gate.execution.scenarioId,
          counterfactualBaseInput,
          counterfactualDeps,
          agentPlan.gate.execution.options,
        );
        state.lastCounterfactual = {
          label: result.scenario?.label || "자연어 시나리오",
          cfarDeltaKrw: result.deltas?.cfarTotalKrw,
          shortfallDeltaKrw: result.deltas?.worstShortfallKrw,
        };
        root.querySelectorAll(".what-if-run").forEach((item) => item.setAttribute("aria-pressed", "false"));
        box.innerHTML = renderWhatIfResult(result);
        box.scrollIntoView({ behavior: "smooth", block: "nearest" });
      } catch (err) {
        box.innerHTML = `<div class="errors"><strong>시나리오를 계산할 수 없습니다.</strong>
          <div>${esc(err?.message || "알 수 없는 오류")}</div></div>`;
      }
    }

    if (agentPlanBtn) agentPlanBtn.addEventListener("click", () => { void previewFromInput(null); });

    // Editing the sentence immediately invalidates any existing preview/approval.
    if (agentInput) agentInput.addEventListener("input", () => {
      agentPreviewSeq++;
      if (agentPlanBtn) agentPlanBtn.disabled = false;
      if (!agentPlan) return;
      agentPlan = null;
      if (agentPreviewBox)
        agentPreviewBox.innerHTML = `<div class="agent-plan-card blocked" role="status"><p>입력이 변경되었습니다. [계획 미리보기]를 다시 눌러 주세요.</p></div>`;
    });
    if (agentExternalOptIn) agentExternalOptIn.addEventListener("change", () => {
      agentPreviewSeq++;
      agentPlan = null;
      if (agentPlanBtn) agentPlanBtn.disabled = false;
      if (agentPreviewBox)
        agentPreviewBox.innerHTML = `<div class="agent-plan-card blocked" role="status"><p>분류 방식이 변경되었습니다. [계획 미리보기]를 다시 눌러 주세요.</p></div>`;
    });

    // 목적 탭: 같은 판정 결과 안에서 목적별 패널만 전환한다.
    root.querySelectorAll(".purpose-tab").forEach((tab) =>
      tab.addEventListener("click", () => {
        const purpose = tab.dataset.purpose;
        root.querySelectorAll(".purpose-tab").forEach((button) =>
          button.setAttribute("aria-selected", String(button === tab)));
        root.querySelectorAll(".purpose-panel").forEach((panel) => {
          panel.hidden = panel.dataset.purpose !== purpose;
        });
      })
    );

    // 추천 후보 선택(전체 재렌더 없이 체크 상태만 변경)
    root.querySelectorAll(".prod-check").forEach((chk) =>
      chk.addEventListener("change", () => {
        const id = chk.dataset.id;
        if (chk.checked) state.selected.add(id);
        else state.selected.delete(id);
        chk.closest(".product-card").classList.toggle("selected", chk.checked);
      })
    );

    root.querySelector("#make-brief").addEventListener("click", () => {
      // alert 은 임베디드 브라우저에서 무시되므로 인라인 경고로 피드백한다.
      const warning = root.querySelector("#brief-warning");
      if (!state.selected.size) {
        if (warning) {
          warning.hidden = false;
          warning.scrollIntoView({ behavior: "smooth", block: "center" });
        }
        return;
      }
      if (warning) warning.hidden = true;
      state.briefCtx = {
        cashflows: cashflows.map((cashflow) => ({
          ...cashflow,
          countryName: countryCatalog.countries[cashflow.country]?.name || cashflow.country,
        })),
        netRows,
        scenarios: analysis.scenarios,
        countries: countryMonitoring,
        selectedProducts: candidates
          .filter((candidate) => state.selected.has(candidate.product_id))
          .map((candidate) => ({
            name: candidate.name,
            category: candidate.category,
            reason: `${PURPOSE_LABEL[candidate.purpose] || candidate.purpose} 목적과 연결되고 공개용 합성 자격 규칙 ${(candidate.passedRules || []).length}건을 통과했습니다.`,
            verifiedConditions: [...new Set((candidate.eligibilityEvidence || []).map(evidenceLabel))],
            source: candidate.source,
          })),
        company: state.company.resolved,
        liquidity: {
          ...state.liquidity,
          worstShortfallKrw: shortfalls.reduce((max, item) => Math.max(max, item.shortfallKrw), 0),
        },
        cfar: {
          totalKrw: cfarTotal,
          comparisonStrategy: strategies[0] || null,
        },
        questions: brief.questionsForRecommendation(recommendation),
        counterfactualHighlight: state.lastCounterfactual,
        asOf: fx.as_of,
        now: new Date(),
      };
      state.screen = "brief";
      render();
    });

    root.querySelector("#edit-input").addEventListener("click", () => {
      state.screen = "input";
      render();
    });
    root.querySelector("#new-analysis").addEventListener("click", () => {
      const resetAll = () => {
        Object.assign(state, createAnalysisState(state.data));
        render();
      };
      const dialog = root.querySelector(".reset-modal");
      // 임베디드 브라우저에서 무시되는 window.confirm 대신 앱 내 <dialog> 사용.
      if (!dialog || typeof dialog.showModal !== "function") { resetAll(); return; }
      const close = () => { try { dialog.close(); } catch { /* already closed */ } };
      dialog.querySelector(".reset-ok").onclick = () => { close(); resetAll(); };
      dialog.querySelector(".reset-cancel").onclick = close;
      try { dialog.showModal(); } catch { resetAll(); }
    });

    // ---- T9: LLM 모드 셀렉터 (키는 브라우저에 입력·저장하지 않음) ----
    function currentLlmMode() {
      try {
        const stored = sessionStorage.getItem("kb_llm_mode");
        return ["mock", "external", "off"].includes(stored)
          ? stored
          : resolveMode("demo");
      } catch {
        return resolveMode("demo");
      }
    }

    const modeSelect = root.querySelector(".llm-mode");
    if (modeSelect) {
      modeSelect.value = currentLlmMode();
      modeSelect.addEventListener("change", () => {
        try { sessionStorage.setItem("kb_llm_mode", modeSelect.value); } catch { /* ignore storage errors */ }
      });
    }

    // ---- T9: 세션 한정·메타데이터 전용 감사 로그 ----
    function refreshAuditLog() {
      const body = root.querySelector(".audit-log-body");
      if (!body) return;
      let log = [];
      try { log = audit.getAuditLog(window.sessionStorage); } catch { log = []; }
      body.innerHTML = log.length
        ? log.slice().reverse().map((e) => `<div class="audit-entry">
            <span>${esc(e.timestamp)}</span> · 목적 ${esc(e.purpose)} · provider ${esc(e.provider)} ·
            승인 ${e.approval ? "Y" : "N"} · 필드 ${esc((e.sent_fields || []).join(", "))} · 결과 ${esc(e.outcome)}
          </div>`).join("")
        : `<p class="hint">전송 이력이 없습니다.</p>`;
    }
    refreshAuditLog();
    const clearAuditButton = root.querySelector(".clear-audit");
    if (clearAuditButton) clearAuditButton.addEventListener("click", () => {
      try { audit.clearAuditLog(window.sessionStorage); } catch { /* non-fatal */ }
      refreshAuditLog();
    });

    // ---- T9: 승인 모달 (브라우저 요청은 purpose + analysisPayload만) ----
    function confirmExternalSend(purpose, context) {
      return new Promise((resolve) => {
        const dialog = root.querySelector(".approval-modal");
        if (!dialog || typeof dialog.showModal !== "function") { resolve(false); return; }
        try {
          const analysisPayload = privacy.buildAnalysisPayload(context);
          const checked = privacy.validateAnalysisPayload(analysisPayload);
          if (!checked.ok) { resolve(false); return; }
          dialog.querySelector(".payload-preview").textContent = JSON.stringify({
            purpose,
            analysisPayload: checked.value,
          }, null, 2);
        } catch {
          resolve(false);
          return;
        }
        const okBtn = dialog.querySelector(".approval-ok");
        const cancelBtn = dialog.querySelector(".approval-cancel");
        let done = false;
        // Resolve directly from the button handlers — do NOT rely on the dialog
        // "close" event (it does not fire reliably in every embedded webview).
        const finish = (val) => {
          if (done) return;
          done = true;
          okBtn.removeEventListener("click", onOk);
          cancelBtn.removeEventListener("click", onCancel);
          dialog.removeEventListener("cancel", onEsc);
          try { dialog.close(); } catch {}
          resolve(val);
        };
        const onOk = () => finish(true);
        const onCancel = () => finish(false);
        const onEsc = () => finish(false); // ESC / native dismiss
        okBtn.addEventListener("click", onOk);
        cancelBtn.addEventListener("click", onCancel);
        dialog.addEventListener("cancel", onEsc);
        try { dialog.showModal(); } catch { finish(false); }
      });
    }

    // ---- v2: 거버넌스 관통 AI 설명 흐름 ----
    async function runGoverned({ purpose, explainFn, boxEl, btnEl }) {
      if (!boxEl || !btnEl) return;
      btnEl.disabled = true;
      boxEl.textContent = "설명을 생성 중입니다…";
      try {
        const context = buildGovernedContext();
        const mode = currentLlmMode();
        let out = null;
        if (mode === "external") {
          const approved = await confirmExternalSend(purpose, context);
          if (!approved) {
            try {
              audit.recordAudit(window.sessionStorage, {
                purpose,
                approval: false,
                provider: "external",
                modelId: "proxy-managed",
                outcome: "denied",
                sentFields: [],
              });
            } catch { /* non-fatal */ }
            boxEl.textContent = "전송이 취소되었습니다. (규칙 기반 설명은 위 패널을 참고하세요)";
            return;
          }
          const provider = createProvider("external", { approved: true });
          out = await explainFn(context, { provider, auditStore: window.sessionStorage });
        } else {
          const provider = createProvider(mode);
          out = await explainFn(context, { provider });
        }
        boxEl.textContent = out;
      } catch {
        boxEl.textContent = "AI 설명 생성 중 오류가 발생했습니다. 위 규칙 기반 설명을 참고하세요.";
      } finally {
        btnEl.disabled = false;
        refreshAuditLog();
      }
    }

    const counterAiBtn = root.querySelector("#counter-ai-btn");
    if (counterAiBtn) counterAiBtn.addEventListener("click", () => runGoverned({
      purpose: "counter_examples",
      explainFn: agent.explainCounterExamples,
      boxEl: root.querySelector("#counter-ai-box"),
      btnEl: counterAiBtn,
    }));

    const productsAiBtn = root.querySelector("#products-ai-btn");
    if (productsAiBtn) productsAiBtn.addEventListener("click", () => runGoverned({
      purpose: "product_explanation",
      explainFn: agent.explainProducts,
      boxEl: root.querySelector("#products-ai-box"),
      btnEl: productsAiBtn,
    }));

    // ---- v2: RAG 근거 검색 (비동기, 실패해도 화면은 절대 깨지지 않음) ----
    (async function loadEvidence() {
      try {
        const situationText = netRows.map((r) => `${r.currency} 순노출 ${Math.abs(r.net).toLocaleString()}`).join(" ")
          + (state.profile.facts.company.hasExport ? " 수출 병행 환헤지" : " 환헤지");
        const ragClient = rag.createRag({
          docs: state.data.productDocs,
          embeddings: state.data.productEmbeddings,
          sources: state.data.sourceRegistry,
        });
        latestEvidence = [];
        // 온톨로지가 후보와 자격을 먼저 판정한다. RAG는 후보·통과 규칙 범위에서만 근거를 찾는다.
        for (const candidate of candidates) {
          for (const passedRule of candidate.passedRules || []) {
            const query = passedRule.failure_reason || `${candidate.name} ${situationText}`;
            const evidence = await ragClient.evidenceForCandidate({
              product_id: candidate.product_id,
              rule_ids: [passedRule.rule_id],
              query,
            });
            if (Array.isArray(evidence)) latestEvidence.push(...evidence);
          }
        }

        const badge = root.querySelector(".search-badge");
        if (badge) badge.textContent = ragClient.state() === "ready" ? "시맨틱 검색(임베딩)" : "키워드 검색";

        for (const candidate of candidates) {
          const box = root.querySelector(`.rag-evidence-body[data-id="${candidate.product_id}"]`);
          const matches = latestEvidence.filter((e) => e.product_id === candidate.product_id);
          const uniqueMatches = [...new Map(matches.map((match) => [match.chunk_id, match])).values()];
          if (!box) continue;
          box.innerHTML = renderRagEvidenceContent(uniqueMatches);
        }
      } catch {
        // Evidence is best-effort only — never break the results screen.
        const badge = root.querySelector(".search-badge");
        if (badge) badge.textContent = "문서 근거 검색 실패";
        root.querySelectorAll(".rag-evidence-body").forEach((box) => {
          box.innerHTML = renderRagEvidenceContent([], { failed: true });
        });
      }
    })();
  }

  // ---------- Screen 4: 상담 신청서 / 브리프 ----------
  function renderBrief() {
    const { html } = brief.buildBrief(state.briefCtx);
    root.innerHTML = `
      <div class="row-actions no-print">
        <button id="back-results" class="btn-ghost">← 결과로</button>
        <button id="print-brief" class="btn-primary">🖨️ 인쇄 / PDF로 저장</button>
      </div>
      <section class="card brief-card">${html}</section>
      <p class="src no-print">인쇄 창에서 "PDF로 저장"을 선택하면 상담 신청서 초안을 파일로 받을 수 있습니다.</p>`;

    root.querySelector("#back-results").addEventListener("click", () => { state.screen = "results"; render(); });
    root.querySelector("#print-brief").addEventListener("click", () => window.print());
  }
}
