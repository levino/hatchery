import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  accountLoginPath,
  claudeAuthSection,
  hasAccountLogin,
  parseClaudeAuthMode,
  readClaudeAuthMode,
  withClaudeAuthSection,
  writeClaudeAuthMode,
} from "./claude-auth.ts";

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

test("claude auth mode defaults to token and round-trips login", () => {
  const dir = mkdtempSync(join(tmpdir(), "hatchery-"));
  assert.equal(readClaudeAuthMode(dir, "hatchery-a"), "token");
  writeClaudeAuthMode(dir, "hatchery-a", "login");
  assert.equal(readClaudeAuthMode(dir, "hatchery-a"), "login");
  writeClaudeAuthMode(dir, "hatchery-a", "token");
  assert.equal(readClaudeAuthMode(dir, "hatchery-a"), "token");
  assert.throws(() => parseClaudeAuthMode("oauth"));
});

test("withClaudeAuthSection swaps only the Claude auth section", () => {
  const md = `# Drone\n\n## gh\n\nstuff\n\n${claudeAuthSection("token")}`;
  const login = withClaudeAuthSection(md, "login");
  assert.equal(login, `# Drone\n\n## gh\n\nstuff\n\n${claudeAuthSection("login")}`);
  assert.equal(withClaudeAuthSection(login, "token"), md);

  const middle = `# Drone\n\n${claudeAuthSection("token")}\n## Later\n\nx\n`;
  assert.equal(withClaudeAuthSection(middle, "login"), `# Drone\n\n${claudeAuthSection("login")}\n## Later\n\nx\n`);

  assert.equal(withClaudeAuthSection("# Drone\n", "login"), `# Drone\n\n${claudeAuthSection("login")}`);
});
