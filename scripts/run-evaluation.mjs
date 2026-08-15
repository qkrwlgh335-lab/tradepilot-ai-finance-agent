import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { explainProducts } from "../js/agent.js";
import { buildBrief } from "../js/brief.js";
import { computeNetExposure } from "../js/exposure.js";
import { createProvider } from "../js/llm-provider.js";
import { buildAnalysisPayload, validateAnalysisPayload } from "../js/privacy.js";
import { buildProfile } from "../js/profile.js";
import { createRag } from "../js/rag.js";
import { recommend } from "../js/reasoner.js";
import {
  bucketNotionalKrw,
  computeCFaRBuckets,
  liquidityTimeline,
  portfolioCFaR,
} from "../js/risk.js";
import { simulateScenarios } from "../js/scenario.js";
import { interpretScenarioIntent, createScenarioSemanticClassifier } from "../js/scenario-semantic.js";
import { buildPresetPlan } from "../js/scenario-preset.js";
import { validatePlan } from "../js/scenario-plan.js";
import { compareStrategies } from "../js/strategy.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const OUTPUT = path.join(ROOT, "generated", "evaluation-report.json");
const DATA_VERSION = "tradepilot-eval-v1";
const FIXED_NOW = new Date(2026, 6, 26, 12, 0, 0);
const INTENT_TYPES = new Set(["payment_delay", "receivable_drop", "adverse_fx"]);

// This explicit, sorted manifest is the contract used by T25 to detect a stale report.
// Generated output, timestamps, and runtime-refreshed official caches are intentionally excluded:
// the metrics assess algorithm/fixture contracts, while market freshness is governed by its own
// validated envelope and must not invalidate the report on the first app access.
export const EVALUATION_SOURCE_FILES = Object.freeze([
  "data/eligibility-rules.json",
  "data/knowledge-graph.json",
  "data/ontology-schema.json",
  "data/product-docs.json",
  "data/product-embeddings.json",
  "data/samples.json",
  "data/scenario-intent-corpus.json",
  "data/scenario-intents.json",
  "data/source-registry.json",
  "eval/eligibility-cases.json",
  "eval/evidence-cases.json",
  "eval/governance-cases.json",
  "eval/reproducibility-cases.json",
  "eval/scenario-intent-cases.json",
  "js/agent.js",
  "js/brief.js",
  "js/exposure.js",
  "js/llm-provider.js",
  "js/privacy.js",
  "js/profile.js",
  "js/rag.js",
  "js/reasoner.js",
  "js/risk.js",
  "js/scenario-intent.js",
  "js/scenario-plan.js",
  "js/scenario-preset.js",
  "js/scenario-semantic.js",
  "js/scenario.js",
  "js/sources.js",
  "js/strategy.js",
  "scripts/run-evaluation.mjs",
].sort());

const json = async (relativePath) =>
  JSON.parse(await readFile(path.join(ROOT, relativePath), "utf8"));

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export async function computeSourceDigest(readImpl = readFile) {
  const hash = createHash("sha256");
  for (const relativePath of EVALUATION_SOURCE_FILES) {
    const bytes = await readImpl(path.join(ROOT, relativePath));
    // All manifest entries are UTF-8 text. Ignore only platform line-ending
    // differences so a Windows checkout and the packaged copy share a digest.
    const normalizedText = Buffer.from(bytes).toString("utf8").replace(/\r\n/g, "\n");
    hash.update(relativePath);
    hash.update("\0");
    hash.update(normalizedText, "utf8");
    hash.update("\0");
  }
  return hash.digest("hex");
}

function metric(value, target, passed, numerator, denominator) {
  return {
    value,
    target,
    passed: passed === true,
    ...(Number.isFinite(numerator) ? { numerator } : {}),
    ...(Number.isFinite(denominator) ? { denominator } : {}),
  };
}

function evaluationProfile(input) {
  return buildProfile({
    cashflows: input.cashflows,
    rates: input.rates,
    // 평가도 실제 UI와 같은 프로필 생성 경계를 통과한다. 테스트 전용 사후 mutation 금지.
    company: { ...(input.company || {}), ...(input.ruleFacts || {}) },
  });
}

function normalizeDecisionGroup(group = {}) {
  return {
    candidate: (group.candidates || []).map((item) => item.product_id).sort(),
    pending: (group.pending || []).map((item) => item.product_id).sort(),
    excluded: (group.excluded || []).map((item) => item.product_id).sort(),
    unavailable: (group.unavailable || []).map((item) => item.product_id).sort(),
  };
}

