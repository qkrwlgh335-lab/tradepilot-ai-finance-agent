import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequestHandler } from "../scripts/dev-server.mjs";

function request(pathname) {
  return { url: pathname, headers: { host: "127.0.0.1" } };
}
function response(done) {
  return {
    writeHead() { return this; },
    end() { done(); return this; },
  };
}

async function call(handler, pathname) {
  await new Promise((resolve) => handler(request(pathname), response(resolve)));
}

test("HTML access refreshes market, country and bilateral trade caches independently", async () => {
  let marketCalls = 0;
  let countryCalls = 0;
  let tradeCalls = 0;
  const handler = createRequestHandler({
    hook: { ensureFresh: async () => { marketCalls += 1; } },
    countryHook: { ensureFresh: async () => { countryCalls += 1; } },
    tradeHook: { ensureFresh: async () => { tradeCalls += 1; } },
  });
  await call(handler, "/");
  assert.equal(marketCalls, 1);
  assert.equal(countryCalls, 1);
  assert.equal(tradeCalls, 1);
});

test("static assets never trigger any external refresh", async () => {
  let marketCalls = 0;
  let countryCalls = 0;
  let tradeCalls = 0;
  const handler = createRequestHandler({
    hook: { ensureFresh: async () => { marketCalls += 1; } },
    countryHook: { ensureFresh: async () => { countryCalls += 1; } },
    tradeHook: { ensureFresh: async () => { tradeCalls += 1; } },
  });
  await call(handler, "/js/main.js");
  assert.equal(marketCalls, 0);
  assert.equal(countryCalls, 0);
  assert.equal(tradeCalls, 0);
});

test("one country refresh failure does not prevent the HTML response", async () => {
  let ended = false;
  const handler = createRequestHandler({
    hook: { ensureFresh: async () => ({ status: "cached" }) },
    countryHook: { ensureFresh: async () => ({ status: "failed" }) },
    tradeHook: { ensureFresh: async () => ({ status: "failed" }) },
  });
  await new Promise((resolve) => handler(request("/"), response(() => { ended = true; resolve(); })));
  assert.equal(ended, true);
});
