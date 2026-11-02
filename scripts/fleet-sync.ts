#!/usr/bin/env bun

// Copies the fleet's config files from fleet/ into a repository,
// byte-identical, and moves its CI's fleet-ci.yml pin to the hub's commit,
// or with --check reports each file and pin that drifted.
//
// Usage: bun scripts/fleet-sync.ts <target-dir> --profile code|prose [--check]
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { parseArgs } from "node:util";

export const HUB_ROOT = join(import.meta.dir, "..");

export const FLEET_DIR = join(HUB_ROOT, "fleet");

export const HUB_REPO = "fgilio/claude-plugins";

/** The workflow in each repository that calls the hub's fleet-ci.yml. */
export const CALLER_WORKFLOW = ".github/workflows/ci.yml";

const FLEET_CI = `${HUB_REPO}/.github/workflows/fleet-ci.yml`;

const PROFILES = ["code", "prose"] as const;

export type Profile = (typeof PROFILES)[number];

export interface FleetFile {
  /** Where the file lives in the target repository. */
  target: string;
  /** Where the canonical copy lives under fleet/. */
  source: string;
}

export type SyncStatus = "same" | "drifted" | "missing";

export interface FileSyncStatus extends FleetFile {
  status: SyncStatus;
}

function filesFrom(directory: string, targets: string[]): FleetFile[] {
  return targets.map((target) => ({
    target,
    source: `${directory}/${target}`,
  }));
}

const SHARED_FILES = filesFrom("shared", [
  ".oxfmtrc.json",
  ".markdownlint-cli2.jsonc",
  "bunfig.toml",
  ".github/dependabot.yml",
  ".github/pull_request_template.md",
]);

export const FLEET_FILES: Record<Profile, FleetFile[]> = {
  prose: [...SHARED_FILES, ...filesFrom("prose", ["lefthook.yml"])],
  code: [
    ...SHARED_FILES,
    ...filesFrom("code", ["lefthook.yml", "tsconfig.json", ".oxlintrc.json"]),
  ],
};

export function isProfile(value: unknown): value is Profile {
  return PROFILES.some((profile) => profile === value);
}

export function syncStatus(
  canonical: Uint8Array,
  current: Uint8Array | null,
): SyncStatus {
  if (current === null) {
    return "missing";
  }

  return Buffer.from(canonical).equals(current) ? "same" : "drifted";
}

/**
 * Quotes a value for a POSIX shell when it holds anything beyond letters,
 * digits and _./-, so a printed command can be pasted as is.
 */
