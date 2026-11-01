import { spyOn } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Creates a temporary git repository holding these files, untracked as a
 * new file is. The caller removes it.
 */
export async function gitRepo(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "fleet-test-"));

  await Promise.all(
    Object.entries(files).map(([path, text]) =>
      Bun.write(join(root, path), text),
    ),
  );

  Bun.spawnSync(["git", "init", "--quiet"], { cwd: root });

  return root;
}

/**
 * Silences console.log and console.error and hands back what they printed.
 * The caller restores them.
 */
export function captureOutput() {
  const log = spyOn(console, "log").mockImplementation(() => undefined);
  const error = spyOn(console, "error").mockImplementation(() => undefined);

  return {
    logged: () => log.mock.calls.map((call) => call.join(" ")),
    errors: () => error.mock.calls.map((call) => call.join(" ")),
    restore: () => {
      log.mockRestore();
      error.mockRestore();
    },
  };
}
