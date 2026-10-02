import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveScope, ScopeDeniedError } from "./scope.ts";

const allowed = ["levino/hatchery", "levino/server-config", "fws-maschsee/Waeldchendienst"];

test("allows a connected repo", () => {
  assert.deepEqual(resolveScope(allowed, "levino/hatchery", null), ["levino/hatchery"]);
});

test("matches case-insensitively and returns the canonical name", () => {
  assert.deepEqual(
    resolveScope(allowed, "FWS-Maschsee/waeldchendienst", null),
    ["fws-maschsee/Waeldchendienst"],
  );
});

test("denies a repo the drone is not connected to", () => {
  assert.throws(
    () => resolveScope(allowed, "levino/secret", null),
    (err: unknown) =>
      err instanceof ScopeDeniedError &&
      err.message.includes("levino/secret") &&
      err.message.includes("hatchery repo connect"),
  );
});

test("repo takes precedence over org", () => {
  assert.throws(() => resolveScope(allowed, "other/repo", "levino"), ScopeDeniedError);
});

test("denies an org without connected repos", () => {
  assert.throws(() => resolveScope(allowed, null, "other-org"), ScopeDeniedError);
});

test("org filter returns only that org's repos", () => {
  assert.deepEqual(resolveScope(allowed, null, "Levino"), ["levino/hatchery", "levino/server-config"]);
  assert.deepEqual(resolveScope(allowed, null, "fws-maschsee"), ["fws-maschsee/Waeldchendienst"]);
});

test("default scope stays within the first repo's org", () => {
  assert.deepEqual(resolveScope(allowed, null, null), ["levino/hatchery", "levino/server-config"]);
  assert.deepEqual(
    resolveScope(["fws-maschsee/a", "levino/b", "FWS-maschsee/c"], null, null),
    ["fws-maschsee/a", "FWS-maschsee/c"],
  );
});

test("denies everything when nothing is connected", () => {
  assert.throws(() => resolveScope([], null, null), ScopeDeniedError);
  assert.throws(() => resolveScope([], "levino/hatchery", null), ScopeDeniedError);
});