export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", "'\\''")}'`;
}

function syncCommand(targetDir: string, profile: Profile): string {
  const script = relative(
    process.cwd(),
    join(import.meta.dir, "fleet-sync.ts"),
  );

  return `bun ${shellQuote(script)} ${shellQuote(targetDir)} --profile ${profile}`;
}

/**
 * One line per file that differs from fleet/, each naming the command that
 * brings it back. Empty when the repository matches.
 */
export function driftReport(
  statuses: FileSyncStatus[],
  targetDir: string,
  profile: Profile,
): string[] {
  return statuses
    .filter(({ status }) => status !== "same")
    .map(
      ({ target, source, status }) =>
        `${target} ${status === "missing" ? "does not exist. Its canonical copy is" : "differs from"} fleet/${source}. Run: ${syncCommand(targetDir, profile)}`,
    );
}

async function readOrNull(path: string): Promise<Uint8Array | null> {
  const file = Bun.file(path);

  return (await file.exists()) ? file.bytes() : null;
}

export async function compareWithFleet(
  targetDir: string,
  profile: Profile,
  fleetDir = FLEET_DIR,
): Promise<FileSyncStatus[]> {
  return Promise.all(
    FLEET_FILES[profile].map(async ({ target, source }) => ({
      target,
      source,
      status: syncStatus(
        await Bun.file(join(fleetDir, source)).bytes(),
        await readOrNull(join(targetDir, target)),
      ),
    })),
  );
}

/**
 * Writes every file that differs from fleet/ and returns the statuses it
 * found before writing.
 */
export async function syncWithFleet(
  targetDir: string,
  profile: Profile,
  fleetDir = FLEET_DIR,
): Promise<FileSyncStatus[]> {
  const statuses = await compareWithFleet(targetDir, profile, fleetDir);

  await Promise.all(
    statuses
      .filter(({ status }) => status !== "same")
      .map(async ({ target, source }) => {
        const destination = join(targetDir, target);

        await mkdir(dirname(destination), { recursive: true });
        await Bun.write(destination, Bun.file(join(fleetDir, source)));
      }),
  );

  return statuses;
}

export interface HubCommit {
  /** The full 40-character SHA, as the actions SHA-pin rule requires. */
  sha: string;
  /** The committer date, YYYY-MM-DD, written next to the pin. */
  date: string;
}

/** Prints the hub's HEAD as parseHubCommit reads it. */
export const HUB_COMMIT_COMMAND = ["git", "log", "-1", "--format=%H%n%cs"];

export function parseHubCommit(stdout: string): HubCommit | undefined {
  const [sha = "", date = ""] = stdout.trim().split("\n");

  return /^[0-9a-f]{40}$/.test(sha) && /^\d{4}-\d{2}-\d{2}$/.test(date)
    ? { sha, date }
    : undefined;
}

export function readHubCommit(hubRoot = HUB_ROOT): HubCommit | undefined {
  const { exitCode, stdout } = Bun.spawnSync(HUB_COMMIT_COMMAND, {
    cwd: hubRoot,
  });

  return exitCode === 0 ? parseHubCommit(stdout.toString()) : undefined;
}

/**
 * Where the caller workflow pins fleet-ci.yml, against the hub's HEAD:
 *
 * - same: every call pins the hub commit.
 * - behind: an older hub commit, and neither fleet-ci.yml nor scripts/
 *   (test files aside) changed since, so CI already runs the current checks.
 * - changed: an older hub commit, and fleet-ci.yml or scripts/ changed since.
 * - unknown: a ref that is not the full SHA of a hub commit (a short SHA,
 *   a branch, a commit the hub does not have).
 * - unpinned: nothing calls fleet-ci.yml from the hub, as in the hub itself.
 */
export type PinStatus = "same" | "behind" | "changed" | "unknown" | "unpinned";

export interface FleetCiPin {
  /** Each ref the caller workflow pins fleet-ci.yml to, in file order. */
  refs: string[];
  status: PinStatus;
}

/** What fleet-ci.yml runs: the workflow and every script it may call. */
export const FLEET_CI_PATHS = [".github/workflows/fleet-ci.yml", "scripts"];

/** fleet-ci.yml never runs the hub's own tests, so they never move a pin. */
const FLEET_CI_EXCLUDED = [":!scripts/*.test.ts"];

export type WorkflowChange = "unchanged" | "changed" | "unknown";

/** How fleet-ci.yml and its scripts changed between a hub commit and HEAD. */
export type WorkflowHistory = (ref: string) => Promise<WorkflowChange>;

/** Exits 0 when FLEET_CI_PATHS match between ref and HEAD, 1 when not. */
export function workflowDiffCommand(ref: string): string[] {
  return [
    "git",
    "diff",
    "--quiet",
    `${ref}..HEAD`,
    "--",
    ...FLEET_CI_PATHS,
    ...FLEET_CI_EXCLUDED,
  ];
}

export function workflowChange(diffExitCode: number): WorkflowChange {
  if (diffExitCode === 0) {
    return "unchanged";
  }

  return diffExitCode === 1 ? "changed" : "unknown";
}

/**
 * Reads the hub's history, which must reach the pinned commits: a shallow
 * checkout reports every older pin as unknown.
 */
export function hubWorkflowHistory(hubRoot = HUB_ROOT): WorkflowHistory {
  return async (ref) =>
    workflowChange(
      await Bun.spawn(workflowDiffCommand(ref), {
        cwd: hubRoot,
        stdout: "ignore",
        stderr: "ignore",
      }).exited,
    );
}

const FLEET_CI_CALL =
  /^(\s*uses:\s*["']?)fgilio\/claude-plugins\/\.github\/workflows\/fleet-ci\.yml@([^\s"'#]*)(["']?)/;

function fleetCiCall(line: string) {
  const [, lead, ref, quote] = FLEET_CI_CALL.exec(line) ?? [];

  return lead === undefined || ref === undefined || quote === undefined
    ? undefined
    : { lead, ref, quote };
}

export function fleetCiRefs(workflow: string): string[] {
  return workflow.split("\n").flatMap((line) => fleetCiCall(line)?.ref ?? []);
}

const STATUS_BY_CHANGE: Record<WorkflowChange, PinStatus> = {
  unchanged: "behind",
  changed: "changed",
  unknown: "unknown",
};

/** The most urgent status first, so one ref decides for the whole file. */
const PIN_URGENCY: PinStatus[] = ["unknown", "changed", "behind", "same"];

export async function pinStatus(
  refs: string[],
  hubSha: string,
  history: WorkflowHistory,
): Promise<PinStatus> {
  if (refs.length === 0) {
    return "unpinned";
  }

  const statuses = await Promise.all(
    [...new Set(refs)].map(async (ref): Promise<PinStatus> => {
      if (ref === hubSha) {
        return "same";
      }

      return /^[0-9a-f]{40}$/.test(ref)
        ? STATUS_BY_CHANGE[await history(ref)]
        : "unknown";
    }),
  );

  return PIN_URGENCY.find((status) => statuses.includes(status)) ?? "same";
}

/** A pin that is drift on its own, whether or not a file drifted. */
export function isPinStale({ status }: FleetCiPin): boolean {
  return status === "changed" || status === "unknown";
}

/**
 * The sync moves a stale pin, and an older one along with drifted files,
 * so a pin never lags far behind the files it checks.
 */
export function shouldMovePin(pin: FleetCiPin, filesDrifted: boolean): boolean {
  return isPinStale(pin) || (pin.status === "behind" && filesDrifted);
}

/**
 * Points every fleet-ci.yml call at the hub's commit, with its date as the
 * version comment, and leaves every other line as written.
 */
export function pinFleetCi(workflow: string, hub: HubCommit): string {
  return workflow
    .split("\n")
    .map((line) => {
      const call = fleetCiCall(line);

      return call === undefined
        ? line
        : `${call.lead}${FLEET_CI}@${hub.sha}${call.quote} # fleet-ci ${hub.date}${line.endsWith("\r") ? "\r" : ""}`;
    })
    .join("\n");
}

