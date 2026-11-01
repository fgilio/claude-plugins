import { describe, expect, spyOn, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { captureOutput, gitRepo } from "./test-support";
import {
  annotation,
  frontmatterProblems,
  hooksProblems,
  linkTargets,
  main,
  missingLinkTargets,
  validatePlugin,
} from "./validate-plugin";

const HUB = join(import.meta.dir, "..");

const SKILL_PATH = "skills/demo/SKILL.md";

function skill(frontmatter: string): string {
  return `---\n${frontmatter}\n---\n\n# Demo\n`;
}

describe("frontmatterProblems", () => {
  test("accepts a complete frontmatter", () => {
    expect(
      frontmatterProblems(
        SKILL_PATH,
        skill(
          [
            "name: demo",
            "description: >",
            "  Does one thing.",
            "  Use when it matters.",
            "user-invocable: true",
            "disable-model-invocation: false",
            "argument-hint: '[scope]'",
            "allowed-tools: Bash(git:*)",
          ].join("\n"),
        ),
      ),
    ).toEqual([]);
  });

  test("accepts allowed-tools as a list", () => {
    expect(
      frontmatterProblems(
        SKILL_PATH,
        skill("name: demo\ndescription: Does it.\nallowed-tools: [Read, Grep]"),
      ),
    ).toEqual([]);
  });

  test("names a missing frontmatter", () => {
    expect(frontmatterProblems(SKILL_PATH, "# Demo\n")).toEqual([
      "has no frontmatter. Start the file with a --- block that sets name and description.",
    ]);
  });

  test("names frontmatter that is not valid YAML", () => {
    const [problem] = frontmatterProblems(
      SKILL_PATH,
      skill("name: [unclosed\ndescription: x"),
    );

    expect(problem).toStartWith("has frontmatter that is not valid YAML (");
    expect(problem).toEndWith("Claude Code skips the skill without an error.");
  });

  test("names frontmatter that is not a mapping", () => {
    expect(frontmatterProblems(SKILL_PATH, skill("- a\n- b"))).toEqual([
      "has frontmatter that is not a YAML mapping of keys to values.",
    ]);
  });

  test.each<[string, string]>([
    [
      "name: other\ndescription: Does it.",
      'sets name to "other". Set it to "demo", the name of its directory.',
    ],
    [
      "description: Does it.",
      'sets name to undefined. Set it to "demo", the name of its directory.',
    ],
    [
      "name: demo",
      "has no description. Add one line that says what the skill does and when to use it.",
    ],
    [
      "name: demo\ndescription: '  '",
      "has no description. Add one line that says what the skill does and when to use it.",
    ],
    [
      "name: demo\ndescription: |\n  One.\n  Two.",
      "has a description that spans several lines once parsed. Write it as one paragraph (a folded > block or a single line).",
    ],
    [
      "name: demo\ndescription: Does it.\nuser-invocable: 'yes'",
      'sets user-invocable to "yes". Set it to true or false.',
    ],
    [
      "name: demo\ndescription: Does it.\ndisable-model-invocation: 1",
      "sets disable-model-invocation to 1. Set it to true or false.",
    ],
    [
      "name: demo\ndescription: Does it.\nargument-hint: [a, b]",
      'sets argument-hint to ["a","b"]. Set it to a string.',
    ],
    [
      "name: demo\ndescription: Does it.\nallowed-tools: {Bash: true}",
      "sets allowed-tools to a value that is neither a string nor a list of strings.",
    ],
  ])("flags %p", (frontmatter, problem) => {
    expect(frontmatterProblems(SKILL_PATH, skill(frontmatter))).toEqual([
      problem,
    ]);
  });
});

describe("hooksProblems", () => {
  test("accepts command hooks", () => {
    expect(
      hooksProblems(
        JSON.stringify({
          description: "Runs at session start.",
          hooks: {
            SessionStart: [
              { hooks: [{ type: "command", command: "true", timeout: 30 }] },
            ],
            PreToolUse: [
              {
                matcher: "Bash",
                hooks: [{ type: "command", command: "true" }],
              },
            ],
          },
        }),
      ),
    ).toEqual([]);
  });

  test("accepts hook modules", () => {
    expect(hooksProblems('{"modules": ["./register.ts"]}')).toEqual([]);
  });

  test.each<[string, string]>([
    ["{", "does not parse as JSON ("],
    ["[]", "is not a JSON object."],
    ["{}", 'sets neither "hooks" nor "modules".'],
    ['{"modules": "./register.ts"}', 'sets "modules" to something other'],
    ['{"hooks": []}', 'sets "hooks" to something other than an object.'],
    [
      '{"hooks": {"SessionStart": {}}}',
      "sets SessionStart to something other than a list.",
    ],
    [
      '{"hooks": {"SessionStart": ["x"]}}',
      "has a SessionStart entry that is not an object.",
    ],
    [
      '{"hooks": {"PreToolUse": [{"matcher": 1, "hooks": []}]}}',
      "has a PreToolUse matcher that is not a string.",
    ],
    [
      '{"hooks": {"SessionStart": [{}]}}',
      "has a SessionStart entry without a hooks list.",
    ],
    [
      '{"hooks": {"SessionStart": [{"hooks": [{}]}]}}',
      "has a SessionStart hook without a type.",
    ],
    [
      '{"hooks": {"SessionStart": [{"hooks": [{"type": "command"}]}]}}',
      "has a SessionStart command hook without a command string.",
    ],
    [
      '{"hooks": {"SessionStart": [{"hooks": [{"type": "command", "command": "x", "timeout": "30"}]}]}}',
      "has a SessionStart hook whose timeout is not a number of seconds.",
    ],
  ])("flags %p", (text, problem) => {
    const problems = hooksProblems(text);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toStartWith(problem);
  });
});

describe("missingLinkTargets", () => {
  test("returns relative targets that point at no file", async () => {
    const root = await gitRepo({
      "README.md": "",
      "docs/guide.md": "",
      "docs/my file.md": "",
    });

    try {
      const markdown = [
        "[ok](guide.md) [ok](../README.md#usage) [ok](/README.md)",
        "[ok](my%20file.md) [ok](#local) [ok](https://example.com/x.md)",
        "[ok](mailto:books@example.com) ![ok](guide.md)",
        "[missing](gone.md) ![missing](/img/logo.png)",
        "",
        "`[not a link](gone.md)`",
        "",
        "```",
        "[not a link](gone.md)",
        "```",
      ].join("\n");

      expect(missingLinkTargets(root, "docs/guide.md", markdown)).toEqual([
        { target: "gone.md", line: 4 },
        { target: "/img/logo.png", line: 4 },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("linkTargets", () => {
  test("names the line of each link and skips a link in a code fence", () => {
    const markdown = [
      "# Guide",
      "",
      "```md",
      "[fenced](gone.md)",
      "```",
      "",
      "See [the guide](gone.md).",
      "",
      "> Quoted [link](quoted.md).",
      "",
      "Then ![a logo](",
      "  img/logo.png) and [a reference][ref].",
      "",
      "[ref]: refs/target.md",
    ].join("\n");

    expect(linkTargets(markdown)).toEqual([
      { target: "gone.md", line: 7 },
      { target: "quoted.md", line: 9 },
      { target: "img/logo.png", line: 11 },
      { target: "refs/target.md", line: 14 },
    ]);
  });

  test("names the definition line of a reference link used before it", () => {
    expect(
      linkTargets("[ref]: first.md\n\nUse [it][ref], then [this](first.md)."),
    ).toEqual([
      { target: "first.md", line: 1 },
      { target: "first.md", line: 3 },
    ]);
  });

  test("names the inline link, never an unused definition with the same path before it", () => {
    expect(
      linkTargets("[unused]: missing.md\n\n[broken](missing.md)\n"),
    ).toEqual([{ target: "missing.md", line: 3 }]);
  });

  test("names the definition a reference link uses, never an unused one before it", () => {
    expect(
      linkTargets("[unused]: missing.md\n[used]: missing.md\n\n[link][used]\n"),
    ).toEqual([{ target: "missing.md", line: 2 }]);
  });

  test("skips an escaped bracket that only looks like a link", () => {
    expect(
      linkTargets(
        "Write \\[example](missing.md) for a link.\n\n[real](missing.md)\n",
      ),
    ).toEqual([{ target: "missing.md", line: 3 }]);
  });

  test("keeps the line of each link after a reference-style badge", () => {
    expect(
      linkTargets(
        "[![CI][badge]](https://example.com/ci)\n\n[badge]: https://example.com/ci.svg\n\nSee [one](one.md).\n",
      ),
    ).toEqual([
      { target: "https://example.com/ci.svg", line: 3 },
      { target: "https://example.com/ci", line: 1 },
      { target: "one.md", line: 5 },
    ]);
  });

  test("locates only the targets it is asked for", () => {
    expect(
      linkTargets("[a](a.md) [b](b.md)\n", (target) => target === "b.md"),
    ).toEqual([
      { target: "a.md", line: undefined },
      { target: "b.md", line: 1 },
    ]);
  });

  test("leaves the line out when the source writes the destination differently", () => {
    expect(linkTargets("See <https://example.com/x>.")).toEqual([
      { target: "https://example.com/x", line: undefined },
    ]);
  });
});

describe("missing links in main", () => {
  test("report the line of each one", async () => {
    const root = await gitRepo({
      "README.md": [
        "# Demo",
        "",
        "```md",
        "[fenced](fenced-gone.md)",
        "```",
        "",
        "See [one](one.md).",
        "",
        "And [two](two.md).",
      ].join("\n"),
    });
    const output = captureOutput();

    try {
      expect(await main(root)).toBe(1);
      expect(output.errors()).toEqual([
        "::error file=README.md,line=7::README.md:7 links to one.md, which does not exist. Fix the path or remove the link.",
        "::error file=README.md,line=9::README.md:9 links to two.md, which does not exist. Fix the path or remove the link.",
      ]);
    } finally {
      output.restore();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("malformed percent escapes", () => {
  test("report a missing link instead of throwing", async () => {
    const root = await gitRepo({ "README.md": "See [50%](docs/50%.md).\n" });
    const output = captureOutput();

    try {
      expect(await main(root)).toBe(1);
      expect(output.errors()).toEqual([
        "::error file=README.md,line=1::README.md:1 links to docs/50%.md, which does not exist. Fix the path or remove the link.",
      ]);
    } finally {
      output.restore();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("resolve to a file named with a literal percent sign", async () => {
    const root = await gitRepo({
      "README.md": "See [50%](docs/50%.md) and [half](docs/50%25%20off.md).\n",
      "docs/50%.md": "",
      "docs/50% off.md": "",
    });

    try {
      expect(
        missingLinkTargets(
          root,
          "README.md",
          "[50%](docs/50%.md) [half](docs/50%25%20off.md)",
        ),
      ).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("validatePlugin", () => {
  test("checks skills, every Markdown link and the hooks file", async () => {
    const root = await gitRepo({
      ".gitignore": "node_modules\n",
      "README.md":
        "See [the skill](skills/demo/SKILL.md) and [gone](gone.md).\n",
      "skills/demo/SKILL.md": skill("name: demo\ndescription: Does it."),
      "skills/other/SKILL.md": skill("name: demo\ndescription: Does it."),
      "skills/other/reference.md": skill("name: whatever"),
      "hooks/hooks.json": "{}",
      "node_modules/dep/README.md": "[gone](gone.md)\n",
    });

    try {
      expect(await validatePlugin(root)).toEqual({
        checked: 5,
        problems: [
          {
            path: "README.md",
            line: 1,
            message:
              "links to gone.md, which does not exist. Fix the path or remove the link.",
          },
          {
            path: "skills/other/SKILL.md",
            message:
              'sets name to "demo". Set it to "other", the name of its directory.',
          },
          {
            path: "hooks/hooks.json",
            message: 'sets neither "hooks" nor "modules".',
          },
        ],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("annotation", () => {
  test("attaches the problem to its file and line", () => {
    expect(
      annotation({
        path: "README.md",
        line: 3,
        message: "links to gone.md.",
      }),
    ).toBe("::error file=README.md,line=3::README.md:3 links to gone.md.");
  });

  test("attaches the problem to its file", () => {
    expect(
      annotation({
        path: "hooks/hooks.json",
        message: "is not a JSON object.",
      }),
    ).toBe(
      "::error file=hooks/hooks.json::hooks/hooks.json is not a JSON object.",
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
    const root = await gitRepo({ "skills/demo/SKILL.md": "# Demo\n" });
    const error = spyOn(console, "error").mockImplementation(() => undefined);

    try {
      expect(await main(root)).toBe(1);
      expect(error).toHaveBeenCalledWith(
        "::error file=skills/demo/SKILL.md::skills/demo/SKILL.md has no frontmatter. Start the file with a --- block that sets name and description.",
      );
    } finally {
      error.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });
});
