// T30a — the browser must never reach the official ECB endpoint, read env vars, or handle
// API keys. Official host access is confined to the Node refresh layer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

async function browserSources() {
  const files = { "index.html": await readFile(join(ROOT, "index.html"), "utf8") };
  for (const entry of await readdir(join(ROOT, "js"))) {
    if (entry.endsWith(".js")) files[`js/${entry}`] = await readFile(join(ROOT, "js", entry), "utf8");
  }
  return files;
}

// Match a real network call to the ECB endpoint, not a validation allowlist entry. Browser code
// referencing the host as an ALLOWED source of trusted metadata is fine (that's how we check the
// server-emitted URL); what must be absent is fetch / XHR / import / URL construction against it.
const ECB_HOST_RE = String.raw`data-api\.ecb\.europa\.eu|www\.ecb\.europa\.eu\/stats`;
const OFFICIAL_CALL_PATTERN = new RegExp(
  `(?:fetch|XMLHttpRequest|new\\s+Request|new\\s+URL|axios|import\\s*\\()[^;\\n]{0,200}(?:${ECB_HOST_RE})`,
  "i",
);
const ENV_ACCESS = /\bprocess\.env\b/;
const API_KEY_KEYWORDS = /\b(?:api[_-]?key|bearer|authorization|x-api-key)\b/i;
// Reserved but sanctioned: an existing browser export whose name mentions "apiKey" for the
// governance dialog. If it ever comes back, adjust this test — but for now none is present.

test("T30a: no browser file makes a network call to the official ECB endpoint", async () => {
  for (const [name, src] of Object.entries(await browserSources()))
    assert.doesNotMatch(src, OFFICIAL_CALL_PATTERN, `${name} must not fetch/import the official ECB endpoint`);
});

test("T30a: no browser file reads process.env", async () => {
  for (const [name, src] of Object.entries(await browserSources()))
    assert.doesNotMatch(src, ENV_ACCESS, `${name} must not read process.env`);
});

test("T30a: no browser file references API-key headers or keywords", async () => {
  for (const [name, src] of Object.entries(await browserSources())) {
    assert.doesNotMatch(src, API_KEY_KEYWORDS, `${name} must not carry API-key headers/keywords`);
  }
});

test("T30a: the official host lives in the Node refresh layer (references + a fetch call)", async () => {
  const refresh = await readFile(join(ROOT, "scripts", "refresh-market-data.mjs"), "utf8");
  assert.match(refresh, new RegExp(ECB_HOST_RE, "i"), "refresh script must reference the ECB host");
  assert.match(refresh, /\bfetchImpl\s*\(/, "refresh script must make a fetch call (via fetchImpl)");
});
