// T30b — readiness must be bound to THIS spawned dev-server instance.
// A stranger process serving 200 on the same port is NOT our server: startDemo must
// notice the mismatch, refuse to open the browser, and exit cleanly. The instance
// token is a per-process secret used only for local identification.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { probeReadiness, buildHealthUrl } from "../scripts/start-demo.mjs";
import { createRequestHandler } from "../scripts/dev-server.mjs";
import { createMarketDataRefreshHook } from "../scripts/market-data-refresh-hook.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

async function withHttp(handler, fn) {
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  try { await fn(port); } finally { await new Promise((r) => server.close(r)); }
}

test("T30b (a): a stranger 200 server on the port is not accepted as ready", async () => {
  await withHttp((_req, res) => res.writeHead(200).end("hi"), async (port) => {
    const result = await probeReadiness({ port, instanceToken: "abc123", timeoutMs: 300, intervalMs: 30 });
    assert.equal(result.ready, false);
  });
});

test("T30b (b): health 200 but wrong instance token is not ready", async () => {
  await withHttp((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ready: true, instanceToken: "someone-else" }));
  }, async (port) => {
    const result = await probeReadiness({ port, instanceToken: "my-token", timeoutMs: 300, intervalMs: 30 });
    assert.equal(result.ready, false);
  });
});

test("T30b (c): matching instance token is ready", async () => {
  const TOKEN = "matching-token-hex";
  await withHttp((req, res) => {
    if (req.url === buildHealthUrl(0).replace(/^http:\/\/[^/]+/, "")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ready: true, instanceToken: TOKEN }));
    } else res.writeHead(404).end();
  }, async (port) => {
    const result = await probeReadiness({ port, instanceToken: TOKEN, timeoutMs: 2000, intervalMs: 30 });
    assert.equal(result.ready, true);
  });
});

test("T30b (d): health 404 or malformed JSON is not ready", async () => {
  await withHttp((_req, res) => res.writeHead(404).end("no"), async (port) => {
    assert.equal((await probeReadiness({ port, instanceToken: "x", timeoutMs: 300, intervalMs: 30 })).ready, false);
  });
  await withHttp((_req, res) => { res.writeHead(200); res.end("<html>not json"); }, async (port) => {
    assert.equal((await probeReadiness({ port, instanceToken: "x", timeoutMs: 300, intervalMs: 30 })).ready, false);
  });
});

test("T30b (e): if the child process exits before ready, probeReadiness returns false quickly", async () => {
  // Simulate a child that exits immediately with an in-band signal.
  const controller = { done: false, exited: true, checkExit: () => true };
  const start = Date.now();
  // No listener will ever answer on this port; the caller reports exit → we bail.
  const result = await probeReadiness({
    port: 1, instanceToken: "x", timeoutMs: 5000, intervalMs: 30,
    isChildAlive: () => !controller.exited,
  });
  const elapsed = Date.now() - start;
  assert.equal(result.ready, false);
  assert.ok(elapsed < 1000, `must abort quickly on child exit — waited ${elapsed}ms`);
});

test("T30b (f): dev-server /_health does NOT trigger the refresh hook", async () => {
  let calls = 0;
  const hook = createMarketDataRefreshHook({ refresh: async () => { calls += 1; }, now: () => 0 });
  const handler = createRequestHandler({ hook, instanceToken: "tok-abc" });
  await withHttp(handler, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/_health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ready, true);
    assert.equal(body.instanceToken, "tok-abc");
    assert.equal(calls, 0, "health must never trigger refresh");
  });
});

test("T30b (g): dev-server / DOES trigger the refresh hook (regression)", async () => {
  let calls = 0;
  const hook = createMarketDataRefreshHook({ refresh: async () => { calls += 1; }, now: () => 0 });
  const handler = createRequestHandler({ hook, instanceToken: "tok-abc" });
  await withHttp(handler, async (port) => {
    await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(calls, 1);
  });
});

test("T30b (h): the instance token never appears in any tracked file under js/ or index.html", async () => {
  // The token is per-process and lives only in env + the /_health JSON response — it MUST NOT
  // be baked into any static asset shipped to the browser.
  const files = ["index.html"];
  for (const name of await readdir(join(ROOT, "js")))
    if (name.endsWith(".js")) files.push(`js/${name}`);
  for (const rel of files) {
    const src = await readFile(join(ROOT, rel), "utf8");
    assert.doesNotMatch(src, /KB_DEMO_INSTANCE_TOKEN/, `${rel} must not reference the instance-token env var`);
    assert.doesNotMatch(src, /instanceToken/, `${rel} must not reference the instance token identifier`);
  }
});

test("T30b: buildHealthUrl targets /_health on 127.0.0.1 with the given port", () => {
  assert.equal(buildHealthUrl(8000), "http://127.0.0.1:8000/_health");
  assert.equal(buildHealthUrl(8801), "http://127.0.0.1:8801/_health");
});