function corePipeline(sample, dependencies) {
  const profile = buildProfile({
    cashflows: sample.cashflows,
    rates: dependencies.fx.rates,
    company: {
      companyType: "corporation",
      isSme: true,
      riskAppetite: "low",
      existingHedges: [],
      requestedPurposes: ["fx_hedge", "working_capital", "guarantee_insurance"],
    },
  });
  Object.assign(profile.facts.company, {
    companyScale: "sme",
    creditGradeMeetsThreshold: true,
    priorYearExportUsd: 1_000_000,
    reviewChannelConfirmed: true,
  });
  const buckets = computeCFaRBuckets(
    profile.transactions,
    dependencies.fx.rates,
    dependencies.volatility.annual_vol,
  );
  const cfar = portfolioCFaR(buckets);
  const notionalKrw = bucketNotionalKrw(buckets);
  const strategies = compareStrategies(cfar.total, notionalKrw);
  const liquidity = liquidityTimeline(profile.transactions, dependencies.fx.rates, {
    openingBalanceKrw: 100_000_000,
    creditLineKrw: 60_000_000,
  });
  const recommendation = recommend({
    profile,
    graph: dependencies.graph,
    rules: dependencies.rules,
    sources: dependencies.sources,
    schema: dependencies.schema,
    today: dependencies.fx.as_of,
  });
  const netRows = computeNetExposure(profile.transactions);
  const scenarios = simulateScenarios(netRows, dependencies.fx.rates);
  const brief = buildBrief({
    cashflows: profile.transactions,
    netRows,
    scenarios,
    selectedProducts: recommendation.candidates,
    cfar: { total: cfar.total },
    asOf: dependencies.fx.as_of,
    now: FIXED_NOW,
  });
  return {
    cfar,
    notionalKrw,
    strategies,
    liquidity,
    recommendation,
    netRows,
    scenarios,
    brief: { html: brief.html, filename: brief.filename },
  };
}

async function evaluateIntent(cases, dependencies) {
  const sample = dependencies.samples.samples.find((item) => item.id === "a");
  const transactions = sample.cashflows.map((item, index) => ({
    ...item,
    transaction_id: item.transaction_id || `txn-${index + 1}`,
  }));
  const classifier = createScenarioSemanticClassifier({
    corpus: dependencies.scenarioCorpus,
    embeddings: null,
    extractorFactory: async () => {
      throw new Error("evaluation_offline");
    },
  });
  const rows = [];
  for (const item of cases) {
    const interpreted = await interpretScenarioIntent(
      item.text,
      { transactions, intents: dependencies.scenarioIntents },
      classifier,
    );
    const step = interpreted.intent.steps[0] || null;
    const gate = validatePlan(buildPresetPlan(interpreted.intent), { transactions });
    const predictedTarget = step?.target?.transaction_id || null;
    const normal = INTENT_TYPES.has(item.expected);
    const correct = normal
      && step?.type === item.expected
      && (item.expected_target === undefined || predictedTarget === item.expected_target);
    rows.push({
      id: item.id,
      expected: item.expected,
      predicted_type: step?.type || null,
      predicted_target: predictedTarget,
      executable: gate.ok === true,
      correct,
      adversarial: Array.isArray(item.adversarial) && item.adversarial.length > 0,
    });
  }
  const normal = rows.filter((row) => INTENT_TYPES.has(row.expected));
  const safety = rows.filter((row) => !INTENT_TYPES.has(row.expected));
  const correct = normal.filter((row) => row.correct).length;
  const blocked = safety.filter((row) => !row.executable).length;
  return {
    rows,
    accuracy: normal.length ? correct / normal.length : 0,
    correct,
    intentCases: normal.length,
    blockRate: safety.length ? blocked / safety.length : 0,
    blocked,
    safetyCases: safety.length,
  };
}

