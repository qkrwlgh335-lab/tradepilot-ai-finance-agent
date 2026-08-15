// T6.1: verifiable, product-scoped source registry for the public synthetic ruleset.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createSourceRegistry } from "../js/sources.js";

const load = async (p) => JSON.parse(await readFile(new URL(`../${p}`, import.meta.url), "utf8"));
const REQUIRED = ["source_id", "product_id", "institution", "document_title", "url", "source_kind", "verification_status", "verified_on", "supported_fields", "page_or_section"];

// Each trusted synthetic source is scoped to exactly one product_id.
const EXPECTED = [
  { source_id: "src:demo-fx-protection-terms", product_id: "fx_insurance", host: "github.com" },
  { source_id: "src:demo-fx-protection-costs", product_id: "fx_insurance", host: "github.com" },
  { source_id: "src:demo-export-working-capital", product_id: "trade_loan", host: "github.com" },
  { source_id: "src:demo-pre-shipment-guarantee", product_id: "ecg_pre", host: "github.com" },
  { source_id: "src:demo-export-receivable", product_id: "export_nego", host: "github.com" },
  { source_id: "src:demo-forward", product_id: "fwd", host: "github.com" },
];

const complete = (over = {}) => ({
  source_id: "src:test-1", product_id: "fwd", institution: "TradePilot 데모은행", document_title: "거래안내",
  url: "https://github.com/qkrwlgh335-lab/tradepilot-ai-finance-agent/blob/main/docs/PUBLIC_DEMO_RULES.md#fwd", source_kind: "product_terms",
  verification_status: "verified", verified_on: "2026-07-24",
  supported_fields: ["eligibility.company_type"], page_or_section: "거래안내 > 이용대상",
  ...over,
});

// ---------- registry data (from data/source-registry.json) ----------
test("1. registry sources is not an empty array", async () => {
  const { sources } = await load("data/source-registry.json");
  assert.ok(Array.isArray(sources) && sources.length > 0);
});

test("2. all T6.0-verified sources are present with the right product_id", async () => {
  const { sources } = await load("data/source-registry.json");
  for (const e of EXPECTED) {
    const s = sources.find((x) => x.source_id === e.source_id);
    assert.ok(s, `missing ${e.source_id}`);
    assert.equal(s.product_id, e.product_id, `${e.source_id} product_id`);
    assert.equal(new URL(s.url).hostname, e.host, `${e.source_id} host`);
    assert.equal(s.verification_status, "verified");
    assert.equal(s.verified_on, "2026-08-16");
    for (const f of REQUIRED) assert.ok(s[f] !== undefined && s[f] !== "", `${e.source_id}.${f}`);
  }
});

test("3. source_id has no duplicates", async () => {
  const ids = (await load("data/source-registry.json")).sources.map((s) => s.source_id);
  assert.equal(new Set(ids).size, ids.length);
});

test("4. every source_id uses the src: prefix", async () => {
  for (const s of (await load("data/source-registry.json")).sources) assert.match(s.source_id, /^src:/);
});

test("5. every product_id is prefix-free (no prod:)", async () => {
  for (const s of (await load("data/source-registry.json")).sources) {
    assert.ok(!/^prod:/.test(s.product_id), `${s.source_id} product_id must be canonical`);
    assert.match(s.product_id, /^[a-z_]+$/);
  }
});

test("registry only contains verified product_terms (no market data, no unverified products)", async () => {
  const { sources } = await load("data/source-registry.json");
  const ids = sources.map((s) => s.product_id);
  for (const s of sources) { assert.equal(s.verification_status, "verified"); assert.equal(s.source_kind, "product_terms"); }
  for (const dropped of ["option", "swap", "policy_fund"]) assert.ok(!ids.includes(dropped), `${dropped} must not be registered`);
  assert.ok(!sources.some((s) => s.source_kind === "market_data"), "no market data in the registry");
});

