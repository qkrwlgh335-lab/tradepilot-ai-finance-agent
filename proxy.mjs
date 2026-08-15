import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ANALYSIS_PURPOSES,
  validateAnalysisPayload,
} from "./js/privacy.js";

const LOOPBACK = "127.0.0.1";
const DEFAULT_PORT = 8787;
const MAX_BODY_BYTES = 32 * 1024;
const UPSTREAM_TIMEOUT_MS = 30_000;
const DEFAULT_MODEL = "claude-sonnet-4-20250514";
const ALLOWED_ORIGINS = new Set([
  "http://localhost:8000",
  "http://127.0.0.1:8000",
]);

export const PROMPTS = Object.freeze({
  counter_examples:
    "당신은 수출입 금융 설명 도우미입니다. JSON의 결정론 계산 결과만 설명하십시오. " +
    "숫자를 재계산하거나 상품 자격·추천을 변경하지 말고, 반례와 대응을 쉬운 한국어로 서술하십시오.",
  product_explanation:
    "당신은 수출입 금융 설명 도우미입니다. JSON에 포함된 후보만 설명하십시오. " +
    "새 상품·조건·가격·순위를 만들지 말고, 모든 최종 판단에는 금융기관 상담이 필요함을 밝히십시오.",
  scenario_intent:
    "당신은 한국어 위기 문장의 의도 유형만 분류합니다. 가능한 type은 payment_delay, " +
    "receivable_drop, adverse_fx 셋뿐입니다. 대상과 수치에는 관여하지 마십시오. " +
    "오직 {\"type\":\"...\",\"confidence\":0~1} JSON 한 개만 반환하십시오.",
});

const json = (response, status, value, origin) => {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("vary", "origin");
  }
  response.end(JSON.stringify(value));
};

const parseEnvLine = (line) => {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (!match) return null;
  let value = match[2].trim();
  if ((value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'")))
    value = value.slice(1, -1);
  return [match[1], value];
};

export async function loadEnvFile({
  env = process.env,
  filePath = path.resolve(process.cwd(), ".env"),
} = {}) {
  let source;
  try {
    source = await readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return env;
    throw error;
  }
  for (const line of source.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (!parsed) continue;
    const [key, value] = parsed;
    if (!Object.prototype.hasOwnProperty.call(env, key)) env[key] = value;
  }
  return env;
}

const readJsonBody = (request) => new Promise((resolve, reject) => {
  let bytes = 0;
  let tooLarge = false;
  const chunks = [];
  request.on("data", (chunk) => {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) {
      tooLarge = true;
      return;
    }
    chunks.push(chunk);
  });
  request.on("end", () => {
    if (tooLarge) {
      reject(Object.assign(new Error("payload_too_large"), { status: 413 }));
      return;
    }
    try {
      resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
    } catch {
      reject(Object.assign(new Error("invalid_json"), { status: 400 }));
    }
  });
  request.on("error", reject);
});

const validTopLevelRequest = (body) => {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const keys = Object.keys(body);
  return keys.length === 2
    && keys.includes("purpose")
    && keys.includes("analysisPayload");
};

const validIntentRequest = (body) => {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const keys = Object.keys(body).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["maskedText", "purpose"])) return false;
  if (body.purpose !== "scenario_intent") return false;
  if (typeof body.maskedText !== "string"
      || !body.maskedText.trim()
      || body.maskedText.length > 500)
    return false;
  // The browser masks these first; the proxy repeats the check fail-closed.
  if (/[\w.+-]+@[\w-]+\.[\w.-]+/u.test(body.maskedText)
      || /\b\d{6,}\b/u.test(body.maskedText)
      || /\b(?:tx|txn)-[a-z0-9_-]+\b/iu.test(body.maskedText))
    return false;
  return true;
};

const strictIntentProposal = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Object.keys(value).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["confidence", "type"])) return null;
  if (!["payment_delay", "receivable_drop", "adverse_fx"].includes(value.type)) return null;
  if (!(typeof value.confidence === "number"
      && Number.isFinite(value.confidence)
      && value.confidence >= 0
      && value.confidence <= 1))
    return null;
  return { type: value.type, confidence: value.confidence };
};

