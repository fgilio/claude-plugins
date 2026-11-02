import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CALLER_WORKFLOW,
  FLEET_DIR,
  FLEET_FILES,
  HUB_COMMIT_COMMAND,
  type Profile,
  type WorkflowChange,
  type WorkflowHistory,
} from "./fleet-sync";
import {
  type CommandRunner,
  type RepoOutcome,
  branchName,
  cloneUrl,
  commitBody,
  dryRunner,
  main,
  outcomeLines,
  profileOf,
  pullRequestBody,
  redact,
  spawnRunner,
  syncRepo,
} from "./fleet-sync-repos";
import { captureOutput, gitRepo } from "./test-support";

const HUB_SHA = "abc1234def5678abc1234def5678abc1234def56";

const HUB = { sha: HUB_SHA, date: "2026-11-01" };

const OLD_SHA = "5291614636ea03f3a630c8547f249b26d7e69e2e";

/** A caller workflow, shaped as the fleet README shows it, pinned to ref. */
const callerWorkflow = (ref: string) =>
  [
    "name: CI",
    "",
    "jobs:",
    "  checks:",
    `    uses: fgilio/claude-plugins/.github/workflows/fleet-ci.yml@${ref} # fleet-ci 2026-10-01`,
    "    with:",
    "      profile: prose",
    "",
  ].join("\n");

const TOKEN = "github_pat_secret";

const PROSE_PACKAGE = JSON.stringify({ name: "acme-books-skill" });

const CODE_PACKAGE = JSON.stringify({
  name: "acme-books-tools",
  devDependencies: { typescript: "7.0.2" },
});

/** Every file of a profile, as fleet/ holds it. */
async function syncedFiles(profile: Profile): Promise<Record<string, string>> {
  return Object.fromEntries(
    await Promise.all(
      FLEET_FILES[profile].map(
        async ({ target, source }): Promise<[string, string]> => [
          target,
          await Bun.file(join(FLEET_DIR, source)).text(),
        ],
      ),
    ),
  );
}

interface FakeRepo {
  files: Record<string, string> | null;
  pullRequests?: { number: number; headRefName: string; url: string }[];
}

/** The value after a flag, or undefined when the command has no such flag. */
function flagValue(command: string[], flag: string): string | undefined {
  const index = command.indexOf(flag);

  return index === -1 ? undefined : command[index + 1];
}

/**
 * A runner that answers git and gh the way GitHub would for these
 * repositories, and records every command it receives.
 */
function fakeGitHub(
  repos: Record<string, FakeRepo>,
  { workflowDiffExitCode = 0 } = {},
) {
  const commands: string[][] = [];

  const run: CommandRunner = async (command, cwd) => {
    commands.push(command);
    const [program, subcommand, action] = command;

    if (program === "git" && subcommand === "log") {
      return {
        exitCode: 0,
        stdout: `${HUB.sha}\n${HUB.date}\n`,
        stderr: "",
      };
    }

    if (program === "git" && subcommand === "diff") {
      return { exitCode: workflowDiffExitCode, stdout: "", stderr: "" };
    }

    if (program === "git" && subcommand === "clone") {
      const url = command.at(-2) ?? "";
      const destination = command.at(-1) ?? "";
      const name = /github\.com\/(.+)\.git$/.exec(url)?.[1] ?? "";
      const repo = repos[name];

      if (repo?.files === null || repo === undefined) {
        return {
          exitCode: 128,
          stdout: "",
          stderr: `fatal: repository '${url}' not found`,
        };
      }

      await Promise.all(
        Object.entries({
          ".git/HEAD": "ref: refs/heads/main\n",
          ...repo.files,
        }).map(([path, text]) => Bun.write(join(destination, path), text)),
      );

      return { exitCode: 0, stdout: "", stderr: "" };
    }

    if (program === "gh" && subcommand === "pr" && action === "list") {
      const repo = flagValue(command, "--repo") ?? "";

      return {
        exitCode: 0,
        stdout: JSON.stringify(repos[repo]?.pullRequests ?? []),
        stderr: "",
      };
    }

    if (program === "gh" && subcommand === "pr" && action === "create") {
      const repo = flagValue(command, "--repo") ?? "";

      return {
        exitCode: 0,
        stdout: `https://github.com/${repo}/pull/7\n`,
        stderr: "",
      };
    }

    expect(cwd).toBeDefined();

    return { exitCode: 0, stdout: "", stderr: "" };
  };

  return { run, commands };
}

