#!/usr/bin/env bun

// Fails when a JSON or JSONC file a commit could carry does not parse, and
// prints the parser's message so the error names what to fix.
//
// Usage: bun scripts/validate-json.ts [repository]
// The repository defaults to the working directory, so CI can run the
// hub's copy against the repository it checks.
import { basename, join } from "node:path";

import { filesGitWouldCommit } from "./git-files";

export interface JsonProblem {
  path: string;
  message: string;
}

/**
 * Files named .json that their tools read as JSONC, so comments and
 * trailing commas are valid in them.
 */
const JSONC_FILE_NAMES = new Set([
  "tsconfig.json",
  "jsconfig.json",
  ".oxlintrc.json",
  ".oxfmtrc.json",
]);

export function isJsonc(path: string): boolean {
  const name = basename(path);

  return (
    path.endsWith(".jsonc") ||
    JSONC_FILE_NAMES.has(name) ||
    /^tsconfig\..+\.json$/.test(name)
  );
}

/**
 * Returns the parser's message when the text does not parse, or null when
 * it does.
 */
export function parseError(path: string, text: string): string | null {
  try {
    (isJsonc(path) ? Bun.JSONC.parse : JSON.parse)(text);

    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function jsonFiles(root: string): string[] {
  return filesGitWouldCommit(root, ["*.json", "*.jsonc"]);
}

export async function validateJson(root: string): Promise<{
  checked: number;
  problems: JsonProblem[];
}> {
  const paths = jsonFiles(root);

  const results = await Promise.all(
    paths.map(async (path) => ({
      path,
      message: parseError(path, await Bun.file(join(root, path)).text()),
    })),
  );

  const problems = results.flatMap(({ path, message }) =>
    message === null ? [] : [{ path, message }],
  );

  return { checked: paths.length, problems };
}

export function annotation({ path, message }: JsonProblem): string {
  return `::error file=${path}::${path} does not parse as ${isJsonc(path) ? "JSONC" : "JSON"}: ${message}`;
}

export async function main(root = process.cwd()): Promise<number> {
  const { checked, problems } = await validateJson(root);

  for (const problem of problems) {
    console.error(annotation(problem));
  }

  if (problems.length > 0) {
    return 1;
  }

  console.log(`parsed ${checked} JSON and JSONC files`);

  return 0;
}

if (import.meta.main) {
  process.exit(await main(process.argv[2]));
}
