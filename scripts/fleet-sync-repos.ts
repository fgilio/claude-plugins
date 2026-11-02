#!/usr/bin/env bun

// Checks every plugin repository the marketplace lists against fleet/ and
// the hub's commit, and opens one draft pull request in each repository
// that drifted. The fleet-sync workflow runs it once a month.
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
  CALLER_WORKFLOW,
  FLEET_CI_PATHS,
  FLEET_DIR,
  type FileSyncStatus,
  type FleetCiPin,
  HUB_COMMIT_COMMAND,
  HUB_REPO,
  HUB_ROOT,
  type HubCommit,
  type Profile,
  type WorkflowHistory,
  compareFleetCiPin,
  compareWithFleet,
  parseHubCommit,
  shellQuote,
  olderRefs,
  shouldMovePin,
  syncWithFleet,
  workflowChange,
  workflowDiffCommand,
  writeFleetCiPin,
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
      pin: FleetCiPin;
      action: "opened" | "updated";
      url: string;
      closed: OpenPullRequest[];
    }
  | { kind: "failed"; message: string };

export interface SyncContext {
  run: CommandRunner;
  /** Undefined in a dry run, which clones anonymously. */
  token: string | undefined;
  hub: HubCommit;
  /** Reads the hub checkout, which needs the history back to each pin. */
  workflowHistory: WorkflowHistory;
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

export interface DriftPullRequest {
  repo: string;
  hub: HubCommit;
  profile: Profile;
  /** The fleet files that differ, each copied byte-identical. */
  files: FileSyncStatus[];
  pin: FleetCiPin;
}

/** The sync moves the pin when it is stale, or behind with drifted files. */
export function movesPin({
  files,
  pin,
}: Pick<DriftPullRequest, "files" | "pin">): boolean {
  return shouldMovePin(pin, files.length > 0);
}

const short = (sha: string) => sha.slice(0, 7);

/** One bullet per file the sync changes, shared by the commit and the body. */
export function changeLines({
  hub,
  files,
  pin,
}: Pick<DriftPullRequest, "hub" | "files" | "pin">): string[] {
  return [
    ...files.map(
      ({ target, source, status }) =>
        `- \`${target}\` ${status === "missing" ? "added from" : "updated to"} \`fleet/${source}\``,
    ),
    ...(movesPin({ files, pin })
      ? [
          `- \`${CALLER_WORKFLOW}\` pins \`fleet-ci.yml\` to \`${hub.sha}\` (was ${olderRefs(
            pin,
            hub.sha,
          )
            .map((ref) => `\`${ref === "" ? "(empty)" : short(ref)}\``)
            .join(", ")})`,
        ]
      : []),
  ];
}

/** The pull request body, in the sections of the fleet's PR template. */
export function pullRequestBody(drift: DriftPullRequest): string {
  const { repo, hub, profile, files, pin } = drift;
  const hubCommit = `[${HUB_REPO}@${short(hub.sha)}](https://github.com/${HUB_REPO}/commit/${hub.sha})`;
  const isPinMoved = movesPin(drift);
  const pinReasons: Record<FleetCiPin["status"], string> = {
    changed: `\`${CALLER_WORKFLOW}\` runs \`fleet-ci.yml\` from an older hub commit, and ${FLEET_CI_PATHS.map((path) => `\`${path}\``).join(" or ")} changed since, so CI checks this repository with older checks than its files follow.`,
    unknown: `\`${CALLER_WORKFLOW}\` pins \`fleet-ci.yml\` to a ref that is not the full SHA of a hub commit.`,
    behind: `The \`fleet-ci.yml\` pin in \`${CALLER_WORKFLOW}\` moves to the same commit as the files, so CI runs the checks of the commit they come from.`,
    same: "",
    unpinned: "",
  };
  const reasons = [
    ...(files.length > 0
      ? [
          files.length === 1
            ? `One config file of the ${profile} profile differs from its canonical copy in the hub.`
            : `${files.length} config files of the ${profile} profile differ from their canonical copies in the hub.`,
        ]
      : []),
    ...(isPinMoved ? [pinReasons[pin.status]] : []),
  ];

