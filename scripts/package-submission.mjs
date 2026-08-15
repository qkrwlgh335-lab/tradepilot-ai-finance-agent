// 최신 코드 전달본과 심사용 문서를 하나의 최종 제출 ZIP으로 조립한다.
// 사용: npm run package:submission
import { access, copyFile, cp, mkdir, rm, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import {
  scanDirectory,
  scanExtractedZip,
} from "./security-scan.mjs";

const execFileP = promisify(execFile);
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const DIST = path.join(ROOT, "dist");
const CODE_SOURCE = path.join(DIST, "KB_TradePilot");
const STAGE_NAME = "1. 수출입금융 지원 에이전트 (KB TradePilot)";
const STAGE = path.join(DIST, STAGE_NAME);
const DOC_SOURCE = path.join(ROOT, "기획안", STAGE_NAME);
const DEFAULT_SUBMISSION_ZIP = path.join(
  ROOT,
  "기획안",
  "KB_TradePilot_수출입금융에이전트_제출.zip",
);

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} 뒤에 경로가 필요합니다.`);
  return value;
}

const outputArgument = argumentValue("--output");
const SUBMISSION_ZIP = path.resolve(outputArgument || DEFAULT_SUBMISSION_ZIP);
if (path.extname(SUBMISSION_ZIP).toLowerCase() !== ".zip")
  throw new Error(`제출 산출물은 .zip이어야 합니다: ${SUBMISSION_ZIP}`);

function assertChild(parent, target) {
  const relative = path.relative(parent, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`안전하지 않은 패키징 경로: ${target}`);
  }
}

assertChild(ROOT, DIST);
assertChild(DIST, STAGE);
if (!outputArgument) assertChild(ROOT, SUBMISSION_ZIP);

for (const required of [
  path.join(DOC_SOURCE, "기획안.md"),
  path.join(DOC_SOURCE, "발표자료.pptx"),
  path.join(ROOT, "README.md"),
  path.join(ROOT, "실행방법_먼저읽기.txt"),
  path.join(ROOT, "generated", "evaluation-report.json"),
  path.join(ROOT, "eval"),
  path.join(ROOT, "docs", "rev4-ppt-evidence.md"),
]) await access(required);

// package.mjs가 dist를 새로 만들므로 항상 현재 소스와 동일한 코드 전달본을 사용한다.
await import("./package.mjs");

await rm(STAGE, { recursive: true, force: true });
await mkdir(STAGE, { recursive: true });
await cp(CODE_SOURCE, path.join(STAGE, "실행코드"), { recursive: true });
await copyFile(path.join(ROOT, "README.md"), path.join(STAGE, "README.md"));
await copyFile(path.join(ROOT, "실행방법_먼저읽기.txt"), path.join(STAGE, "실행방법_먼저읽기.txt"));
await copyFile(path.join(DOC_SOURCE, "기획안.md"), path.join(STAGE, "기획안.md"));
await copyFile(path.join(DOC_SOURCE, "발표자료.pptx"), path.join(STAGE, "발표자료.pptx"));
await copyFile(
  path.join(CODE_SOURCE, "전체코드_한파일.md"),
  path.join(STAGE, "전체코드_한파일.md"),
);

const EVIDENCE_STAGE = path.join(STAGE, "평가근거");
await mkdir(EVIDENCE_STAGE, { recursive: true });
await copyFile(
  path.join(ROOT, "generated", "evaluation-report.json"),
  path.join(EVIDENCE_STAGE, "evaluation-report.json"),
);
await cp(path.join(ROOT, "eval"), path.join(EVIDENCE_STAGE, "eval"), { recursive: true });
await copyFile(
  path.join(ROOT, "docs", "rev4-ppt-evidence.md"),
  path.join(EVIDENCE_STAGE, "발표자료_근거매핑.md"),
);

const stagedScan = await scanDirectory(STAGE);
if (stagedScan.findings.length > 0)
  throw new Error(`패키징 단계에서 키 유사 값 ${stagedScan.findings.length}건을 발견했습니다.`);

await mkdir(path.dirname(SUBMISSION_ZIP), { recursive: true });
if (process.platform === "win32") {
  await execFileP("powershell", [
    "-NoProfile",
    "-Command",
    "Compress-Archive -LiteralPath $env:TRADEPILOT_ZIP_SOURCE -DestinationPath $env:TRADEPILOT_ZIP_DESTINATION -Force",
  ], {
    env: {
      ...process.env,
      TRADEPILOT_ZIP_SOURCE: STAGE,
      TRADEPILOT_ZIP_DESTINATION: SUBMISSION_ZIP,
    },
  });
} else {
  await rm(SUBMISSION_ZIP, { force: true });
  await execFileP("zip", ["-qr", SUBMISSION_ZIP, STAGE_NAME], { cwd: DIST });
}

const extractedScan = await scanExtractedZip(SUBMISSION_ZIP);
if (extractedScan.findings.length > 0)
  throw new Error(`추출된 제출 ZIP에서 키 유사 값 ${extractedScan.findings.length}건을 발견했습니다.`);

const bytes = (await stat(SUBMISSION_ZIP)).size;
console.log(`[최종 제출본] ${path.relative(ROOT, SUBMISSION_ZIP)} (${Math.round(bytes / 1024)} KB)`);
console.log("포함: 실행방법 · README · 기획안 · 발표자료 · 최신 실행코드 · 전체코드 번들 · 평가근거");
console.log(`[보안 스캔 통과] 단계 ${stagedScan.scannedFiles}개 + ZIP 추출 ${extractedScan.scannedFiles}개 텍스트 파일 · 키 유사 값 0건`);
