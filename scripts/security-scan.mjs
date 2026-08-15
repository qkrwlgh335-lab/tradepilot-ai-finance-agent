// 제출 소스와 "추출된" ZIP 내부에서 실제 키처럼 보이는 값을 찾는다.
// 환경변수 이름이나 API 키 설정 안내 문구만으로는 실패시키지 않는다.
import { execFile } from "node:child_process";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const ROOT = fileURLToPath(new URL("../", import.meta.url));

export const DEFAULT_EXCLUDED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "기획안",
]);

export function excludedDirsForRoot(root) {
  return path.resolve(root) === path.resolve(ROOT)
    ? DEFAULT_EXCLUDED_DIRS
    : new Set();
}

const TEXT_EXTENSIONS = new Set([
  "",
  ".cmd",
  ".css",
  ".csv",
  ".env",
  ".example",
  ".html",
  ".ini",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".ps1",
  ".svg",
  ".toml",
  ".ts",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);

const KEY_LIKE_PATTERNS = [
  {
    kind: "anthropic_key",
    regex: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g,
  },
  {
    kind: "generic_api_key",
    regex: /\bsk-(?!ant-)[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    kind: "aws_access_key",
    regex: /\bAKIA[0-9A-Z]{16}\b/g,
  },
  {
    kind: "bearer_token",
    regex: /\bBearer[ \t]+[A-Za-z0-9._~+/=-]{20,}/gi,
  },
  {
    kind: "jwt",
    regex: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
];

function lineAndColumn(text, index) {
  const before = text.slice(0, index);
  const lines = before.split(/\r?\n/);
  return {
    line: lines.length,
    column: lines.at(-1).length + 1,
  };
}

export function findKeyLikeValues(text) {
  if (typeof text !== "string") return [];
  const findings = [];
  for (const { kind, regex } of KEY_LIKE_PATTERNS) {
    const matcher = new RegExp(regex.source, regex.flags);
    for (const match of text.matchAll(matcher)) {
      const position = lineAndColumn(text, match.index);
      findings.push({
        kind,
        index: match.index,
        ...position,
      });
    }
  }
  return findings.sort((a, b) => a.index - b.index || a.kind.localeCompare(b.kind));
}

function isTextCandidate(filePath) {
  const name = path.basename(filePath);
  if (name === ".gitignore" || name === "Dockerfile") return true;
  return TEXT_EXTENSIONS.has(path.extname(name).toLowerCase());
}

async function collectTextFiles(root, excludedDirs, current = root) {
  const files = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) {
      if (!excludedDirs.has(entry.name))
        files.push(...await collectTextFiles(root, excludedDirs, absolute));
      continue;
    }
    if (entry.isFile() && isTextCandidate(absolute)) files.push(absolute);
  }
  return files;
}

export async function scanDirectory(root, {
  excludedDirs = new Set(),
} = {}) {
  const absoluteRoot = path.resolve(root);
  const rootStat = await stat(absoluteRoot);
  if (!rootStat.isDirectory()) throw new Error(`스캔 대상이 디렉터리가 아닙니다: ${absoluteRoot}`);

  const files = await collectTextFiles(absoluteRoot, excludedDirs);
  const findings = [];
  for (const filePath of files.sort((a, b) => a.localeCompare(b))) {
    const text = await readFile(filePath, "utf8");
    for (const finding of findKeyLikeValues(text)) {
      findings.push({
        file: path.relative(absoluteRoot, filePath).replaceAll("\\", "/"),
        kind: finding.kind,
        line: finding.line,
        column: finding.column,
      });
    }
  }
  return {
    root: absoluteRoot,
    scannedFiles: files.length,
    findings,
  };
}

export async function scanExtractedZip(zipPath) {
  const absoluteZip = path.resolve(zipPath);
  const zipStat = await stat(absoluteZip);
  if (!zipStat.isFile() || path.extname(absoluteZip).toLowerCase() !== ".zip")
    throw new Error(`ZIP 파일이 아닙니다: ${absoluteZip}`);

  const extractionRoot = await mkdtemp(path.join(tmpdir(), "tradepilot-zip-scan-"));
  try {
    if (process.platform === "win32") {
      await execFileP("powershell", [
        "-NoProfile",
        "-Command",
        "Expand-Archive -LiteralPath $env:TRADEPILOT_ZIP_ARCHIVE -DestinationPath $env:TRADEPILOT_ZIP_EXTRACT -Force",
      ], {
        env: {
          ...process.env,
          TRADEPILOT_ZIP_ARCHIVE: absoluteZip,
          TRADEPILOT_ZIP_EXTRACT: extractionRoot,
        },
      });
    } else {
      await execFileP("unzip", ["-q", absoluteZip, "-d", extractionRoot]);
    }
    const report = await scanDirectory(extractionRoot);
    return {
      archive: absoluteZip,
      scannedFiles: report.scannedFiles,
      findings: report.findings,
    };
  } finally {
    await rm(extractionRoot, { recursive: true, force: true });
  }
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} 뒤에 경로가 필요합니다.`);
  return value;
}

function assertClean(label, report) {
  if (report.findings.length === 0) return;
  const locations = report.findings
    .map((item) => `${item.file}:${item.line}:${item.column} (${item.kind})`)
    .join("\n");
  throw new Error(`${label}에서 키 유사 값 ${report.findings.length}건을 발견했습니다.\n${locations}`);
}

async function main() {
  const root = path.resolve(argumentValue("--root") || ROOT);
  const zip = argumentValue("--zip");
  const repoReport = await scanDirectory(root, {
    excludedDirs: excludedDirsForRoot(root),
  });
  assertClean("디렉터리", repoReport);
  console.log(`[보안 스캔 통과] ${repoReport.scannedFiles}개 텍스트 파일 · 키 유사 값 0건`);

  if (zip) {
    const zipReport = await scanExtractedZip(zip);
    assertClean("추출된 ZIP", zipReport);
    console.log(`[ZIP 추출 스캔 통과] ${zipReport.scannedFiles}개 텍스트 파일 · 키 유사 값 0건`);
  }
}

const isDirectRun = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
