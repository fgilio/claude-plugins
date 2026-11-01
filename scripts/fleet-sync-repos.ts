#!/usr/bin/env bun

// Checks every plugin repository the marketplace lists against fleet/ and
// opens one draft pull request in each repository that drifted. The
// fleet-sync workflow runs it once a month.
//
// Usage: bun scripts/fleet-sync-repos.ts [--repository owner/name] [--dry-run]
// GH_TOKEN holds a token that can push and open pull requests in the plugin
// repositories. --dry-run needs no token: it clones anonymously and prints
// the push and the gh commands instead of running them.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import {
  FLEET_DIR,
  type FileSyncStatus,
  type Profile,
  compareWithFleet,
  shellQuote,
  syncWithFleet,
} from "./fleet-sync";
import { pluginRepos, readMarketplace } from "./marketplace";

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  command: string[],
  cwd?: string,
) => Promise<CommandResult>;

export const BRANCH_PREFIX = "fleet-sync/";

export const TOKEN_SECRET = "FLEET_SYNC_TOKEN";

const HUB_ROOT = join(import.meta.dir, "..");

const HUB_REPO = "fgilio/claude-plugins";

const COMMIT_AUTHOR = [
  "-c",
  "user.name=github-actions[bot]",
  "-c",
  "user.email=41898282+github-actions[bot]@users.noreply.github.com",
];

interface OpenPullRequest {
  number: number;
  headRefName: string;
  url: string;
}

export type RepoOutcome =
  | { kind: "not-adopted" }
  | { kind: "in-sync"; profile: Profile; closed: OpenPullRequest[] }
  | {
      kind: "synced";
      profile: Profile;
      files: FileSyncStatus[];
      action: "opened" | "updated";
      url: string;
      closed: OpenPullRequest[];
    }
  | { kind: "failed"; message: string };

