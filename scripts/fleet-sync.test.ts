import { describe, expect, spyOn, test } from "bun:test";
import { readdir, rm } from "node:fs/promises";
import { join, relative } from "node:path";

import {
  FLEET_DIR,
  FLEET_FILES,
  compareWithFleet,
  driftReport,
  isProfile,
  main,
  syncStatus,
  syncWithFleet,
} from "./fleet-sync";
import { gitRepo } from "./test-support";

const HUB = join(import.meta.dir, "..");

const bytes = (text: string) => new TextEncoder().encode(text);

// Silences the CLI's output and hands back what it printed.
function captureOutput() {
  const log = spyOn(console, "log").mockImplementation(() => undefined);
  const error = spyOn(console, "error").mockImplementation(() => undefined);

  return {
    logged: () => log.mock.calls.map((call) => call.join(" ")),
    errors: () => error.mock.calls.map((call) => call.join(" ")),
    restore: () => {
      log.mockRestore();
      error.mockRestore();
    },
  };
}

describe("FLEET_FILES", () => {
  test("every listed source exists under fleet/", async () => {
    const sources = Object.values(FLEET_FILES)
      .flat()
      .map(({ source }) => join(FLEET_DIR, source));

    const present = await Promise.all(
      sources.map((source) => Bun.file(source).exists()),
    );

    expect(present.every(Boolean)).toBe(true);
  });

  test("every file under fleet/ except the README belongs to a profile", async () => {
    const entries = await readdir(FLEET_DIR, {
      recursive: true,
      withFileTypes: true,
    });
    const files = entries
      .filter((entry) => entry.isFile())
      .map((entry) => relative(FLEET_DIR, join(entry.parentPath, entry.name)))
      .filter((path) => path !== "README.md")
      .toSorted();

    const listed = [
      ...new Set(
        Object.values(FLEET_FILES)
          .flat()
          .map(({ source }) => source),
      ),
    ].toSorted();

    expect(files).toEqual(listed);
  });

  test("the code profile carries every prose file", () => {
    const codeTargets = FLEET_FILES.code.map(({ target }) => target);

    for (const { target } of FLEET_FILES.prose) {
      expect(codeTargets).toContain(target);
    }
  });

  test("no target is listed twice in a profile", () => {
    for (const files of Object.values(FLEET_FILES)) {
      const targets = files.map(({ target }) => target);

      expect(new Set(targets).size).toBe(targets.length);
    }
  });
});

describe("the hub", () => {
  test("syncs itself: its root files equal fleet/ for the code profile", async () => {
    const statuses = await compareWithFleet(HUB, "code");

    expect(statuses.filter(({ status }) => status !== "same")).toEqual([]);
  });
});

describe("isProfile", () => {
  test.each<[unknown, boolean]>([
    ["code", true],
    ["prose", true],
    ["Code", false],
    ["", false],
    [undefined, false],
  ])("%p is %p", (value, expected) => {
    expect(isProfile(value)).toBe(expected);
  });
});

describe("syncStatus", () => {
  test("is same for identical bytes", () => {
    expect(syncStatus(bytes("a\n"), bytes("a\n"))).toBe("same");
  });

  test("is drifted when one byte differs, even trailing whitespace", () => {
    expect(syncStatus(bytes("a\n"), bytes("a \n"))).toBe("drifted");
  });

  test("is missing when the target has no file", () => {
    expect(syncStatus(bytes("a\n"), null)).toBe("missing");
  });
});

describe("driftReport", () => {
  test("names each file that differs and the command that fixes it", () => {
    const report = driftReport(
      [
        { target: "bunfig.toml", source: "shared/bunfig.toml", status: "same" },
        {
          target: "lefthook.yml",
          source: "code/lefthook.yml",
          status: "drifted",
        },
        {
          target: ".github/dependabot.yml",
          source: "shared/.github/dependabot.yml",
          status: "missing",
        },
      ],
      "../acme-books",
      "code",
    );

    expect(report).toHaveLength(2);
    expect(report[0]).toStartWith(
      "lefthook.yml differs from fleet/code/lefthook.yml. Run: bun ",
    );
    expect(report[0]).toEndWith("fleet-sync.ts ../acme-books --profile code");
    expect(report[1]).toStartWith(
      ".github/dependabot.yml does not exist. Its canonical copy is fleet/shared/.github/dependabot.yml. Run: bun ",
    );
  });

  test("is empty when every file matches", () => {
    expect(
      driftReport(
        [
          {
            target: "bunfig.toml",
            source: "shared/bunfig.toml",
            status: "same",
          },
        ],
        ".",
        "prose",
      ),
    ).toEqual([]);
  });
});

