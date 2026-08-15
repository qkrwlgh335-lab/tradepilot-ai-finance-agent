// SHACL의 그래프 제약 검증 원리를 참고한 경량 폐쇄형 검증기 (실제 SHACL 아님).
// 현재 단계(T5): 프로파일이 온톨로지 스키마의 필수 사실과 값 제약을 만족하는지 검증한다.
// 정보 없음 = 충족이 아니다. 누락은 missingFacts, 잘못된 값은 violations 로 분리 보고한다.
import { createSourceRegistry } from "./sources.js";

const isFiniteNum = (v) => typeof v === "number" && Number.isFinite(v);
const isNonEmptyString = (v) => typeof v === "string" && v.trim() !== "";

const PRODUCT_STATUSES = ["available", "unavailable_unverified_source", "unavailable_invalid_knowledge"];
const CANONICAL_PRODUCT_ID = /^[a-z][a-z0-9_]*$/;

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const hasOwn = (object, key) => isObject(object) && Object.prototype.hasOwnProperty.call(object, key);
const isRealIsoDate = (value) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};

export const OPERATORS = Object.freeze({
  eq: (actual, expected) => Object.is(actual, expected),
  neq: (actual, expected) => !Object.is(actual, expected),
  gt: (actual, expected) => isFiniteNum(actual) && isFiniteNum(expected) && actual > expected,
  gte: (actual, expected) => isFiniteNum(actual) && isFiniteNum(expected) && actual >= expected,
  lt: (actual, expected) => isFiniteNum(actual) && isFiniteNum(expected) && actual < expected,
  lte: (actual, expected) => isFiniteNum(actual) && isFiniteNum(expected) && actual <= expected,
  in: (actual, expected) => Array.isArray(expected) && expected.includes(actual),
  not_in: (actual, expected) => Array.isArray(expected) && !expected.includes(actual),
  includes_any: (actual, expected) => Array.isArray(actual) && Array.isArray(expected)
    && actual.some((value) => expected.includes(value)),
  subset_of: (actual, expected) => Array.isArray(actual) && Array.isArray(expected)
    && actual.every((value) => expected.includes(value)),
  between: (actual, expected) => isFiniteNum(actual) && Array.isArray(expected)
    && expected.length === 2 && expected.every(isFiniteNum)
    && actual >= expected[0] && actual <= expected[1],
  is_true: (actual) => actual === true,
  is_false: (actual) => actual === false,
  date_within: (actual, expected) => isRealIsoDate(actual) && isObject(expected)
    && isRealIsoDate(expected.from) && isRealIsoDate(expected.to)
    && expected.from <= actual && actual <= expected.to,
  lte_by: (actual, expected, context = {}) => isFiniteNum(actual) && isObject(expected)
    && isObject(expected.thresholds) && isFiniteNum(expected.thresholds[context.selector])
    && actual <= expected.thresholds[context.selector],
});

const readOwnPath = (root, parts) => {
  let value = root;
  for (const part of parts) {
    if (!hasOwn(value, part)) return undefined;
    value = value[part];
  }
  return value;
};

export function resolveFact(profile, factPath) {
  if (!isObject(profile) || !isNonEmptyString(factPath)) return undefined;
  const parts = factPath.split(".");
  if (parts.length < 2 || parts.some((part) => part === "")) return undefined;
  const [namespace, ...path] = parts;

  if (namespace === "company") {
    const company = profile.facts && profile.facts.company;
    if (path.join(".") === "companyScale") {
      const explicit = readOwnPath(company, path);
      if (explicit !== undefined && explicit !== null && explicit !== "unknown") return explicit;
      return company && company.isSme === true ? "sme" : undefined;
    }
    return readOwnPath(company, path);
  }

  if (namespace === "exposure") {
    if (path.join(".") === "maxExportHorizonMonths") {
      if (!Array.isArray(profile.transactions)) return undefined;
      const exports = profile.transactions.filter((transaction) => transaction && transaction.tradeType === "export");
      if (exports.length === 0 || exports.some((transaction) => !isFiniteNum(transaction.months) || transaction.months < 0))
        return undefined;
      return Math.max(...exports.map((transaction) => transaction.months));
    }
    return readOwnPath(profile.derived, path);
  }

  if (namespace === "context") {
    const direct = readOwnPath(profile.context, path);
    return direct !== undefined ? direct : readOwnPath(profile.facts && profile.facts.context, path);
  }

  if (namespace === "product") {
    const direct = readOwnPath(profile.product, path);
    return direct !== undefined ? direct : readOwnPath(profile.facts && profile.facts.product, path);
  }

  return undefined;
}

const operatorValueIsConfigured = (operator, value) => {
  if (operator === "is_true" || operator === "is_false") return value === undefined;
  if (["gt", "gte", "lt", "lte"].includes(operator)) return isFiniteNum(value);
  if (["in", "not_in", "includes_any", "subset_of"].includes(operator))
    return Array.isArray(value) && value.length > 0;
  if (operator === "between")
    return Array.isArray(value) && value.length === 2 && value.every(isFiniteNum) && value[0] <= value[1];
  if (operator === "date_within")
    return isObject(value) && isRealIsoDate(value.from) && isRealIsoDate(value.to) && value.from <= value.to;
  if (operator === "lte_by")
    return isObject(value) && isNonEmptyString(value.selector_fact_path) && isObject(value.thresholds)
      && Object.keys(value.thresholds).length > 0
      && Object.values(value.thresholds).every((threshold) => isFiniteNum(threshold) && threshold > 0);
  return value !== undefined;
};

const operatorActualIsUsable = (operator, actual) => {
  if (["gt", "gte", "lt", "lte", "between", "lte_by"].includes(operator)) return isFiniteNum(actual);
  if (operator === "is_true" || operator === "is_false") return typeof actual === "boolean";
  if (operator === "date_within") return isRealIsoDate(actual);
  if (operator === "includes_any" || operator === "subset_of") return Array.isArray(actual);
  return actual !== undefined && actual !== null;
};

const unknownRuleResult = (rule, { question, configurationError = false, missingFactPath } = {}) => ({
  rule_id: rule && rule.rule_id,
  product_id: rule && rule.product_id,
  field: rule && rule.field,
  source_id: rule && rule.source_id,
  status: "unknown",
  actual: undefined,
  question: question || (rule && rule.missing_info_question) || "판정에 필요한 정보를 확인해 주세요.",
  ...(isNonEmptyString(missingFactPath) ? { missing_fact_path: missingFactPath } : {}),
  ...(configurationError ? { configuration_error: true } : {}),
});