export interface SyncContext {
  run: CommandRunner;
  /** Undefined in a dry run, which clones anonymously. */
  token: string | undefined;
  hubSha: string;
  workDir: string;
  fleetDir: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The fleet profile a repository's package.json asks for: code when it
 * installs TypeScript, prose otherwise.
 */
export function profileOf(packageJson: unknown): Profile {
  const devDependencies = isRecord(packageJson)
    ? packageJson["devDependencies"]
    : undefined;

  return isRecord(devDependencies) && "typescript" in devDependencies
    ? "code"
    : "prose";
}

export function cloneUrl(repo: string, token: string | undefined): string {
  return token === undefined
    ? `https://github.com/${repo}.git`
    : `https://x-access-token:${token}@github.com/${repo}.git`;
}

export function branchName(hubSha: string): string {
  return `${BRANCH_PREFIX}${hubSha.slice(0, 7)}`;
}

export function pullRequestTitle(hubSha: string): string {
  return `Sync the fleet config files to ${hubSha.slice(0, 7)}`;
}

export function pullRequestBody(
  hubSha: string,
  profile: Profile,
  files: FileSyncStatus[],
): string {
  return [
    `Copies the ${profile} profile's config files from ${HUB_REPO}@${hubSha}, byte-identical.`,
    "",
    ...files.map(
      ({ target, source, status }) =>
        `- \`${target}\` ${status === "missing" ? "added from" : "updated to"} \`fleet/${source}\``,
    ),
    "",
    `The monthly fleet-sync workflow in ${HUB_REPO} opened this pull request and updates it on each run. Review it like any other change. If a file here must differ from the fleet, change the standard in the hub instead.`,
  ].join("\n");
}

/**
 * Replaces every copy of the token in a command's output, so an error
 * message never prints it.
 */
export function redact(text: string, token: string | undefined): string {
  return token === undefined || token === ""
    ? text
    : text.replaceAll(token, "***");
}

async function runOrThrow(
  context: SyncContext,
  command: string[],
  cwd?: string,
): Promise<string> {
  const { exitCode, stdout, stderr } = await context.run(command, cwd);

  if (exitCode !== 0) {
    const shown = command.map((part) => redact(part, context.token));

    throw new Error(
      `${shown.join(" ")} exited with ${exitCode}: ${redact(stderr.trim() || stdout.trim(), context.token)}`,
    );
  }

  return stdout;
}

async function openSyncPullRequests(
  context: SyncContext,
  repo: string,
  clone: string,
): Promise<OpenPullRequest[]> {
  const listed: unknown = JSON.parse(
    await runOrThrow(
      context,
      [
        "gh",
        "pr",
        "list",
        "--repo",
        repo,
        "--state",
        "open",
        "--limit",
        "100",
        "--json",
        "number,headRefName,url,isCrossRepository",
      ],
      clone,
    ),
  );

  if (!Array.isArray(listed)) {
    throw new TypeError(`gh pr list for ${repo} did not print a JSON list.`);
  }

  return listed.flatMap((pullRequest: unknown) => {
    if (!isRecord(pullRequest)) {
      return [];
    }

    const { number, headRefName, url, isCrossRepository } = pullRequest;

    return typeof number === "number" &&
      typeof headRefName === "string" &&
      typeof url === "string" &&
      isCrossRepository !== true &&
      headRefName.startsWith(BRANCH_PREFIX)
      ? [{ number, headRefName, url }]
      : [];
  });
}

async function closePullRequests(
  context: SyncContext,
  repo: string,
  clone: string,
  pullRequests: OpenPullRequest[],
  comment: string,
): Promise<void> {
  await Promise.all(
    pullRequests.map(({ number }) =>
      runOrThrow(
        context,
        [
          "gh",
          "pr",
          "close",
          String(number),
          "--repo",
          repo,
          "--delete-branch",
          "--comment",
          comment,
        ],
        clone,
      ),
    ),
  );
}

async function readPackageJson(clone: string): Promise<unknown> {
  const file = Bun.file(join(clone, "package.json"));

  return (await file.exists()) ? file.json() : undefined;
}

/**
 * Clones one repository, compares it with fleet/ for the profile its
 * package.json asks for, and when it drifted pushes the synced files to
 * fleet-sync/<hub short SHA> and opens a draft pull request, or updates
 * the one open on that branch. Older fleet-sync pull requests close, so a
 * repository never has more than one open.
 */
export async function syncRepo(
  context: SyncContext,
  repo: string,
): Promise<RepoOutcome> {
  const clone = join(context.workDir, repo.replace("/", "__"));

  try {
    await runOrThrow(context, [
      "git",
      "clone",
      "--quiet",
      "--depth",
      "1",
      cloneUrl(repo, context.token),
      clone,
    ]);

    const packageJson = await readPackageJson(clone);

    if (packageJson === undefined) {
      return { kind: "not-adopted" };
    }

    const profile = profileOf(packageJson);
    const files = (
      await compareWithFleet(clone, profile, context.fleetDir)
    ).filter(({ status }) => status !== "same");
    const open = await openSyncPullRequests(context, repo, clone);

    if (files.length === 0) {
      await closePullRequests(
        context,
        repo,
        clone,
        open,
        `The default branch matches the fleet config files at ${HUB_REPO}@${context.hubSha}.`,
      );

      return { kind: "in-sync", profile, closed: open };
    }

    const branch = branchName(context.hubSha);
    const title = pullRequestTitle(context.hubSha);
    const body = pullRequestBody(context.hubSha, profile, files);

    await syncWithFleet(clone, profile, context.fleetDir);
    await runOrThrow(
      context,
      ["git", "switch", "--quiet", "--create", branch],
      clone,
    );
    await runOrThrow(
      context,
      ["git", "add", "--", ...files.map(({ target }) => target)],
      clone,
    );
    await runOrThrow(
      context,
      ["git", ...COMMIT_AUTHOR, "commit", "--quiet", "-m", title, "-m", body],
      clone,
    );
    // The routine owns fleet-sync/* branches and rebuilds them from the
    // default branch on every run.
    await runOrThrow(
      context,
      [
        "git",
        "push",
        "--quiet",
        "--force",
        "origin",
        `HEAD:refs/heads/${branch}`,
      ],
      clone,
    );

    const current = open.find(({ headRefName }) => headRefName === branch);
    let url: string;

    if (current === undefined) {
      url = (
        await runOrThrow(
          context,
          [
            "gh",
            "pr",
            "create",
            "--repo",
            repo,
            "--draft",
            "--head",
            branch,
            "--title",
            title,
            "--body",
            body,
          ],
          clone,
        )
      ).trim();
    } else {
      await runOrThrow(
        context,
        [
          "gh",
          "pr",
          "edit",
          String(current.number),
          "--repo",
          repo,
          "--title",
          title,
          "--body",
          body,
        ],
        clone,
      );
      url = current.url;
    }

    const superseded = open.filter(({ headRefName }) => headRefName !== branch);

    await closePullRequests(
      context,
      repo,
      clone,
      superseded,
      `Superseded by ${url}.`,
    );

    return {
      kind: "synced",
      profile,
      files,
      action: current === undefined ? "opened" : "updated",
      url,
      closed: superseded,
    };
  } catch (error) {
    return {
      kind: "failed",
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await rm(clone, { recursive: true, force: true });
  }
}

/**
 * The lines a repository's outcome prints. Notices and errors use GitHub
 * workflow commands, so the run summary shows them.
 */
export function outcomeLines(
  repo: string,
  outcome: RepoOutcome,
  dryRun: boolean,
): string[] {
  const closedLines = (closed: OpenPullRequest[]) =>
    closed.map(
      ({ url }) => `${repo}: ${dryRun ? "would close" : "closed"} ${url}`,
    );

  if (outcome.kind === "failed") {
    return [`::error::${repo}: ${outcome.message}`];
  }

  if (outcome.kind === "not-adopted") {
    return [
      `::notice::${repo} has no package.json, so it has not adopted the fleet standard. Skipped.`,
    ];
  }

  if (outcome.kind === "in-sync") {
    return [
      `${repo} matches the ${outcome.profile} profile.`,
      ...closedLines(outcome.closed),
    ];
  }

  const targets = outcome.files.map(({ target }) => target).join(", ");
  const action = dryRun
    ? `Would ${outcome.action === "opened" ? "open a draft pull request" : `update ${outcome.url}`}`
    : `${outcome.action === "opened" ? "Opened" : "Updated"} ${outcome.url}`;

  return [
    `${repo} drifts from the ${outcome.profile} profile in ${outcome.files.length} ${outcome.files.length === 1 ? "file" : "files"} (${targets}). ${action}.`,
    ...closedLines(outcome.closed),
  ];
}

export const spawnRunner: CommandRunner = async (command, cwd) => {
  const child = Bun.spawn(command, {
    ...(cwd === undefined ? {} : { cwd }),
    stdout: "pipe",
    stderr: "pipe",
    // A rejected token fails the clone instead of waiting for a password.
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  return { exitCode, stdout, stderr };
};

/**
 * Wraps a runner so every command that writes to GitHub (a push and any
 * gh call) prints instead of running. Clones and local git commands still
 * run, so the report reflects each repository as it is.
 */
export function dryRunner(run: CommandRunner): CommandRunner {
  return async (command, cwd) => {
    const [program, subcommand, action] = command;
    const writesToGitHub =
      program === "gh" || (program === "git" && command.includes("push"));

    if (!writesToGitHub) {
      return run(command, cwd);
    }

    console.log(`  would run: ${command.map(shellQuote).join(" ")}`);

    const stdout =
      subcommand === "pr" && action === "list"
        ? "[]"
        : subcommand === "pr" && action === "create"
          ? "(new pull request)"
          : "";

    return { exitCode: 0, stdout, stderr: "" };
  };
}

const USAGE =
  "Usage: bun scripts/fleet-sync-repos.ts [--repository owner/name] [--dry-run]";

export interface MainOptions {
  run?: CommandRunner;
  env?: Record<string, string | undefined>;
  hubRoot?: string;
  fleetDir?: string;
}

export async function main(
  argv: string[],
  {
    run = spawnRunner,
    env = process.env,
    hubRoot = HUB_ROOT,
    fleetDir = FLEET_DIR,
  }: MainOptions = {},
): Promise<number> {
  let parsed;

  try {
    parsed = parseArgs({
      args: argv,
      options: {
        repository: { type: "string" },
        "dry-run": { type: "boolean", default: false },
      },
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(USAGE);

    return 2;
  }

  const dryRun = parsed.values["dry-run"];
  const token = env["GH_TOKEN"]?.trim();

  if (!dryRun && (token === undefined || token === "")) {
    console.error(
      `::error::The ${TOKEN_SECRET} secret is missing or empty. Add a fine-grained token with contents and pull requests write access on the plugin repositories as the repository secret ${TOKEN_SECRET}.`,
    );

    return 1;
  }

  const listed = pluginRepos(await readMarketplace(hubRoot));
  // The workflow passes an empty string when its repository input is blank.
  const only = parsed.values.repository?.trim() || undefined;

  if (only !== undefined && !listed.includes(only)) {
    console.error(
      `::error::${only} is not a plugin repository in the marketplace. Pass one of: ${listed.join(", ")}.`,
    );

    return 2;
  }

  const hubHead = await run(["git", "rev-parse", "HEAD"], hubRoot);

  if (hubHead.exitCode !== 0) {
    console.error(
      `::error::Unable to read the hub's commit with git rev-parse HEAD in ${hubRoot}: ${hubHead.stderr.trim()}`,
    );

    return 1;
  }

  const context: SyncContext = {
    run: dryRun ? dryRunner(run) : run,
    token: dryRun ? undefined : token,
    hubSha: hubHead.stdout.trim(),
    workDir: await mkdtemp(join(tmpdir(), "fleet-sync-")),
    fleetDir,
  };
  let failed = 0;

  try {
    for (const repo of only === undefined ? listed : [only]) {
      // One repository at a time keeps each one's log lines together.
      // oxlint-disable-next-line eslint/no-await-in-loop
      const outcome = await syncRepo(context, repo);

      for (const line of outcomeLines(repo, outcome, dryRun)) {
        (outcome.kind === "failed" ? console.error : console.log)(line);
      }

      failed += outcome.kind === "failed" ? 1 : 0;
    }
  } finally {
    await rm(context.workDir, { recursive: true, force: true });
  }

  return failed > 0 ? 1 : 0;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
