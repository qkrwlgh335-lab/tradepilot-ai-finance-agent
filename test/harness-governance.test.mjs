// HARNESS: LLM governance — nested egress schema, provider modes, audit, fallback.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  ANALYSIS_PAYLOAD_SCHEMA,
  buildAnalysisPayload,
  maskSensitive,
} from "../js/privacy.js";
import {
  recordAudit,
  getAuditLog,
  clearAuditLog,
} from "../js/audit.js";
import { createProvider, resolveMode, ENV_DEFAULT_MODE } from "../js/llm-provider.js";

function memStore() {
  const m = new Map();
  return {
    getItem: (key) => (m.has(key) ? m.get(key) : null),
    setItem: (key, value) => m.set(key, String(value)),
    removeItem: (key) => m.delete(key),
  };
}

test("GOV: nested schema drops raw input and unlisted child fields", () => {
  const payload = buildAnalysisPayload({
    netRows: [{ currency: "USD", net: 200_000, receivable: 300_000 }],
    companyName: "A제조(주)",
    cashflows: [{ amount: 300_000 }],
    rawContractText: "계약서 원문",
  });
  assert.deepEqual(payload, { netRows: [{ currency: "USD", net: 200_000 }] });
  assert.deepEqual(Object.keys(ANALYSIS_PAYLOAD_SCHEMA).sort(), [
    "cfarTotal",
    "counters",
    "countries",
    "netRows",
    "products",
    "scenarios",
    "strategies",
  ]);
});

test("GOV: masking hides email/account/RRN patterns", () => {
  const masked = maskSensitive({
    note: "문의 a@b.com 계좌 1002123456789 주민 900101-1234567",
  });
  assert.ok(!masked.note.includes("a@b.com"));
  assert.ok(!/\d{10,}/.test(masked.note));
  assert.ok(!/\d{6}-?\d{7}/.test(masked.note));
});

test("GOV: demo/dev default to mock; internal remains a disabled swap hook", () => {
  assert.deepEqual(ENV_DEFAULT_MODE, {
    demo: "mock",
    dev: "mock",
    production: "internal",
  });
  assert.equal(resolveMode("demo"), "mock");
  assert.equal(resolveMode("dev"), "mock");
  assert.equal(resolveMode("production"), "internal");
  assert.equal(resolveMode("unknown"), "off");
  assert.equal(resolveMode("demo", "external"), "external");
  assert.equal(createProvider("internal").disabled, true);
});

test("GOV: audit stores metadata only, caps at 100 and is clearable", () => {
  const store = memStore();
  for (let index = 0; index < 130; index += 1) {
    recordAudit(store, {
      purpose: "product_explanation",
      approval: true,
      provider: "external",
      modelId: "proxy-managed",
      promptTemplateVersion: "t9-v1",
      policyVersion: "egress-v1",
      corpusHash: "product-kb-v1",
      outcome: "success",
      sentFields: ["netRows"],
      payload: { forbidden: 200_000 },
      response: "forbidden response",
      apiKey: "forbidden key",
    });
  }
  const log = getAuditLog(store);
  assert.equal(log.length, 100);
  const entry = log.at(-1);
  for (const key of [
    "event_id",
    "timestamp",
    "purpose",
    "approval",
    "provider",
    "model_id",
    "prompt_template_version",
    "policy_version",
    "corpus_hash",
    "outcome",
    "sent_fields",
  ]) assert.ok(key in entry, key);
  for (const forbidden of ["payloadHash", "payload", "response", "apiKey", "200000"])
    assert.ok(!JSON.stringify(entry).includes(forbidden), forbidden);
  clearAuditLog(store);
  assert.deepEqual(getAuditLog(store), []);
});

test("GOV: providers send exact proxy request and always fail closed", async () => {
  assert.equal(await createProvider("off").complete({}), null);
  const mock = createProvider("mock");
  assert.equal(await mock.complete({}), await mock.complete({}));

  let sentBody;
  const external = createProvider("external", {
    approved: true,
    fetchImpl: async (_url, options) => {
      sentBody = JSON.parse(options.body);
      return { ok: true, json: async () => ({ text: "설명" }) };
    },
  });
  const request = {
    purpose: "product_explanation",
    analysisPayload: { netRows: [{ currency: "USD", net: 1 }] },
  };
  assert.equal(await external.complete(request), "설명");
  assert.deepEqual(sentBody, request);
  assert.equal(await createProvider("internal").complete(request), null);

  for (const fetchImpl of [
    async () => { throw new Error("down"); },
    async () => ({ ok: false, status: 503, json: async () => ({}) }),
    async () => ({ ok: true, json: async () => ({ nope: true }) }),
  ]) {
    assert.equal(await createProvider("external", {
      approved: true,
      fetchImpl,
    }).complete(request), null);
  }
});

test("GOV: synthetic fixtures stay labelled while refreshed market data has verified provenance", async () => {
  const load = async (file) =>
    JSON.parse(await readFile(new URL(`../${file}`, import.meta.url), "utf8"));
  for (const file of [
    "data/products.json",
    "data/product-docs.json",
    "data/samples.json",
  ]) assert.match(JSON.stringify(await load(file)), /예시|합성/, file);

  const countryCatalog = await load("data/country-catalog.json");
  assert.match(countryCatalog.note, /국가위험등급·거시지표·예측값은 포함하지 않는다/);
  assert.doesNotMatch(JSON.stringify(countryCatalog), /risk_level|credit_rating|gdp_growth|policy_rate/);

  const [fx, vol, marketSources] = await Promise.all([
    load("data/fx.json"),
    load("data/fx-vol.json"),
    load("data/market-sources.json"),
  ]);
  assert.match(fx.note, /ECB 공식/);
  assert.match(vol.note, /공식 기준환율/);
  assert.ok(marketSources.sources.every((source) =>
    source.status === "cached"
    && source.verification_status === "verified"
    && /^https:\/\/data-api\.ecb\.europa\.eu\//.test(source.source_url)));
});
