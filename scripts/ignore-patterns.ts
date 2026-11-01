// Reads a file of gitignore-style patterns, such as .proseignore, and
// filters repository paths through it the way git filters untracked files.

export interface IgnorePattern {
  /** The line of the pattern in its file, counted from 1. */
  line: number;
  /** The pattern as written, without trailing spaces. */
  source: string;
  negated: boolean;
  directoryOnly: boolean;
  glob: Bun.Glob;
}

export interface IgnoreResult {
  kept: string[];
  skipped: string[];
  /** Patterns that matched none of the paths or their directories. */
  unused: IgnorePattern[];
}

/**
 * The POSIX character classes git accepts inside brackets, as the ASCII
 * ranges Bun.Glob reads. No range starts with "!", which would negate the
 * bracket when the class comes first in it.
 */
export const CHARACTER_CLASSES: Record<string, string> = {
  alnum: "a-zA-Z0-9",
  alpha: "a-zA-Z",
  blank: " \\t",
  cntrl: "\u0000-\u001F\u007F",
  digit: "0-9",
  graph: '"-~!',
  lower: "a-z",
  print: " -~",
  punct: ":-@!-/\\[-`{-~",
  space: " \\t\\n\\r\\f\\v",
  upper: "A-Z",
  xdigit: "0-9a-fA-F",
};

/**
 * Turns a gitignore glob into one Bun.Glob reads the same way: braces stay
 * literal characters, and a character class such as [[:digit:]] becomes
 * its range. An unknown class stays as written.
 */
function toBunGlob(pattern: string): string {
  return pattern
    .replace(/[{}]/g, (brace) => `\\${brace}`)
    .replace(
      /\[:([a-z]+):\]/g,
      (written, name: string) => CHARACTER_CLASSES[name] ?? written,
    );
}

function parseLine(text: string, line: number): IgnorePattern | null {
  // Trailing spaces are dropped unless a backslash escapes the last one.
  const source = text.replace(/\r$/, "").replace(/(?<!\\) +$/, "");

  if (source === "" || source.startsWith("#")) {
    return null;
  }

  const negated = source.startsWith("!");
  let body = negated ? source.slice(1) : source;

  const directoryOnly = body.endsWith("/");
  body = body.replace(/\/+$/, "");

  if (body === "") {
    return null;
  }

  // A slash before the end anchors the pattern to the root, as in git.
  // Without one, the pattern matches a name at any depth.
  const anchored = body.includes("/");
  // A leading ! left after the anchor is a literal character, which
  // Bun.Glob would read as a negation.
  body = body.replace(/^\//, "").replace(/^!/, "\\!");

  return {
    line,
    source,
    negated,
    directoryOnly,
    glob: new Bun.Glob(toBunGlob(anchored ? body : `**/${body}`)),
  };
}

export function parseIgnorePatterns(text: string): IgnorePattern[] {
  return text
    .split("\n")
    .map((line, index) => parseLine(line, index + 1))
    .filter((pattern) => pattern !== null);
}

/**
 * Splits paths (relative, with "/" separators) into the ones the patterns
 * keep and the ones they skip. The last matching pattern wins, and a file
 * inside a skipped directory stays skipped even when a later "!" pattern
 * names it, since git never looks inside that directory.
 */
export function applyIgnorePatterns(
  patterns: IgnorePattern[],
  paths: string[],
): IgnoreResult {
  const used = new Set<IgnorePattern>();

  const isSkipped = (target: string, isDirectory: boolean): boolean => {
    let skipped = false;

    for (const pattern of patterns) {
      if (pattern.directoryOnly && !isDirectory) {
        continue;
      }

      if (pattern.glob.match(target)) {
        used.add(pattern);
        skipped = !pattern.negated;
      }
    }

    return skipped;
  };

  const isPathSkipped = (path: string): boolean => {
    const segments = path.split("/");

    for (let depth = 1; depth < segments.length; depth++) {
      if (isSkipped(segments.slice(0, depth).join("/"), true)) {
        return true;
      }
    }

    return isSkipped(path, false);
  };

  const kept: string[] = [];
  const skipped: string[] = [];

  for (const path of paths) {
    (isPathSkipped(path) ? skipped : kept).push(path);
  }

  return {
    kept,
    skipped,
    unused: patterns.filter((pattern) => !used.has(pattern)),
  };
}
