import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const setupScript = join(import.meta.dir, "..", "cloud-setup.sh");
const realBash = Bun.which("bash") ?? "/bin/bash";

const PLUGINS = ["coding", "polish", "fgilio-review", "ship-it"];

// PATH holds only these stubs and the system tools the script runs, so every
// program it reaches outside the machine is a stub that records its call.
const stubs: Record<string, string> = {
  timeout: `#!/bin/sh
printf 'timeout %s %s\\n' "$1" "$2" >> "$CALLS"
shift 2
exec "$@"
`,
  claude: `#!/bin/sh
printf 'claude %s\\n' "$*" >> "$CALLS"
exit "\${CLAUDE_EXIT:-0}"
`,
};
const SYSTEM_TOOLS = ["grep", "mktemp", "rm", "sed", "tee", "tr", "wc"];

const roots: string[] = [];
afterAll(() =>
  roots.forEach((root) => rmSync(root, { recursive: true, force: true })),
);

type Run = { exitCode: number; stdout: string; calls: string[]; home: string };

function runSetup(
  options: {
    env?: Record<string, string>;
    prepare?: (home: string) => void;
  } = {},
): Run {
  const root = mkdtempSync(join(tmpdir(), "cloud-setup-"));
  roots.push(root);
  const stubDir = join(root, "stubs");
  const home = join(root, "home");
  const calls = join(root, "calls");
  mkdirSync(stubDir);
  mkdirSync(home);

  for (const [name, body] of Object.entries(stubs)) {
    writeFileSync(join(stubDir, name), body);
    chmodSync(join(stubDir, name), 0o755);
  }
  for (const tool of SYSTEM_TOOLS) {
    symlinkSync(Bun.which(tool) ?? `/usr/bin/${tool}`, join(stubDir, tool));
  }
  options.prepare?.(home);

  const run = Bun.spawnSync([realBash, setupScript], {
    env: {
      PATH: stubDir,
      HOME: home,
      TMPDIR: root,
      CALLS: calls,
      ...options.env,
    },
  });

  return {
    exitCode: run.exitCode,
    stdout: run.stdout.toString(),
    calls: existsSync(calls)
      ? readFileSync(calls, "utf8").trim().split("\n")
      : [],
    home,
  };
}

describe("cloud-setup.sh", () => {
  test("installs each plugin, one at a time and time-boxed", () => {
    const run = runSetup();

    expect(run.exitCode).toBe(0);
    expect(run.calls).toEqual(
      PLUGINS.flatMap((plugin) => [
        "timeout --kill-after=10 60",
        `claude plugin install ${plugin}@fgilio`,
      ]),
    );
    expect(run.stdout).toContain("cloud-setup: 4 steps, 0 failed");
  });

  test("leaves the home directory to the environment", () => {
    const settings = JSON.stringify({ env: { EDITOR: "vim" } });
    const run = runSetup({
      prepare: (home) => {
        mkdirSync(join(home, ".claude"));
        writeFileSync(join(home, ".claude/settings.json"), settings);
        writeFileSync(join(home, ".claude/CLAUDE.md"), "# Mine\n");
      },
    });

    expect(readdirSync(run.home)).toEqual([".claude"]);
    expect(readdirSync(join(run.home, ".claude")).toSorted()).toEqual([
      "CLAUDE.md",
      "settings.json",
    ]);
    expect(readFileSync(join(run.home, ".claude/settings.json"), "utf8")).toBe(
      settings,
    );
    expect(readFileSync(join(run.home, ".claude/CLAUDE.md"), "utf8")).toBe(
      "# Mine\n",
    );
  });

  test("exits 0 and counts each failure when every install fails", () => {
    const run = runSetup({ env: { CLAUDE_EXIT: "1" } });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("FAIL  ship-it@fgilio");
    expect(run.stdout).toContain("cloud-setup: 4 steps, 4 failed");
  });
});
