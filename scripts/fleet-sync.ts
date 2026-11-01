#!/usr/bin/env bun

// Copies the fleet's config files from fleet/ into a repository,
// byte-identical, or with --check reports each file that drifted.
//
// Usage: bun scripts/fleet-sync.ts <target-dir> --profile code|prose [--check]
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { parseArgs } from "node:util";

export const FLEET_DIR = join(import.meta.dir, "..", "fleet");

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

const USAGE =
  "Usage: bun scripts/fleet-sync.ts <target-dir> --profile code|prose [--check]";

export async function main(
  argv: string[],
  fleetDir = FLEET_DIR,
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

  const profile = values.profile;

  if (values.check) {
    const drift = driftReport(
      await compareWithFleet(targetDir, profile, fleetDir),
      targetDir,
      profile,
    );

    for (const line of drift) {
      console.error(line);
    }

    if (drift.length > 0) {
      return 1;
    }

    console.log(
      `${targetDir} matches the ${profile} profile (${FLEET_FILES[profile].length} files).`,
    );

    return 0;
  }

  for (const { target, status } of await syncWithFleet(
    targetDir,
    profile,
    fleetDir,
  )) {
    console.log(`${status === "same" ? "unchanged" : "wrote    "} ${target}`);
  }

  return 0;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
