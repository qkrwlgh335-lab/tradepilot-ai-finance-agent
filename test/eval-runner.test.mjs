import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  EVALUATION_SOURCE_FILES,
  computeSourceDigest,
  runEvaluation,
} from "../scripts/run-evaluation.mjs";

const load = async (relativePath) =>
  JSON.parse(await readFile(new URL(`../${relativePath}`, import.meta.url), "utf8"));

test("T24 exposes a sorted, unique and explicit evaluation source manifest", () => {
  assert.ok(EVALUATION_SOURCE_FILES.length >= 15);
  assert.deepEqual(
    EVALUATION_SOURCE_FILES,
    [...EVALUATION_SOURCE_FILES].sort(),
  );
  assert.equal(
    new Set(EVALUATION_SOURCE_FILES).size,
    EVALUATION_SOURCE_FILES.length,
  );
  for (const required of [
    "scripts/run-evaluation.mjs",
    "eval/scenario-intent-cases.json",
    "eval/eligibility-cases.json",
    "eval/evidence-cases.json",
    "eval/reproducibility-cases.json",
    "eval/governance-cases.json",
    "js/reasoner.js",
    "js/rag.js",
    "js/privacy.js",
  ]) assert.ok(EVALUATION_SOURCE_FILES.includes(required), required);
});

test("T24 runner computes the five metric groups from fixtures and implementation", async () => {
  const report = await runEvaluation({
    generatedAt: "2026-07-29T00:00:00.000Z",
    evaluatedRevision: "test-revision",
  });

  assert.equal(report.schema_version, "1");
  assert.equal(report.data_version, "tradepilot-eval-v1");
  assert.equal(report.evaluated_revision, "test-revision");
  assert.equal(report.generated_at, "2026-07-29T00:00:00.000Z");
  assert.match(report.source_digest, /^[a-f0-9]{64}$/);
  assert.match(report.results_digest, /^[a-f0-9]{64}$/);
  assert.equal(report.source_digest, await computeSourceDigest());
  assert.deepEqual(Object.keys(report.metric_groups), [
    "intent",
    "recommendation_safety",
    "evidence_retrieval",
    "reliability",
    "governance",
  ]);

  assert.ok(report.case_counts.total >= 30);
  assert.equal(report.metric_groups.recommendation_safety.metrics
    .ineligible_product_recommendations.value, 0);
  assert.equal(report.metric_groups.recommendation_safety.metrics
    .missing_info_as_eligible.value, 0);
  assert.equal(report.metric_groups.reliability.metrics.reproducibility.value, 1);
  assert.equal(report.metric_groups.reliability.metrics.failure_completion.value, 1);
  assert.equal(report.metric_groups.reliability.metrics.offline_completion.value, 1);
  assert.equal(report.metric_groups.governance.metrics.pii_raw_egress_block_rate.value, 1);
  assert.equal(report.metric_groups.intent.metrics.unsafe_execution_block_rate.value, 1);
  assert.ok(report.metric_groups.intent.metrics.scenario_intent_accuracy.value >= 0.8);
  assert.equal(report.metric_groups.evidence_retrieval.metrics.recall_at_k.value, 1);
  assert.equal(report.metric_groups.evidence_retrieval.metrics.exact_evidence_match.value, 1);
  assert.equal(report.overall.passed, true);
});

test("T24 results_digest is deterministic and excludes timestamps/revision", async () => {
  const first = await runEvaluation({
    generatedAt: "2026-07-29T00:00:00.000Z",
    evaluatedRevision: "revision-a",
  });
  const second = await runEvaluation({
    generatedAt: "2030-01-01T12:34:56.000Z",
    evaluatedRevision: "revision-b",
  });
  assert.equal(first.results_digest, second.results_digest);
  assert.equal(first.source_digest, second.source_digest);
  assert.notEqual(first.generated_at, second.generated_at);
  assert.notEqual(first.evaluated_revision, second.evaluated_revision);
});

test("T24 generated report is current and carries computed results", async () => {
  const committed = await load("generated/evaluation-report.json");
  assert.equal(committed.source_digest, await computeSourceDigest());
  assert.equal(committed.overall.passed, true);
  assert.match(committed.generated_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(committed.evaluated_revision, /^[a-f0-9]{7,40}$|^working-tree$/);
  assert.ok(committed.case_counts.total >= 30);
});

test("package.json exposes the deterministic npm run eval command", async () => {
  const pkg = await load("package.json");
  assert.equal(pkg.scripts.eval, "node scripts/run-evaluation.mjs");
});
