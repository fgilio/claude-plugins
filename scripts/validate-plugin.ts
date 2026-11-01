#!/usr/bin/env bun

// Fails on the plugin mistakes `claude plugin validate` lets through: a
// SKILL.md whose frontmatter does not parse (the skill is skipped without
// an error), a name that differs from its directory, a multi-line or
// missing description, a flag that is not a boolean, a hooks.json of the
// wrong shape, and a relative Markdown link to a missing file.
//
// Usage: bun scripts/validate-plugin.ts [repository]
// The repository defaults to the working directory, so CI can run the
// hub's copy against the repository it checks.
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { filesGitWouldCommit } from "./git-files";
import { lineAt } from "./markdown-source";

export interface PluginProblem {
  path: string;
  /** The line the problem sits on, when it has one. */
  line?: number;
  message: string;
}

export interface LinkTarget {
  target: string;
  /** Undefined when the destination is written differently in the source. */
  line: number | undefined;
}

const BOOLEAN_KEYS = ["user-invocable", "disable-model-invocation"];

const STRING_KEYS = ["argument-hint", "model"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

/**
 * Where a link destination can start: after "](" in an inline link, or
 * after the label of a reference definition.
 */
const DESTINATION_START =
  /\]\(\s*<?|^ {0,3}\[(?:[^\]\\]|\\.)+\]:[ \t]*\n?[ \t]*<?/gm;

const MARKER = "\uE000";

/**
 * Link and image destinations as a Markdown parser reads them, in document
 * order, so code blocks, code spans and unused definitions never count.
 */
function destinations(markdown: string): string[] {
  const found: string[] = [];

  Bun.markdown.render(markdown, {
    link: (children, { href }) => {
      found.push(href);
      return children;
    },
    image: (children, { src }) => {
      found.push(src);
      return children;
    },
  });

  return found;
}

/**
 * Collects link and image destinations, each with the line it sits on: an
 * inline link's own line, or the definition line of a reference link.
 *
 * Bun.markdown reports no positions, so each place in the source that could
 * hold a destination is marked in turn, and the links whose destination
 * picks up the marker are the ones written there. Text that only looks
 * like a link, such as a code example or an escaped bracket, marks none.
 * Each mark costs a parse, so only the targets isLocated accepts get a
 * line.
 */
export function linkTargets(
  markdown: string,
  isLocated: (target: string) => boolean = () => true,
): LinkTarget[] {
  const targets = destinations(markdown);
  const lines: (number | undefined)[] = targets.map(() => undefined);
  const candidates = [...new Set(targets)]
    .filter((target) => target !== "" && isLocated(target))
    .toSorted((a, b) => b.length - a.length);

  for (const match of markdown.matchAll(DESTINATION_START)) {
    const start = match.index + match[0].length;
    const target = candidates.find((candidate) =>
      markdown.startsWith(candidate, start),
    );

    if (target === undefined) {
      continue;
    }

    const end = start + target.length;
    const marked = destinations(
      markdown.slice(0, end) + MARKER + markdown.slice(end),
    );

    marked.forEach((destination, index) => {
      if (destination.includes(MARKER) && lines[index] === undefined) {
        lines[index] = lineAt(markdown, match.index);
      }
    });
  }

  return targets.map((target, index) => ({ target, line: lines[index] }));
}

/**
 * Decodes percent escapes in a link path. A malformed escape such as "50%"
 * keeps the path as written, which then resolves or reads as missing.
 */
function decodeLinkPath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/**
 * Relative link targets in a Markdown file that point at no file. A target
 * starting with "/" resolves from the repository root, as GitHub renders it.
 */
