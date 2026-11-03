import { HatcheryError } from "./zerg.ts";

export interface UpChild {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
}

/**
 * Poll until the container is running. Fails fast if `devcontainer up` exits
 * non-zero (build error) before that, instead of waiting for the timeout.
 * Returns true once the container runs, false on timeout.
 */
export async function waitForRunning(
  isRunning: () => Promise<boolean>,
  child: UpChild,
  deadline: number,
  pollMs = 2000,
): Promise<boolean> {
  while (Date.now() < deadline) {
    if (await isRunning()) return true;
    const failed = child.exitCode !== null ? child.exitCode !== 0 : child.signalCode !== null;
    if (failed) {
      // One last look: the container may have come up just before the exit.
      if (await isRunning()) return true;
      const how = child.exitCode !== null ? `exit code ${child.exitCode}` : `signal ${child.signalCode}`;
      throw new HatcheryError(
        `devcontainer up failed (${how}) before the container started. See the build output above for the error.`,
      );
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return false;
}
