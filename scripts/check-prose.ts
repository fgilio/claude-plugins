#!/usr/bin/env bun

// Fails when the prose in a Markdown file breaks a writing rule that a
// pattern can catch. Code, code spans, HTML and link destinations are
// not prose, so they never count.
//
// Usage: bun scripts/check-prose.ts [repository]
// The repository defaults to the working directory, so CI can run the
// hub's copy against the repository it checks. A .proseignore file at its
// root (gitignore syntax) leaves out Markdown carried verbatim, such as a
// quoted prompt by another author.
import { join } from "node:path";

import { filesGitWouldCommit } from "./git-files";
import {
  applyIgnorePatterns,
  type IgnorePattern,
  parseIgnorePatterns,
} from "./ignore-patterns";
import { lineAt, maskSkippedSource } from "./markdown-source";

const CODE_OPEN = /^<(?:code|kbd|samp|pre)\b[^>]*>$/i;
const CODE_CLOSE = /^<\/(?:code|kbd|samp|pre)\s*>$/i;
const HTML_TAG = /^<\/?[a-z][\w-]*(?:\s[^>]*)?\/?>$/i;

interface Rule {
  pattern: RegExp;
  message: (match: string) => string;
}

export interface ProseProblem {
  line: number;
  message: string;
}

export interface FileProseProblem extends ProseProblem {
  path: string;
}

const RULES: Rule[] = [
  {
    pattern: /—/g,
    message: () => "has an em dash. Use parentheses or split the sentence.",
  },
  {
    pattern: / [-–] /g,
    message: (match) =>
      `uses "${match.trim()}" as a separator. Use parentheses or split the sentence.`,
  },
  {
    pattern: /;/g,
    message: () => "has a semicolon. Split it into two sentences.",
  },
  {
    pattern: /[‘’“”]/g,
    message: (match) =>
      `has the curly quote ${match}. Use straight quotes (' and ").`,
  },
  {
    pattern:
      /\b(?:it's worth noting|in this article|comprehensive guide|step-by-step|important to understand|leverag(?:e|es|ed|ing)|utiliz(?:e|es|ed|ing|ation))\b/gi,
    message: (match) => `says "${match}". Say it plainly or cut it.`,
  },
  {
    pattern: /\binvariants?\b/gi,
    message: (match) => `says "${match}". Say "rule" or "guarantee".`,
  },
];

/**
 * Collects the text a reader sees as prose, in document order. Code and
 * quotes keep their own conventions, so their text is left out.
 */
export function proseFragments(markdown: string): string[] {
  const texts: string[] = [];

  const rendered = Bun.markdown.render(markdown, {
    text: (children) => `${texts.push(children) - 1}`,
    code: () => "",
    codespan: () => "",
    html: () => "",
    blockquote: () => "",
    // An autolink shows its own destination, which is a URL, not prose.
    link: (children, { href }) => {
      const only = /^\uE000(\d+)\uE001$/.exec(children)?.[1];
      const label = only === undefined ? undefined : texts[Number(only)];

      return label === href || `mailto:${label}` === href ? "" : children;
    },
  });

  const prose: string[] = [];
  let codeDepth = 0;
  let inComment = false;

  for (const [, index] of rendered.matchAll(/(\d+)/g)) {
    const text = texts[Number(index)] ?? "";

    // Inline HTML arrives as text nodes, so comments and code tags are
    // tracked here, and a tag's attributes never count as prose.
    if (inComment || text.startsWith("<!--")) {
      inComment = !text.endsWith("-->");
    } else if (CODE_OPEN.test(text)) {
      codeDepth++;
    } else if (CODE_CLOSE.test(text)) {
      codeDepth = Math.max(0, codeDepth - 1);
    } else if (codeDepth === 0 && !HTML_TAG.test(text)) {
      prose.push(text);
    }
  }

  return prose;
}

export function findProseProblems(markdown: string): ProseProblem[] {
  const problems: ProseProblem[] = [];
  const source = maskSkippedSource(markdown);
  let cursor = 0;

  for (const fragment of proseFragments(markdown)) {
    // A fragment the mask hides (list text that looks like indented
    // code) is searched in the source as written.
    const masked = source.indexOf(fragment, cursor);
    const position =
      masked === -1 ? markdown.indexOf(fragment, cursor) : masked;

    if (position !== -1) {
      cursor = position + fragment.length;
    }

    const line = lineAt(markdown, position === -1 ? cursor : position);

    // A URL in running text keeps its own punctuation.
    const words = fragment.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "");

    for (const { pattern, message } of RULES) {
      for (const [match] of words.matchAll(pattern)) {
        problems.push({ line, message: message(match) });
      }
    }
  }

  return problems;
}

export function markdownFiles(root: string): string[] {
  return filesGitWouldCommit(root, ["*.md"]);
}

export const PROSE_IGNORE = ".proseignore";

export interface ProseIgnoreReport {
  skipped: number;
  unused: IgnorePattern[];
}

export async function checkProse(root: string): Promise<{
  checked: number;
  ignored: ProseIgnoreReport | null;
  problems: FileProseProblem[];
}> {
  const ignoreFile = Bun.file(join(root, PROSE_IGNORE));
  let paths = markdownFiles(root);
  let ignored: ProseIgnoreReport | null = null;

  if (await ignoreFile.exists()) {
    const { kept, skipped, unused } = applyIgnorePatterns(
      parseIgnorePatterns(await ignoreFile.text()),
      paths,
    );

    paths = kept;
    ignored = { skipped: skipped.length, unused };
  }

  const problems = await Promise.all(
    paths.map(async (path) =>
      findProseProblems(await Bun.file(join(root, path)).text()).map(
        ({ line, message }) => ({ path, line, message }),
      ),
    ),
  );

  return { checked: paths.length, ignored, problems: problems.flat() };
}

/**
 * Formats a problem as a GitHub workflow command, so the run attaches it
 * to the line in the diff. Outside Actions it still reads as one line.
 */
export function annotation({ path, line, message }: FileProseProblem): string {
  return `::error file=${path},line=${line}::${path}:${line} ${message}`;
}

/**
 * A warning for a .proseignore pattern that skips nothing, so a renamed
 * directory never leaves a stale line behind.
 */
export function unusedPatternWarning({ line, source }: IgnorePattern): string {
  return `::warning file=${PROSE_IGNORE},line=${line}::${PROSE_IGNORE}:${line} "${source}" matches no Markdown file. Fix the pattern or remove the line.`;
}

export async function main(root = process.cwd()): Promise<number> {
  const { checked, ignored, problems } = await checkProse(root);

  if (ignored !== null) {
    for (const pattern of ignored.unused) {
      console.error(unusedPatternWarning(pattern));
    }

    console.log(
      `skipped ${ignored.skipped} Markdown ${ignored.skipped === 1 ? "file" : "files"} listed in ${PROSE_IGNORE}`,
    );
  }

  for (const problem of problems) {
    console.error(annotation(problem));
  }

  if (problems.length > 0) {
    return 1;
  }

  console.log(`checked the prose in ${checked} Markdown files`);

  return 0;
}

if (import.meta.main) {
  process.exit(await main(process.argv[2]));
}
