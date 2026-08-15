import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  computeEvaluationSourceDigest,
  createSnapshotSource,
} from "../js/data-source.js";
import { renderEvaluationCard } from "../js/ui.js";

const root = new URL("../", import.meta.url);
const load = async (relativePath) =>
  JSON.parse(await readFile(new URL(relativePath, root), "utf8"));

function response(bytes) {
  const body = Buffer.from(bytes);
  return {
    ok: true,
    async json() {
      return JSON.parse(body.toString("utf8"));
    },
    async arrayBuffer() {
      return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
    },
  };
}

function fileFetch({ tamper = null, missing = null } = {}) {
  return async (relativePath) => {
    if (relativePath === missing) return { ok: false, status: 404 };
    try {
      let bytes = await readFile(new URL(relativePath, root));
      if (relativePath === tamper)
        bytes = Buffer.concat([bytes, Buffer.from("\n// changed", "utf8")]);
      return response(bytes);
    } catch {
      return { ok: false, status: 404 };
    }
  };
}

test("T25 browser digest contract matches the current T24 report", async () => {
  const report = await load("generated/evaluation-report.json");
  const digest = await computeEvaluationSourceDigest(
    report.source_files,
    fileFetch(),
  );
  assert.equal(digest, report.source_digest);
});

test("T25 data source returns current, stale and missing states fail-closed", async () => {
  const current = await createSnapshotSource(fileFetch()).getEvaluationReport();
  assert.equal(current.status, "current");
  assert.equal(current.report.overall.passed, true);
  assert.equal(current.current_source_digest, current.report.source_digest);

  const stale = await createSnapshotSource(
    fileFetch({ tamper: "js/reasoner.js" }),
  ).getEvaluationReport();
  assert.equal(stale.status, "stale");
  assert.ok(stale.report);
  assert.notEqual(stale.current_source_digest, stale.report.source_digest);

  const missing = await createSnapshotSource(
    fileFetch({ missing: "generated/evaluation-report.json" }),
  ).getEvaluationReport();
  assert.equal(missing.status, "missing");
  assert.equal(missing.report, null);
});

test("T25 current evaluation card renders five groups, basis and case counts", async () => {
  const current = await createSnapshotSource(fileFetch()).getEvaluationReport();
  const html = renderEvaluationCard(current);
  for (const label of [
    "의도 해석",
    "추천 안전성",
    "근거 검색",
    "신뢰성",
    "거버넌스",
  ]) assert.match(html, new RegExp(label));
  assert.match(html, /합성 평가 34건/);
  assert.match(html, /83\.3%/);
  assert.match(html, /평가 통과/);
  assert.match(html, /working-tree|[a-f0-9]{7,40}/);
  assert.ok(html.includes(current.report.source_digest.slice(0, 12)));
  assert.doesNotMatch(html, /Git HEAD와 동일/);
});

test("T25 failed report is honest; stale/missing cards never show old metrics", async () => {
  const current = await createSnapshotSource(fileFetch()).getEvaluationReport();
  const failedEnvelope = structuredClone(current);
  failedEnvelope.report.overall.passed = false;
  failedEnvelope.report.metric_groups.intent.metrics
    .scenario_intent_accuracy.passed = false;
  const failed = renderEvaluationCard(failedEnvelope);
  assert.match(failed, /평가 기준 미통과/);
  assert.match(failed, /83\.3%/);

  for (const envelope of [
    { status: "stale", report: current.report, current_source_digest: "0".repeat(64) },
    { status: "missing", report: null, current_source_digest: null },
  ]) {
    const html = renderEvaluationCard(envelope);
    assert.match(html, /평가 미실행|최신 코드와 불일치/);
    assert.doesNotMatch(html, /83\.3%/);
    assert.doesNotMatch(html, /Recall@K 100\.0%/);
  }
});

test("T25 UI loads the evaluation envelope inside the collapsed judge-evidence area", async () => {
  const source = await readFile(new URL("js/ui.js", root), "utf8");
  assert.match(source, /source\.getEvaluationReport\(\)/);
  assert.match(source, /renderEvaluationCard\(state\.data\.evaluation\)/);
  const cardAt = source.indexOf("renderEvaluationCard(state.data.evaluation)");
  const detailsAt = source.indexOf('<details class="results-details">');
  const verificationAt = source.indexOf('<details class="verification-details">');
  assert.ok(detailsAt > 0 && verificationAt > detailsAt && cardAt > verificationAt);
});
