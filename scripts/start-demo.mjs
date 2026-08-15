// KB TradePilot demo launcher.
// Spawns the dev server, waits for a real HTTP 200 on `/_health` whose JSON body carries THIS
// child's instance token before opening the browser. A stranger process serving 200 on the same
// port will not know the token, so we refuse to launch the browser and exit with a clear error.
// No fixed sleeps. No token leakage to logs / files / browser bundle.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";
import { loadEnvFile } from "../proxy.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const DEFAULT_PORT = Number(process.env.PORT || 8000);
const PROXY_PORT = 8787;

export function resolveExternalAiConfig(env = {}) {
  const key = typeof env.ANTHROPIC_API_KEY === "string"
    ? env.ANTHROPIC_API_KEY.trim()
    : "";
  const model = typeof env.ANTHROPIC_MODEL === "string"
    ? env.ANTHROPIC_MODEL.trim()
    : "";
  if (!key) return { enabled: false, reason: "missing_api_key" };
  if (!model) return { enabled: false, reason: "missing_model" };
  return { enabled: true, reason: "configured" };
}

export async function loadDemoEnvironment({
  env = process.env,
  filePath = path.join(ROOT, ".env"),
} = {}) {
  const merged = { ...env };
  await loadEnvFile({ env: merged, filePath });
  return merged;
}

export function buildDemoUrl(port) {
  return `http://127.0.0.1:${port}/`;
}
export function buildHealthUrl(port) {
  return `http://127.0.0.1:${port}/_health`;
}

// Poll /_health until the JSON body reports { ready:true, instanceToken:<expected> }, or the
// caller's timeout budget is exhausted, or the child process exits before ready. Returns
// { ready, attempts, reason? }. `isChildAlive` is optional; when it returns false we bail
// immediately without waiting for timeout.
export async function probeReadiness({
  port,
  instanceToken,
  timeoutMs = 15_000,
  intervalMs = 100,
  fetchImpl = globalThis.fetch,
  isChildAlive = null,
} = {}) {
  if (typeof instanceToken !== "string" || instanceToken.length === 0)
    return { ready: false, attempts: 0, reason: "missing instance token" };
  const url = buildHealthUrl(port);
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  while (Date.now() < deadline) {
    if (typeof isChildAlive === "function" && !isChildAlive())
      return { ready: false, attempts, reason: "child exited" };
    attempts += 1;
    try {
      const response = await fetchImpl(url);
      if (response && response.status === 200) {
        let payload;
        try { payload = await response.json(); } catch { payload = null; }
        if (payload && payload.ready === true && payload.instanceToken === instanceToken)
          return { ready: true, attempts };
        // Reachable but not ours (missing/wrong token or malformed) — keep polling in case our
        // own child comes up on a DIFFERENT port later would be pointless, but here we're pinned
        // to this port, so a stranger will keep answering: the timeout will trip.
      }
    } catch { /* server not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return { ready: false, attempts };
}

// Best-effort browser open. Failure to open the browser is not a startup failure — the URL is
// printed either way. On failure the child exits gracefully and start-demo returns without opening.
function openBrowserDefault(url) {
  const platform = process.platform;
  try {
    if (platform === "win32") {
      // start "" "url"  — the empty title argument is required so cmd.exe doesn't treat the URL
      // as the window title.
      spawn("cmd.exe", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    } else if (platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch { /* leave the URL printed to the console */ }
}

export async function startDemo({
  port = DEFAULT_PORT,
  openBrowser: openBrowserFn = openBrowserDefault,
  timeoutMs = 15_000,
  env = process.env,
} = {}) {
  const launchEnv = await loadDemoEnvironment({ env });
  const externalConfig = resolveExternalAiConfig(launchEnv);
  let proxy = null;

  if (externalConfig.enabled) {
    const proxyToken = randomBytes(16).toString("hex");
    let proxyExited = false;
    proxy = spawn(process.execPath, [path.join(ROOT, "proxy.mjs")], {
      cwd: ROOT,
      stdio: "inherit",
      env: {
        ...launchEnv,
        KB_PROXY_INSTANCE_TOKEN: proxyToken,
      },
    });
    proxy.on("exit", () => { proxyExited = true; });
    const proxyReadiness = await probeReadiness({
      port: PROXY_PORT,
      instanceToken: proxyToken,
      timeoutMs: Math.min(timeoutMs, 5_000),
      intervalMs: 100,
      isChildAlive: () => !proxyExited,
    });
    if (proxyReadiness.ready) {
      console.log("[KB TradePilot] 외부 AI 프록시 준비 완료 — 화면에서 전송 내용을 확인·승인하면 사용합니다.");
    } else {
      console.warn("[KB TradePilot] 외부 AI 프록시를 시작하지 못해 로컬 설명 모드로 계속합니다.");
      if (!proxyExited) proxy.kill();
      proxy = null;
    }
  } else {
    console.log("[KB TradePilot] 외부 AI 미설정 — API 키 없이 로컬 설명 모드로 시작합니다.");
  }

  // Local process identifier — 32 hex chars. Not a secret. Never logged.
  const instanceToken = randomBytes(16).toString("hex");
  const server = spawn(process.execPath, [path.join(ROOT, "scripts", "dev-server.mjs")], {
    cwd: ROOT,
    stdio: "inherit",
    env: {
      ...launchEnv,
      PORT: String(port),
      KB_DEMO_INSTANCE_TOKEN: instanceToken,
    },
  });
  const url = buildDemoUrl(port);
  let exited = false;
  server.on("exit", (code) => {
    exited = true;
    if (proxy && !proxy.killed) proxy.kill();
    if (code !== 0 && code !== null) process.exitCode = code;
  });
  const forward = (signal) => () => {
    server.kill(signal);
    if (proxy && !proxy.killed) proxy.kill(signal);
  };
  process.on("SIGINT", forward("SIGINT"));
  process.on("SIGTERM", forward("SIGTERM"));

  const readiness = await probeReadiness({
    port,
    instanceToken,
    timeoutMs,
    intervalMs: 100,
    isChildAlive: () => !exited,
  });
  if (!readiness.ready) {
    // Message stays generic — it never prints the token or the raw child stderr.
    console.error(`[KB TradePilot] 서버 준비 실패 (attempts=${readiness.attempts}). 브라우저를 열지 않습니다. 다른 프로세스가 포트를 점유 중인지 확인하세요.`);
    if (!exited) server.kill();
    process.exitCode = 1;
    return { started: false, url, attempts: readiness.attempts };
  }
  console.log(`[KB TradePilot] 서버 준비 완료 (${readiness.attempts}회 확인) → ${url}`);
  openBrowserFn(url);
  return {
    started: true,
    url,
    attempts: readiness.attempts,
    externalAi: proxy ? "ready" : "local",
  };
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  startDemo().catch((error) => {
    // Fixed message — never echoes stray data that might carry the token.
    console.error(`[KB TradePilot] 데모 시작 실패: ${error?.message ?? "unknown"}`);
    process.exitCode = 1;
  });
}
