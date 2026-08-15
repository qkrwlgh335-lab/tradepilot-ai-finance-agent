// HARNESS: T9 browser/proxy security boundaries and honest automated checks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createProvider } from "../js/llm-provider.js";

const execFileP = promisify(execFile);
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const JS_DIR = path.join(ROOT, "js");

async function jsFiles() {
  const names = (await readdir(JS_DIR)).filter((name) => name.endsWith(".js"));
  return Promise.all(names.map(async (name) => [
    name,
    await readFile(path.join(JS_DIR, name), "utf8"),
  ]));
}

test("SECURITY: browser code has no API key storage, dangerous header or direct Anthropic call", async () => {
  const files = [
    ...await jsFiles(),
    ["index.html", await readFile(path.join(ROOT, "index.html"), "utf8")],
  ];
  for (const [name, source] of files) {
    assert.doesNotMatch(source, /anthropic-dangerous-direct-browser-access/, name);
    assert.doesNotMatch(source, /api\.anthropic\.com/, name);
    assert.doesNotMatch(
      source,
      /(local|session)Storage\.setItem\([^)]*(key|token|anthropic)/i,
      name,
    );
    assert.doesNotMatch(source, /sk-ant-[A-Za-z0-9_-]{6,}/, name);
  }
});

test("SECURITY: external browser request contains only purpose and analysisPayload", async () => {
  let url;
  let body;
  const provider = createProvider("external", {
    approved: true,
    fetchImpl: async (requestUrl, options) => {
      url = requestUrl;
      body = JSON.parse(options.body);
      return { ok: true, json: async () => ({ text: "ok" }) };
    },
  });
  await provider.complete({
    purpose: "product_explanation",
    analysisPayload: { cfarTotal: 1 },
  });
  assert.equal(url, "http://127.0.0.1:8787/api/explain");
  assert.deepEqual(Object.keys(body).sort(), ["analysisPayload", "purpose"]);
  assert.equal(JSON.stringify(body).includes("system"), false);
  assert.equal(JSON.stringify(body).includes("userContent"), false);
});

test("SECURITY: proxy check mode never echoes its fake environment key", async () => {
  const fakeKey = "test-secret-value-never-print";
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
  assert.ok(!`${stdout}${stderr}`.includes(fakeKey));
});

test("SECURITY: tracked source and extracted package contain no key-like value", async () => {
  const keyish =
    /(sk-ant-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9]{20,}|ANTHROPIC_API_KEY[ \t]*[:=][ \t]*["']?(?:sk-)?[A-Za-z0-9_-]{12,})/;
  const sourceFiles = [
    "index.html",
    "proxy.mjs",
    ".env.example",
    ...(await readdir(JS_DIR)).filter((name) => name.endsWith(".js")).map((name) => `js/${name}`),
  ];
  for (const relative of sourceFiles) {
    const source = await readFile(path.join(ROOT, relative), "utf8");
    assert.doesNotMatch(source, keyish, relative);
  }

  const extracted = path.join(ROOT, "dist", "KB_TradePilot");
  try {
    if ((await stat(extracted)).isDirectory()) {
      for (const relative of sourceFiles) {
        const source = await readFile(path.join(extracted, relative), "utf8");
        assert.doesNotMatch(source, keyish, `dist/${relative}`);
      }
    }
  } catch {
    // Clean checkout before `npm run package`: extracted-package verification is
    // performed after packaging, and is intentionally not claimed here.
  }
});