function evaluateEligibility(cases, dependencies) {
  const rows = [];
  let ineligibleRecommendations = 0;
  let missingAsEligible = 0;
  let candidateCount = 0;
  let candidateRuleEvidence = 0;
  let candidateSourceEvidence = 0;
  let noCandidate = 0;

  for (const item of cases) {
    const profile = evaluationProfile(item.input);
    const recommendation = recommend({
      profile,
      graph: dependencies.graph,
      rules: dependencies.rules,
      sources: dependencies.sources,
      schema: dependencies.schema,
      today: item.input.today,
    });
    const actualByPurpose = Object.fromEntries(
      recommendation.byPurpose.map((group) => [
        group.purpose,
        normalizeDecisionGroup(group),
      ]),
    );
    const expectedByPurpose = Object.fromEntries(
      Object.entries(item.expected_by_purpose).map(([purpose, group]) => [
        purpose,
        Object.fromEntries(
          Object.entries(group).map(([status, ids]) => [status, [...ids].sort()]),
        ),
      ]),
    );
    const exact = stableJson(actualByPurpose) === stableJson(expectedByPurpose);
    const actualCandidateIds = new Set(
      recommendation.candidates.map((candidate) => candidate.product_id),
    );
    for (const [productId, status] of Object.entries(item.expected_status)) {
      if (status === "excluded" && actualCandidateIds.has(productId))
        ineligibleRecommendations++;
      if (status === "pending" && actualCandidateIds.has(productId))
        missingAsEligible++;
    }
    if (recommendation.candidates.length === 0) noCandidate++;
    for (const candidate of recommendation.candidates) {
      candidateCount++;
      if (Array.isArray(candidate.eligibilityEvidence)
          && candidate.eligibilityEvidence.length > 0)
        candidateRuleEvidence++;
      if (candidate.source?.url && Array.isArray(candidate.sources)
          && candidate.sources.length > 0)
        candidateSourceEvidence++;
    }
    rows.push({
      id: item.id,
      exact,
      candidate_ids: [...actualCandidateIds].sort(),
      actual_by_purpose: actualByPurpose,
    });
  }

  return {
    rows,
    exactCases: rows.filter((row) => row.exact).length,
    ineligibleRecommendations,
    missingAsEligible,
    candidateCount,
    noCandidate,
    ruleCoverage: candidateCount ? candidateRuleEvidence / candidateCount : null,
    sourceCoverage: candidateCount ? candidateSourceEvidence / candidateCount : null,
  };
}

async function evaluateEvidence(cases, dependencies) {
  const rag = createRag({
    docs: dependencies.productDocs,
    embeddings: dependencies.productEmbeddings,
    sources: dependencies.sources,
    extractorFactory: async () => {
      throw new Error("evaluation_offline");
    },
  });
  const rows = [];
  for (const item of cases) {
    const evidence = await rag.evidenceForCandidate({
      product_id: item.product_id,
      rule_ids: [item.rule_id],
      query: item.query,
      k: item.top_k,
    });
    const matches = Array.isArray(evidence) ? evidence : [];
    const recalled = matches.some((match) =>
      match.chunk_id === item.expected_chunk_id
      && match.source?.source_id === item.expected_source_id);
    const first = matches[0] || null;
    const exact = first?.chunk_id === item.expected_chunk_id
      && first?.source?.source_id === item.expected_source_id;
    rows.push({
      id: item.id,
      recalled,
      exact,
      top_chunk_id: first?.chunk_id || null,
      top_source_id: first?.source?.source_id || null,
    });
  }
  const recalled = rows.filter((row) => row.recalled).length;
  const exact = rows.filter((row) => row.exact).length;
  return {
    rows,
    recalled,
    exact,
    recallAtK: rows.length ? recalled / rows.length : 0,
    exactMatch: rows.length ? exact / rows.length : 0,
  };
}

