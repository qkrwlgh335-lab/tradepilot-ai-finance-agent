// 코드 전달용 산출물 생성기 — 리포 안에 소스 복사본을 만들지 않고 gitignore된 dist/ 에만 만든다.
// 이것은 "현재 코드 전달용"일 뿐 최종 제출 패키지가 아니다.
// 최종 제출 패키지(참가신청서 + 기술설명서 PPT + 기획안/README + 실행 코드)는
// 계획의 T12·T14 이후 별도로 조립한다. (계획 "최종 제출 패키지 조립" 절 참고)
// 사용: npm run package
import { readdir, readFile, writeFile, mkdir, copyFile, rm, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileP = promisify(execFile);
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const DIST = path.join(ROOT, "dist");
const OUT_NAME = "KB_TradePilot";
const OUT = path.join(DIST, OUT_NAME);

// 복사 제외: 의존성·VCS·산출물·기존 전달용 폴더·비밀
// (.gitignore는 포함한다 — 제출본에서도 test/test-scope.test.mjs가 그대로 통과해야 한다)
const SKIP = new Set([
  "node_modules", ".git", ".superpowers", "superpowers", ".claude", "dist", "기획안", ".env",
]);
// 한 파일 번들에 본문을 넣을 확장자
const TEXT_EXT = new Set([".html", ".css", ".js", ".mjs", ".json", ".md"]);
// 번들 본문에서 제외(생성물이라 사람이 읽을 필요 없음)
const BUNDLE_SKIP_FILES = new Set(["package-lock.json", "product-embeddings.json"]);
const LANG = { ".html": "html", ".css": "css", ".js": "javascript", ".mjs": "javascript", ".json": "json", ".md": "markdown" };

async function collect(dir, rel = "") {
  const out = [];
  for (const e of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (SKIP.has(e.name)) continue;
    const abs = path.join(dir, e.name);
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await collect(abs, r)));
    else out.push({ abs, rel: r });
  }
  return out;
}

function tree(files) {
  const lines = [];
  const seen = new Set();
  for (const f of files) {
    const parts = f.rel.split("/");
    for (let i = 0; i < parts.length; i++) {
      const key = parts.slice(0, i + 1).join("/");
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(`${"  ".repeat(i)}${parts[i]}${i < parts.length - 1 ? "/" : ""}`);
    }
  }
  return lines.join("\n");
}

const files = await collect(ROOT);

await rm(DIST, { recursive: true, force: true });
for (const f of files) {
  const dest = path.join(OUT, f.rel);
  await mkdir(path.dirname(dest), { recursive: true });
  await copyFile(f.abs, dest);
}

// AI 분석용 단일 파일 번들
const parts = [
  `# KB TradePilot — 전체 코드 한 파일 번들`,
  ``,
  `생성일: ${new Date().toISOString().slice(0, 10)} · 파일 ${files.length}개`,
  `- 이 문서는 \`npm run package\`로 자동 생성됩니다(수동 편집 금지).`,
  `- \`product-embeddings.json\`, \`package-lock.json\`은 생성물이라 본문에서 제외했습니다(패키지에는 포함).`,
  ``,
  `## 파일 트리`,
  ``,
  "```",
  tree(files),
  "```",
  ``,
  `## 파일 내용`,
  ``,
];
for (const f of files) {
  const ext = path.extname(f.rel);
  if (!TEXT_EXT.has(ext) || BUNDLE_SKIP_FILES.has(path.basename(f.rel))) continue;
  parts.push(`### \`${f.rel}\``, ``, "```" + (LANG[ext] || ""), await readFile(f.abs, "utf8"), "```", ``);
}
await writeFile(path.join(OUT, "전체코드_한파일.md"), parts.join("\n"), "utf8");

// zip (플랫폼별 도구 사용, 없으면 폴더만 남기고 계속 진행)
const zipPath = path.join(DIST, `${OUT_NAME}.zip`);
let zipped = false;
try {
  if (process.platform === "win32") {
    await execFileP("powershell", ["-NoProfile", "-Command", `Compress-Archive -Path '${OUT}\\*' -DestinationPath '${zipPath}' -Force`]);
  } else {
    await execFileP("zip", ["-qr", zipPath, OUT_NAME], { cwd: DIST });
  }
  zipped = true;
} catch (err) {
  console.warn(`zip 생성 건너뜀 (${err.code || err.message}). 폴더는 생성되었습니다.`);
}

const bundleBytes = (await stat(path.join(OUT, "전체코드_한파일.md"))).size;
console.log(`[코드 전달용 산출물 — 최종 제출 패키지 아님] ${files.length} files -> ${path.relative(ROOT, OUT)}`);
console.log(`bundle: 전체코드_한파일.md (${Math.round(bundleBytes / 1024)} KB)`);
if (zipped) console.log(`zip: ${path.relative(ROOT, zipPath)}`);