const shown = (commands: string[][]) =>
  commands.map((command) => command.slice(0, 3).join(" "));

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "fleet-sync-repos-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/** A hub history where only these refs saw fleet-ci.yml or scripts/ change. */
const historyWith =
  (changes: Record<string, WorkflowChange>): WorkflowHistory =>
  (ref) =>
    Promise.resolve(changes[ref] ?? "unchanged");

const SCRIPTS_CHANGED = historyWith({ [OLD_SHA]: "changed" });

function context(
  run: CommandRunner,
  token: string | undefined = TOKEN,
  workflowHistory: WorkflowHistory = historyWith({}),
) {
  return {
    run,
    token,
    hub: HUB,
    workflowHistory,
    workDir,
    fleetDir: FLEET_DIR,
  };
}

describe("profileOf", () => {
  test.each<[unknown, Profile]>([
    [{ devDependencies: { typescript: "7.0.2" } }, "code"],
    [{ devDependencies: { oxfmt: "0.75.0" } }, "prose"],
    [{ dependencies: { typescript: "7.0.2" } }, "prose"],
    [{}, "prose"],
    [[], "prose"],
  ])("reads %j as %s", (packageJson, profile) => {
    expect(profileOf(packageJson)).toBe(profile);
  });
});

describe("cloneUrl", () => {
  test("puts the token in the URL git authenticates with", () => {
    expect(cloneUrl("acme/acme-books-skill", TOKEN)).toBe(
      `https://x-access-token:${TOKEN}@github.com/acme/acme-books-skill.git`,
    );
  });

  test("clones anonymously without a token", () => {
    expect(cloneUrl("acme/acme-books-skill", undefined)).toBe(
      "https://github.com/acme/acme-books-skill.git",
    );
  });
});

describe("redact", () => {
  test("replaces every copy of the token", () => {
    expect(redact(`a ${TOKEN} b ${TOKEN}`, TOKEN)).toBe("a *** b ***");
  });
});

