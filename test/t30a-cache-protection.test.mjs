// T30a — under any refresh failure (network error, timeout, malformed CSV), the last-known-good
// fx.json / fx-vol.json / market-sources.json must remain BYTE-IDENTICAL. Uses a private temp
// directory so the real data/ tree is never touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { refreshMarketData } from "../scripts/refresh-market-data.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const FILES = ["fx.json", "fx-vol.json", "market-sources.json"];

async function seededDir() {
  const dir = await mkdtemp(join(tmpdir(), "kb-cache-"));
  for (const file of FILES) await copyFile(join(ROOT, "data", file), join(dir, file));
  return dir;
}

async function hashesFor(dir) {
  const out = {};
  for (const file of FILES) out[file] = createHash("sha256").update(await readFile(join(dir, file))).digest("hex");
  return out;
}

async function expectUnchanged(dir, before) {
  const after = await hashesFor(dir);
  for (const file of FILES) assert.equal(after[file], before[file], `${file} must be byte-identical after failure`);
  const listing = new Set(await readdir(dir));
  assert.equal(listing.size, FILES.length, "no partial/leftover files may remain in the cache dir");
  for (const file of FILES) assert.ok(listing.has(file), `${file} must still exist`);
}

async function attemptRefresh(dir, fetchImpl, options = {}) {
  try {
    await refreshMarketData({
      outputDir: dir,
      fetchImpl,
      now: () => new Date("2026-07-30T00:00:00.000Z"),
      timeoutMs: 200,
      ...options,
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

test("T30a: network error leaves all three cache files byte-identical", async () => {
  const dir = await seededDir();
  const before = await hashesFor(dir);
  try {
    const result = await attemptRefresh(dir, async () => { throw new Error("network down"); });
    assert.equal(result.ok, false);
    await expectUnchanged(dir, before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("T30a: timeout while awaiting the response leaves all three cache files byte-identical", async () => {
  const dir = await seededDir();
  const before = await hashesFor(dir);
  try {
    // Cooperating fetch: aborts when the caller's AbortSignal fires (real fetch behaviour).
    const result = await attemptRefresh(dir, (_url, opts) => new Promise((_resolve, reject) => {
      opts?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    }));
    assert.equal(result.ok, false);
    await expectUnchanged(dir, before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("T30a: malformed ECB CSV leaves all three cache files byte-identical", async () => {
  const dir = await seededDir();
  const before = await hashesFor(dir);
  try {
    const result = await attemptRefresh(dir, async () => ({
      ok: true, status: 200,
      text: async () => "not,a,valid,ecb,csv\nfoo,bar,baz",
    }));
    assert.equal(result.ok, false);
    await expectUnchanged(dir, before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("T30a: HTTP 500 leaves all three cache files byte-identical", async () => {
  const dir = await seededDir();
  const before = await hashesFor(dir);
  try {
    const result = await attemptRefresh(dir, async () => ({
      ok: false, status: 500,
      text: async () => "server error",
    }));
    assert.equal(result.ok, false);
    await expectUnchanged(dir, before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
