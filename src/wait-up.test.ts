import { test } from "node:test";
import assert from "node:assert/strict";
import { waitForRunning } from "./wait-up.ts";
import { HatcheryError } from "./zerg.ts";

const later = () => Date.now() + 5000;

test("returns true when the container is running", async () => {
  const child = { exitCode: null, signalCode: null };
  assert.equal(await waitForRunning(async () => true, child, later(), 1), true);
});

test("throws right away when devcontainer up exits non-zero", async () => {
  const child = { exitCode: 1, signalCode: null };
  await assert.rejects(
    waitForRunning(async () => false, child, later(), 1),
    (e) => e instanceof HatcheryError && /exit code 1/.test(e.message),
  );
});

test("keeps polling after a clean exit until running", async () => {
  const child = { exitCode: 0, signalCode: null };
  let n = 0;
  assert.equal(await waitForRunning(async () => ++n > 2, child, later(), 1), true);
});

test("returns false on timeout", async () => {
  const child = { exitCode: null, signalCode: null };
  assert.equal(await waitForRunning(async () => false, child, Date.now() + 20, 5), false);
});
