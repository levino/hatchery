import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const helper = new URL("../../features/hatchery/git-credential-hatchery", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "cred-"));
const fake = join(dir, "token");
writeFileSync(fake, '#!/bin/sh\nprintf "tok:%s" "$1"\n');
chmodSync(fake, 0o755);

const run = (input: string) =>
  execFileSync("sh", [helper, "get"], {
    input,
    env: { ...process.env, HATCHERY_TOKEN_BIN: fake },
  }).toString();

test("requests a repo-scoped token from the path", () => {
  const out = run("protocol=https\nhost=github.com\npath=other-org/repo.git\n\n");
  assert.match(out, /^password=tok:repo=other-org\/repo$/m);
});

test("ignores extra path segments", () => {
  const out = run("protocol=https\nhost=github.com\npath=o/r.git/info/refs\n\n");
  assert.match(out, /^password=tok:repo=o\/r$/m);
});

test("falls back to the default token without a path", () => {
  const out = run("protocol=https\nhost=github.com\n\n");
  assert.match(out, /^password=tok:$/m);
});