async function readTextOrNull(path: string): Promise<string | null> {
  const file = Bun.file(path);

  return (await file.exists()) ? file.text() : null;
}

export async function compareFleetCiPin(
  targetDir: string,
  hubSha: string,
  history: WorkflowHistory,
): Promise<FleetCiPin> {
  const workflow = await readTextOrNull(join(targetDir, CALLER_WORKFLOW));
  const refs = workflow === null ? [] : fleetCiRefs(workflow);

  return { refs, status: await pinStatus(refs, hubSha, history) };
}

export async function writeFleetCiPin(
  targetDir: string,
  hub: HubCommit,
): Promise<void> {
  const path = join(targetDir, CALLER_WORKFLOW);

  await Bun.write(path, pinFleetCi(await Bun.file(path).text(), hub));
}

/** The refs of a pin that differ from the hub's commit, once each. */
export function olderRefs(pin: FleetCiPin, hubSha: string): string[] {
  return [...new Set(pin.refs.filter((ref) => ref !== hubSha))];
}

/**
 * One line when the sync would move the pin, saying why: fleet-ci.yml or
 * its scripts changed since the pinned commit, the hub has no such commit,
 * or files drifted and the pin moves with them.
 */
export function pinDriftReport(
  pin: FleetCiPin,
  filesDrifted: boolean,
  hubSha: string,
  targetDir: string,
  profile: Profile,
): string[] {
  if (!shouldMovePin(pin, filesDrifted)) {
    return [];
  }

  const pinned = `${CALLER_WORKFLOW} pins fleet-ci.yml to ${olderRefs(pin, hubSha).join(", ")}`;
  const reason =
    pin.status === "unknown"
      ? `which is not the full SHA of a commit in ${HUB_REPO}`
      : pin.status === "changed"
        ? `and ${FLEET_CI_PATHS.join(" or ")} changed in ${HUB_REPO} since then (now ${hubSha})`
        : `and the drifted files above come from ${HUB_REPO}@${hubSha}, so the pin moves with them`;

  return [`${pinned}, ${reason}. Run: ${syncCommand(targetDir, profile)}`];
}