export function evaluateRule(rule, profile) {
  if (!isObject(rule) || !isNonEmptyString(rule.rule_id) || !isNonEmptyString(rule.fact_path)
      || !isNonEmptyString(rule.operator) || typeof OPERATORS[rule.operator] !== "function"
      || !operatorValueIsConfigured(rule.operator, rule.value)) {
    return unknownRuleResult(rule, {
      question: "규칙 설정을 확인할 수 없어 자동 판정을 보류합니다.",
      configurationError: true,
    });
  }

  const actual = resolveFact(profile, rule.fact_path);
  if (actual === undefined || actual === null || (typeof actual === "number" && !Number.isFinite(actual)))
    return unknownRuleResult(rule, { missingFactPath: rule.fact_path });
  if (!operatorActualIsUsable(rule.operator, actual))
    return unknownRuleResult(rule, { missingFactPath: rule.fact_path });

  const context = {};
  if (rule.operator === "lte_by") {
    context.selector = resolveFact(profile, rule.value.selector_fact_path);
    if (context.selector === undefined || context.selector === null
        || !hasOwn(rule.value.thresholds, context.selector))
      return unknownRuleResult(rule, { missingFactPath: rule.value.selector_fact_path });
  }

  const passed = OPERATORS[rule.operator](actual, rule.value, context);
  const base = {
    rule_id: rule.rule_id,
    product_id: rule.product_id,
    field: rule.field,
    source_id: rule.source_id,
    status: passed ? "pass" : "fail",
    actual,
    expected: rule.value,
  };
  return passed ? base : {
    ...base,
    reason: rule.failure_reason || "공개용 합성 자격 조건을 충족하지 않습니다.",
  };
}

const emptyRecommendation = (questions = []) => ({
  candidates: [],
  excluded: [],
  pending: [],
  unavailable: [],
  questions: [...questions],
  byPurpose: [],
});