// ---------- createSourceRegistry behaviour ----------
test("6. only verification_status=verified is active", () => {
  const reg = createSourceRegistry([complete(), complete({ source_id: "src:test-2", verification_status: "unverified" })]);
  assert.equal(reg.isActive("src:test-1"), true);
  assert.equal(reg.isActive("src:test-2"), false);
});

test("7. only HTTPS is active", () => {
  const reg = createSourceRegistry([complete({ source_id: "src:http", url: "http://github.com/qkrwlgh335-lab/tradepilot-ai-finance-agent/blob/main/docs/PUBLIC_DEMO_RULES.md" })]);
  assert.equal(reg.isActive("src:http"), false);
});

test("8. only the pinned public demo specification is active", () => {
  const reg = createSourceRegistry([complete({ source_id: "src:blog", url: "https://blog.example.com/x" })]);
  assert.equal(reg.isActive("src:blog"), false);
});

test("9. empty supported_fields is inactive", () => {
  const reg = createSourceRegistry([complete({ source_id: "src:nofields", supported_fields: [] })]);
  assert.equal(reg.isActive("src:nofields"), false);
});

test("10. a missing required field makes it inactive", () => {
  for (const f of REQUIRED) {
    const bad = complete({ source_id: `src:miss-${f}` });
    delete bad[f];
    const reg = createSourceRegistry([bad]);
    assert.equal(reg.isActive(bad.source_id ?? `src:miss-${f}`), false, `missing ${f} should be inactive`);
  }
});

test("11. get() of an unknown source_id is null", () => {
  const reg = createSourceRegistry([complete()]);
  assert.equal(reg.get("src:nope"), null);
});

test("12. mutating the returned object does not change the internal registry", () => {
  const reg = createSourceRegistry([complete()]);
  const a = reg.get("src:test-1");
  a.institution = "TAMPERED";
  a.supported_fields.push("hacked");
  assert.notEqual(reg.get("src:test-1").institution, "TAMPERED");
  assert.ok(!reg.get("src:test-1").supported_fields.includes("hacked"));
});

// ---------- canSupport ----------
test("canSupport is true only when active AND product_id matches AND field is supported", () => {
  const reg = createSourceRegistry([complete({ source_id: "src:demo-forward", supported_fields: ["eligibility.company_type", "eligibility.internet_banking_enrolled"] })]);
  assert.equal(reg.canSupport("src:demo-forward", "fwd", "eligibility.company_type"), true);
  assert.equal(reg.canSupport("src:demo-forward", "fwd", "eligibility.min_amount_usd"), false, "field not supported");
  assert.equal(reg.canSupport("src:demo-forward", "trade_loan", "eligibility.company_type"), false, "wrong product");
  assert.equal(reg.canSupport("src:none", "fwd", "eligibility.company_type"), false, "inactive/unknown");
});

test("canSupport does not let one product's source back another product with the same field", async () => {
  const reg = createSourceRegistry((await load("data/source-registry.json")).sources);
  // trade_loan and export_nego share the same demo spec but have distinct source_ids.
  assert.equal(reg.canSupport("src:demo-export-working-capital", "trade_loan", "eligibility.requires_export"), true);
  assert.equal(reg.canSupport("src:demo-export-working-capital", "export_nego", "eligibility.requires_export"), false, "must not reuse trade_loan's source for export_nego");
});

test("all registered sources are active trusted synthetic product_terms", async () => {
  const { sources } = await load("data/source-registry.json");
  const reg = createSourceRegistry(sources);
  for (const s of sources) assert.equal(reg.isActive(s.source_id), true, `${s.source_id} should be active`);
});

// ---------- T6.1a: fail closed on malformed / mutable entries ----------
const inactiveWith = (over) => {
  const s = complete(over);
  const id = s.source_id;
  return createSourceRegistry([s]).isActive(id);
};

