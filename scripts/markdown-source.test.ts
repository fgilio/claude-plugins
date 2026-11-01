import { describe, expect, test } from "bun:test";

import { findProseProblems } from "./check-prose";
import { lineAt, maskSkippedSource } from "./markdown-source";

const masked = (markdown: string) =>
  maskSkippedSource(markdown)
    .split("\n")
    .map((line) => line.trim());

describe("maskSkippedSource", () => {
  test("keeps a fence open across a marker line with an info string", () => {
    const markdown = [
      "````md",
      "Example; quoted.",
      "```js",
      "const a = 1;",
      "```",
      "````",
      "After; prose.",
    ].join("\n");

    expect(masked(markdown)).toEqual(["", "", "", "", "", "", "After; prose."]);
    expect(findProseProblems(markdown)).toEqual([
      { line: 7, message: "has a semicolon. Split it into two sentences." },
    ]);
  });

  test("keeps a fence open when a same-length marker carries text", () => {
    const markdown = [
      "```md",
      "Inside; still code.",
      "```js",
      "More; code.",
      "```",
      "Outside; prose.",
    ].join("\n");

    expect(masked(markdown)).toEqual(["", "", "", "", "", "Outside; prose."]);
    expect(findProseProblems(markdown)).toEqual([
      { line: 6, message: "has a semicolon. Split it into two sentences." },
    ]);
  });

  test("closes a fence on a marker followed by whitespace only", () => {
    expect(masked("~~~\nCode; here.\n~~~  \t\nProse; here.")).toEqual([
      "",
      "",
      "",
      "Prose; here.",
    ]);
  });

  test("keeps every offset", () => {
    const markdown = "```\na; b\n```\nText `x; y` <!-- c; d --> end.";

    expect(maskSkippedSource(markdown)).toHaveLength(markdown.length);
  });
});

describe("lineAt", () => {
  test("counts lines from 1", () => {
    expect(lineAt("a\nb\nc", 0)).toBe(1);
    expect(lineAt("a\nb\nc", 4)).toBe(3);
  });
});