const uniqueStrings = (values) => {
  const seen = new Set();
  const result = [];
  for (const value of values || []) {
    if (!isNonEmptyString(value) || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
};

const recommendationKnowledgeStatus = ({
  product, edges, nodeById, ruleById, duplicateRuleIds, gapById, registry, profile,
}) => {
  const productEdges = edges.filter((edge) => edge && edge.from === product.id);
  const supported = productEdges.filter((edge) => edge.rel === "supportedBy");
  const activeSameProduct = supported.filter((edge) => {
    if (!registry.isActive(edge.to)) return false;
    const source = registry.get(edge.to);
    return source && source.source_kind === "product_terms" && source.product_id === product.product_id;
  });
  if (activeSameProduct.length === 0) return "unavailable_unverified_source";

  const linkedSources = new Set(activeSameProduct.map((edge) => edge.to));
  const requires = productEdges.filter((edge) => edge.rel === "requires");
  const requiredStrings = [
    "rule_id", "product_id", "field", "fact_path", "operator",
    "failure_reason", "missing_info_question", "source_id",
  ];
  const rulesComplete = requires.length > 0 && requires.every((edge) => {
    if (gapById.has(edge.to) || duplicateRuleIds.has(edge.to)) return false;
    const rule = ruleById.get(edge.to);
    if (!isObject(rule) || rule.product_id !== product.product_id || rule.required !== true) return false;
    if (!requiredStrings.every((field) => isNonEmptyString(rule[field]))) return false;
    if (!linkedSources.has(rule.source_id)) return false;
    if (!registry.canSupport(rule.source_id, product.product_id, rule.field)) return false;
    return evaluateRule(rule, profile).configuration_error !== true;
  });
  const providerComplete = productEdges.some((edge) => edge.rel === "providedBy"
    && nodeById.get(edge.to)?.type === "Institution");
  const riskComplete = productEdges.some((edge) => edge.rel === "mitigates"
    && nodeById.get(edge.to)?.type === "Risk");
  const purposeComplete = productEdges.some((edge) => edge.rel === "supportsPurpose"
    && nodeById.get(edge.to)?.type === "Purpose");
  const allEvidenceValid = supported.length === activeSameProduct.length;
  const derived = providerComplete && riskComplete && purposeComplete && rulesComplete && allEvidenceValid
    ? "available"
    : "unavailable_invalid_knowledge";
  if (derived === "available" && product.productKnowledgeStatus !== "available")
    return PRODUCT_STATUSES.includes(product.productKnowledgeStatus)
      ? product.productKnowledgeStatus
      : "unavailable_invalid_knowledge";
  return derived;
};

const buildReasoningPath = ({ profile, product, purpose, riskId }) => {
  const purposeId = `purpose:${purpose}`;
  const riskType = riskId.startsWith("risk:") ? riskId.slice(5) : riskId;
  const detected = Array.isArray(profile.risks)
    ? profile.risks.find((risk) => risk && risk.riskType === riskType)
    : null;
  const path = [];

  if (detected) {
    const exposure = Array.isArray(profile.exposures)
      ? profile.exposures.find((item) => item && detected.source
        && item.currency === detected.source.currency && item.months === detected.source.months)
        || profile.exposures[0]
      : null;
    const transaction = Array.isArray(profile.transactions)
      ? profile.transactions.find((item) => item && exposure
        && item.currency === exposure.currency && item.months === exposure.months)
        || profile.transactions[0]
      : null;
    const exposureId = exposure ? `exposure:${exposure.currency}:${exposure.months}` : null;
    if (transaction && isNonEmptyString(transaction.transaction_id))
      path.push({ from: "company:profile", rel: "hasTransaction", to: `transaction:${transaction.transaction_id}`, basis: "profile" });
    if (transaction && exposureId)
      path.push({ from: `transaction:${transaction.transaction_id}`, rel: "createsExposure", to: exposureId, basis: "profile" });
    if (exposureId) {
      path.push({ from: "company:profile", rel: "hasExposure", to: exposureId, basis: "profile" });
      path.push({ from: exposureId, rel: "hasRisk", to: riskId, basis: "profile.risks" });
    }
  } else {
    path.push({ from: "company:profile", rel: "hasPurpose", to: purposeId, basis: "requestedPurposes" });
  }

  path.push({ from: product.id, rel: "mitigates", to: riskId, basis: "knowledge-graph" });
  path.push({ from: product.id, rel: "supportsPurpose", to: purposeId, basis: "knowledge-graph" });
  path.push({ from: purposeId, rel: "matchedByRule", to: product.id, basis: "eligibility-rules" });
  return path;
};

export function recommend(input) {
  const invalid = (message) => emptyRecommendation([message]);
  if (!isObject(input)) return invalid("추천 입력 객체를 확인할 수 없습니다.");

  const { profile, graph, rules, sources, schema, today } = input;
  if (!isObject(profile)) return invalid("기업·거래 프로파일을 확인할 수 없습니다.");
  if (!Array.isArray(profile.requestedPurposes)
      || (profile.transactions !== undefined && !Array.isArray(profile.transactions))
      || (profile.missingFacts !== undefined && !Array.isArray(profile.missingFacts)))
    return invalid("기업·거래 프로파일의 배열 구조를 확인할 수 없습니다.");
  if (!isObject(graph) || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges))
    return invalid("상품 지식그래프를 확인할 수 없습니다.");
  if (!Array.isArray(sources)) return invalid("근거 출처 레지스트리를 확인할 수 없습니다.");
  if (!isObject(schema) || !isObject(schema.riskToPurpose)
      || !isObject(schema.classes) || !isObject(schema.classes.Company)
      || !isObject(schema.classes.Company.fields)
      || !isObject(schema.classes.TradeTransaction)
      || !isObject(schema.classes.TradeTransaction.fields))
    return invalid("온톨로지 목적 매핑을 확인할 수 없습니다.");

  let ruleList;
  let gapList = [];
  if (Array.isArray(rules)) ruleList = rules;
  else if (isObject(rules) && Array.isArray(rules.rules)) {
    ruleList = rules.rules;
    if ("knowledge_gaps" in rules && !Array.isArray(rules.knowledge_gaps))
      return invalid("상품 지식 공백 목록을 확인할 수 없습니다.");
    gapList = Array.isArray(rules.knowledge_gaps) ? rules.knowledge_gaps : [];
  } else return invalid("상품 자격 규칙을 확인할 수 없습니다.");

  const requestedPurposes = uniqueStrings(profile.requestedPurposes);
  if (requestedPurposes.length === 0) return invalid("필요한 지원 목적을 선택해 주세요.");
  const profileValidation = validateProfile(profile, schema);
  if (profileValidation.violations.length > 0)
    return invalid("프로파일 입력값 오류가 있어 추천 판정을 수행하지 않습니다.");
  const knowledgeValidation = validateProductKnowledge(graph, rules, sources, schema);
  if (!knowledgeValidation.conforms)
    return invalid("상품 지식그래프·규칙·근거 출처의 정합성을 확인할 수 없어 추천 판정을 수행하지 않습니다.");

  const evaluationProfile = {
    ...profile,
    context: {
      ...(isObject(profile.context) ? profile.context : {}),
      ...(today !== undefined ? { today } : {}),
    },
  };
  const registry = createSourceRegistry(sources);
  if (graph.nodes.some((node) => !isObject(node) || !isNonEmptyString(node.id) || !isNonEmptyString(node.type)))
    return invalid("상품 지식그래프 노드의 식별자를 확인할 수 없습니다.");
  const allNodeIds = graph.nodes.map((node) => node.id);
  if (new Set(allNodeIds).size !== allNodeIds.length)
    return invalid("상품 지식그래프에 중복된 노드 식별자가 있습니다.");
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const products = graph.nodes.filter((node) => node && node.type === "FinancialProduct");
  const productIds = products.map((product) => product.product_id);
  if (products.some((product) => !isNonEmptyString(product.id)
      || !isNonEmptyString(product.product_id)
      || product.id !== `prod:${product.product_id}`)
      || new Set(productIds).size !== productIds.length)
    return invalid("상품 지식그래프의 상품 식별자가 유효하지 않습니다.");
  const productById = new Map(products.map((product) => [product.id, product]));

  const ruleCounts = new Map();
  for (const rule of ruleList) {
    if (!rule || !isNonEmptyString(rule.rule_id)) continue;
    ruleCounts.set(rule.rule_id, (ruleCounts.get(rule.rule_id) || 0) + 1);
  }
  const duplicateRuleIds = new Set([...ruleCounts].filter(([, count]) => count > 1).map(([ruleId]) => ruleId));
  const ruleById = new Map();
  for (const rule of ruleList)
    if (rule && isNonEmptyString(rule.rule_id) && !duplicateRuleIds.has(rule.rule_id))
      ruleById.set(rule.rule_id, rule);
  const gapById = new Map();
  for (const gap of gapList)
    if (gap && isNonEmptyString(gap.rule_id)) gapById.set(gap.rule_id, gap);

  const purposeNodeIds = new Set(graph.nodes.filter((node) => node && node.type === "Purpose").map((node) => node.id));

  const result = emptyRecommendation();
  for (const purpose of requestedPurposes) {
    const purposeId = `purpose:${purpose}`;
    const group = { purpose, candidates: [], excluded: [], pending: [], unavailable: [] };
    const relevant = [];
    const relevantProductIds = new Set();
    if (purposeNodeIds.has(purposeId)) {
      for (const edge of graph.edges) {
        if (!edge || edge.rel !== "supportsPurpose" || edge.to !== purposeId) continue;
        const product = productById.get(edge.from);
        const riskEdge = graph.edges.find((candidate) => candidate
          && candidate.from === edge.from
          && candidate.rel === "mitigates"
          && nodeById.get(candidate.to)?.type === "Risk");
        if (product && riskEdge && !relevantProductIds.has(product.product_id)) {
          relevantProductIds.add(product.product_id);
          relevant.push({ product, riskId: riskEdge.to });
        }
      }
    }

    for (const { product, riskId } of relevant) {
      const productKnowledgeStatus = recommendationKnowledgeStatus({
        product,
        edges: graph.edges,
        nodeById,
        ruleById,
        duplicateRuleIds,
        gapById,
        registry,
        profile: evaluationProfile,
      });
      const supportedSources = graph.edges
        .filter((edge) => edge && edge.from === product.id && edge.rel === "supportedBy" && registry.isActive(edge.to))
        .map((edge) => registry.get(edge.to))
        .filter((source) => source && source.product_id === product.product_id);
      const common = {
        product_id: product.product_id,
        name: product.name,
        category: product.category,
        purpose,
        ...(isNonEmptyString(product.scope_note) ? { scope_note: product.scope_note } : {}),
        ...(supportedSources[0] ? { source: supportedSources[0], sources: supportedSources } : {}),
      };

      if (productKnowledgeStatus !== "available") {
        const gaps = graph.edges
          .filter((edge) => edge && edge.from === product.id && edge.rel === "requires" && gapById.has(edge.to))
          .map((edge) => ({ ...gapById.get(edge.to) }));
        const item = {
          ...common,
          productKnowledgeStatus,
          reason: productKnowledgeStatus === "unavailable_unverified_source"
            ? "검증된 공식 상품 출처가 없어 추천 판정을 보류합니다."
            : "근거 출처와 필수 자격 규칙이 완전하게 연결되지 않아 추천 판정을 보류합니다.",
          knowledgeGaps: gaps,
        };
        group.unavailable.push(item);
        result.unavailable.push(item);
        continue;
      }

      const requiredRules = graph.edges
        .filter((edge) => edge && edge.from === product.id && edge.rel === "requires")
        .map((edge) => ruleById.get(edge.to))
        .filter(Boolean);
      const evaluations = requiredRules.map((rule) => evaluateRule(rule, evaluationProfile));
      const failedRules = evaluations.filter((evaluation) => evaluation.status === "fail");
      const unknownRules = evaluations.filter((evaluation) => evaluation.status === "unknown");

      if (failedRules.length > 0) {
        const item = {
          ...common,
          eligibilityStatus: "ineligible",
          failedRules,
          reasons: uniqueStrings(failedRules.map((rule) => rule.reason)),
        };
        group.excluded.push(item);
        result.excluded.push(item);
        continue;
      }

      if (unknownRules.length > 0) {
        const missingByPath = new Map();
        for (const evaluation of unknownRules) {
          const rule = ruleById.get(evaluation.rule_id);
          const factPath = evaluation.missing_fact_path || rule.fact_path;
          if (!missingByPath.has(factPath)) {
            const catalogQuestion = schema.ruleFactCatalog
              && schema.ruleFactCatalog[factPath]
              && schema.ruleFactCatalog[factPath].question;
            missingByPath.set(factPath, {
              factPath,
              rule_ids: [],
              question: isNonEmptyString(catalogQuestion) ? catalogQuestion : evaluation.question,
            });
          }
          missingByPath.get(factPath).rule_ids.push(evaluation.rule_id);
        }
        const item = {
          ...common,
          eligibilityStatus: "needs_information",
          missingFacts: [...missingByPath.values()].map(({ question, ...fact }) => fact),
          questions: uniqueStrings([...missingByPath.values()].map((fact) => fact.question)),
        };
        group.pending.push(item);
        result.pending.push(item);
        result.questions.push(...item.questions);
        continue;
      }

      const passedRules = evaluations.filter((evaluation) => evaluation.status === "pass");
      const item = {
        ...common,
        eligibilityStatus: "eligible",
        reasoningPath: buildReasoningPath({ profile: evaluationProfile, product, purpose, riskId }),
        passedRules,
        eligibilityEvidence: passedRules.map((evaluation) => ({
          rule_id: evaluation.rule_id,
          field: evaluation.field,
          source_id: evaluation.source_id,
          source: registry.get(evaluation.source_id),
        })),
        source: supportedSources[0],
        sources: supportedSources,
        ...(isNonEmptyString(product.scope_note) ? { scope_note: product.scope_note } : {}),
      };
      group.candidates.push(item);
      result.candidates.push(item);
    }

    if (relevant.length === 0) {
      group.note = "확인된 근거 출처와 목적 연결을 갖춘 항목이 없습니다.";
      result.questions.push(`${purpose}: ${group.note}`);
    } else if (group.candidates.length === 0 && group.excluded.length === 0 && group.pending.length === 0) {
      group.note = "확인된 근거 출처와 완전한 자격 규칙을 갖춘 항목이 없습니다.";
      result.questions.push(`${purpose}: ${group.note}`);
    } else if (group.candidates.length === 0) {
      group.note = "현재 입력으로 추천 가능한 후보가 없습니다.";
    }
    result.byPurpose.push(group);
  }

  result.questions = uniqueStrings(result.questions);
  return result;
}

// 상품 지식그래프 검증기(폐쇄형). 관계 계약은 ontology-schema.relations 에서 가져오고, 출처는
// source-registry(sources)로 실제 활성 여부를 확인하며, requires 규칙은 rules 데이터와 대조한다.
// productKnowledgeStatus 는 선언값을 신뢰하지 않고 파생값과 대조한다:
//   활성 동일상품 product_terms 출처 없음        -> unavailable_unverified_source
//   출처는 있으나 provider/mitigates/requires/실제 규칙 미완비 -> unavailable_invalid_knowledge
//   위가 모두 완비                                -> available
export function validateProductKnowledge(graph, rules, sources, schema) {
  const violations = [];
  const v = (o) => violations.push(o);

  // --- fail-closed: 잘못된 컨테이너는 TypeError 대신 violation ---
  if (!graph || typeof graph !== "object" || Array.isArray(graph)) { v({ constraint: "graph", message: "graph가 객체가 아닙니다." }); return { conforms: false, violations }; }
  if (!Array.isArray(graph.nodes)) v({ constraint: "graph", message: "nodes가 배열이 아닙니다." });
  if (!Array.isArray(graph.edges)) v({ constraint: "graph", message: "edges가 배열이 아닙니다." });
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) return { conforms: false, violations };

  // --- dependency 컨테이너 fail-closed: 잘못된 타입을 조용히 기본값으로 바꾸지 않고 violation ---
  let ruleList = null;
  if (Array.isArray(rules)) ruleList = rules;
  else if (rules && typeof rules === "object" && !Array.isArray(rules) && Array.isArray(rules.rules)) ruleList = rules.rules;
  else v({ constraint: "rules_container", message: "rules는 배열 또는 {rules: 배열}이어야 합니다." });

  // knowledge_gaps: 근거 사양에서 확정되지 않아 규칙화할 수 없는 필수 조건(available 승격 차단).
  // 컨테이너 fail-closed: 존재하면 배열이어야 한다(잘못된 타입은 조용히 [] 로 바꾸지 않고 violation).
  let gapList = [];
  if (rules && typeof rules === "object" && !Array.isArray(rules) && "knowledge_gaps" in rules) {
    if (Array.isArray(rules.knowledge_gaps)) gapList = rules.knowledge_gaps;
    else v({ constraint: "gaps_container", message: "knowledge_gaps는 배열이어야 합니다." });
  }

  const sourceList = Array.isArray(sources) ? sources : null;
  if (sourceList === null) v({ constraint: "sources_container", message: "sources는 배열이어야 합니다." });

  const isObj = (o) => o && typeof o === "object" && !Array.isArray(o);
  const isUniqueStringArray = (a) => Array.isArray(a) && a.length > 0
    && a.every(isNonEmptyString) && new Set(a).size === a.length;
  const relationsAreValid = (relations) => isObj(relations) && Object.keys(relations).length > 0
    && Object.values(relations).every((rel) => {
      if (!isObj(rel) || !isNonEmptyString(rel.range) || !["asserted", "derived"].includes(rel.kind)) return false;
      return isNonEmptyString(rel.domain) || isUniqueStringArray(rel.domain);
    });
  const externalPrefixesAreValid = (prefixes) => isObj(prefixes)
    && isNonEmptyString(prefixes.EligibilityRule) && isNonEmptyString(prefixes.EvidenceSource);
  const ALLOWED_VALUE_KINDS = new Set(["none", "any_required", "number", "non_empty_array", "range2", "date_range", "threshold_map"]);
  const ALLOWED_FACT_TYPES = new Set(["boolean", "number", "enum", "string", "array", "date"]);
  const operatorMapsAreValid = (operators, valueKinds, factTypes) => isUniqueStringArray(operators)
    && isObj(valueKinds) && isObj(factTypes)
    && Object.keys(valueKinds).length === operators.length
    && Object.keys(factTypes).length === operators.length
    && operators.every((op) => ALLOWED_VALUE_KINDS.has(valueKinds[op])
      && isUniqueStringArray(factTypes[op])
      && factTypes[op].every((type) => ALLOWED_FACT_TYPES.has(type)));
  const factCatalogIsValid = (catalog) => isObj(catalog) && Object.keys(catalog).length > 0
    && Object.entries(catalog).every(([path, def]) => {
      if (!isNonEmptyString(path) || !isObj(def) || !ALLOWED_FACT_TYPES.has(def.type) || !isNonEmptyString(def.question)) return false;
      return def.type !== "enum" || isUniqueStringArray(def.values);
    });
  const schemaOk = isObj(schema) && relationsAreValid(schema.relations)
    && isUniqueStringArray(schema.graphNodeClasses)
    && externalPrefixesAreValid(schema.externalRangePrefix)
    && isUniqueStringArray(schema.operators)
    && operatorMapsAreValid(schema.operators, schema.operatorValueKinds, schema.operatorFactTypes)
    && factCatalogIsValid(schema.ruleFactCatalog);
  if (!schemaOk) v({ constraint: "schema_container", message: "schema에 relations/graphNodeClasses/externalRangePrefix/operators/operatorValueKinds/operatorFactTypes/ruleFactCatalog가 올바른 타입으로 있어야 합니다." });

  if (ruleList === null || sourceList === null || !schemaOk) return { conforms: false, violations };

  const relations = schema.relations;
  const graphNodeClasses = new Set(schema.graphNodeClasses);
  const externalRangePrefix = schema.externalRangePrefix;
  const schemaOperators = schema.operators;
  const operatorValueKinds = schema.operatorValueKinds;
  const operatorFactTypes = schema.operatorFactTypes;
  const ruleFactCatalog = schema.ruleFactCatalog;
  const reg = createSourceRegistry(sourceList);

  // operator value 의미 검증(값 존재만이 아니라 형태·범위까지). schema.operatorValueKinds 기반.
  const isRealDate = (s) => {
    if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const [y, m, d] = s.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  };
  const valueSemanticsOk = (operator, value, fact) => {
    switch (operatorValueKinds[operator]) {
      case "none": return value === undefined;
      case "any_required": return value !== undefined;
      case "number": return isFiniteNum(value);
      case "non_empty_array": {
        if (!Array.isArray(value) || value.length === 0 || new Set(value).size !== value.length) return false;
        if (fact?.type === "enum") return value.every((item) => typeof item === "string" && fact.values.includes(item));
        if (fact?.type === "string") return value.every(isNonEmptyString);
        return value.every((item) => item !== undefined && item !== null && ["string", "number", "boolean"].includes(typeof item));
      }
      case "range2": return Array.isArray(value) && value.length === 2 && value.every(isFiniteNum) && value[0] <= value[1];
      case "date_range": return isObj(value) && isRealDate(value.from) && isRealDate(value.to) && value.from <= value.to;
      case "threshold_map": {
        if (!isObj(value) || !isNonEmptyString(value.selector_fact_path) || !isObj(value.thresholds)) return false;
        const selector = ruleFactCatalog[value.selector_fact_path];
        if (!selector || !["enum", "string"].includes(selector.type)) return false;
        const keys = Object.keys(value.thresholds);
        if (keys.length === 0 || !Object.values(value.thresholds).every((t) => isFiniteNum(t) && t > 0)) return false;
        return selector.type !== "enum" || keys.every((key) => selector.values.includes(key));
      }
      default: return false;
    }
  };

  // --- rules 색인 + 중복 rule_id 차단 (중복은 available 계산에 사용 불가) ---
  const ruleCount = new Map();
  for (const r of ruleList) { const id = r && r.rule_id; if (typeof id === "string") ruleCount.set(id, (ruleCount.get(id) || 0) + 1); }
  const dupRuleIds = new Set([...ruleCount].filter(([, n]) => n > 1).map(([id]) => id));
  for (const id of dupRuleIds) v({ ruleId: id, constraint: "duplicate_rule_id", message: `rule_id 중복: ${id}` });
  const ruleById = new Map();
  for (const r of ruleList) if (r && typeof r.rule_id === "string" && !dupRuleIds.has(r.rule_id)) ruleById.set(r.rule_id, r);

  // requires 가 가리키는 규칙이 "완비"돼야 available 을 만들 수 있다(껍데기·타상품·잘못된 출처 규칙 금지).
  // value 는 값이 필요한 연산자에만 요구한다(is_true/is_false 제외).
  const REQUIRED_RULE_FIELDS = ["rule_id", "product_id", "field", "fact_path", "operator", "required", "failure_reason", "missing_info_question", "source_id"];
  const VALUE_OPERATORS = new Set(schemaOperators.filter((op) => op !== "is_true" && op !== "is_false"));
  const ruleActivates = (ruleId, product) => {
    const rule = ruleById.get(ruleId);
    if (!rule) return false;
    for (const f of REQUIRED_RULE_FIELDS) {
      const val = rule[f];
      if (val === undefined || val === null) return false;
      if (typeof val === "string" && val.trim() === "") return false;
    }
    for (const f of ["rule_id", "product_id", "field", "fact_path", "operator", "failure_reason", "missing_info_question", "source_id"])
      if (!isNonEmptyString(rule[f])) return false;
    if (!/^rule:/.test(rule.rule_id)) return false;
    if (rule.product_id !== product.product_id) return false;
    if (!schemaOperators.includes(rule.operator)) return false;
    // fact_path 는 카탈로그에 있어야 하고, operator 와 fact 타입이 호환돼야 한다.
    const fact = ruleFactCatalog[rule.fact_path];
    if (!fact || !(operatorFactTypes[rule.operator] || []).includes(fact.type)) return false;
    if (!valueSemanticsOk(rule.operator, rule.value, fact)) return false;
    if (rule.required !== true) return false;                       // requires 가 가리키는 규칙은 required===true
    if (!reg.isActive(rule.source_id)) return false;
    const s = reg.get(rule.source_id);
    if (!s || s.source_kind !== "product_terms" || s.product_id !== rule.product_id) return false;
    return reg.canSupport(rule.source_id, product.product_id, rule.field);
  };

  // --- 노드 식별자: 모든 node.id 는 비어 있지 않은 문자열, type 은 graphNodeClasses ---
  const nodeById = new Map();
  const seenNodeIds = new Set();
  const seenProductIds = new Set();
  for (const n of graph.nodes) {
    if (!n || typeof n !== "object") { v({ constraint: "node", message: "node가 객체가 아닙니다." }); continue; }
    if (typeof n.id !== "string" || n.id.trim() === "") { v({ constraint: "node_id", message: `node.id는 비어 있지 않은 문자열이어야 합니다: ${JSON.stringify(n.id)}` }); continue; }
    if (seenNodeIds.has(n.id)) v({ nodeId: n.id, constraint: "duplicate_node_id", message: `node.id 중복: ${n.id}` });
    seenNodeIds.add(n.id);
    nodeById.set(n.id, n);
    if (!graphNodeClasses.has(n.type)) v({ nodeId: n.id, constraint: "node_type", message: `알 수 없는 노드 타입: ${n.type}` });
  }

  const products = graph.nodes.filter((n) => n && n.type === "FinancialProduct");
  for (const p of products) {
    if (typeof p.product_id !== "string" || !CANONICAL_PRODUCT_ID.test(p.product_id)) {
      v({ nodeId: p.id, constraint: "product_id", message: `canonical product_id 아님: ${p.product_id}` });
    } else {
      if (seenProductIds.has(p.product_id)) v({ nodeId: p.id, constraint: "duplicate_product_id", message: `product_id 중복: ${p.product_id}` });
      seenProductIds.add(p.product_id);
      if (p.id !== `prod:${p.product_id}`) v({ nodeId: p.id, constraint: "node_id_format", message: `node.id는 prod:${p.product_id} 여야 합니다.` });
    }
    if (!PRODUCT_STATUSES.includes(p.productKnowledgeStatus)) v({ nodeId: p.id, constraint: "status_enum", message: `잘못된 productKnowledgeStatus: ${p.productKnowledgeStatus}` });
    if ("assumptions" in p) v({ nodeId: p.id, constraint: "assumptions", message: "FinancialProduct는 assumptions 필드를 가질 수 없습니다." });
    // 속성은 활성 동일상품 product_terms 출처가 그 필드를 지원할 때만 허용.
    for (const [k] of Object.entries(p.attributes || {})) {
      const sid = p.attribute_sources && p.attribute_sources[k];
      if (!sid || !reg.canSupport(sid, p.product_id, k))
        v({ nodeId: p.id, constraint: "attribute_source", message: `${p.id}.${k}: 활성 동일상품 출처가 지원하지 않는 수치 속성` });
    }
  }

  // --- supportedBy 엣지 자체 검증(선언 상태와 무관): 활성 동일상품 product_terms 출처만 허용 ---
  // 미검증 상품은 잘못된 supportedBy 를 남기는 게 아니라 supportedBy 가 아예 없어야 한다.
  const isValidEvidence = (to, product) => {
    if (!reg.isActive(to)) return false;
    const s = reg.get(to);
    return !!(s && s.source_kind === "product_terms" && s.product_id === product.product_id);
  };
  for (const p of products) {
    for (const e of graph.edges.filter((e) => e && e.from === p.id && e.rel === "supportedBy")) {
      if (!isValidEvidence(e.to, p))
        v({ edge: e, constraint: "evidence_edge", message: `${p.id}의 supportedBy는 활성 동일상품 product_terms 출처여야 합니다: ${e.to}` });
    }
  }

  // --- 규칙(rules) 자체 검증: 근거 출처 기반 필수 필드·연산자·출처 정합성 ---
  const productIdSet = new Set(products.map((p) => p.product_id));
  for (const rule of ruleById.values()) {
    const rid = rule.rule_id;
    if (!/^rule:/.test(rid)) v({ ruleId: rid, constraint: "rule_id_format", message: `rule_id는 rule: 접두사여야 합니다: ${rid}` });
    for (const f of REQUIRED_RULE_FIELDS) {
      const val = rule[f];
      if (val === undefined || val === null || (typeof val === "string" && val.trim() === "")) v({ ruleId: rid, constraint: "rule_missing_field", message: `필수 필드 누락: ${f}` });
    }
    if (!isNonEmptyString(rule.fact_path)) v({ ruleId: rid, constraint: "rule_fact_path", message: "fact_path는 비어 있지 않은 문자열이어야 합니다." });
    const operatorKnown = schemaOperators.includes(rule.operator);
    if (!operatorKnown) v({ ruleId: rid, constraint: "rule_operator", message: `알 수 없는 operator: ${rule.operator}` });
    if (typeof rule.required !== "boolean") v({ ruleId: rid, constraint: "rule_required_type", message: "required는 boolean이어야 합니다." });
    if (operatorKnown) {
      const fact = ruleFactCatalog[rule.fact_path];
      if (VALUE_OPERATORS.has(rule.operator) && rule.value === undefined) v({ ruleId: rid, constraint: "rule_value_missing", message: `${rule.operator}에는 value가 필요합니다.` });
      else if (!valueSemanticsOk(rule.operator, rule.value, fact)) v({ ruleId: rid, constraint: "rule_value_invalid", message: `${rule.operator}의 value 형식이 올바르지 않습니다.` });
      // fact_path/selector_fact_path 는 ruleFactCatalog 에 있어야 하고, operator 와 fact 타입이 호환돼야 한다.
      if (!fact) v({ ruleId: rid, constraint: "unknown_fact_path", message: `ruleFactCatalog에 없는 fact_path: ${rule.fact_path}` });
      else if (!(operatorFactTypes[rule.operator] || []).includes(fact.type)) v({ ruleId: rid, constraint: "operator_fact_incompatible", message: `operator ${rule.operator}와 fact 타입 ${fact.type} 비호환` });
      if (operatorValueKinds[rule.operator] === "threshold_map" && isObj(rule.value) && rule.value.selector_fact_path && !ruleFactCatalog[rule.value.selector_fact_path])
        v({ ruleId: rid, constraint: "unknown_selector_fact_path", message: `ruleFactCatalog에 없는 selector_fact_path: ${rule.value.selector_fact_path}` });
    }
    if (typeof rule.product_id !== "string" || !CANONICAL_PRODUCT_ID.test(rule.product_id) || !productIdSet.has(rule.product_id)) {
      v({ ruleId: rid, constraint: "rule_product_id", message: `존재하지 않거나 잘못된 product_id: ${rule.product_id}` });
    } else if (!reg.isActive(rule.source_id)) {
      v({ ruleId: rid, constraint: "rule_source_inactive", message: `source가 없거나 비활성: ${rule.source_id}` });
    } else {
      const s = reg.get(rule.source_id);
      if (s.source_kind !== "product_terms" || s.product_id !== rule.product_id) v({ ruleId: rid, constraint: "rule_source_product", message: `출처가 타상품/시장데이터: ${rule.source_id}` });
      else if (!isNonEmptyString(rule.field) || !reg.canSupport(rule.source_id, rule.product_id, rule.field)) v({ ruleId: rid, constraint: "rule_field_unsupported", message: `출처가 field를 지원하지 않음: ${rule.field}` });
    }
  }

  // --- knowledge_gaps 검증 + 색인 ---
  const gapById = new Map();
  const seenGapIds = new Set();
  for (const g of gapList) {
    if (!g || typeof g !== "object") { v({ constraint: "gap", message: "knowledge_gap이 객체가 아닙니다." }); continue; }
    if (typeof g.rule_id !== "string" || !/^rule:/.test(g.rule_id)) { v({ constraint: "gap_id_format", message: `gap rule_id는 rule: 접두사여야 합니다: ${g.rule_id}` }); continue; }
    if (seenGapIds.has(g.rule_id)) v({ ruleId: g.rule_id, constraint: "duplicate_gap_id", message: `gap rule_id 중복: ${g.rule_id}` });
    seenGapIds.add(g.rule_id);
    if (ruleById.has(g.rule_id)) v({ ruleId: g.rule_id, constraint: "gap_rule_conflict", message: `동일 rule_id가 완전 규칙과 knowledge_gap에 동시에 존재: ${g.rule_id}` });
    if (typeof g.product_id !== "string" || !productIdSet.has(g.product_id)) v({ ruleId: g.rule_id, constraint: "gap_product_id", message: `gap product_id가 존재하지 않음: ${g.product_id}` });
    if (!isNonEmptyString(g.reason)) v({ ruleId: g.rule_id, constraint: "gap_reason", message: "gap.reason이 필요합니다." });
    if (!isNonEmptyString(g.missing_info_question)) v({ ruleId: g.rule_id, constraint: "gap_question", message: "gap.missing_info_question이 필요합니다." });
    gapById.set(g.rule_id, g);
  }

  // --- requires 엣지 해소 + 참조 카운트 ---
  // 각 complete rule / gap 은 정확히 하나의 "동일상품" requires edge 에서만 참조돼야 한다.
  const refCountByProduct = new Map();   // rule_id -> Set(product.product_id)
  const productById = new Map(products.map((p) => [p.id, p]));
  for (const p of products) {
    for (const e of graph.edges.filter((e) => e && e.from === p.id && e.rel === "requires")) {
      const rule = ruleById.get(e.to);
      const gap = gapById.get(e.to);
      if (rule && rule.product_id !== p.product_id) v({ edge: e, constraint: "cross_product_requires", message: `${p.id}가 타상품 규칙을 참조: ${e.to}` });
      else if (gap && gap.product_id !== p.product_id) v({ edge: e, constraint: "cross_product_requires", message: `${p.id}가 타상품 knowledge_gap을 참조: ${e.to}` });
      else if (!rule && !gap) v({ edge: e, constraint: "unresolved_requires", message: `${p.id}의 requires가 실제 규칙·knowledge_gap 어디에도 연결되지 않음: ${e.to}` });
      if (rule || gap) {
        if (!refCountByProduct.has(e.to)) refCountByProduct.set(e.to, []);
        refCountByProduct.get(e.to).push(p.product_id);
      }
    }
  }

  // required rule 의 source_id 는 해당 상품의 supportedBy edge 에 실제로 연결돼 있어야 한다(그래프 연결 없이 사용 금지).
  const supportedByOfProduct = (productId) => new Set(graph.edges.filter((e) => e && e.from === productId && e.rel === "supportedBy").map((e) => e.to));
  for (const p of products) {
    const links = supportedByOfProduct(p.id);
    for (const e of graph.edges.filter((e) => e && e.from === p.id && e.rel === "requires")) {
      const rule = ruleById.get(e.to);
      if (rule && rule.product_id === p.product_id && rule.required === true && !links.has(rule.source_id))
        v({ ruleId: rule.rule_id, constraint: "rule_source_not_linked", message: `${p.id}의 required 규칙 source가 supportedBy에 없음: ${rule.source_id}` });
    }
  }

  // 고아(orphan) 규칙/갭: 어떤 requires edge 에서도 참조되지 않으면 violation. 중복 참조도 violation.
  for (const rule of ruleById.values()) {
    const refs = refCountByProduct.get(rule.rule_id) || [];
    if (refs.length === 0) v({ ruleId: rule.rule_id, constraint: "orphan_rule", message: `어떤 requires edge에서도 참조되지 않는 규칙: ${rule.rule_id}` });
    else if (refs.length > 1) v({ ruleId: rule.rule_id, constraint: "multi_referenced_rule", message: `규칙이 둘 이상의 requires에서 참조됨: ${rule.rule_id} (${refs.join(",")})` });
  }
  for (const gap of gapById.values()) {
    const refs = refCountByProduct.get(gap.rule_id) || [];
    if (refs.length === 0) v({ ruleId: gap.rule_id, constraint: "orphan_gap", message: `어떤 requires edge에서도 참조되지 않는 knowledge_gap: ${gap.rule_id}` });
    else if (refs.length > 1) v({ ruleId: gap.rule_id, constraint: "multi_referenced_gap", message: `knowledge_gap이 둘 이상의 requires에서 참조됨: ${gap.rule_id}` });
  }

  // --- 엣지 domain/range (schema.relations 기준) ---
  for (const e of graph.edges) {
    if (!e || typeof e !== "object") { v({ constraint: "edge", message: "edge가 객체가 아닙니다." }); continue; }
    const rel = relations[e.rel];
    if (!rel) { v({ edge: e, constraint: "relation", message: `알 수 없는 관계: ${e.rel}` }); continue; }
    if (rel.kind !== "asserted")
      v({ edge: e, constraint: "derived_relation_asserted", message: `파생 관계 ${e.rel}은 정적 지식그래프에 저장할 수 없습니다.` });
    const domain = Array.isArray(rel.domain) ? rel.domain : [rel.domain];
    const from = nodeById.get(e.from);
    if (!from) v({ edge: e, constraint: "domain", message: `from 노드 없음: ${e.from}` });
    else if (!domain.includes(from.type)) v({ edge: e, constraint: "domain", message: `${e.rel} domain은 ${domain.join("|")}인데 ${e.from}은 ${from.type}` });
    if (graphNodeClasses.has(rel.range)) {
      const to = nodeById.get(e.to);
      if (!to) v({ edge: e, constraint: "range", message: `to 노드 없음: ${e.to}` });
      else if (to.type !== rel.range) v({ edge: e, constraint: "range", message: `${e.rel} range는 ${rel.range}인데 ${e.to}은 ${to.type}` });
    } else {
      const prefix = externalRangePrefix[rel.range];
      if (prefix && !String(e.to).startsWith(prefix)) v({ edge: e, constraint: "range", message: `${e.rel} range는 ${rel.range}(${prefix}*)여야 하는데 ${e.to}` });
    }
  }

  // --- 파생 productKnowledgeStatus vs 선언값 ---
  for (const p of products) {
    const pEdges = graph.edges.filter((e) => e && e.from === p.id);
    const supported = pEdges.filter((e) => e.rel === "supportedBy");
    const activeSameProduct = supported.filter((e) => isValidEvidence(e.to, p));
    let derived;
    if (activeSameProduct.length === 0) {
      derived = "unavailable_unverified_source";
    } else {
      const hasProvider = pEdges.some((e) => e.rel === "providedBy");
      const hasMitigates = pEdges.some((e) => e.rel === "mitigates");
      const hasPurpose = pEdges.some((e) => e.rel === "supportsPurpose");
      const requiresEdges = pEdges.filter((e) => e.rel === "requires");
      // 규칙 존재만으로는 부족 — requires 가 가리키는 규칙이 모두 "완비"돼야 한다.
      const allRulesComplete = requiresEdges.length > 0 && requiresEdges.every((e) => ruleActivates(e.to, p));
      const allSupportedValid = supported.length === activeSameProduct.length;   // 부적합 출처가 섞이면 불완전
      derived = hasProvider && hasMitigates && hasPurpose && allRulesComplete && allSupportedValid
        ? "available"
        : "unavailable_invalid_knowledge";
    }
    if (p.productKnowledgeStatus !== derived)
      v({ nodeId: p.id, constraint: "status_mismatch", message: `선언 ${p.productKnowledgeStatus} != 파생 ${derived}` });
  }

  return { conforms: violations.length === 0, violations };
}