async function callAnthropic({
  purpose,
  analysisPayload,
  env,
  fetchImpl,
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetchImpl("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: env.ANTHROPIC_MODEL || DEFAULT_MODEL,
        max_tokens: 1_024,
        system: PROMPTS[purpose],
        messages: [{
          role: "user",
          content: JSON.stringify(analysisPayload),
        }],
      }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    const text = data?.content?.find?.((block) => block.type === "text")?.text;
    return typeof text === "string" && text.trim() ? text : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function callAnthropicIntent({ maskedText, env, fetchImpl }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetchImpl("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: env.ANTHROPIC_MODEL || DEFAULT_MODEL,
        max_tokens: 128,
        system: PROMPTS.scenario_intent,
        messages: [{ role: "user", content: maskedText }],
      }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    const text = data?.content?.find?.((block) => block.type === "text")?.text;
    if (typeof text !== "string") return null;
    try {
      return strictIntentProposal(JSON.parse(text));
    } catch {
      return null;
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function createProxyServer({
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  return http.createServer(async (request, response) => {
    const origin = request.headers.origin;
    if (origin && !ALLOWED_ORIGINS.has(origin)) {
      json(response, 403, { error: "origin_not_allowed" });
      return;
    }
    if (request.method === "GET" && request.url === "/_health") {
      const instanceToken = typeof env.KB_PROXY_INSTANCE_TOKEN === "string"
        ? env.KB_PROXY_INSTANCE_TOKEN
        : "";
      if (!instanceToken) {
        json(response, 404, { error: "not_found" }, origin);
        return;
      }
      json(response, 200, {
        ready: true,
        configured: Boolean(env.ANTHROPIC_API_KEY && env.ANTHROPIC_MODEL),
        instanceToken,
      }, origin);
      return;
    }
    if (request.method === "OPTIONS") {
      response.statusCode = 204;
      if (origin) {
        response.setHeader("access-control-allow-origin", origin);
        response.setHeader("vary", "origin");
      }
      response.setHeader("access-control-allow-methods", "POST, OPTIONS");
      response.setHeader("access-control-allow-headers", "content-type");
      response.end();
      return;
    }
    const isExplain = request.method === "POST" && request.url === "/api/explain";
    const isIntent = request.method === "POST" && request.url === "/api/intent";
    if (!isExplain && !isIntent) {
      json(response, 404, { error: "not_found" }, origin);
      return;
    }

    let body;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      json(response, error?.status || 400, {
        error: error?.status === 413 ? "payload_too_large" : "invalid_request",
      }, origin);
      return;
    }
    if (isIntent) {
      if (!validIntentRequest(body)) {
        json(response, 400, { error: "invalid_request" }, origin);
        return;
      }
      if (!env.ANTHROPIC_API_KEY) {
        json(response, 503, { error: "llm_unavailable" }, origin);
        return;
      }
      if (typeof fetchImpl !== "function") {
        json(response, 502, { error: "upstream_error" }, origin);
        return;
      }
      const proposal = await callAnthropicIntent({
        maskedText: body.maskedText,
        env,
        fetchImpl,
      });
      if (!proposal) {
        json(response, 502, { error: "upstream_error" }, origin);
        return;
      }
      json(response, 200, proposal, origin);
      return;
    }

    if (!validTopLevelRequest(body)
        || !ANALYSIS_PURPOSES.includes(body.purpose)) {
      json(response, 400, { error: "invalid_request" }, origin);
      return;
    }

    const checked = validateAnalysisPayload(body.analysisPayload);
    if (!checked.ok) {
      json(response, 400, { error: "invalid_analysis_payload" }, origin);
      return;
    }
    if (!env.ANTHROPIC_API_KEY) {
      json(response, 503, { error: "llm_unavailable" }, origin);
      return;
    }
    if (typeof fetchImpl !== "function") {
      json(response, 502, { error: "upstream_error" }, origin);
      return;
    }

    const text = await callAnthropic({
      purpose: body.purpose,
      analysisPayload: checked.value,
      env,
      fetchImpl,
    });
    if (!text) {
      json(response, 502, { error: "upstream_error" }, origin);
      return;
    }
    json(response, 200, { text }, origin);
  });
}

export async function startProxy({
  port = DEFAULT_PORT,
  env = process.env,
  fetchImpl = globalThis.fetch,
  logger = console.log,
} = {}) {
  const server = createProxyServer({ env, fetchImpl });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address
    ? address.port
    : port;
  logger(`TradePilot explanation proxy listening on http://${LOOPBACK}:${actualPort}`);
  return { server, host: LOOPBACK, port: actualPort };
}

const mainPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const thisPath = path.resolve(fileURLToPath(import.meta.url));
if (mainPath.toLowerCase() === thisPath.toLowerCase()) {
  await loadEnvFile();
  if (process.argv.includes("--check")) {
    console.log("proxy_config_ok");
  } else {
    await startProxy();
  }
}
