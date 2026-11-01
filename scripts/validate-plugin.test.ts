import { describe, expect, spyOn, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { gitRepo } from "./test-support";
import {
  annotation,
  frontmatterProblems,
  hooksProblems,
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
        "gone.md",
        "/img/logo.png",
      ]);
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
