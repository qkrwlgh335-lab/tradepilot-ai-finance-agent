import { ruleCounterExamples } from "./counter.js";
import {
  buildAnalysisPayload,
  validateAnalysisPayload,
} from "./privacy.js";
import { recordAudit } from "./audit.js";

export const FALLBACK_NOTICE =
  "외부 AI 설명을 사용할 수 없어 검증된 규칙 설명으로 전환했습니다.";
export const NON_ADVICE =
  "※ 참고 정보이며 금융 자문이 아닙니다. 실행 전 금융기관 담당자 상담·심사가 필요합니다.";

const AUDIT_META = Object.freeze({
  promptTemplateVersion: "t9-v1",
  policyVersion: "egress-v1",
  corpusHash: "product-kb-v1",
});
const PURPOSE_LABEL = Object.freeze({
  fx_hedge: "환헤지",
  working_capital: "운전자금",
  export_receivable: "수출대금 회수",
  guarantee_insurance: "보증·보험",
  policy_fund: "정책자금",
});

async function govern({ purpose, context, provider, auditStore }) {
  const analysisPayload = buildAnalysisPayload(context);
  const checked = validateAnalysisPayload(analysisPayload);
  let text = null;
  if (checked.ok) {
    try {
      text = provider
        ? await provider.complete({ purpose, analysisPayload: checked.value })
        : null;
    } catch {
      text = null;
    }
  }

  // 감사로그는 실제 외부 전송 경계만 기록한다. 로컬 규칙/mock은 egress가 아니다.
  if (auditStore && provider?.mode === "external") {
    recordAudit(auditStore, {
      purpose,
      approval: !!provider?.approved,
      provider: provider?.mode || "off",
      modelId: provider?.modelId || "none",
      ...AUDIT_META,
      outcome: text ? "success" : "fallback",
      sentFields: provider?.mode === "external" && provider?.approved
        ? Object.keys(checked.value)
        : [],
    });
  }
  return text;
}

export async function explainCounterExamples(context, {
  provider,
  auditStore,
} = {}) {
  const text = await govern({
    purpose: "counter_examples",
    context,
    provider,
    auditStore,
  });
  const body = text || ruleCounterExamples(context.strategies || [])
    .map((item) => `Q. ${item.q}\n${item.a}`)
    .join("\n\n");
  return `${body}\n\n${NON_ADVICE}`;
}

export async function explainProducts(context, {
  provider,
  auditStore,
} = {}) {
  const text = await govern({
    purpose: "product_explanation",
    context,
    provider,
    auditStore,
  });
  const body = text || (context.products || [])
    .map((product) => {
      const purpose = PURPOSE_LABEL[product.purpose] || product.purpose || "요청 목적";
      const evidence = product.matchedText
        ? `연결 문서 근거는 “${product.matchedText}”입니다.`
        : "공개용 합성 자격 규칙을 통과했으며 문서 근거는 화면의 상세 영역에서 확인할 수 있습니다.";
      return `• ${product.name} (${purpose}): ${evidence}\n`
        + `  공개본의 규칙은 합성이며 실제 적용 범위·한도·비용은 금융기관 담당자에게 확인하세요.`;
    })
    .join("\n\n");
  return `${body}\n\n${NON_ADVICE}`;
}