async function evaluateReliability(cases, dependencies) {
  const sample = dependencies.samples.samples.find((item) => item.id === "a");
  const rows = [];
  for (const item of cases) {
    let passed = false;
    if (item.operation === "repeat_pipeline") {
      const outputs = Array.from(
        { length: item.runs },
        () => corePipeline(sample, dependencies),
      );
      passed = outputs.every((output) =>
        stableJson(output) === stableJson(outputs[0]));
    } else if (item.operation === "pipeline_with_failure" && item.failure === "rag") {
      const baseline = corePipeline(sample, dependencies);
      const before = stableJson({
        cfar: baseline.cfar,
        recommendation: baseline.recommendation,
      });
      const rag = createRag({
        docs: dependencies.productDocs,
        embeddings: dependencies.productEmbeddings,
        sources: dependencies.sources,
        extractorFactory: async () => {
          throw new Error("injected_rag_failure");
        },
      });
      await rag.evidenceForCandidate({
        product_id: "fx_insurance",
        rule_ids: ["rule:fx_insurance-trade-scope"],
        query: "의도된 RAG 실패",
      });
      passed = stableJson({
        cfar: baseline.cfar,
        recommendation: baseline.recommendation,
      }) === before;
    } else if (item.operation === "pipeline_with_failure" && item.failure === "llm") {
      const baseline = corePipeline(sample, dependencies);
      const provider = createProvider("external", {
        approved: true,
        fetchImpl: async () => {
          throw new Error("injected_llm_failure");
        },
      });
      const explanation = await explainProducts({
        products: baseline.recommendation.candidates,
      }, { provider });
      passed = baseline.recommendation.candidates.length > 0
        && typeof explanation === "string"
        && explanation.includes("금융 자문이 아닙니다");
    } else if (item.operation === "offline_pipeline") {
      let externalCalls = 0;
      const baseline = corePipeline(sample, dependencies);
      const provider = createProvider(item.mode, {
        fetchImpl: async () => {
          externalCalls++;
          throw new Error("network_must_not_run");
        },
      });
      await provider.complete({
        purpose: "product_explanation",
        analysisPayload: {},
      });
      passed = baseline.brief.html.includes("초안 · 제출본 아님")
        && externalCalls === item.expected.external_calls;
    }
    rows.push({ id: item.id, operation: item.operation, passed });
  }
  const byOperation = (predicate) => {
    const selected = rows.filter(predicate);
    return selected.length
      ? selected.filter((row) => row.passed).length / selected.length
      : 0;
  };
  return {
    rows,
    reproducibility: byOperation((row) => row.operation === "repeat_pipeline"),
    failureCompletion: byOperation((row) => row.operation === "pipeline_with_failure"),
    offlineCompletion: byOperation((row) => row.operation === "offline_pipeline"),
  };
}

function evaluateGovernance(cases) {
  const rows = cases.map((item) => {
    const payload = buildAnalysisPayload(item.input);
    const checked = validateAnalysisPayload(payload);
    const serialized = JSON.stringify(payload);
    const keys = Object.keys(payload).sort();
    const expectedKeys = [...item.expected_allowed_keys].sort();
    const passed = checked.ok
      && stableJson(keys) === stableJson(expectedKeys)
      && item.forbidden_markers.every((marker) => !serialized.includes(marker));
    return { id: item.id, passed, output_keys: keys };
  });
  const passed = rows.filter((row) => row.passed).length;
  return {
    rows,
    passed,
    blockRate: rows.length ? passed / rows.length : 0,
  };
}

