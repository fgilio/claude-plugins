import { describe, expect, test } from "bun:test";
import { readdir, rm } from "node:fs/promises";
import { join, relative } from "node:path";

import {
  CALLER_WORKFLOW,
  FLEET_DIR,
  FLEET_FILES,
  compareFleetCiPin,
  compareWithFleet,
  driftReport,
  fleetCiRefs,
  isProfile,
  hubWorkflowHistory,
  main,
  type PinStatus,
  shouldMovePin,
  type WorkflowChange,
  type WorkflowHistory,
  parseHubCommit,
  pinDriftReport,
  pinFleetCi,
  pinStatus,
  readHubCommit,
  shellQuote,
  syncStatus,
  syncWithFleet,
} from "./fleet-sync";
import { captureOutput, gitRepo } from "./test-support";

const HUB = join(import.meta.dir, "..");

const bytes = (text: string) => new TextEncoder().encode(text);

const HUB_COMMIT = {
  sha: "abc1234def5678abc1234def5678abc1234def56",
  date: "2026-11-01",
};

const OLD_SHA = "5291614636ea03f3a630c8547f249b26d7e69e2e";

const callCi = (ref: string, comment = " # fleet-ci 2026-10-01") =>
  `    uses: fgilio/claude-plugins/.github/workflows/fleet-ci.yml@${ref}${comment}`;

const callerWorkflow = (ref: string) =>
  [
    "jobs:",
    "  checks:",
    callCi(ref),
    "    with:",
    "      profile: code",
    "",
  ].join("\n");

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

