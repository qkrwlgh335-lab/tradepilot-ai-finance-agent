// T30a — the npm start entry point must probe an actual readiness endpoint (no fixed sleep),
// return a clear error on server startup failure, and never open the browser before the server
// responds. START_DEMO.cmd is a thin wrapper around `npm start`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { probeReadiness, buildDemoUrl } from "../scripts/start-demo.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

// T30b tightened probeReadiness: it now requires a JSON /_health body carrying the caller's
// own instance token. These T30a tests are updated in place to use the new contract; T30b
// covers the stranger-server rejection path.
const TOKEN = "unit-test-token";
const healthJson = (token) => (req, res) => {
  if (req.url === "/_health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ready: true, instanceToken: token }));
    return;
  }
  res.writeHead(404).end();
};

test("T30a: probeReadiness resolves once /_health returns the matching token", async () => {
  const server = createServer(healthJson(TOKEN));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  try {
    const result = await probeReadiness({ port, instanceToken: TOKEN, timeoutMs: 2000, intervalMs: 20 });
    assert.equal(result.ready, true);
    assert.ok(result.attempts >= 1);
  } finally { await new Promise((r) => server.close(r)); }
});

test("T30a: probeReadiness fails cleanly when the server never comes up (no infinite wait)", async () => {
  const start = Date.now();
  const result = await probeReadiness({ port: 1, instanceToken: TOKEN, timeoutMs: 200, intervalMs: 30 });
  assert.equal(result.ready, false);
  assert.ok(Date.now() - start < 2000, "must respect the caller's timeout budget");
});

test("T30a: probeReadiness keeps polling until /_health returns the matching token", async () => {
  let hits = 0;
  const server = createServer((req, res) => {
    hits += 1;
    if (hits < 3) { res.writeHead(503).end(); return; }
    if (req.url === "/_health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ready: true, instanceToken: TOKEN }));
    } else res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  try {
    const result = await probeReadiness({ port, instanceToken: TOKEN, timeoutMs: 3000, intervalMs: 30 });
    assert.equal(result.ready, true);
    assert.ok(result.attempts >= 3, `attempts=${result.attempts}`);
  } finally { await new Promise((r) => server.close(r)); }
});

test("T30a: buildDemoUrl targets 127.0.0.1 with the given port and no query", () => {
  assert.equal(buildDemoUrl(8000), "http://127.0.0.1:8000/");
  assert.equal(buildDemoUrl(8801), "http://127.0.0.1:8801/");
});

test("T30a: package.json exposes 'start' → node scripts/start-demo.mjs", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(typeof pkg.scripts?.start, "string");
  assert.match(pkg.scripts.start, /scripts[\\\/]start-demo\.mjs/);
});

test("T30a: START_DEMO.cmd is a thin wrapper that calls npm start and does not open the browser directly", async () => {
  const cmd = await readFile(new URL("../START_DEMO.cmd", import.meta.url), "utf8");
  assert.match(cmd, /npm\s+start/i, "START_DEMO.cmd must call npm start");
  // The browser must be opened by start-demo.mjs AFTER readiness, not blindly by the .cmd.
  assert.doesNotMatch(cmd, /^\s*start\s+""\s+"http:/im, "START_DEMO.cmd must not open the browser itself");
  assert.doesNotMatch(cmd, /timeout\s*\/t\s*\d+\s*\/nobreak/i, "no fixed timeout wait — the wrapper delegates readiness to start-demo.mjs");
});