  return [
    "## Summary",
    "",
    `Syncs this repository with the fleet standard at ${hubCommit}, ${profile} profile.`,
    "",
    "## Why",
    "",
    reasons.join(" "),
    "",
    `The monthly fleet-sync workflow in ${HUB_REPO} opened this pull request and updates it on each run. Review it like any other change. If a file here must differ from the fleet, change the standard in the hub instead.`,
    "",
    "## Changes",
    "",
    ...changeLines(drift),
    ...(files.length > 0
      ? [
          "",
          `Each file is a byte-identical copy of its canonical file in \`fleet/\` at ${short(hub.sha)}.`,
        ]
      : []),
    "",
    "## Testing",
    "",
    `From a checkout of the hub at ${short(hub.sha)}, with this branch checked out next to it:`,
    "",
    "```bash",
    `bun scripts/fleet-sync.ts ../${repo.split("/").at(-1) ?? repo} --profile ${profile} --check`,
    "```",
    "",
    `This repository's CI on this pull request is the proof: it runs the fleet's checks ${isPinMoved ? "from the newly pinned hub commit " : ""}against the synced files.`,
  ].join("\n");
}

/** The commit message body: the hub commit and the changes, without Markdown sections. */
export function commitBody(drift: DriftPullRequest): string {
  return [
    `Syncs the ${drift.profile} profile with ${HUB_REPO}@${drift.hub.sha}.`,
    "",
    ...changeLines(drift),
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
    const pin = await compareFleetCiPin(
      clone,
      context.hub.sha,
      context.workflowHistory,
    );
    const open = await openSyncPullRequests(context, repo, clone);

    const drift = { repo, hub: context.hub, profile, files, pin };

    if (files.length === 0 && !movesPin(drift)) {
      await closePullRequests(
        context,
        repo,
        clone,
        open,
        `The default branch matches the fleet config files at ${HUB_REPO}@${context.hub.sha}.`,
      );

      return { kind: "in-sync", profile, closed: open };
    }

    const branch = branchName(context.hub.sha);
    const title = pullRequestTitle(context.hub.sha);
    const body = pullRequestBody(drift);

    await syncWithFleet(clone, profile, context.fleetDir);

    if (movesPin(drift)) {
      await writeFleetCiPin(clone, context.hub);
    }

    await runOrThrow(
      context,
      ["git", "switch", "--quiet", "--create", branch],
      clone,
    );
    await runOrThrow(
      context,
      [
        "git",
        "add",
        "--",
        ...files.map(({ target }) => target),
        ...(movesPin(drift) ? [CALLER_WORKFLOW] : []),
      ],
      clone,
    );
    await runOrThrow(
      context,
      [
        "git",
        ...COMMIT_AUTHOR,
        "commit",
        "--quiet",
        "-m",
        title,
        "-m",
        commitBody(drift),
      ],
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
      pin,
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

  const { profile, files, pin } = outcome;
  const targets = files.map(({ target }) => target).join(", ");
  const fileDrift =
    files.length === 0
      ? `matches the ${profile} profile`
      : `drifts from the ${profile} profile in ${files.length} ${files.length === 1 ? "file" : "files"} (${targets})`;
  const pinned = `${CALLER_WORKFLOW} pins fleet-ci.yml to ${pin.refs.join(", ")}`;
  const pinReasons: Record<FleetCiPin["status"], string> = {
    changed: `, and ${pinned}, older than a change to ${FLEET_CI_PATHS.join(" or ")}`,
    unknown: `, and ${pinned}, which is not the full SHA of a hub commit`,
    behind: `, and ${pinned}, which moves with the files`,
    same: "",
    unpinned: "",
  };
  const pinDrift = movesPin(outcome) ? pinReasons[pin.status] : "";
  const action = dryRun
    ? `Would ${outcome.action === "opened" ? "open a draft pull request" : `update ${outcome.url}`}`
    : `${outcome.action === "opened" ? "Opened" : "Updated"} ${outcome.url}`;

  return [
    `${repo} ${fileDrift}${pinDrift}. ${action}.`,
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
      `::error::The ${TOKEN_SECRET} secret is missing or empty. Add a fine-grained token with contents, pull requests and workflows write access on the plugin repositories as the repository secret ${TOKEN_SECRET}.`,
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

  const hubHead = await run(HUB_COMMIT_COMMAND, hubRoot);
  const hub =
    hubHead.exitCode === 0 ? parseHubCommit(hubHead.stdout) : undefined;

  if (hub === undefined) {
    console.error(
      `::error::Unable to read the hub's commit with ${HUB_COMMIT_COMMAND.join(" ")} in ${hubRoot}: ${hubHead.stderr.trim() || hubHead.stdout.trim()}`,
    );

    return 1;
  }

  const context: SyncContext = {
    run: dryRun ? dryRunner(run) : run,
    token: dryRun ? undefined : token,
    hub,
    workflowHistory: async (ref) =>
      workflowChange((await run(workflowDiffCommand(ref), hubRoot)).exitCode),
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
