import { describe, expect, test } from "bun:test";

import { applyIgnorePatterns, parseIgnorePatterns } from "./ignore-patterns";

const PATHS = [
  "README.md",
  "docs/guide.md",
  "docs/api.generated.md",
  "skills/demo/SKILL.md",
  "skills/demo/prompts/audit.md",
  "skills/demo/prompts/nested/more.md",
  "skills/other/prompts.md",
];

function skippedBy(text: string): string[] {
  return applyIgnorePatterns(parseIgnorePatterns(text), PATHS).skipped;
}

describe("parseIgnorePatterns", () => {
  test("skips comments and blank lines and keeps each pattern's line", () => {
    const patterns = parseIgnorePatterns(
      "# Quoted prompts\n\n   \ndocs/\r\n  # indented text is a pattern\n",
    );

    expect(
      patterns.map(({ line, source, directoryOnly }) => ({
        line,
        source,
        directoryOnly,
      })),
    ).toEqual([
      { line: 4, source: "docs/", directoryOnly: true },
      {
        line: 5,
        source: "  # indented text is a pattern",
        directoryOnly: false,
      },
    ]);
  });

  test("reads a leading ! as a negation and \\# as a literal #", () => {
    const [negated, literal] = parseIgnorePatterns("!keep.md\n\\#notes.md\n");

    expect(negated?.negated).toBe(true);
    expect(literal?.glob.match("#notes.md")).toBe(true);
  });
});

describe("applyIgnorePatterns", () => {
  test("skips everything under a directory pattern", () => {
    expect(skippedBy("skills/demo/prompts/\n")).toEqual([
      "skills/demo/prompts/audit.md",
      "skills/demo/prompts/nested/more.md",
    ]);
  });

  test("matches a directory pattern without a slash at any depth, and only directories", () => {
    expect(skippedBy("prompts/\n")).toEqual([
      "skills/demo/prompts/audit.md",
      "skills/demo/prompts/nested/more.md",
    ]);
  });

  test("matches a name without a trailing slash as a file or a directory", () => {
    expect(skippedBy("prompts.md\nnested\n")).toEqual([
      "skills/demo/prompts/nested/more.md",
      "skills/other/prompts.md",
    ]);
  });

  test("matches a file glob at any depth", () => {
    expect(skippedBy("**/*.generated.md\n")).toEqual(["docs/api.generated.md"]);
    expect(skippedBy("*.generated.md\n")).toEqual(["docs/api.generated.md"]);
  });

  test("anchors a pattern with a leading slash to the root", () => {
    expect(skippedBy("/README.md\n/guide.md\n")).toEqual(["README.md"]);
  });

  test("lets a later ! pattern keep a file, except inside a skipped directory", () => {
    expect(
      skippedBy("docs/*.md\n!docs/guide.md\nprompts/\n!prompts/audit.md\n"),
    ).toEqual([
      "docs/api.generated.md",
      "skills/demo/prompts/audit.md",
      "skills/demo/prompts/nested/more.md",
    ]);
  });

  test("keeps braces literal", () => {
    expect(
      applyIgnorePatterns(parseIgnorePatterns("{a,b}.md\n"), ["a.md"]).skipped,
    ).toEqual([]);
  });

  test("reports each pattern that matches nothing", () => {
    const { unused } = applyIgnorePatterns(
      parseIgnorePatterns("# Comment\n\nprompts/\nvendor/\n*.txt\n"),
      PATHS,
    );

    expect(unused.map(({ line, source }) => ({ line, source }))).toEqual([
      { line: 4, source: "vendor/" },
      { line: 5, source: "*.txt" },
    ]);
  });
});
