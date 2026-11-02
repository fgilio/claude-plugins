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
 * Where the caller workflow pins fleet-ci.yml: same when every call pins
 * the hub's commit, stale when one pins anything else (another commit, a
 * short SHA, a branch), and unpinned when nothing calls it from the hub,
 * as in the hub itself, which calls its own copy.
 */
export type PinStatus = "same" | "stale" | "unpinned";

export interface FleetCiPin {
  /** Each ref the caller workflow pins fleet-ci.yml to, in file order. */
  refs: string[];
  status: PinStatus;
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

export function pinStatus(refs: string[], hubSha: string): PinStatus {
  if (refs.length === 0) {
    return "unpinned";
  }

  return refs.every((ref) => ref === hubSha) ? "same" : "stale";
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
): Promise<FleetCiPin> {
  const workflow = await readTextOrNull(join(targetDir, CALLER_WORKFLOW));
  const refs = workflow === null ? [] : fleetCiRefs(workflow);

  return { refs, status: pinStatus(refs, hubSha) };
}

/**
 * Moves a stale pin to the hub's commit and returns the pin it found
 * before writing.
 */
export async function syncFleetCiPin(
  targetDir: string,
  hub: HubCommit,
): Promise<FleetCiPin> {
  const pin = await compareFleetCiPin(targetDir, hub.sha);

  if (pin.status === "stale") {
    const path = join(targetDir, CALLER_WORKFLOW);

    await Bun.write(path, pinFleetCi(await Bun.file(path).text(), hub));
  }

  return pin;
}

/** The refs of a stale pin that differ from the hub's commit, once each. */
export function staleRefs(pin: FleetCiPin, hubSha: string): string[] {
  return [...new Set(pin.refs.filter((ref) => ref !== hubSha))];
}

/**
 * One line when the caller workflow pins fleet-ci.yml anywhere but the
 * commit the fleet files come from, naming the command that moves it.
 */
export function pinDriftReport(
  pin: FleetCiPin,
  hubSha: string,
  targetDir: string,
  profile: Profile,
): string[] {
  if (pin.status !== "stale") {
    return [];
  }

  return [
    `${CALLER_WORKFLOW} pins fleet-ci.yml to ${staleRefs(pin, hubSha).join(", ")}, but the fleet files come from ${HUB_REPO}@${hubSha}. Run: ${syncCommand(targetDir, profile)}`,
  ];
}

const USAGE =
  "Usage: bun scripts/fleet-sync.ts <target-dir> --profile code|prose [--check]";

export interface MainOptions {
  fleetDir?: string;
  /** The commit the fleet files come from. Read from the hub's HEAD by default. */
  hub?: HubCommit;
}

export async function main(
  argv: string[],
  { fleetDir = FLEET_DIR, hub = readHubCommit() }: MainOptions = {},
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
    const pin = await compareFleetCiPin(targetDir, hub.sha);
    const drift = [
      ...driftReport(
        await compareWithFleet(targetDir, profile, fleetDir),
        targetDir,
        profile,
      ),
      ...pinDriftReport(pin, hub.sha, targetDir, profile),
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

    if (pin.status === "same") {
      console.log(`${CALLER_WORKFLOW} pins fleet-ci.yml to ${hub.sha}.`);
    }

    return 0;
  }

  for (const { target, status } of await syncWithFleet(
    targetDir,
    profile,
    fleetDir,
  )) {
    console.log(`${status === "same" ? "unchanged" : "wrote    "} ${target}`);
  }

  const pin = await syncFleetCiPin(targetDir, hub);

  if (pin.status !== "unpinned") {
    console.log(
      `${pin.status === "same" ? "unchanged" : "wrote    "} ${CALLER_WORKFLOW} (fleet-ci.yml pin)`,
    );
  }

  return 0;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