describe("syncWithFleet", () => {
  test("writes missing and drifted files byte-identical, and leaves the rest", async () => {
    const root = await gitRepo({
      "package.json": '{"name": "acme-books"}\n',
      "lefthook.yml": "pre-commit: {}\n",
    });

    try {
      const before = await syncWithFleet(root, "prose");

      expect(
        Object.fromEntries(
          before.map(({ target, status }) => [target, status]),
        ),
      ).toEqual({
        ".oxfmtrc.json": "missing",
        ".markdownlint-cli2.jsonc": "missing",
        "bunfig.toml": "missing",
        ".github/dependabot.yml": "missing",
        ".github/pull_request_template.md": "missing",
        "lefthook.yml": "drifted",
      });

      const after = await compareWithFleet(root, "prose");

      expect(after.every(({ status }) => status === "same")).toBe(true);
      expect(await Bun.file(join(root, "package.json")).text()).toBe(
        '{"name": "acme-books"}\n',
      );
      expect(await Bun.file(join(root, "tsconfig.json")).exists()).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reads the canonical files from the fleet directory it is given", async () => {
    const fleet = await gitRepo(
      Object.fromEntries(
        FLEET_FILES.prose.map(({ source }) => [
          source,
          `canonical ${source}\n`,
        ]),
      ),
    );
    const root = await gitRepo({});

    try {
      await syncWithFleet(root, "prose", fleet);

      expect(await Bun.file(join(root, "bunfig.toml")).text()).toBe(
        "canonical shared/bunfig.toml\n",
      );
    } finally {
      await rm(fleet, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("main", () => {
  test("--check passes on the hub with the code profile", async () => {
    const output = captureOutput();

    try {
      expect(await main([HUB, "--profile", "code", "--check"])).toBe(0);
      expect(output.logged()).toEqual([
        `${HUB} matches the code profile (8 files).`,
      ]);
    } finally {
      output.restore();
    }
  });

  test("--check fails on a planted drift, names it and the fix, and writes nothing", async () => {
    const root = await gitRepo({});
    const output = captureOutput();

    try {
      expect(await main([root, "--profile", "code"])).toBe(0);
      await Bun.write(join(root, "tsconfig.json"), "{}\n");

      expect(await main([root, "--profile", "code", "--check"])).toBe(1);
      expect(output.errors()).toEqual([
        expect.stringMatching(
          /^tsconfig\.json differs from fleet\/code\/tsconfig\.json\. Run: bun \S*fleet-sync\.ts \S+ --profile code$/,
        ),
      ]);
      expect(await Bun.file(join(root, "tsconfig.json")).text()).toBe("{}\n");
    } finally {
      output.restore();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("syncs and then reports a match", async () => {
    const root = await gitRepo({});
    const output = captureOutput();

    try {
      expect(await main([root, "--profile", "prose"])).toBe(0);
      expect(output.logged()).toContain("wrote     lefthook.yml");
      expect(await main([root, "--profile", "prose"])).toBe(0);
      expect(output.logged()).toContain("unchanged lefthook.yml");
      expect(await main([root, "--profile", "prose", "--check"])).toBe(0);
    } finally {
      output.restore();
      await rm(root, { recursive: true, force: true });
    }
  });

  test.each<[string[], string]>([
    [["--profile", "code"], "Pass exactly one target directory, got 0."],
    [
      [".", "..", "--profile", "code"],
      "Pass exactly one target directory, got 2.",
    ],
    [["."], "The --profile option is undefined. Pass code or prose."],
    [
      [".", "--profile", "php"],
      'The --profile option is "php". Pass code or prose.',
    ],
    [[".", "--profile", "code", "--force"], "Unknown option '--force'"],
  ])("refuses %p", async (argv, message) => {
    const output = captureOutput();

    try {
      expect(await main(argv)).toBe(2);
      expect(output.errors()[0]).toContain(message);
    } finally {
      output.restore();
    }
  });

  test("refuses a directory that is not a repository root", async () => {
    const root = await gitRepo({});
    const output = captureOutput();

    try {
      expect(await main([join(root, "missing"), "--profile", "code"])).toBe(2);
      expect(output.errors()[0]).toStartWith(
        `Unable to find a git repository at ${join(root, "missing")}.`,
      );
    } finally {
      output.restore();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("runs as a CLI and exits 1 on drift", async () => {
    const root = await gitRepo({});

    try {
      const run = Bun.spawnSync([
        "bun",
        join(import.meta.dir, "fleet-sync.ts"),
        root,
        "--profile",
        "prose",
        "--check",
      ]);

      expect(run.exitCode).toBe(1);
      expect(run.stderr.toString()).toContain(
        "lefthook.yml does not exist. Its canonical copy is fleet/prose/lefthook.yml.",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
