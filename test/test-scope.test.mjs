import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const TEST_DIR = path.join(ROOT, "test");

// dist/ is a gitignored packaging artifact; 기획안/ holds the existing handoff copy
// whose deletion is deferred to a separate approval gate (plan Task 15).
const SKIP_DIRS = new Set(["node_modules", ".git", ".superpowers", "dist", "기획안"]);

test("npm test is scoped to root test/ so copies are never double-counted", async () => {
  const pkg = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
  // Must target root test/ explicitly. A bare `node --test` discovers copies elsewhere in
  // the repo (the handoff folder) and double-counts them; `node --test test/` is not usable
  // because Node >=22 resolves a directory argument as a module path, so use a glob.
  assert.match(pkg.scripts.test, /^node --test test\/[^ ]*\.test\.mjs$/);
  assert.equal(pkg.scripts.package, "node scripts/package.mjs");
  assert.equal(pkg.scripts.proxy, "node proxy.mjs");
});

test("dist/ and .env are gitignored so packaging output never becomes a source copy", async () => {
  const gi = await readFile(path.join(ROOT, ".gitignore"), "utf8");
  assert.match(gi, /^dist\/?$/m);
  assert.match(gi, /^\.env$/m);
});

test("no NEW test files outside root test/ (dist and 기획안 excluded by policy)", async () => {
  async function walk(dir) {
    let hits = [];
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) hits = hits.concat(await walk(p));
      else if (/\.test\.mjs$/.test(e.name) && path.dirname(p) !== TEST_DIR) hits.push(path.relative(ROOT, p));
    }
    return hits;
  }
  assert.deepEqual(await walk(ROOT), []);
});