describe("pullRequestBody", () => {
  const files = [
    {
      target: "bunfig.toml",
      source: "shared/bunfig.toml",
      status: "drifted" as const,
    },
    {
      target: "lefthook.yml",
      source: "prose/lefthook.yml",
      status: "missing" as const,
    },
  ];

  test("fills the fleet's PR template with the hub commit, the files, the pin and the proof", () => {
    expect(
      pullRequestBody({
        repo: "acme/acme-books-skill",
        hub: HUB,
        profile: "prose",
        files,
        pin: { refs: [OLD_SHA], status: "changed" },
      }),
    ).toBe(
      [
        "## Summary",
        "",
        `Syncs this repository with the fleet standard at [fgilio/claude-plugins@abc1234](https://github.com/fgilio/claude-plugins/commit/${HUB_SHA}), prose profile.`,
        "",
        "## Why",
        "",
        "2 config files of the prose profile differ from their canonical copies in the hub. `.github/workflows/ci.yml` runs `fleet-ci.yml` from an older hub commit, and `.github/workflows/fleet-ci.yml` or `scripts` changed since, so CI checks this repository with older checks than its files follow.",
        "",
        "The monthly fleet-sync workflow in fgilio/claude-plugins opened this pull request and updates it on each run. Review it like any other change. If a file here must differ from the fleet, change the standard in the hub instead.",
        "",
        "## Changes",
        "",
        "- `bunfig.toml` updated to `fleet/shared/bunfig.toml`",
        "- `lefthook.yml` added from `fleet/prose/lefthook.yml`",
        `- \`.github/workflows/ci.yml\` pins \`fleet-ci.yml\` to \`${HUB_SHA}\` (was \`5291614\`)`,
        "",
        "Each file is a byte-identical copy of its canonical file in `fleet/` at abc1234.",
        "",
        "## Testing",
        "",
        "From a checkout of the hub at abc1234, with this branch checked out next to it:",
        "",
        "```bash",
        "bun scripts/fleet-sync.ts ../acme-books-skill --profile prose --check",
        "```",
        "",
        "This repository's CI on this pull request is the proof: it runs the fleet's checks from the newly pinned hub commit against the synced files.",
      ].join("\n"),
    );
  });

  test("leaves the pin out when it already names the hub commit", () => {
    const body = pullRequestBody({
      repo: "acme/acme-books-skill",
      hub: HUB,
      profile: "prose",
      files: files.slice(0, 1),
      pin: { refs: [HUB_SHA], status: "same" },
    });

    expect(body).toContain(
      "One config file of the prose profile differs from its canonical copy in the hub.",
    );
    expect(body).not.toContain(CALLER_WORKFLOW);
    expect(body).toContain(
      "it runs the fleet's checks against the synced files.",
    );
  });

  test("names only the pin when no file drifted", () => {
    const body = pullRequestBody({
      repo: "acme/acme-books-skill",
      hub: HUB,
      profile: "code",
      files: [],
      pin: { refs: [OLD_SHA], status: "changed" },
    });

    expect(body).toContain(
      "## Why\n\n`.github/workflows/ci.yml` runs `fleet-ci.yml` from an older hub commit",
    );
    expect(body).toContain(
      `## Changes\n\n- \`.github/workflows/ci.yml\` pins \`fleet-ci.yml\` to \`${HUB_SHA}\` (was \`5291614\`)\n\n## Testing`,
    );
    expect(body).not.toContain("byte-identical");
  });
});

describe("pullRequestBody with a pin behind", () => {
  test("moves the pin with drifted files and says so", () => {
    const body = pullRequestBody({
      repo: "acme/acme-books-skill",
      hub: HUB,
      profile: "prose",
      files: [
        {
          target: "bunfig.toml",
          source: "shared/bunfig.toml",
          status: "drifted",
        },
      ],
      pin: { refs: [OLD_SHA], status: "behind" },
    });

    expect(body).toContain(
      "The `fleet-ci.yml` pin in `.github/workflows/ci.yml` moves to the same commit as the files, so CI runs the checks of the commit they come from.",
    );
    expect(body).toContain(
      `- \`.github/workflows/ci.yml\` pins \`fleet-ci.yml\` to \`${HUB_SHA}\` (was \`5291614\`)`,
    );
  });
});

describe("commitBody", () => {
  test("carries the hub commit and the changes without Markdown sections", () => {
    expect(
      commitBody({
        repo: "acme/acme-books-skill",
        hub: HUB,
        profile: "prose",
        files: [
          {
            target: "bunfig.toml",
            source: "shared/bunfig.toml",
            status: "drifted",
          },
        ],
        pin: { refs: [], status: "unpinned" },
      }),
    ).toBe(
      `Syncs the prose profile with fgilio/claude-plugins@${HUB_SHA}.\n\n- \`bunfig.toml\` updated to \`fleet/shared/bunfig.toml\``,
    );
  });
});