export function validateProfile(profile, schema) {
  const violations = [];
  const missingFacts = [...((profile && profile.missingFacts) || [])];
  const company = (profile && profile.facts && profile.facts.company) || {};
  const transactions = (profile && profile.transactions) || [];
  const companyFields = schema.classes.Company.fields;
  const txFields = schema.classes.TradeTransaction.fields;

  const addMissing = (factPath, question) => {
    if (!missingFacts.some((m) => m.factPath === factPath)) missingFacts.push({ factPath, question });
  };
  const violate = (path, constraint, actual, message) => violations.push({ path, constraint, actual, message });

  // ---- Company: companyType / riskAppetite (enum), isSme (real boolean) ----
  for (const name of ["companyType", "riskAppetite"]) {
    const def = companyFields[name];
    // 누락은 missingFacts 에만 기록한다(같은 사실을 violation 으로 중복 보고하지 않음).
    if (!(name in company)) { addMissing(`company.${name}`, def.question); continue; }
    if (!def.values.includes(company[name]))
      violate(`company.${name}`, "enum", company[name], `${name} 값이 허용 목록(${def.values.join(", ")})에 없습니다.`);
  }
  if (!("isSme" in company)) {
    addMissing("company.isSme", companyFields.isSme.question);
  } else if (typeof company.isSme !== "boolean") {
    violate("company.isSme", "type", typeof company.isSme, "중소기업 여부는 참/거짓 값이어야 합니다(문자열 불가).");
  }

  // ---- Company.requestedPurposes: array + allowed values ----
  const purposes = profile && profile.requestedPurposes;
  const purposeDef = companyFields.requestedPurposes;
  if (!Array.isArray(purposes) || purposes.length === 0) {
    addMissing("company.requestedPurposes", purposeDef.question);   // 미선택 = 누락(질문)
  } else {
    for (const p of purposes)
      if (!purposeDef.values.includes(p))
        violate("company.requestedPurposes", "enum", p, `지원 목적 값이 허용 목록에 없습니다: ${p}`);
  }

  // ---- Company.existingHedges: 3-state + item constraints ----
  if (!("hasExistingHedge" in company)) {
    addMissing("company.existingHedges", companyFields.existingHedges.question);   // unknown = 질문만
  } else {
    const hedges = company.existingHedges;
    if (typeof company.hasExistingHedge !== "boolean")
      violate("company.hasExistingHedge", "type", typeof company.hasExistingHedge, "기존 헤지 보유 여부는 참/거짓 값이어야 합니다.");
    if (!Array.isArray(hedges)) {
      violate("company.existingHedges", "type", typeof hedges, "기존 헤지는 배열이어야 합니다.");
    } else {
      // 파생값이므로 배열 길이와 반드시 일치해야 한다.
      if (typeof company.hasExistingHedge === "boolean" && company.hasExistingHedge !== hedges.length > 0)
        violate("company.hasExistingHedge", "consistency", company.hasExistingHedge,
          `기존 헤지 보유 여부(${company.hasExistingHedge})가 입력된 헤지 ${hedges.length}건과 일치하지 않습니다.`);
      hedges.forEach((h, i) => {
        const at = `company.existingHedges[${i}]`;
        if (h === null || typeof h !== "object") { violate(at, "type", typeof h, "헤지 항목이 객체가 아닙니다."); return; }
        if (!isNonEmptyString(h.currency)) violate(`${at}.currency`, "required", h.currency, "헤지 통화가 없습니다.");
        if (!isFiniteNum(h.amount) || h.amount <= 0) violate(`${at}.amount`, "range", h.amount, "헤지 금액은 0보다 큰 숫자여야 합니다.");
        if (!isFiniteNum(h.maturityMonths) || h.maturityMonths < 0) violate(`${at}.maturityMonths`, "range", h.maturityMonths, "헤지 만기는 0 이상 숫자여야 합니다.");
        if (h.instrumentType !== undefined && !isNonEmptyString(h.instrumentType))
          violate(`${at}.instrumentType`, "type", h.instrumentType, "헤지 상품유형이 문자열이 아닙니다.");
      });
    }
  }

  // ---- TradeTransaction: enums, numbers, id presence and uniqueness ----
  const seenIds = new Set();
  transactions.forEach((t, i) => {
    const at = `transactions[${i}]`;
    // 두 축은 서로 다른 질문이다: tradeType = 수출/수입, direction = 수취/지급
    const TX_QUESTION = {
      tradeType: "각 거래의 수출/수입 구분을 선택해 주세요.",
      direction: "각 거래의 수취/지급 구분을 선택해 주세요.",
    };
    for (const name of ["tradeType", "direction"]) {
      const def = txFields[name];
      if (t[name] === undefined || t[name] === "") { addMissing(`${at}.${name}`, TX_QUESTION[name]); continue; }
      if (!def.values.includes(t[name])) violate(`${at}.${name}`, "enum", t[name], `${name} 값이 허용 목록(${def.values.join(", ")})에 없습니다.`);
    }
    for (const name of ["country", "currency"])
      if (!isNonEmptyString(t[name])) violate(`${at}.${name}`, "required", t[name], `${name} 값이 없습니다.`);
    if (!isFiniteNum(t.amount) || t.amount <= 0) violate(`${at}.amount`, "range", t.amount, "거래 금액은 0보다 큰 숫자여야 합니다.");
    if (!isFiniteNum(t.months) || t.months < 0) violate(`${at}.months`, "range", t.months, "결제 시점(개월)은 0 이상 숫자여야 합니다.");
    if (!isNonEmptyString(t.transaction_id)) violate(`${at}.transaction_id`, "required", t.transaction_id, "거래 ID가 없습니다.");
    else if (seenIds.has(t.transaction_id)) violate(`${at}.transaction_id`, "unique", t.transaction_id, `거래 ID가 중복되었습니다: ${t.transaction_id}`);
    else seenIds.add(t.transaction_id);
  });

  // ---- Rule facts: explicit values must satisfy the ontology catalog before evaluation ----
  // Missing optional rule facts stay missing so the relevant product can ask a question later.
  // A present-but-malformed value must never be converted into a customer-ineligible result.
  const classValidatedPaths = new Set(["company.companyType"]);
  for (const [factPath, def] of Object.entries(schema.ruleFactCatalog || {})) {
    if (classValidatedPaths.has(factPath) || !isObject(def)) continue;
    const actual = resolveFact(profile, factPath);
    if (actual === undefined || actual === null) continue;
    let valid = true;
    if (def.type === "boolean") valid = typeof actual === "boolean";
    else if (def.type === "number") valid = isFiniteNum(actual);
    else if (def.type === "enum") valid = Array.isArray(def.values) && def.values.includes(actual);
    else if (def.type === "string") valid = isNonEmptyString(actual);
    else if (def.type === "date") valid = isRealIsoDate(actual);
    else if (def.type === "array") valid = Array.isArray(actual);
    else valid = false;
    if (!valid)
      violate(factPath, "rule_fact_type", actual, `${factPath} 값이 온톨로지 사실 타입(${def.type})과 일치하지 않습니다.`);
  }

  return { conforms: violations.length === 0 && missingFacts.length === 0, violations, missingFacts };
}
