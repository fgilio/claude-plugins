import { describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  annotation,
  checkProse,
  findProseProblems,
  main,
  markdownFiles,
  proseFragments,
} from "./check-prose";
import { gitRepo } from "./test-support";

const HUB = join(import.meta.dir, "..");

describe("proseFragments", () => {
  test("skips code blocks, code spans, raw HTML and link destinations", () => {
    const text = [
      "Prose with `span; code` and [a link](https://example.com/a;b).",
      "",
      "```ts",
      "const a = 1;",
      "```",
      "",
      "<!-- a comment; -->",
    ].join("\n");

    expect(proseFragments(text).join("")).toBe("Prose with  and a link.");
  });

  test("skips quotes, which keep their own punctuation", () => {
    expect(
      proseFragments("Before.\n\n> They said “yes; now”.\n\nAfter."),
    ).toEqual(["Before.", "After."]);
  });

  test("skips the text inside inline code, kbd, samp and pre tags", () => {
    expect(
      proseFragments(
        "Run <code>a; b</code>, press <kbd>Ctrl</kbd>; then <b>bold</b>.",
      ),
    ).toEqual(["Run ", ", press ", "; then ", "<b>", "bold", "</b>", "."]);
  });
});

describe("findProseProblems", () => {
  test("accepts prose that follows the rules", () => {
    expect(
      findProseProblems("Split it into two sentences. Don't use `a; b`.\n"),
    ).toEqual([]);
  });

  test.each<[string, string]>([
    ["One thing — another.", "has an em dash"],
    ["One thing - another.", 'uses "-" as a separator'],
    ["One thing – another.", 'uses "–" as a separator'],
    ["One thing; another.", "has a semicolon"],
    ["It’s curly.", "has the curly quote ’"],
    ["It's worth noting that it works.", 'says "It\'s worth noting"'],
    ["We leverage the cache.", 'says "leverage"'],
    ["Utilization is high.", 'says "Utilization"'],
    ["A step-by-step guide.", 'says "step-by-step"'],
    ["The invariant holds.", 'says "invariant". Say "rule" or "guarantee"'],
  ])("flags %p", (text, problem) => {
    const problems = findProseProblems(text);

    expect(problems).toHaveLength(1);
    expect(problems[0]?.message).toContain(problem);
  });

  test("names the line of each problem, also after code", () => {
    const text = [
      "# Title",
      "",
      "```",
      "a; b",
      "```",
      "",
      "Fine here.",
      "",
      "Then one; two.",
    ].join("\n");

    expect(findProseProblems(text)).toEqual([
      { line: 9, message: "has a semicolon. Split it into two sentences." },
    ]);
  });

  test("reports a character written as an entity on the line where the text before it ends", () => {
    expect(findProseProblems("First line.\n\nSee &#8212; here.")).toEqual([
      {
        line: 3,
        message: "has an em dash. Use parentheses or split the sentence.",
      },
    ]);
  });
});

describe("checkProse", () => {
  test("checks every Markdown file git would commit, in any directory", async () => {
    const root = await gitRepo({
      ".gitignore": "node_modules\nignored.md\n",
      "README.md": "Fine.\n",
      "skills/demo/SKILL.md": "One; two.\n",
      "docs/guide.md": "Fine.\n\nFive — six.\n",
      "node_modules/dep/README.md": "One; two.\n",
      "ignored.md": "One; two.\n",
    });

    try {
      expect(await checkProse(root)).toEqual({
        checked: 3,
        problems: [
          {
            path: "docs/guide.md",
            line: 3,
            message: "has an em dash. Use parentheses or split the sentence.",
          },
          {
            path: "skills/demo/SKILL.md",
            line: 1,
            message: "has a semicolon. Split it into two sentences.",
          },
        ],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("skips a nested repository, such as a second checkout in CI", async () => {
    const root = await gitRepo({ "README.md": "Fine.\n" });
    const nested = join(root, ".fleet");

    await Bun.write(join(nested, "README.md"), "One; two.\n");
    Bun.spawnSync(["git", "init", "--quiet"], { cwd: nested });

    try {
      expect(markdownFiles(root)).toEqual(["README.md"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("names the folder when git cannot list it", async () => {
    const root = await mkdtemp(join(tmpdir(), "check-prose-"));

    try {
      expect(() => markdownFiles(root)).toThrow(
        `Unable to list *.md with git in ${root}:`,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("annotation", () => {
  test("attaches the problem to its file and line", () => {
    expect(
      annotation({
        path: "docs/guide.md",
        line: 3,
        message: "has a semicolon. Split it into two sentences.",
      }),
    ).toBe(
      "::error file=docs/guide.md,line=3::docs/guide.md:3 has a semicolon. Split it into two sentences.",
    );
  });
});

describe("main", () => {
  test("passes on the hub", async () => {
    const log = spyOn(console, "log").mockImplementation(() => undefined);

    try {
      expect(await main(HUB)).toBe(0);
    } finally {
      log.mockRestore();
    }
  });

  test("fails and reports each problem", async () => {
    const root = await gitRepo({ "README.md": "One — two.\n" });
    const error = spyOn(console, "error").mockImplementation(() => undefined);

    try {
      expect(await main(root)).toBe(1);
      expect(error).toHaveBeenCalledWith(
        "::error file=README.md,line=1::README.md:1 has an em dash. Use parentheses or split the sentence.",
      );
    } finally {
      error.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("checks the working directory when run from another repository", async () => {
    const root = await gitRepo({ "README.md": "One; two.\n" });

    try {
      const run = Bun.spawnSync(
        ["bun", join(import.meta.dir, "check-prose.ts")],
        { cwd: root },
      );

      expect(run.exitCode).toBe(1);
      expect(run.stderr.toString()).toContain(
        "::error file=README.md,line=1::",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