describe("syncRepo", () => {
  test("skips a repository without package.json", async () => {
    const { run, commands } = fakeGitHub({
      "acme/acme-books-skill": { files: { "README.md": "# Acme\n" } },
    });

    expect(await syncRepo(context(run), "acme/acme-books-skill")).toEqual({
      kind: "not-adopted",
    });
    expect(shown(commands)).toEqual(["git clone --quiet"]);
  });

  test("leaves a repository that matches its profile and pins the hub commit alone", async () => {
    const { run, commands } = fakeGitHub({
      "acme/acme-books-tools": {
        files: {
          "package.json": CODE_PACKAGE,
          ...(await syncedFiles("code")),
          [CALLER_WORKFLOW]: callerWorkflow(HUB_SHA),
        },
      },
    });

    expect(await syncRepo(context(run), "acme/acme-books-tools")).toEqual({
      kind: "in-sync",
      profile: "code",
      closed: [],
    });
    expect(shown(commands)).toEqual(["git clone --quiet", "gh pr list"]);
  });

  test("closes a fleet-sync pull request left open once the repository matches", async () => {
    const stale = {
      number: 3,
      headRefName: "fleet-sync/0000000",
      url: "https://github.com/acme/acme-books-skill/pull/3",
    };
    const { run, commands } = fakeGitHub({
      "acme/acme-books-skill": {
        files: {
          "package.json": PROSE_PACKAGE,
          ...(await syncedFiles("prose")),
        },
        pullRequests: [stale],
      },
    });

    expect(await syncRepo(context(run), "acme/acme-books-skill")).toEqual({
      kind: "in-sync",
      profile: "prose",
      closed: [stale],
    });
    expect(commands.at(-1)).toEqual([
      "gh",
      "pr",
      "close",
      "3",
      "--repo",
      "acme/acme-books-skill",
      "--delete-branch",
      "--comment",
      `The default branch matches the fleet config files at fgilio/claude-plugins@${HUB_SHA}.`,
    ]);
  });

  test("pushes the drifted files and opens one draft pull request", async () => {
    const { "lefthook.yml": _missing, ...files } = await syncedFiles("prose");
    const { run, commands } = fakeGitHub({
      "acme/acme-books-skill": {
        files: {
          "package.json": PROSE_PACKAGE,
          ...files,
          "bunfig.toml": "[install]\n",
        },
      },
    });

    const outcome = await syncRepo(context(run), "acme/acme-books-skill");

    expect(outcome).toMatchObject({
      kind: "synced",
      profile: "prose",
      action: "opened",
      url: "https://github.com/acme/acme-books-skill/pull/7",
      files: [
        { target: "bunfig.toml", status: "drifted" },
        { target: "lefthook.yml", status: "missing" },
      ],
      closed: [],
    });
    expect(shown(commands)).toEqual([
      "git clone --quiet",
      "gh pr list",
      "git switch --quiet",
      "git add --",
      "git -c user.name=github-actions[bot]",
      "git push --quiet",
      "gh pr create",
    ]);
    expect(commands[2]).toContain("fleet-sync/abc1234");
    expect(commands[3]).toEqual([
      "git",
      "add",
      "--",
      "bunfig.toml",
      "lefthook.yml",
    ]);
    expect(commands[5]).toEqual([
      "git",
      "push",
      "--quiet",
      "--force",
      "origin",
      "HEAD:refs/heads/fleet-sync/abc1234",
    ]);

    const create = commands[6] ?? [];

    expect(create.slice(0, 9)).toEqual([
      "gh",
      "pr",
      "create",
      "--repo",
      "acme/acme-books-skill",
      "--draft",
      "--head",
      "fleet-sync/abc1234",
      "--title",
    ]);
    expect(create[9]).toBe("Sync the fleet config files to abc1234");
    expect(create[11]).toStartWith("## Summary\n");
    expect(create[11]).toContain(
      "- `lefthook.yml` added from `fleet/prose/lefthook.yml`",
    );
  });

  test("leaves a repository alone when the hub changed only docs since its pin", async () => {
    const { run, commands } = fakeGitHub({
      "acme/acme-books-skill": {
        files: {
          "package.json": PROSE_PACKAGE,
          ...(await syncedFiles("prose")),
          [CALLER_WORKFLOW]: callerWorkflow(OLD_SHA),
        },
      },
    });

    expect(await syncRepo(context(run), "acme/acme-books-skill")).toEqual({
      kind: "in-sync",
      profile: "prose",
      closed: [],
    });
    expect(shown(commands)).toEqual(["git clone --quiet", "gh pr list"]);
  });

  test("moves the pin with drifted files when the hub changed only docs since it", async () => {
    const { run, commands } = fakeGitHub({
      "acme/acme-books-skill": {
        files: {
          "package.json": PROSE_PACKAGE,
          ...(await syncedFiles("prose")),
          "bunfig.toml": "[install]\n",
          [CALLER_WORKFLOW]: callerWorkflow(OLD_SHA),
        },
      },
    });

    expect(await syncRepo(context(run), "acme/acme-books-skill")).toMatchObject(
      { kind: "synced", pin: { refs: [OLD_SHA], status: "behind" } },
    );
    expect(commands[3]).toEqual([
      "git",
      "add",
      "--",
      "bunfig.toml",
      CALLER_WORKFLOW,
    ]);
  });

  test("moves the pin when scripts/ changed since it, even with every file matching", async () => {
    const { run, commands } = fakeGitHub({
      "acme/acme-books-skill": {
        files: {
          "package.json": PROSE_PACKAGE,
          ...(await syncedFiles("prose")),
          [CALLER_WORKFLOW]: callerWorkflow(OLD_SHA),
        },
      },
    });

    expect(
      await syncRepo(
        context(run, TOKEN, SCRIPTS_CHANGED),
        "acme/acme-books-skill",
      ),
    ).toMatchObject({
      kind: "synced",
      files: [],
      pin: { refs: [OLD_SHA], status: "changed" },
      action: "opened",
    });
    expect(commands[3]).toEqual(["git", "add", "--", CALLER_WORKFLOW]);
    expect(flagValue(commands[6] ?? [], "--body")).toContain(
      `- \`.github/workflows/ci.yml\` pins \`fleet-ci.yml\` to \`${HUB_SHA}\` (was \`5291614\`)`,
    );
  });

  test("updates the open pull request on the same branch and closes older ones", async () => {
    const current = {
      number: 5,
      headRefName: branchName(HUB_SHA),
      url: "https://github.com/acme/acme-books-tools/pull/5",
    };
    const older = {
      number: 2,
      headRefName: "fleet-sync/0000000",
      url: "https://github.com/acme/acme-books-tools/pull/2",
    };
    const { run, commands } = fakeGitHub({
      "acme/acme-books-tools": {
        files: {
          "package.json": CODE_PACKAGE,
          ...(await syncedFiles("code")),
          "tsconfig.json": "{}\n",
        },
        pullRequests: [
          current,
          older,
          {
            number: 9,
            headRefName: "feature/other",
            url: "https://example.com/9",
          },
        ],
      },
    });

    expect(await syncRepo(context(run), "acme/acme-books-tools")).toMatchObject(
      {
        kind: "synced",
        profile: "code",
        action: "updated",
        url: current.url,
        closed: [older],
      },
    );
    expect(shown(commands).slice(-2)).toEqual(["gh pr edit", "gh pr close"]);
    expect(shown(commands)).not.toContain("gh pr create");
    expect(commands.at(-1)).toContain(`Superseded by ${current.url}.`);
    expect(commands.at(-1)).toContain("2");
  });

  test("reports a failed clone without the token", async () => {
    const { run } = fakeGitHub({});
    const outcome = await syncRepo(context(run), "acme/gone");

    expect(outcome.kind).toBe("failed");
    expect(JSON.stringify(outcome)).not.toContain(TOKEN);
    expect(JSON.stringify(outcome)).toContain("x-access-token:***@github.com");
  });
});