export function missingLinkTargets(
  root: string,
  path: string,
  markdown: string,
): LinkTarget[] {
  const isMissing = (target: string): boolean => {
    if (
      target === "" ||
      /^[a-z][a-z0-9+.-]*:/i.test(target) ||
      target.startsWith("#") ||
      target.startsWith("//")
    ) {
      return false;
    }

    const file = decodeLinkPath(target.split(/[?#]/)[0] ?? "");
    const resolved = file.startsWith("/")
      ? join(root, file)
      : join(root, dirname(path), file);

    return !existsSync(resolved);
  };

  return linkTargets(markdown, isMissing).filter(({ target }) =>
    isMissing(target),
  );
}

export function frontmatterProblems(path: string, markdown: string): string[] {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(
    markdown,
  )?.[1];

  if (frontmatter === undefined) {
    return [
      "has no frontmatter. Start the file with a --- block that sets name and description.",
    ];
  }

  let fields: unknown;

  try {
    fields = Bun.YAML.parse(frontmatter);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);

    return [
      `has frontmatter that is not valid YAML (${reason}). Claude Code skips the skill without an error.`,
    ];
  }

  if (!isRecord(fields)) {
    return ["has frontmatter that is not a YAML mapping of keys to values."];
  }

  const problems: string[] = [];
  const directory = basename(dirname(path));
  const { name, description } = fields;

  if (name !== directory) {
    problems.push(
      `sets name to ${JSON.stringify(name)}. Set it to "${directory}", the name of its directory.`,
    );
  }

  if (typeof description !== "string" || description.trim() === "") {
    problems.push(
      "has no description. Add one line that says what the skill does and when to use it.",
    );
  } else if (description.trim().includes("\n")) {
    problems.push(
      "has a description that spans several lines once parsed. Write it as one paragraph (a folded > block or a single line).",
    );
  }

  for (const key of BOOLEAN_KEYS) {
    if (key in fields && typeof fields[key] !== "boolean") {
      problems.push(
        `sets ${key} to ${JSON.stringify(fields[key])}. Set it to true or false.`,
      );
    }
  }

  for (const key of STRING_KEYS) {
    if (key in fields && typeof fields[key] !== "string") {
      problems.push(
        `sets ${key} to ${JSON.stringify(fields[key])}. Set it to a string.`,
      );
    }
  }

  if (
    "allowed-tools" in fields &&
    typeof fields["allowed-tools"] !== "string" &&
    !isStringArray(fields["allowed-tools"])
  ) {
    problems.push(
      "sets allowed-tools to a value that is neither a string nor a list of strings.",
    );
  }

  return problems;
}

function commandHookProblems(event: string, matcher: unknown): string[] {
  if (!isRecord(matcher)) {
    return [`has a ${event} entry that is not an object.`];
  }

  if ("matcher" in matcher && typeof matcher["matcher"] !== "string") {
    return [`has a ${event} matcher that is not a string.`];
  }

  if (!Array.isArray(matcher["hooks"])) {
    return [`has a ${event} entry without a hooks list.`];
  }

  return matcher["hooks"].flatMap((hook: unknown) => {
    if (!isRecord(hook) || typeof hook["type"] !== "string") {
      return [`has a ${event} hook without a type.`];
    }

    if (hook["type"] === "command" && typeof hook["command"] !== "string") {
      return [`has a ${event} command hook without a command string.`];
    }

    if ("timeout" in hook && typeof hook["timeout"] !== "number") {
      return [`has a ${event} hook whose timeout is not a number of seconds.`];
    }

    return [];
  });
}

/**
 * Checks the shape of hooks/hooks.json: a map of hook events to matchers,
 * or a list of hook modules.
 */
export function hooksProblems(text: string): string[] {
  let hooksFile: unknown;

  try {
    hooksFile = JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);

    return [`does not parse as JSON (${reason}).`];
  }

  if (!isRecord(hooksFile)) {
    return ["is not a JSON object."];
  }

  const { hooks, modules } = hooksFile;

  if (hooks === undefined && modules === undefined) {
    return ['sets neither "hooks" nor "modules".'];
  }

  const problems: string[] = [];

  if (modules !== undefined && !isStringArray(modules)) {
    problems.push('sets "modules" to something other than a list of paths.');
  }

  if (hooks !== undefined) {
    if (!isRecord(hooks)) {
      problems.push('sets "hooks" to something other than an object.');
    } else {
      for (const [event, matchers] of Object.entries(hooks)) {
        if (Array.isArray(matchers)) {
          problems.push(
            ...matchers.flatMap((matcher: unknown) =>
              commandHookProblems(event, matcher),
            ),
          );
        } else {
          problems.push(`sets ${event} to something other than a list.`);
        }
      }
    }
  }

  return problems;
}

export async function validatePlugin(root: string): Promise<{
  checked: number;
  problems: PluginProblem[];
}> {
  const markdownPaths = filesGitWouldCommit(root, ["*.md"]);
  const hooksPaths = filesGitWouldCommit(root, ["hooks/hooks.json"]);

  const markdownProblems = await Promise.all(
    markdownPaths.map(async (path) => {
      const markdown = await Bun.file(join(root, path)).text();
      const isSkill = /^skills\/[^/]+\/SKILL\.md$/.test(path);

      return [
        ...missingLinkTargets(root, path, markdown).map(
          ({ target, line }): PluginProblem => {
            const message = `links to ${target}, which does not exist. Fix the path or remove the link.`;

            return line === undefined
              ? { path, message }
              : { path, line, message };
          },
        ),
        ...(isSkill ? frontmatterProblems(path, markdown) : []).map(
          (message) => ({ path, message }),
        ),
      ];
    }),
  );

  const hookProblems = await Promise.all(
    hooksPaths.map(async (path) =>
      hooksProblems(await Bun.file(join(root, path)).text()).map((message) => ({
        path,
        message,
      })),
    ),
  );

  return {
    checked: markdownPaths.length + hooksPaths.length,
    problems: [...markdownProblems.flat(), ...hookProblems.flat()],
  };
}

/**
 * Formats a problem as a GitHub workflow command, so the run attaches it
 * to its file, and to its line when it has one.
 */
export function annotation({ path, line, message }: PluginProblem): string {
  return line === undefined
    ? `::error file=${path}::${path} ${message}`
    : `::error file=${path},line=${line}::${path}:${line} ${message}`;
}

export async function main(root = process.cwd()): Promise<number> {
  const { checked, problems } = await validatePlugin(root);

  for (const problem of problems) {
    console.error(annotation(problem));
  }

  if (problems.length > 0) {
    return 1;
  }

  console.log(`checked ${checked} skill, Markdown and hooks files`);

  return 0;
}

if (import.meta.main) {
  process.exit(await main(process.argv[2]));
}