describe("shellQuote", () => {
  test.each<[string, string]>([
    ["../acme-books", "../acme-books"],
    ["scripts/fleet-sync.ts", "scripts/fleet-sync.ts"],
    ["my repo", "'my repo'"],
    ["it's", "'it'\\''s'"],
    ["", "''"],
  ])("%p becomes %p", (value, quoted) => {
    expect(shellQuote(value)).toBe(quoted);
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

  test("quotes a target directory with a space, and leaves a plain one", () => {
    const drifted = [
      {
        target: "lefthook.yml",
        source: "code/lefthook.yml",
        status: "drifted" as const,
      },
    ];

    expect(driftReport(drifted, "../my repo", "code")[0]).toEndWith(
      " '../my repo' --profile code",
    );
    expect(driftReport(drifted, "../acme-books", "code")[0]).toEndWith(
      " ../acme-books --profile code",
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

describe("parseHubCommit", () => {
  test("reads the full SHA and the date git log prints", () => {
    expect(parseHubCommit(`${HUB_COMMIT.sha}\n2026-11-01\n`)).toEqual(
      HUB_COMMIT,
    );
  });

  test.each(["", "abc1234\n2026-11-01", `${HUB_COMMIT.sha}\n`])(
    "refuses %p",
    (stdout) => {
      expect(parseHubCommit(stdout)).toBeUndefined();
    },
  );
});

describe("readHubCommit", () => {
  test("reads the hub's HEAD", () => {
    expect(readHubCommit(HUB)?.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  test("is undefined outside a repository with commits", async () => {
    const root = await gitRepo({});

    try {
      expect(readHubCommit(root)).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("fleetCiRefs", () => {
  test("reads the ref of each call to the hub's fleet-ci.yml", () => {
    expect(
      fleetCiRefs(
        [
          callCi(OLD_SHA),
          "    uses: ./.github/workflows/fleet-ci.yml",
          '    uses: "fgilio/claude-plugins/.github/workflows/fleet-ci.yml@main"',
          "      - uses: re-actors/alls-green@b5b5b37504aa4183270bd3d855c52a67f212be35 # v1.3.0",
          `    # uses: fgilio/claude-plugins/.github/workflows/fleet-ci.yml@${OLD_SHA}`,
        ].join("\n"),
      ),
    ).toEqual([OLD_SHA, "main"]);
  });
});

/** A hub history where only these refs saw fleet-ci.yml or scripts/ change. */
const historyWith =
  (changes: Record<string, WorkflowChange>): WorkflowHistory =>
  (ref) =>
    Promise.resolve(changes[ref] ?? "unchanged");

describe("pinStatus", () => {
  const SHORT = OLD_SHA.slice(0, 7);
  const UNKNOWN_SHA = "f".repeat(40);
  const history = historyWith({ [SHORT]: "changed", [UNKNOWN_SHA]: "unknown" });

  test.each<[string[], PinStatus]>([
    [[], "unpinned"],
    [[HUB_COMMIT.sha], "same"],
    [[HUB_COMMIT.sha, HUB_COMMIT.sha], "same"],
    [[OLD_SHA], "behind"],
    [[UNKNOWN_SHA], "unknown"],
    [[SHORT], "unknown"],
    [["main"], "unknown"],
    [[HUB_COMMIT.sha, OLD_SHA], "behind"],
    [[OLD_SHA, "main"], "unknown"],
  ])("%p is %p", async (refs, status) => {
    expect(await pinStatus(refs, HUB_COMMIT.sha, history)).toBe(status);
  });

  test("is changed when fleet-ci.yml or scripts/ changed since the pin", async () => {
    expect(
      await pinStatus(
        [OLD_SHA],
        HUB_COMMIT.sha,
        historyWith({ [OLD_SHA]: "changed" }),
      ),
    ).toBe("changed");
  });
});

describe("shouldMovePin", () => {
  test.each<[PinStatus, boolean, boolean]>([
    ["changed", false, true],
    ["unknown", false, true],
    ["behind", false, false],
    ["behind", true, true],
    ["same", true, false],
    ["unpinned", true, false],
  ])("%s with files drifted %p is %p", (status, filesDrifted, moves) => {
    expect(shouldMovePin({ refs: [], status }, filesDrifted)).toBe(moves);
  });
});

describe("hubWorkflowHistory", () => {
  test("sees a change under scripts/, ignores a docs-only commit, and reports a commit the hub lacks", async () => {
    const hub = await gitRepo({
      "README.md": "# Hub\n",
      "scripts/check.ts": "export {};\n",
      ".github/workflows/fleet-ci.yml": "name: Fleet CI\n",
    });
    const git = (...args: string[]) =>
      Bun.spawnSync(
        [
          "git",
          "-c",
          "user.name=Acme",
          "-c",
          "user.email=acme@example.com",
          ...args,
        ],
        { cwd: hub },
      )
        .stdout.toString()
        .trim();
    const commit = (path: string, text: string) => {
      Bun.spawnSync(["sh", "-c", `printf '%s' "$1" > "$2"`, "sh", text, path], {
        cwd: hub,
      });
      git("add", ".");
      git("commit", "--quiet", "-m", `Change ${path}`);

      return git("rev-parse", "HEAD");
    };

    try {
      const pinned = commit("README.md", "# Hub\n");
      const history = hubWorkflowHistory(hub);

      commit("README.md", "# Hub, documented\n");
      expect(await history(pinned)).toBe("unchanged");

      commit("scripts/check.ts", "export const checked = true;\n");
      expect(await history(pinned)).toBe("changed");
      expect(await history("f".repeat(40))).toBe("unknown");
    } finally {
      await rm(hub, { recursive: true, force: true });
    }
  });
});

describe("pinFleetCi", () => {
  test("pins every call to the hub commit, dated, and leaves the other lines", () => {
    expect(pinFleetCi(callerWorkflow(OLD_SHA), HUB_COMMIT)).toBe(
      callerWorkflow(HUB_COMMIT.sha).replace("2026-10-01", "2026-11-01"),
    );
  });

  test("keeps the quotes and the line ending, and adds a missing comment", () => {
    expect(
      pinFleetCi(
        '    uses: "fgilio/claude-plugins/.github/workflows/fleet-ci.yml@main"\r\n',
        HUB_COMMIT,
      ),
    ).toBe(
      `    uses: "fgilio/claude-plugins/.github/workflows/fleet-ci.yml@${HUB_COMMIT.sha}" # fleet-ci 2026-11-01\r\n`,
    );
  });
});

describe("pinDriftReport", () => {
  const report = (status: PinStatus, filesDrifted: boolean) =>
    pinDriftReport(
      { refs: [OLD_SHA, OLD_SHA], status },
      filesDrifted,
      HUB_COMMIT.sha,
      "../acme-books",
      "prose",
    );

  test.each<[PinStatus, boolean, string]>([
    [
      "changed",
      false,
      `and .github/workflows/fleet-ci.yml or scripts changed in fgilio/claude-plugins since then (now ${HUB_COMMIT.sha}).`,
    ],
    [
      "unknown",
      false,
      "which is not the full SHA of a commit in fgilio/claude-plugins.",
    ],
    [
      "behind",
      true,
      `and the drifted files above come from fgilio/claude-plugins@${HUB_COMMIT.sha}, so the pin moves with them.`,
    ],
  ])(
    "says why a %s pin moves (files drifted: %p)",
    (status, filesDrifted, reason) => {
      const [line] = report(status, filesDrifted);

      expect(line).toStartWith(
        `.github/workflows/ci.yml pins fleet-ci.yml to ${OLD_SHA}, ${reason} Run: bun `,
      );
      expect(line).toEndWith("fleet-sync.ts ../acme-books --profile prose");
    },
  );

  test.each<[PinStatus, boolean]>([
    ["behind", false],
    ["same", true],
    ["unpinned", true],
  ])("is empty when %s (files drifted: %p)", (status, filesDrifted) => {
    expect(report(status, filesDrifted)).toEqual([]);
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
  test("--check reports a pin older than a change to the workflow, and the sync moves it", async () => {
    const root = await gitRepo({ [CALLER_WORKFLOW]: callerWorkflow(OLD_SHA) });
    const output = captureOutput();
    const options = {
      hub: HUB_COMMIT,
      workflowHistory: historyWith({ [OLD_SHA]: "changed" }),
    };

    try {
      expect(await main([root, "--profile", "code"], options)).toBe(0);
      expect(output.logged()).toContain(
        `wrote     ${CALLER_WORKFLOW} (fleet-ci.yml pin)`,
      );
      await Bun.write(join(root, CALLER_WORKFLOW), callerWorkflow(OLD_SHA));

      expect(await main([root, "--profile", "code", "--check"], options)).toBe(
        1,
      );
      expect(output.errors()).toHaveLength(1);
      expect(output.errors()[0]).toMatch(
        new RegExp(
          `^\\.github/workflows/ci\\.yml pins fleet-ci\\.yml to ${OLD_SHA}, and \\S+ or scripts changed in fgilio/claude-plugins since then \\(now ${HUB_COMMIT.sha}\\)\\. Run: bun \\S*fleet-sync\\.ts \\S+ --profile code$`,
        ),
      );

      expect(await main([root, "--profile", "code"], options)).toBe(0);
      expect(
        await compareFleetCiPin(root, HUB_COMMIT.sha, options.workflowHistory),
      ).toEqual({
        refs: [HUB_COMMIT.sha],
        status: "same",
      });
      expect(await main([root, "--profile", "code", "--check"], options)).toBe(
        0,
      );
      expect(output.logged().at(-1)).toBe(
        `${CALLER_WORKFLOW} pins fleet-ci.yml to ${HUB_COMMIT.sha}.`,
      );
    } finally {
      output.restore();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("leaves a pin behind a docs-only hub commit, and moves it with drifted files", async () => {
    const root = await gitRepo({ [CALLER_WORKFLOW]: callerWorkflow(OLD_SHA) });
    const output = captureOutput();
    const options = { hub: HUB_COMMIT, workflowHistory: historyWith({}) };

    try {
      expect(await main([root, "--profile", "prose"], options)).toBe(0);
      expect(
        fleetCiRefs(await Bun.file(join(root, CALLER_WORKFLOW)).text()),
      ).toEqual([HUB_COMMIT.sha]);

      await Bun.write(join(root, CALLER_WORKFLOW), callerWorkflow(OLD_SHA));
      expect(await main([root, "--profile", "prose", "--check"], options)).toBe(
        0,
      );
      expect(output.logged().at(-1)).toBe(
        `${CALLER_WORKFLOW} pins fleet-ci.yml to ${OLD_SHA}, and neither .github/workflows/fleet-ci.yml nor scripts changed since then.`,
      );

      expect(await main([root, "--profile", "prose"], options)).toBe(0);
      expect(output.logged().at(-1)).toBe(
        `unchanged ${CALLER_WORKFLOW} (fleet-ci.yml pin)`,
      );

      await Bun.write(join(root, "bunfig.toml"), "[install]\n");
      expect(await main([root, "--profile", "prose", "--check"], options)).toBe(
        1,
      );
      expect(output.errors().at(-1)).toContain(
        "and the drifted files above come from",
      );
    } finally {
      output.restore();
      await rm(root, { recursive: true, force: true });
    }
  });

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
      const errors = output.errors();
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(
        /^tsconfig\.json differs from fleet\/code\/tsconfig\.json\. Run: bun \S*fleet-sync\.ts \S+ --profile code$/,
      );
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