describe("outcomeLines", () => {
  const synced: RepoOutcome = {
    kind: "synced",
    profile: "prose",
    files: [
      {
        target: "bunfig.toml",
        source: "shared/bunfig.toml",
        status: "drifted",
      },
    ],
    pin: { refs: [HUB_SHA], status: "same" },
    action: "opened",
    url: "https://github.com/acme/acme-books-skill/pull/7",
    closed: [],
  };

  test("names the files and the pull request", () => {
    expect(outcomeLines("acme/acme-books-skill", synced, false)).toEqual([
      "acme/acme-books-skill drifts from the prose profile in 1 file (bunfig.toml). Opened https://github.com/acme/acme-books-skill/pull/7.",
    ]);
  });

  test("says what a dry run would do", () => {
    expect(outcomeLines("acme/acme-books-skill", synced, true)).toEqual([
      "acme/acme-books-skill drifts from the prose profile in 1 file (bunfig.toml). Would open a draft pull request.",
    ]);
  });

  test("says why the pin moves", () => {
    const line = (
      files: typeof synced.files,
      status: "changed" | "unknown" | "behind",
    ) =>
      outcomeLines(
        "acme/acme-books-skill",
        { ...synced, files, pin: { refs: [OLD_SHA], status } },
        true,
      );

    expect(line([], "changed")).toEqual([
      `acme/acme-books-skill matches the prose profile, and .github/workflows/ci.yml pins fleet-ci.yml to ${OLD_SHA}, older than a change to .github/workflows/fleet-ci.yml or scripts. Would open a draft pull request.`,
    ]);
    expect(line([], "unknown")[0]).toContain(
      "which is not the full SHA of a hub commit.",
    );
    expect(line(synced.files, "behind")).toEqual([
      `acme/acme-books-skill drifts from the prose profile in 1 file (bunfig.toml), and .github/workflows/ci.yml pins fleet-ci.yml to ${OLD_SHA}, which moves with the files. Would open a draft pull request.`,
    ]);
  });

  test("prints a notice for a repository that has not adopted the standard", () => {
    expect(
      outcomeLines("acme/acme-books-skill", { kind: "not-adopted" }, false),
    ).toEqual([
      "::notice::acme/acme-books-skill has no package.json, so it has not adopted the fleet standard. Skipped.",
    ]);
  });
});

