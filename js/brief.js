// Deterministic consultation-brief / application-draft generator.
// Produces a printable HTML draft (NOT a submission) from computed analysis + user selection.
import { formatKRW } from "./scenario.js";

const DIR = { in: "수취", out: "지급" };
const TRADE = { export: "수출", import: "수입" };
const COMPANY_TYPE = { corporation: "법인", sole_proprietor: "개인사업자" };
const APPETITE = { low: "안정", medium: "중립", high: "공격" };
const PURPOSE = {
  fx_hedge: "환헤지",
  working_capital: "운전자금",
  export_receivable: "수출대금 회수",
  guarantee_insurance: "보증·보험",
  policy_fund: "정책자금",
};

function esc(s) {
  return String(s).replace(/[<>&"']/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fmtDateTime(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const fmtKrw = (value) => Number.isFinite(value) ? formatKRW(value) : "-";

// 추천 결과의 전역 질문 문자열은 화면 표시에는 편리하지만, 상담 인계물에서는
// 어느 상품의 확인사항인지 잃기 쉽다. 보류 상품 질문은 상품 귀속을 보존하고,
// 상품에 속하지 않는 목적별 안내만 기존 문자열로 남긴다.
export function questionsForRecommendation(recommendation = {}) {
  if (!recommendation || typeof recommendation !== "object" || Array.isArray(recommendation)) return [];
  const result = [];
  const ownedQuestions = new Set();
  const seen = new Set();

  for (const item of Array.isArray(recommendation.pending) ? recommendation.pending : []) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const productId = typeof item.product_id === "string" ? item.product_id.trim() : "";
    const productName = typeof item.name === "string" ? item.name.trim() : "";
    if (!productName) continue;
    for (const value of Array.isArray(item.questions) ? item.questions : []) {
      const question = typeof value === "string" ? value.trim() : "";
      if (!question) continue;
      ownedQuestions.add(question);
      const key = `${productId || productName}\u0000${question}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ product_id: productId, productName, question });
    }
  }

  for (const value of Array.isArray(recommendation.questions) ? recommendation.questions : []) {
    const question = typeof value === "string" ? value.trim() : "";
    if (!question || ownedQuestions.has(question) || seen.has(`global\u0000${question}`)) continue;
    seen.add(`global\u0000${question}`);
    result.push(question);
  }
  return result;
}

export function buildBrief(ctx) {
  const {
    cashflows = [],
    netRows = [],
    scenarios = [],
    countries = [],
    selectedProducts = [],
    company = {},
    liquidity = {},
    cfar = {},
    questions = [],
    counterfactualHighlight = null,
    asOf = "",
    now = new Date(),
  } = ctx;

  const nowDate = now instanceof Date ? now : new Date(now);
  const dateTime = fmtDateTime(nowDate);
  const worst = scenarios.length
    ? scenarios.reduce((a, b) => (b.totalPnl < a.totalPnl ? b : a))
    : null;

  const cfRows = cashflows
    .map(
      (c) =>
        `<tr><td>${esc(c.countryName || c.country)}</td><td>${esc(c.currency)}</td><td>${TRADE[c.tradeType] || esc(c.tradeType || "-")}</td><td>${DIR[c.direction] || esc(c.direction)}</td>` +
        `<td class="num">${Number(c.amount).toLocaleString()}</td><td>${esc(c.months)}개월 후</td></tr>`
    )
    .join("");

  const netList = netRows
    .map(
      (r) =>
        `<li>${esc(r.currency)}: 순 ${r.net >= 0 ? "수취" : "지급"} ${Math.abs(r.net).toLocaleString()} ${esc(r.currency)}</li>`
    )
    .join("");

  const prodList =
    selectedProducts
      .map((p) => `<li><strong>${esc(p.name)}</strong> <span class="muted">(${esc(p.category)})</span>
        ${p.reason ? `<div>${esc(p.reason)}</div>` : ""}
        ${Array.isArray(p.verifiedConditions) && p.verifiedConditions.length
          ? `<div class="muted">확인된 자격: ${esc(p.verifiedConditions.join(" · "))}</div>`
          : ""}
        ${p.source?.url
          ? `<div class="muted">규칙 근거: <a href="${esc(p.source.url)}">${esc(p.source.document_title || p.source.institution || "근거 문서")}</a></div>`
          : ""}
      </li>`)
      .join("") || "<li>(선택된 상품 없음)</li>";

  const ctryList = countries.map((country) => {
    const parts = [esc(country.name)];
    if (Number.isFinite(country.exposureShare)) parts.push(`거래비중 ${(country.exposureShare * 100).toFixed(1)}%`);
    else parts.push("거래비중 미확인");
    if (country.gdpGrowth) parts.push(`GDP 성장률 ${Number(country.gdpGrowth.value).toLocaleString("ko-KR", { maximumFractionDigits: 2 })}% (${esc(country.gdpGrowth.year)})`);
    if (country.inflation) parts.push(`소비자물가 상승률 ${Number(country.inflation.value).toLocaleString("ko-KR", { maximumFractionDigits: 2 })}% (${esc(country.inflation.year)})`);
    return parts.join(" · ");
  }).join("<br>");
  const hedges = Array.isArray(company.existingHedges) ? company.existingHedges : null;
  const hedgeText = hedges && hedges.length
    ? hedges.map((hedge) =>
      `${esc(hedge.currency)} ${Number(hedge.amount).toLocaleString()} · ${esc(hedge.maturityMonths)}개월`
      + (hedge.instrumentType ? ` · ${esc(hedge.instrumentType)}` : "")).join(" / ")
    : hedges ? "기존 헤지 없음 (사용자 확정)" : "확인 필요";
  const purposeText = (company.requestedPurposes || []).map((item) => PURPOSE[item] || item).join(", ") || "-";
  const strategy = cfar.comparisonStrategy;
  const questionList = Array.isArray(questions) && questions.length
    ? questions.map((item) => {
      if (typeof item === "string") return `<li>${esc(item)}</li>`;
      if (item && typeof item === "object" && !Array.isArray(item)
          && typeof item.productName === "string" && typeof item.question === "string")
        return `<li><strong>${esc(item.productName)} 검토 시:</strong> ${esc(item.question)}</li>`;
      return "";
    }).join("") || "<li>현재 화면에서 추가 확인이 필요한 자격 질문 없음</li>"
    : "<li>현재 화면에서 추가 확인이 필요한 자격 질문 없음</li>";

  const html = `
  <div class="brief">
    <h1>KB 수출입 금융 상담 신청서 <span class="draft">초안 · 제출본 아님</span></h1>
    <p class="brief-meta">생성일시 ${dateTime} · 데이터 기준일 ${esc(asOf)}</p>

    <h2>1. 기업·상담 목적</h2>
    <ul>
      <li>기업 형태: <strong>${esc(COMPANY_TYPE[company.companyType] || "확인 필요")}</strong></li>
      <li>기업 규모: <strong>${company.isSme === true ? "중소기업" : company.isSme === false ? "중소기업 아님" : "확인 필요"}</strong></li>
      <li>위험성향: <strong>${esc(APPETITE[company.riskAppetite] || "확인 필요")}</strong></li>
      <li>지원 목적: <strong>${esc(purposeText)}</strong></li>
      <li>기존 헤지: <strong>${hedgeText}</strong></li>
    </ul>

    <h2>2. 거래 요약</h2>
    <table class="brief-table">
      <thead><tr><th>거래국</th><th>통화</th><th>수출/수입</th><th>수취/지급</th><th>금액</th><th>시점</th></tr></thead>
      <tbody>${cfRows}</tbody>
    </table>

    <h2>3. 위험·유동성 요약</h2>
    <p>CFaR(보수적 단순합): <strong>${fmtKrw(cfar.totalKrw)}</strong></p>
    ${strategy ? `<p>${esc(strategy.key)} 비교 시나리오 · 헤지율 ${Math.round(strategy.hedgeRatio * 100)}%:
      잔여 CFaR <strong>${fmtKrw(strategy.residualCFaR)}</strong> ·
      헤지 비용(별도) <strong>${fmtKrw(strategy.hedgeCost)}</strong><br>
      <span class="muted">${esc(strategy.assumptionsLabel || "데모 가정")} · 실제 상품 효과가 아님</span></p>` : ""}
    <p>기초 현금잔고 ${fmtKrw(liquidity.openingBalanceKrw)} +
      사용 가능 신용한도 ${fmtKrw(liquidity.creditLineKrw)} ·
      최대 유동성 부족액 <strong>${fmtKrw(Number.isFinite(liquidity.worstShortfallKrw) ? liquidity.worstShortfallKrw : 0)}</strong></p>

    <h2>4. 통화별 총 순노출 (만기별 관리대상 별도 확인)</h2>
    <ul>${netList}</ul>
    ${
      worst && worst.totalPnl < 0
        ? `<p>표시 시나리오 중 합계 손익이 가장 불리한 경우
          (${Math.round(worst.delta * 100)}%): <strong>${fmtKrw(worst.totalPnl)}</strong></p>`
        : ""
    }

    <h2>5. 거래국 모니터링 참고정보</h2>
    <p>${ctryList || "-"}</p>
    <p class="muted">입력 거래의 원화환산 명목 비중과 World Bank 관측값이며 국가위험등급·예측·상품 판정값이 아닙니다.</p>

    <h2>6. 상담 희망 상품과 판정 근거</h2>
    <ul>${prodList}</ul>

    <h2>7. 상담 시 추가 확인사항</h2>
    <ul>${questionList}</ul>
    ${counterfactualHighlight ? `<p><strong>재검증:</strong> ${esc(counterfactualHighlight.label)}
      · CFaR 변화 ${fmtKrw(counterfactualHighlight.cfarDeltaKrw)}
      · 최대 유동성 부족액 변화 ${fmtKrw(counterfactualHighlight.shortfallDeltaKrw)}</p>` : ""}

    <h2>8. 상담 요청</h2>
    <p>위 내용으로 금융기관 담당자 상담을 요청합니다. 실제 상품 조건·자격·한도·환율·보험 인수 여부는 상담 및 심사를 통해 확정됩니다.</p>

    <p class="brief-disclaimer">※ 본 문서는 입력값과 예시 데이터로 자동 생성된 <strong>상담용 초안</strong>이며,
      투자·금융상품 권유나 계약·신청의 효력이 없습니다. 실제 거래 전 금융기관 담당자 상담 및 심사가 필요합니다.</p>
  </div>`;

  return { html, filename: `KB상담신청서_${dateTime.slice(0, 10)}.html` };
}
