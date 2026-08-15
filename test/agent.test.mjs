import { test } from "node:test";
import assert from "node:assert/strict";
import {
  explainCounterExamples,
  explainProducts,
  FALLBACK_NOTICE,
  NON_ADVICE,
} from "../js/agent.js";
import { createProvider } from "../js/llm-provider.js";

const context = {
  netRows: [{ currency: "USD", net: 200_000 }],
  cfarTotal: 10_000_000,
  strategies: [{
    key: "안정형",
    hedgeRatio: 0.9,
    residualCFaR: 1_000_000,
    hedgeCost: 500_000,
  }],
  counters: [{ q: "입금이 늦으면?", a: "만기를 다시 계산합니다." }],
  countries: [{ name: "미국", exposureShare: 0.75 }],
  products: [{
    product_id: "fx_insurance",
    purpose: "fx_hedge",
    status: "candidate",
    name: "환변동보험",
    source: "공식 문서",
  }],
  companyName: "A제조(주)",
  cashflows: [{ amount: 300_000 }],
};

test("agent sends only purpose + analysisPayload to the provider", async () => {
  let request;
  const provider = {
    mode: "external",
    approved: true,
    modelId: "proxy-managed",
    complete: async (value) => {
      request = value;
      return "설명";
    },
  };
  const output = await explainProducts(context, { provider });
  assert.match(output, /^설명/);
  assert.deepEqual(Object.keys(request).sort(), ["analysisPayload", "purpose"]);
  assert.equal(request.purpose, "product_explanation");
  assert.ok(!JSON.stringify(request).includes("companyName"));
  assert.ok(!JSON.stringify(request).includes("cashflows"));
  assert.ok(output.includes(NON_ADVICE));
});

test("counter explanation uses the closed purpose enum", async () => {
  let purpose;
  const provider = {
    mode: "external",
    approved: true,
    complete: async (request) => {
      purpose = request.purpose;
      return "반례 설명";
    },
  };
  await explainCounterExamples(context, { provider });
  assert.equal(purpose, "counter_examples");
});

test("provider failure preserves the deterministic rule fallback", async () => {
  const output = await explainCounterExamples(context, {
    provider: createProvider("off"),
  });
  assert.match(output, /입금|환율/);
  assert.ok(output.includes(NON_ADVICE));
  assert.doesNotMatch(output, new RegExp(FALLBACK_NOTICE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});