describe("dryRunner", () => {
  test("prints every command that writes to GitHub instead of running it", async () => {
    const { run, commands } = fakeGitHub({});
    const output = captureOutput();

    try {
      const dry = dryRunner(run);

      expect((await dry(["gh", "pr", "list", "--repo", "acme/a"])).stdout).toBe(
        "[]",
      );
      await dry(["gh", "pr", "create", "--title", "Sync it"], workDir);
      await dry(["git", "push", "--quiet", "origin", "HEAD"], workDir);
      await dry(HUB_COMMIT_COMMAND);

      expect(commands).toEqual([HUB_COMMIT_COMMAND]);
      expect(output.logged()).toEqual([
        "  would run: gh pr list --repo acme/a",
        "  would run: gh pr create --title 'Sync it'",
        "  would run: git push --quiet origin HEAD",
      ]);
    } finally {
      output.restore();
    }
  });
});

async function hubWith(repos: string[]): Promise<string> {
  return gitRepo({
    ".claude-plugin/marketplace.json": JSON.stringify({
      name: "acme",
      owner: { name: "Acme Books" },
      plugins: repos.map((repo, index) => ({
        name: `plugin-${index}`,
        description: "Reads Acme Books catalogs.",
        source: { source: "github", repo },
      })),
    }),
  });
}