test("T6.1a-1: non-src: source_id is inactive", () => {
  assert.equal(createSourceRegistry([complete({ source_id: "kb-fwd" })]).isActive("kb-fwd"), false);
  assert.equal(createSourceRegistry([complete({ source_id: "SRC:fwd" })]).isActive("SRC:fwd"), false);
  assert.equal(createSourceRegistry([complete({ source_id: "src:" })]).isActive("src:"), false);
});

test("T6.1a-2: a non-string source_id never activates and does not crash", () => {
  for (const bad of [123, null, {}, ["src:x"]]) {
    const reg = createSourceRegistry([complete({ source_id: bad })]);
    assert.equal(reg.isActive(bad), false);
  }
});

test("T6.1a-3: a prod:-prefixed product_id is inactive", () => {
  assert.equal(inactiveWith({ source_id: "src:a", product_id: "prod:fwd" }), false);
});

test("T6.1a-4: an empty / non-string / malformed product_id is inactive", () => {
  for (const bad of ["", " ", "Fwd", "1fwd", "fwd-x", 42, null]) {
    assert.equal(inactiveWith({ source_id: "src:pid", product_id: bad }), false, `product_id=${JSON.stringify(bad)}`);
  }
});

test("T6.1a-5: an unknown source_kind is inactive", () => {
  for (const bad of ["blog", "news", "", "PRODUCT_TERMS", null]) {
    assert.equal(inactiveWith({ source_id: "src:kind", source_kind: bad }), false, `source_kind=${JSON.stringify(bad)}`);
  }
});

test("T6.1a-6: an unknown verification_status is inactive", () => {
  for (const bad of ["pending", "true", "", "Verified", null]) {
    assert.equal(inactiveWith({ source_id: "src:vs", verification_status: bad }), false, `verification_status=${JSON.stringify(bad)}`);
  }
});

test("T6.1a-7: a verified_on that is not YYYY-MM-DD is inactive", () => {
  for (const bad of ["2026-7-24", "24-07-2026", "2026/07/24", "2026-07-24T00:00", "yesterday", ""]) {
    assert.equal(inactiveWith({ source_id: "src:d", verified_on: bad }), false, `verified_on=${JSON.stringify(bad)}`);
  }
});

test("T6.1a-8: a non-existent calendar date is inactive", () => {
  for (const bad of ["2026-02-30", "2026-13-01", "2026-00-10", "2026-04-31"]) {
    assert.equal(inactiveWith({ source_id: "src:d2", verified_on: bad }), false, `verified_on=${bad}`);
  }
});

test("T6.1a-9: a non-array supported_fields is inactive", () => {
  for (const bad of ["eligibility.company_type", {}, null, 3]) {
    assert.equal(inactiveWith({ source_id: "src:sf", supported_fields: bad }), false);
  }
});

test("T6.1a-10: a non-string / empty supported_fields element is inactive", () => {
  for (const bad of [["eligibility.company_type", ""], ["eligibility.company_type", "  "], ["eligibility.company_type", 5], [null]]) {
    assert.equal(inactiveWith({ source_id: "src:sf2", supported_fields: bad }), false);
  }
});

test("T6.1a-11: duplicate fields in supported_fields is inactive", () => {
  assert.equal(inactiveWith({ source_id: "src:dup", supported_fields: ["a.b", "a.b"] }), false);
});

test("T6.1a-12: a non-string institution / document_title / page_or_section is inactive", () => {
  for (const f of ["institution", "document_title", "page_or_section"]) {
    assert.equal(inactiveWith({ source_id: `src:${f}`, [f]: 42 }), false, `${f}=42`);
    assert.equal(inactiveWith({ source_id: `src:${f}2`, [f]: "  " }), false, `${f}=blank`);
  }
});

