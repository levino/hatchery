import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountLoginPath, hasAccountLogin } from "./claude-auth.ts";

test("accountLoginPath points into the drone's bind-mounted CLAUDE_CONFIG_DIR", () => {
  assert.equal(
    accountLoginPath("hatchery-levino-x", "/base"),
    "/base/hatchery-levino-x/worktrees/.claude/.credentials.json",
  );
});

test("hasAccountLogin is false without a credentials file", () => {
  const base = mkdtempSync(join(tmpdir(), "hatchery-"));
  mkdirSync(join(base, "hatchery-a", "worktrees", ".claude"), { recursive: true });
  assert.equal(hasAccountLogin("hatchery-a", base), false);
  assert.equal(hasAccountLogin("hatchery-missing", base), false);
});

test("hasAccountLogin is true once /login wrote credentials", () => {
  const base = mkdtempSync(join(tmpdir(), "hatchery-"));
  const dir = join(base, "hatchery-a", "worktrees", ".claude");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".credentials.json"), "{}");
  assert.equal(hasAccountLogin("hatchery-a", base), true);
});