describe("main", () => {
  test.each<[string, Record<string, string>]>([
    ["missing", {}],
    ["empty", { GH_TOKEN: "" }],
    ["blank", { GH_TOKEN: "  " }],
  ])(
    "fails with one line naming the secret when the token is %s",
    async (_case, env) => {
      const { run, commands } = fakeGitHub({});
      const output = captureOutput();

      try {
        expect(await main([], { run, env })).toBe(1);
        expect(output.errors()).toEqual([
          "::error::The FLEET_SYNC_TOKEN secret is missing or empty. Add a fine-grained token with contents, pull requests and workflows write access on the plugin repositories as the repository secret FLEET_SYNC_TOKEN.",
        ]);
        expect(commands).toEqual([]);
      } finally {
        output.restore();
      }
    },
  );

  test("goes through every listed repository and fails when one fails", async () => {
    const hub = await hubWith([
      "acme/acme-books-skill",
      "acme/gone",
      "acme/acme-books-tools",
    ]);
    const { run } = fakeGitHub({
      "acme/acme-books-skill": { files: { "README.md": "# Acme\n" } },
      "acme/acme-books-tools": {
        files: { "package.json": CODE_PACKAGE, ...(await syncedFiles("code")) },
      },
    });
    const output = captureOutput();

    try {
      expect(
        await main([], { run, env: { GH_TOKEN: TOKEN }, hubRoot: hub }),
      ).toBe(1);
      expect(output.logged()).toEqual([
        "::notice::acme/acme-books-skill has no package.json, so it has not adopted the fleet standard. Skipped.",
        "acme/acme-books-tools matches the code profile.",
      ]);
      expect(output.errors()).toHaveLength(1);
      expect(output.errors()[0]).toStartWith("::error::acme/gone: git clone");
      expect(output.errors()[0]).not.toContain(TOKEN);
    } finally {
      output.restore();
      await rm(hub, { recursive: true, force: true });
    }
  });

  test("--repository runs one listed repository, and an empty value runs them all", async () => {
    const hub = await hubWith([
      "acme/acme-books-skill",
      "acme/acme-audit-skill",
    ]);
    const { run, commands } = fakeGitHub({
      "acme/acme-books-skill": { files: {} },
      "acme/acme-audit-skill": { files: {} },
    });
    const output = captureOutput();
    const clones = () =>
      commands.filter(([, subcommand]) => subcommand === "clone").length;

    try {
      expect(
        await main(["--repository", "acme/acme-audit-skill"], {
          run,
          env: { GH_TOKEN: TOKEN },
          hubRoot: hub,
        }),
      ).toBe(0);
      expect(clones()).toBe(1);

      expect(
        await main(["--repository", ""], {
          run,
          env: { GH_TOKEN: TOKEN },
          hubRoot: hub,
        }),
      ).toBe(0);
      expect(clones()).toBe(3);
    } finally {
      output.restore();
      await rm(hub, { recursive: true, force: true });
    }
  });

  test("diffs fleet-ci.yml and scripts/ in the hub checkout since each pin", async () => {
    const hub = await hubWith(["acme/acme-books-skill"]);
    const member = {
      files: {
        "package.json": PROSE_PACKAGE,
        ...(await syncedFiles("prose")),
        [CALLER_WORKFLOW]: callerWorkflow(OLD_SHA),
      },
    };
    const output = captureOutput();

    try {
      const docsOnly = fakeGitHub({ "acme/acme-books-skill": member });

      expect(
        await main([], {
          run: docsOnly.run,
          env: { GH_TOKEN: TOKEN },
          hubRoot: hub,
        }),
      ).toBe(0);
      expect(
        docsOnly.commands.find(([, subcommand]) => subcommand === "diff"),
      ).toEqual([
        "git",
        "diff",
        "--quiet",
        `${OLD_SHA}..HEAD`,
        "--",
        ".github/workflows/fleet-ci.yml",
        "scripts",
        ":!scripts/*.test.ts",
      ]);
      expect(output.logged().at(-1)).toBe(
        "acme/acme-books-skill matches the prose profile.",
      );

      const scriptsChanged = fakeGitHub(
        { "acme/acme-books-skill": member },
        { workflowDiffExitCode: 1 },
      );

      expect(
        await main([], {
          run: scriptsChanged.run,
          env: { GH_TOKEN: TOKEN },
          hubRoot: hub,
        }),
      ).toBe(0);
      expect(output.logged().at(-1)).toStartWith(
        `acme/acme-books-skill matches the prose profile, and .github/workflows/ci.yml pins fleet-ci.yml to ${OLD_SHA}, older than a change`,
      );
    } finally {
      output.restore();
      await rm(hub, { recursive: true, force: true });
    }
  });

  test("refuses a repository the marketplace does not list", async () => {
    const hub = await hubWith(["acme/acme-books-skill"]);
    const { run, commands } = fakeGitHub({});
    const output = captureOutput();

    try {
      expect(
        await main(["--repository", "acme/other"], {
          run,
          env: { GH_TOKEN: TOKEN },
          hubRoot: hub,
        }),
      ).toBe(2);
      expect(output.errors()).toEqual([
        "::error::acme/other is not a plugin repository in the marketplace. Pass one of: acme/acme-books-skill.",
      ]);
      expect(commands).toEqual([]);
    } finally {
      output.restore();
      await rm(hub, { recursive: true, force: true });
    }
  });

  test("--dry-run needs no token, clones anonymously and never pushes or calls gh", async () => {
    const hub = await hubWith(["acme/acme-books-skill"]);
    const { run, commands } = fakeGitHub({
      "acme/acme-books-skill": { files: { "package.json": PROSE_PACKAGE } },
    });
    const output = captureOutput();

    try {
      expect(await main(["--dry-run"], { run, env: {}, hubRoot: hub })).toBe(0);
      expect(
        commands.find(([, subcommand]) => subcommand === "clone"),
      ).toContain("https://github.com/acme/acme-books-skill.git");
      expect(commands.some(([program]) => program === "gh")).toBe(false);
      expect(commands.some((command) => command.includes("push"))).toBe(false);
      expect(output.logged().at(-1)).toStartWith(
        "acme/acme-books-skill drifts from the prose profile in 6 files",
      );
      expect(output.logged().at(-1)).toEndWith(
        "Would open a draft pull request.",
      );
    } finally {
      output.restore();
      await rm(hub, { recursive: true, force: true });
    }
  });
});

