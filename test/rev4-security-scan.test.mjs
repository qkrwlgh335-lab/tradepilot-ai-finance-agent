import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  DEFAULT_EXCLUDED_DIRS,
  excludedDirsForRoot,
  findKeyLikeValues,
  scanDirectory,
  scanExtractedZip,
} from "../scripts/security-scan.mjs";

const execFileP = promisify(execFile);
const ROOT = fileURLToPath(new URL("../", import.meta.url));

async function makeZip(sourceDir, zipPath) {
  if (process.platform === "win32") {
    await execFileP("powershell", [
      "-NoProfile",
      "-Command",
      "Compress-Archive -LiteralPath $env:TRADEPILOT_ZIP_SOURCE -DestinationPath $env:TRADEPILOT_ZIP_DESTINATION -Force",
    ], {
      env: {
        ...process.env,
        TRADEPILOT_ZIP_SOURCE: sourceDir,
        TRADEPILOT_ZIP_DESTINATION: zipPath,
      },
    });
    return;
  }
  await execFileP("zip", ["-qr", zipPath, path.basename(sourceDir)], {
    cwd: path.dirname(sourceDir),
  });
}

test("T28 key scan detects values, not environment-variable names", () => {
  const anthropic = ["sk", "ant", "AbCdEfGhIjKlMnOpQrStUvWxYz012345"].join("-");
  const aws = `AKIA${"A1B2C3D4E5F6G7H8"}`;
  const bearer = `Bearer ${"tokenValue0123456789abcdef"}`;
  const jwt = [
    "eyJhbGciOiJIUzI1NiJ9",
    "eyJzdWIiOiIxMjM0NTY3ODkwIn0",
    "signatureValue012345",
  ].join(".");

  for (const value of [anthropic, aws, bearer, jwt])
    assert.ok(findKeyLikeValues(value).length >= 1, value.slice(0, 8));

  assert.deepEqual(findKeyLikeValues("ANTHROPIC_API_KEY"), []);
  assert.deepEqual(findKeyLikeValues("ANTHROPIC_API_KEY=replace-me"), []);
  assert.deepEqual(findKeyLikeValues("AWS_ACCESS_KEY_ID"), []);
});

test("T28 repository scan excludes generated/vendor areas but scans release source", async () => {
  assert.ok(DEFAULT_EXCLUDED_DIRS.has(".git"));
  assert.ok(DEFAULT_EXCLUDED_DIRS.has("node_modules"));
  assert.ok(DEFAULT_EXCLUDED_DIRS.has("dist"));
  assert.ok(DEFAULT_EXCLUDED_DIRS.has("기획안"));
  assert.equal(excludedDirsForRoot(`${ROOT}${path.sep}`), DEFAULT_EXCLUDED_DIRS);
  assert.equal(excludedDirsForRoot(ROOT), DEFAULT_EXCLUDED_DIRS);

  const report = await scanDirectory(ROOT, {
    excludedDirs: DEFAULT_EXCLUDED_DIRS,
  });
  assert.ok(report.scannedFiles > 0);
  assert.deepEqual(report.findings, []);
});

test("T28 ZIP scan extracts to temp, finds unsafe content and leaves the ZIP unchanged", async () => {
  const work = await mkdtemp(path.join(tmpdir(), "tradepilot-t28-test-"));
  try {
    const safeDir = path.join(work, "safe-package");
    const unsafeDir = path.join(work, "unsafe-package");
    const safeZip = path.join(work, "safe.zip");
    const unsafeZip = path.join(work, "unsafe.zip");
    await mkdir(safeDir);
    await mkdir(unsafeDir);
    await writeFile(path.join(safeDir, "README.md"), "ANTHROPIC_API_KEY is configured only on the server.\n");
    const unsafeValue = ["sk", "ant", "UnsafeValue0123456789abcdefgh"].join("-");
    await writeFile(path.join(unsafeDir, "leak.txt"), `secret=${unsafeValue}\n`);
    await makeZip(safeDir, safeZip);
    await makeZip(unsafeDir, unsafeZip);

    const before = await stat(safeZip);
    const safeReport = await scanExtractedZip(safeZip);
    const after = await stat(safeZip);
    assert.deepEqual(safeReport.findings, []);
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeMs, before.mtimeMs);

    const unsafeReport = await scanExtractedZip(unsafeZip);
    assert.ok(unsafeReport.findings.some((item) => item.kind === "anthropic_key"));
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("T28 proxy check never echoes a fake key-like value", async () => {
  const fakeKey = ["sk", "ant", "NeverPrintThisValue0123456789"].join("-");
  const { stdout, stderr } = await execFileP(
    process.execPath,
    [path.join(ROOT, "proxy.mjs"), "--check"],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: fakeKey,
        ANTHROPIC_MODEL: "test-model",
      },
      timeout: 5_000,
    },
  );
  assert.equal(`${stdout}${stderr}`.includes(fakeKey), false);
});

test("T28 package and checklist distinguish automatic and manual verification", async () => {
  const [pack, checklist, pkgText] = await Promise.all([
    readFile(path.join(ROOT, "scripts", "package-submission.mjs"), "utf8"),
    readFile(path.join(ROOT, "docs", "rev4-verification-checklist.md"), "utf8"),
    readFile(path.join(ROOT, "package.json"), "utf8"),
  ]);
  const pkg = JSON.parse(pkgText);

  assert.match(pack, /--output/);
  assert.match(pack, /path\.join\(ROOT,\s*"generated",\s*"evaluation-report\.json"\)/);
  assert.match(pack, /path\.join\(ROOT,\s*"eval"\)/);
  assert.match(pack, /scanExtractedZip/);
  assert.doesNotMatch(pack, /readFile\([^)]*SUBMISSION_ZIP[^)]*"utf8"/s);
  assert.equal(pkg.scripts["security:scan"], "node scripts/security-scan.mjs");

  assert.match(checklist, /자동 검사[\s\S]*정적/);
  assert.match(checklist, /수동 확인[\s\S]*localStorage[\s\S]*sessionStorage/);
  assert.match(checklist, /기존 제출 ZIP을 덮어쓰지 않는다/);
  assert.match(checklist, /합성 평가 34건[\s\S]*12\/12/);
});