test("T6.1a-13: mutating the input object or its supported_fields after construction cannot change the registry", () => {
  const s = complete({ source_id: "src:snap", supported_fields: ["eligibility.company_type"] });
  const reg = createSourceRegistry([s]);
  assert.equal(reg.isActive("src:snap"), true);
  // 원본 입력을 사후 오염
  s.verification_status = "unverified";
  s.supported_fields.push("hacked");
  s.institution = "TAMPERED";
  assert.equal(reg.isActive("src:snap"), true, "post-hoc mutation must not deactivate");
  assert.ok(!reg.get("src:snap").supported_fields.includes("hacked"));
  assert.notEqual(reg.get("src:snap").institution, "TAMPERED");
  assert.equal(reg.canSupport("src:snap", "fwd", "hacked"), false);
});

test("T6.1a-dup: a duplicate source_id is inactive (not silently overwritten)", () => {
  const a = complete({ source_id: "src:twin", institution: "첫 번째" });
  const b = complete({ source_id: "src:twin", institution: "두 번째" });
  const reg = createSourceRegistry([a, b]);
  assert.equal(reg.isActive("src:twin"), false, "colliding ids must not resolve to the last one");
});

test("T6.1a: a malformed entry deactivates only itself, not the whole registry", () => {
  const good = complete({ source_id: "src:good" });
  const bad = complete({ source_id: "not-src", verification_status: "nonsense" });
  const reg = createSourceRegistry([good, bad]);
  assert.equal(reg.isActive("src:good"), true);
  assert.equal(reg.isActive("not-src"), false);
});

// ---------- T6.1b: market_data is never product evidence; duplicate ids fully fail closed ----------
test("T6.1b-1: market_data can never back a product condition, even with matching product_id + field", () => {
  const field = "eligibility.company_type";
  const md = complete({ source_id: "src:md", product_id: "fwd", source_kind: "market_data",
    supported_fields: [field], url: "https://github.com/qkrwlgh335-lab/tradepilot-ai-finance-agent/blob/main/docs/PUBLIC_DEMO_RULES.md" });
  const pt = complete({ source_id: "src:pt", product_id: "fwd", source_kind: "product_terms",
    supported_fields: [field], url: "https://github.com/qkrwlgh335-lab/tradepilot-ai-finance-agent/blob/main/docs/PUBLIC_DEMO_RULES.md" });
  const reg = createSourceRegistry([md, pt]);
  // 3개 인수를 모두 일치시켜, 상품/필드 불일치 때문에 우연히 false가 되지 않게 한다.
  assert.equal(reg.canSupport("src:md", "fwd", field), false, "market_data must not support a product condition");
  assert.equal(reg.canSupport("src:pt", "fwd", field), true, "product_terms control stays true");
});

test("T6.1b-1b: every real registered source that canSupport a field is product_terms", async () => {
  const { sources } = await load("data/source-registry.json");
  const reg = createSourceRegistry(sources);
  for (const s of sources) for (const f of s.supported_fields)
    if (reg.canSupport(s.source_id, s.product_id, f)) assert.equal(s.source_kind, "product_terms", `${s.source_id} backed a field but is ${s.source_kind}`);
});

test("T6.1b-2: a duplicate source_id fully fails closed (isActive/canSupport/get/activeIds)", () => {
  const a = complete({ source_id: "src:twin", institution: "첫 번째", supported_fields: ["eligibility.company_type"] });
  const b = complete({ source_id: "src:twin", institution: "두 번째", supported_fields: ["eligibility.company_type"] });
  const good = complete({ source_id: "src:solo" });
  const reg = createSourceRegistry([a, b, good]);

  assert.equal(reg.isActive("src:twin"), false);
  assert.equal(reg.canSupport("src:twin", "fwd", "eligibility.company_type"), false);
  assert.equal(reg.get("src:twin"), null, "must not return the last colliding entry");
  assert.ok(!reg.activeIds().includes("src:twin"), "colliding id must not be listed active");
  // 정상 항목은 영향 없음
  assert.equal(reg.isActive("src:solo"), true);
  assert.ok(reg.activeIds().includes("src:solo"));
  assert.ok(!reg.all().some((s) => s.source_id === "src:twin"), "colliding id must not leak via all()");
});
