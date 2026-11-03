import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRepoArg } from "./spawn.ts";
import { HatcheryError } from "./zerg.ts";

const config = { forgejo: {} } as any;

test("rejects a nonexistent absolute path instead of treating it as GitHub", () => {
  assert.throws(() => parseRepoArg("/nonexistent/hatchery/test-repo", config), HatcheryError);
});

test("rejects nonexistent relative paths", () => {
  assert.throws(() => parseRepoArg("./nonexistent-hatchery-dir", config), HatcheryError);
  assert.throws(() => parseRepoArg("../nonexistent-hatchery-dir", config), HatcheryError);
});

test("accepts an existing local path", () => {
  const dir = mkdtempSync(join(tmpdir(), "hatchery-"));
  assert.equal(parseRepoArg(dir, config).provider, "local");
});

test("org/repo still parses as GitHub", () => {
  assert.equal(parseRepoArg("levino/hatchery", config).provider, "github");
});