const USAGE =
  "Usage: bun scripts/fleet-sync.ts <target-dir> --profile code|prose [--check]";

export interface MainOptions {
  fleetDir?: string;
  /** The commit the fleet files come from. Read from the hub's HEAD by default. */
  hub?: HubCommit;
  workflowHistory?: WorkflowHistory;
}

export async function main(
  argv: string[],
  {
    fleetDir = FLEET_DIR,
    hub = readHubCommit(),
    workflowHistory = hubWorkflowHistory(),
  }: MainOptions = {},
): Promise<number> {
  let parsed;

  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        profile: { type: "string" },
        check: { type: "boolean", default: false },
      },
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(USAGE);

    return 2;
  }

  const { positionals, values } = parsed;
  const [targetDir] = positionals;

  if (targetDir === undefined || positionals.length > 1) {
    console.error(
      `Pass exactly one target directory, got ${positionals.length}.`,
    );
    console.error(USAGE);

    return 2;
  }

  if (!isProfile(values.profile)) {
    console.error(
      `The --profile option is ${JSON.stringify(values.profile)}. Pass code or prose.`,
    );
    console.error(USAGE);

    return 2;
  }

  if (!existsSync(join(targetDir, ".git"))) {
    console.error(
      `Unable to find a git repository at ${targetDir}. Pass the root of the repository to sync.`,
    );

    return 2;
  }

  if (hub === undefined) {
    console.error(
      `Unable to read the hub's commit with ${HUB_COMMIT_COMMAND.join(" ")} in ${HUB_ROOT}. Run fleet-sync from a git checkout of ${HUB_REPO}.`,
    );

    return 2;
  }

  const profile = values.profile;

  if (values.check) {
    const files = driftReport(
      await compareWithFleet(targetDir, profile, fleetDir),
      targetDir,
      profile,
    );
    const pin = await compareFleetCiPin(targetDir, hub.sha, workflowHistory);
    const drift = [
      ...files,
      ...pinDriftReport(pin, files.length > 0, hub.sha, targetDir, profile),
    ];

    for (const line of drift) {
      console.error(line);
    }

    if (drift.length > 0) {
      return 1;
    }

    console.log(
      `${targetDir} matches the ${profile} profile (${FLEET_FILES[profile].length} files).`,
    );

    if (pin.status === "same" || pin.status === "behind") {
      console.log(
        `${CALLER_WORKFLOW} pins fleet-ci.yml to ${pin.refs.join(", ")}${pin.status === "behind" ? `, and neither ${FLEET_CI_PATHS.join(" nor ")} changed since then` : ""}.`,
      );
    }

    return 0;
  }

  const statuses = await syncWithFleet(targetDir, profile, fleetDir);

  for (const { target, status } of statuses) {
    console.log(`${status === "same" ? "unchanged" : "wrote    "} ${target}`);
  }

  const pin = await compareFleetCiPin(targetDir, hub.sha, workflowHistory);
  const movesPin = shouldMovePin(
    pin,
    statuses.some(({ status }) => status !== "same"),
  );

  if (movesPin) {
    await writeFleetCiPin(targetDir, hub);
  }

  if (pin.status !== "unpinned") {
    console.log(
      `${movesPin ? "wrote    " : "unchanged"} ${CALLER_WORKFLOW} (fleet-ci.yml pin)`,
    );
  }

  return 0;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
