import { test } from "node:test";
import assert from "node:assert/strict";
import { explainCounterExamples, explainProducts, NON_ADVICE } from "../js/agent.js";
import { createProvider } from "../js/llm-provider.js";
import { getAuditLog } from "../js/audit.js";

function memStore() {
  const m = new Map();
  return {
    getItem: (key) => (m.has(key) ? m.get(key) : null),
    setItem: (key, value) => m.set(key, String(value)),
    removeItem: (key) => m.delete(key),
  };
}

const ctx = {
  netRows: [{ currency: "USD", net: 200_000 }],
  cfarTotal: 10_000_000,
  strategies: [
    { key: "안정형", hedgeRatio: 0.9, residualCFaR: 1_000_000, hedgeCost: 500_000 },
    { key: "균형형", hedgeRatio: 0.6, residualCFaR: 4_000_000, hedgeCost: 300_000 },
  ],
  counters: [{ q: "입금이 늦으면?", a: "만기를 다시 계산합니다." }],
  countries: [],
  products: [{
    product_id: "fx_insurance",
    purpose: "fx_hedge",
    status: "candidate",
    name: "환변동보험",
    source: "데모보증기관",
  }],
  companyName: "A제조(주)",
  cashflows: [{ country: "US", amount: 300_000 }],
};

const proxyFetch = (kind = "success", text = "프록시 설명") => async (_url, options) => {
  if (kind === "throw") throw new Error("proxy down");
  if (kind === "httpError") return { ok: false, status: 503, json: async () => ({}) };
  if (kind === "malformed") return { ok: true, json: async () => ({ nope: true }) };
  assert.deepEqual(Object.keys(JSON.parse(options.body)).sort(), ["analysisPayload", "purpose"]);
  return { ok: true, json: async () => ({ text }) };
};

test("off mode -> rule fallback + non-advice label", async () => {
  const out = await explainCounterExamples(ctx, { provider: createProvider("off") });
  assert.match(out, /입금|환율/);
  assert.ok(out.includes(NON_ADVICE));
});

test("default mock uses the rich local explanation and creates no egress audit", async () => {
  const store = memStore();
  const out = await explainProducts(ctx, {
    provider: createProvider("mock"),
    auditStore: store,
  });
  assert.match(out, /환변동보험/);
  assert.match(out, /공개용 합성 자격 규칙|문서 근거/);
  assert.doesNotMatch(out, /\[MOCK\]|모의 AI 설명/);
  assert.deepEqual(getAuditLog(store), []);
});

test("external without approval sends nothing -> rule fallback", async () => {
  let calls = 0;
  const provider = createProvider("external", {
    approved: false,
    fetchImpl: async (...args) => {
      calls += 1;
      return proxyFetch()(...args);
    },
  });
  const out = await explainProducts(ctx, { provider });
  assert.equal(calls, 0);
  assert.match(out, /환변동보험/);
});

test("approved proxy success -> model text + metadata-only audit", async () => {
  const store = memStore();
  const provider = createProvider("external", {
    approved: true,
    fetchImpl: proxyFetch("success", "비교 설명"),
  });
  const out = await explainProducts(ctx, { provider, auditStore: store });
  assert.ok(out.startsWith("비교 설명"));
  const [entry] = getAuditLog(store);
  assert.equal(entry.outcome, "success");
  assert.equal(entry.provider, "external");
  assert.equal(entry.approval, true);
  assert.ok(!("payloadHash" in entry));
  assert.ok(!JSON.stringify(entry).includes("200000"));
});

test("proxy/network failures always return the rule fallback", async () => {
  for (const kind of ["throw", "httpError", "malformed"]) {
    const provider = createProvider("external", {
      approved: true,
      fetchImpl: proxyFetch(kind),
    });
    const out = await explainProducts(ctx, { provider });
    assert.match(out, /환변동보험/, kind);
  }
});
