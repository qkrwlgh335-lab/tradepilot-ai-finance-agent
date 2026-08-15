import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadDemoEnvironment,
  resolveExternalAiConfig,
} from "../scripts/start-demo.mjs";
import { createProxyServer } from "../proxy.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

test("T54: external AI auto-start requires both a non-empty key and model", () => {
  assert.deepEqual(resolveExternalAiConfig({}), { enabled: false, reason: "missing_api_key" });
  assert.deepEqual(resolveExternalAiConfig({ ANTHROPIC_API_KEY: "  ", ANTHROPIC_MODEL: "model" }),
    { enabled: false, reason: "missing_api_key" });
  assert.deepEqual(resolveExternalAiConfig({ ANTHROPIC_API_KEY: "test-key", ANTHROPIC_MODEL: "  " }),
    { enabled: false, reason: "missing_model" });
  assert.deepEqual(resolveExternalAiConfig({ ANTHROPIC_API_KEY: "test-key", ANTHROPIC_MODEL: "model-id" }),
    { enabled: true, reason: "configured" });
});

test("T54: .env is loaded into a cloned child environment without mutating the caller", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "tradepilot-env-"));
  const filePath = path.join(dir, ".env");
  await writeFile(filePath, "ANTHROPIC_API_KEY=test-key\nANTHROPIC_MODEL=test-model\n", "utf8");
  const original = { SAFE: "yes" };
  const loaded = await loadDemoEnvironment({ env: original, filePath });
  assert.equal(original.ANTHROPIC_API_KEY, undefined);
  assert.equal(loaded.SAFE, "yes");
  assert.equal(loaded.ANTHROPIC_API_KEY, "test-key");
  assert.equal(loaded.ANTHROPIC_MODEL, "test-model");
});

test("T54: proxy readiness is instance-bound and never returns the API key", async () => {
  const env = {
    ANTHROPIC_API_KEY: "never-print-this-value",
    ANTHROPIC_MODEL: "test-model",
    KB_PROXY_INSTANCE_TOKEN: "proxy-instance-token",
  };
  const server = createProxyServer({ env, fetchImpl: async () => { throw new Error("unused"); } });
  const port = await listen(server);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/_health`);
    assert.equal(response.status, 200);
    const raw = await response.text();
    assert.doesNotMatch(raw, /never-print-this-value/);
    assert.deepEqual(JSON.parse(raw), {
      ready: true,
      configured: true,
      instanceToken: "proxy-instance-token",
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("T54: manually started proxy without an instance token does not expose readiness", async () => {
  const server = createProxyServer({
    env: { ANTHROPIC_API_KEY: "test-key", ANTHROPIC_MODEL: "test-model" },
    fetchImpl: async () => { throw new Error("unused"); },
  });
  const port = await listen(server);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/_health`);
    assert.equal(response.status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("T54: setup helper creates local .env, waits for editing, then launches the normal demo", async () => {
  const setup = await readFile(path.join(ROOT, "외부AI_설정후_실행.cmd"), "utf8");
  assert.match(setup, /copy\s+\/y\s+"\.env\.example"\s+"\.env"/i);
  assert.match(setup, /start\s+""\s+\/wait\s+notepad\.exe\s+"\.env"/i);
  assert.match(setup, /call\s+START_DEMO\.cmd/i);
  assert.doesNotMatch(setup, /sk-ant-|ANTHROPIC_API_KEY\s*=\s*[^\r\n%]+/i);
});

test("T54: the standard launcher contains automatic proxy start and child cleanup", async () => {
  const source = await readFile(path.join(ROOT, "scripts", "start-demo.mjs"), "utf8");
  assert.match(source, /path\.join\(ROOT,\s*"proxy\.mjs"\)/);
  assert.match(source, /resolveExternalAiConfig\(launchEnv\)/);
  assert.match(source, /KB_PROXY_INSTANCE_TOKEN/);
  assert.match(source, /if \(proxy && !proxy\.killed\) proxy\.kill/);
});
