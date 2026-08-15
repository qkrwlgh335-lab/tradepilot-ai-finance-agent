import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const readIfPackaged = async (path) => {
  try {
    return await read(path);
  } catch (error) {
    if (error?.code === "ENOENT" && path.startsWith("기획안/")) return null;
    throw error;
  }
};

const DOC_PATHS = [
  "README.md",
  "기획안/1. 수출입금융 지원 에이전트 (KB TradePilot)/README.md",
  "기획안/1. 수출입금융 지원 에이전트 (KB TradePilot)/기획안.md",
  "docs/RUNBOOK.md",
];

test("[T12] public docs describe the implemented ontology-first prototype", async () => {
  const docs = (await Promise.all(DOC_PATHS.map(readIfPackaged))).filter(Boolean);
  const combined = docs.join("\n");

  for (const term of ["경량 온톨로지", "후보 제한 RAG", "1차 스크리닝", "상담", "초안"])
    assert.ok(combined.includes(term), `missing current term: ${term}`);

  assert.match(combined, /키 없이|오프라인/);
  assert.match(combined, /internal.{0,30}(미구현|구현되지)/s);
  assert.match(combined, /ANTHROPIC_MODEL/);
});

test("[T12] public docs contain no stale or overstated implementation claim", async () => {
  const docs = (await Promise.all(DOC_PATHS.map(readIfPackaged))).filter(Boolean);
  const combined = docs.join("\n");

  for (const forbidden of [
    /TradeGuard/,
    /예상손실/,
    /가중\s*(스코어|점수|합)/,
    /상품순위/,
    /API\s*키\s*설정\s*모달/i,
    /OCR로\s*자동|자동\s*(인식|추출)/i,
    /SHACL\s*(준수|구현|적용)/i,
  ]) assert.doesNotMatch(combined, forbidden);

  assert.doesNotMatch(combined, /CORS(?:만으로)?\s*(충분하다|안전하다|완성된다)/i);
});

test("[T12] runbook documents local execution, optional proxy and manual checks honestly", async () => {
  const runbook = await read("docs/RUNBOOK.md");
  for (const required of [
    "node scripts/dev-server.mjs",
    "127.0.0.1:8000",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_MODEL",
    "PowerShell",
    "bash",
    "수동 브라우저 검증",
    "현재 미구현",
  ]) assert.ok(runbook.includes(required), required);
});

test("[T12] governance matrix separates data and AI controls at every pipeline stage", async () => {
  const governance = await read("docs/governance-matrix.md");

  for (const heading of ["Data Governance", "AI Governance"])
    assert.ok(governance.includes(heading), heading);
  for (const stage of ["입력", "계산", "온톨로지 판정", "RAG 근거", "LLM 설명", "상담 브리프"])
    assert.ok(governance.includes(stage), stage);
  for (const column of ["위험", "통제", "테스트 증거", "프로토타입 한계", "실서비스 교체"])
    assert.ok(governance.includes(column), column);

  assert.doesNotMatch(
    governance,
    /(IAM|RBAC|DLP|SIEM|LLM Gateway).{0,20}(구현됨|구현 완료|현재 제공)/,
  );
  for (const futureControl of ["IAM/RBAC", "DLP", "암호화 키관리", "중앙 SIEM", "내부 LLM Gateway", "보존·삭제 정책"])
    assert.ok(governance.includes(futureControl), futureControl);
});