function gitRevision() {
  try {
    const dirty = execFileSync(
      "git",
      ["status", "--porcelain", "--", ...EVALUATION_SOURCE_FILES],
      {
        cwd: ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
    if (dirty) return "working-tree";
    return execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || "working-tree";
  } catch {
    return "working-tree";
  }
}

export async function runEvaluation({
  generatedAt = new Date().toISOString(),
  evaluatedRevision = gitRevision(),
} = {}) {
  const [
    scenarioCases,
    eligibilityCases,
    evidenceCases,
    reliabilityCases,
    governanceCases,
    samples,
    fx,
    volatility,
    graph,
    rules,
    sourceRegistry,
    schema,
    productDocs,
    productEmbeddings,
    scenarioIntents,
    scenarioCorpus,
  ] = await Promise.all([
    json("eval/scenario-intent-cases.json"),
    json("eval/eligibility-cases.json"),
    json("eval/evidence-cases.json"),
    json("eval/reproducibility-cases.json"),
    json("eval/governance-cases.json"),
    json("data/samples.json"),
    json("data/fx.json"),
    json("data/fx-vol.json"),
    json("data/knowledge-graph.json"),
    json("data/eligibility-rules.json"),
    json("data/source-registry.json"),
    json("data/ontology-schema.json"),
    json("data/product-docs.json"),
    json("data/product-embeddings.json"),
    json("data/scenario-intents.json"),
    json("data/scenario-intent-corpus.json"),
  ]);
  const dependencies = {
    samples,
    fx,
    volatility,
    graph,
    rules,
    sources: sourceRegistry.sources,
    schema,
    productDocs,
    productEmbeddings,
    scenarioIntents,
    scenarioCorpus,
  };
  const [intent, eligibility, evidence, reliability] = await Promise.all([
    evaluateIntent(scenarioCases.cases, dependencies),
    Promise.resolve(evaluateEligibility(eligibilityCases.cases, dependencies)),
    evaluateEvidence(evidenceCases.cases, dependencies),
    evaluateReliability(reliabilityCases.cases, dependencies),
  ]);
  const governance = evaluateGovernance(governanceCases.cases);

  const caseCounts = {
    scenario_intent: scenarioCases.cases.length,
    eligibility: eligibilityCases.cases.length,
    evidence: evidenceCases.cases.length,
    reliability: reliabilityCases.cases.length,
    governance: governanceCases.cases.length,
    total: scenarioCases.cases.length
      + eligibilityCases.cases.length
      + evidenceCases.cases.length
      + reliabilityCases.cases.length
      + governanceCases.cases.length,
  };
  const metricGroups = {
    intent: {
      label: "Intent",
      metrics: {
        scenario_intent_accuracy: metric(
          intent.accuracy,
          0.8,
          intent.accuracy >= 0.8,
          intent.correct,
          intent.intentCases,
        ),
        unsafe_execution_block_rate: metric(
          intent.blockRate,
          1,
          intent.blockRate === 1,
          intent.blocked,
          intent.safetyCases,
        ),
      },
    },
    recommendation_safety: {
      label: "Recommendation Safety",
      metrics: {
        ineligible_product_recommendations: metric(
          eligibility.ineligibleRecommendations,
          0,
          eligibility.ineligibleRecommendations === 0,
        ),
        missing_info_as_eligible: metric(
          eligibility.missingAsEligible,
          0,
          eligibility.missingAsEligible === 0,
        ),
      },
    },
    evidence_retrieval: {
      label: "Evidence Retrieval",
      metrics: {
        recall_at_k: metric(
          evidence.recallAtK,
          0.9,
          evidence.recallAtK >= 0.9,
          evidence.recalled,
          evidence.rows.length,
        ),
        exact_evidence_match: metric(
          evidence.exactMatch,
          0.9,
          evidence.exactMatch >= 0.9,
          evidence.exact,
          evidence.rows.length,
        ),
      },
    },
    reliability: {
      label: "Reliability",
      metrics: {
        reproducibility: metric(
          reliability.reproducibility,
          1,
          reliability.reproducibility === 1,
        ),
        failure_completion: metric(
          reliability.failureCompletion,
          1,
          reliability.failureCompletion === 1,
        ),
        offline_completion: metric(
          reliability.offlineCompletion,
          1,
          reliability.offlineCompletion === 1,
        ),
      },
    },
    governance: {
      label: "Governance",
      metrics: {
        pii_raw_egress_block_rate: metric(
          governance.blockRate,
          1,
          governance.blockRate === 1,
          governance.passed,
          governance.rows.length,
        ),
        candidate_rule_evidence_coverage: metric(
          eligibility.ruleCoverage,
          1,
          eligibility.ruleCoverage === 1,
          eligibility.candidateCount
            ? Math.round(eligibility.ruleCoverage * eligibility.candidateCount)
            : 0,
          eligibility.candidateCount,
        ),
        candidate_source_coverage: metric(
          eligibility.sourceCoverage,
          1,
          eligibility.sourceCoverage === 1,
          eligibility.candidateCount
            ? Math.round(eligibility.sourceCoverage * eligibility.candidateCount)
            : 0,
          eligibility.candidateCount,
        ),
      },
      no_candidate: eligibility.noCandidate,
    },
  };
  const allMetrics = Object.values(metricGroups)
    .flatMap((group) => Object.values(group.metrics));
  const deterministicResults = {
    data_version: DATA_VERSION,
    case_counts: caseCounts,
    metric_groups: metricGroups,
    details: {
      intent: intent.rows,
      eligibility: eligibility.rows,
      evidence: evidence.rows,
      reliability: reliability.rows,
      governance: governance.rows,
    },
  };
  return {
    schema_version: "1",
    generated_at: generatedAt,
    source_digest: await computeSourceDigest(),
    source_files: [...EVALUATION_SOURCE_FILES],
    evaluated_revision: evaluatedRevision,
    data_version: DATA_VERSION,
    case_counts: caseCounts,
    metric_groups: metricGroups,
    results_digest: sha256(stableJson(deterministicResults)),
    overall: {
      passed: allMetrics.every((item) => item.passed),
      passed_metrics: allMetrics.filter((item) => item.passed).length,
      total_metrics: allMetrics.length,
    },
    details: deterministicResults.details,
  };
}

async function main() {
  const report = await runEvaluation();
  await mkdir(path.dirname(OUTPUT), { recursive: true });
  await writeFile(OUTPUT, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    output: path.relative(ROOT, OUTPUT),
    overall: report.overall,
    case_counts: report.case_counts,
    source_digest: report.source_digest,
    results_digest: report.results_digest,
  }, null, 2));
  if (!report.overall.passed) process.exitCode = 1;
}

const isDirect = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) await main();
