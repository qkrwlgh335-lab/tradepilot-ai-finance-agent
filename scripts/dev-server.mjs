// 개발용 정적 서버. python -m http.server 와 달리 no-store 를 보내 ES 모듈 캐시로 인한
// "코드를 고쳤는데 브라우저는 옛 화면" 문제를 없앤다. 제출물 실행에는 아무 서버나 써도 된다.
//
// 첫 `/` 접속에서 T30 훅을 통해 공식 시장데이터 캐시를 갱신 시도한다. 실패해도 검증된 기존
// 캐시가 그대로 유지되므로 브라우저는 항상 HTTP 200을 받는다. 정적 자산은 갱신을 유발하지 않는다.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { refreshMarketData } from "./refresh-market-data.mjs";
import { refreshCountryIndicators } from "./refresh-country-indicators.mjs";
import { refreshBilateralTrade } from "./refresh-bilateral-trade.mjs";
import { createMarketDataRefreshHook } from "./market-data-refresh-hook.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PORT = Number(process.env.PORT || 8000);
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".ico": "image/x-icon", ".map": "application/json",
};

// A refresh is triggered only on the HTML entry-points, never on static assets — this way one
// analysis session locks in a single snapshot without every image/JS fetch retrying the ECB.
const HTML_ENTRY_POINTS = new Set(["/", "/index.html"]);

// Server-side kill-switch for the T30 refresh. The browser never reads this — only the Node
// server does — so offline demos can start with KB_MARKET_AUTO_REFRESH=off and make ZERO
// external calls. Default is "auto" (refresh on first `/` access).
const REFRESH_MODE_OFF_VALUES = new Set(["off", "false", "0", "no"]);
export function resolveRefreshMode(env = process.env) {
  const raw = env?.KB_MARKET_AUTO_REFRESH;
  if (typeof raw !== "string") return "auto";
  const normalized = raw.trim().toLowerCase();
  return REFRESH_MODE_OFF_VALUES.has(normalized) ? "off" : "auto";
}

export const HEALTH_PATH = "/_health";

export function createRequestHandler({ hook, countryHook, tradeHook, root = ROOT, instanceToken = null } = {}) {
  return async (req, res) => {
    try {
      const url = decodeURIComponent(new URL(req.url, `http://${req.headers.host}`).pathname);
      // T30b: `/_health` is answered ONLY when we know our own instance token, and returns just
      // { ready, instanceToken } — no static file, no refresh, no logging of the token value.
      // A stranger process serving 200 on the same port will not know this token and therefore
      // cannot masquerade as this child.
      if (url === HEALTH_PATH) {
        if (typeof instanceToken !== "string" || instanceToken.length === 0) {
          res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found");
          return;
        }
        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store, must-revalidate",
        }).end(JSON.stringify({ ready: true, instanceToken }));
        return;
      }
      if (HTML_ENTRY_POINTS.has(url)) {
        await Promise.all([
          hook?.ensureFresh(),
          countryHook?.ensureFresh(),
          tradeHook?.ensureFresh(),
        ]);
      }
      let file = path.join(root, url === "/" ? "index.html" : url.replace(/^\/+/, ""));
      if (!path.resolve(file).startsWith(path.resolve(root))) { res.writeHead(403).end("forbidden"); return; }
      if ((await stat(file)).isDirectory()) file = path.join(file, "index.html");
      const body = await readFile(file);
      res.writeHead(200, {
        "content-type": TYPES[path.extname(file)] || "application/octet-stream",
        "cache-control": "no-store, must-revalidate",
      }).end(body);
    } catch {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found");
    }
  };
}

// Only start listening when invoked as a CLI, so tests can import createRequestHandler safely.
const isCli = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  const mode = resolveRefreshMode();
  const hook = mode === "off"
    ? null
    : createMarketDataRefreshHook({
      refresh: () => refreshMarketData({ timeoutMs: 5_000 }),
    });
  const countryHook = mode === "off"
    ? null
    : createMarketDataRefreshHook({
      refresh: () => refreshCountryIndicators({ timeoutMs: 5_000 }),
      ttlMs: 24 * 60 * 60_000,
    });
  const tradeHook = mode === "off"
    ? null
    : createMarketDataRefreshHook({
      refresh: async () => {
        const catalog = JSON.parse(await readFile(path.join(ROOT, "data", "country-catalog.json"), "utf8"));
        return refreshBilateralTrade({
          countryIsoList: Object.keys(catalog.countries),
          timeoutMs: 5_000,
        });
      },
      ttlMs: 24 * 60 * 60_000,
    });
  // T30b: the parent (start-demo.mjs) supplies a per-process token so the readiness probe can
  // tell "our just-spawned child" from any stranger already serving on the same port. The token
  // is a local process identifier — not a secret — and is never logged.
  const instanceToken = typeof process.env.KB_DEMO_INSTANCE_TOKEN === "string"
    && process.env.KB_DEMO_INSTANCE_TOKEN.length > 0
    ? process.env.KB_DEMO_INSTANCE_TOKEN
    : null;
  const server = createServer(createRequestHandler({ hook, countryHook, tradeHook, instanceToken }));
  server.on("error", (err) => {
    // T30b: EADDRINUSE (or any bind error) becomes a clear one-line message + exit(1),
    // never an unhandled stack trace on the console.
    if (err && err.code === "EADDRINUSE")
      console.error(`[dev-server] 포트 ${PORT} 이(가) 이미 사용 중입니다. 다른 프로세스를 종료하거나 PORT=… 로 다른 포트를 지정하세요.`);
    else
      console.error(`[dev-server] 서버 시작 실패: ${err?.message ?? err}`);
    process.exitCode = 1;
  });
  server.listen(PORT, "127.0.0.1", () => {
    const suffix = mode === "off" ? " · 자동 갱신 off (KB_MARKET_AUTO_REFRESH)" : "";
    console.log(`dev server (no-cache) http://127.0.0.1:${PORT}${suffix}`);
  });
}
