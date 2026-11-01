import { describe, expect, test } from "bun:test";

import {
  CHARACTER_CLASSES,
  applyIgnorePatterns,
  parseIgnorePatterns,
} from "./ignore-patterns";

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

  test("reads a ! after an anchoring slash as a literal character", () => {
    expect(
      applyIgnorePatterns(parseIgnorePatterns("/!quoted.md\n"), [
        "!quoted.md",
        "README.md",
      ]).skipped,
    ).toEqual(["!quoted.md"]);
  });

  test.each<[string, string, string]>([
    ["[[:digit:]].md", "7.md", "x.md"],
    ["[[:alpha:]_]*.md", "_notes.md", "1notes.md"],
    ["[[:upper:]]*.md", "README.md", "readme.md"],
    ["[![:digit:]].md", "x.md", "7.md"],
  ])(
    "reads the character class in %p as git does",
    (pattern, matched, kept) => {
      expect(
        applyIgnorePatterns(parseIgnorePatterns(`${pattern}\n`), [
          matched,
          kept,
        ]).skipped,
      ).toEqual([matched]);
    },
  );

  test("covers every character class git supports", () => {
    expect(Object.keys(CHARACTER_CLASSES).toSorted()).toEqual([
      "alnum",
      "alpha",
      "blank",
      "cntrl",
      "digit",
      "graph",
      "lower",
      "print",
      "punct",
      "space",
      "upper",
      "xdigit",
    ]);
  });

  test.each<[string, string[], string[]]>([
    ["print", ["x.md", " .md", "!.md"], ["\u0001.md"]],
    ["graph", ["x.md", "!.md", "~.md"], [" .md", "\u0001.md"]],
    ["cntrl", ["\u0001.md", "\u007F.md"], ["x.md", " .md"]],
    ["punct", ["!.md", "_.md", "~.md"], ["x.md", " .md"]],
  ])("reads [[:%s:]] as git does", (name, skipped, kept) => {
    expect(
      applyIgnorePatterns(parseIgnorePatterns(`[[:${name}:]].md\n`), [
        ...skipped,
        ...kept,
      ]).skipped,
    ).toEqual(skipped);
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