describe("with real git", () => {
  test("pushes the synced files and the moved pin to the fleet-sync branch of the remote", async () => {
    const remote = await gitRepo({
      "package.json": PROSE_PACKAGE,
      "README.md": "# Acme\n",
      [CALLER_WORKFLOW]: callerWorkflow(OLD_SHA),
    });
    const git = (...args: string[]) =>
      Bun.spawnSync(
        [
          "git",
          "-c",
          "user.name=Acme",
          "-c",
          "user.email=acme@example.com",
          ...args,
        ],
        {
          cwd: remote,
        },
      );

    git("add", ".");
    git("commit", "--quiet", "-m", "Start");
    // Pushing to the checked-out branch of a non-bare remote is refused,
    // so the remote stays on a detached head.
    git("checkout", "--quiet", "--detach");

    const viaLocalRemote: CommandRunner = (command, cwd) => {
      if (command[0] === "gh") {
        return Promise.resolve({
          exitCode: 0,
          stdout:
            command[2] === "list"
              ? "[]"
              : "https://github.com/acme/acme-books-skill/pull/1\n",
          stderr: "",
        });
      }

      return spawnRunner(
        command.map((part) =>
          part === cloneUrl("acme/acme-books-skill", TOKEN)
            ? `file://${remote}`
            : part,
        ),
        cwd,
      );
    };

    try {
      const outcome = await syncRepo(
        context(viaLocalRemote),
        "acme/acme-books-skill",
      );

      expect(outcome).toMatchObject({ kind: "synced", action: "opened" });

      const pushed = Bun.spawnSync(
        ["git", "ls-tree", "-r", "--name-only", "fleet-sync/abc1234"],
        { cwd: remote },
      );
      const subject = Bun.spawnSync(
        ["git", "log", "-1", "--format=%s%n%an", "fleet-sync/abc1234"],
        { cwd: remote },
      );

      expect(
        pushed.stdout.toString().split("\n").filter(Boolean).toSorted(),
      ).toEqual(
        [
          "README.md",
          "package.json",
          CALLER_WORKFLOW,
          ...FLEET_FILES.prose.map(({ target }) => target),
        ].toSorted(),
      );
      expect(
        Bun.spawnSync(
          ["git", "show", `fleet-sync/abc1234:${CALLER_WORKFLOW}`],
          { cwd: remote },
        ).stdout.toString(),
      ).toBe(
        callerWorkflow(HUB_SHA).replace(
          "# fleet-ci 2026-10-01",
          "# fleet-ci 2026-11-01",
        ),
      );
      expect(subject.stdout.toString()).toBe(
        "Sync the fleet config files to abc1234\ngithub-actions[bot]\n",
      );
    } finally {
      await rm(remote, { recursive: true, force: true });
    }
  });
});
