import { describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import {
  cloudSetupPlugins,
  main,
  manifestMismatches,
  marketplaceProblems,
  pluginEntries,
  readmePlugins,
  sourceProblems,
  type PluginEntry,
} from "./marketplace";
import { captureOutput, gitRepo } from "./test-support";

const ROOT = join(import.meta.dir, "..");

const marketplace: unknown = await Bun.file(
  join(ROOT, ".claude-plugin/marketplace.json"),
).json();

const entries = pluginEntries(marketplace);

const names = entries.map(({ name }) => name);

describe("the hub's marketplace", () => {
  test("has every field Claude Code reads", () => {
    expect(marketplaceProblems(marketplace)).toEqual([]);
    expect(entries.length).toBeGreaterThan(0);
  });

  test("cloud-setup.sh installs only plugins the marketplace lists", async () => {
    const installed = cloudSetupPlugins(
      await Bun.file(join(ROOT, "cloud-setup.sh")).text(),
    );

    expect(installed.length).toBeGreaterThan(0);
    expect(installed.filter((name) => !names.includes(name))).toEqual([]);
  });

  test("the README lists every plugin, in the marketplace's order", async () => {
    expect(
      readmePlugins(await Bun.file(join(ROOT, "README.md")).text()),
    ).toEqual(names);
  });
});

const ENTRY: PluginEntry = {
  name: "acme-books",
  description: "Reads Acme Books catalogs.",
  repo: "acme/acme-books-skill",
};

const VALID_MARKETPLACE = {
  name: "acme",
  owner: { name: "Acme Books" },
  plugins: [
    {
      name: "acme-books",
      source: { source: "github", repo: "acme/acme-books-skill" },
      description: "Reads Acme Books catalogs.",
    },
  ],
};

describe("marketplaceProblems", () => {
  test("accepts a valid manifest", () => {
    expect(marketplaceProblems(VALID_MARKETPLACE)).toEqual([]);
  });

  test.each<[string, unknown, string]>([
    ["a non-object", [], "The marketplace manifest is not a JSON object."],
    [
      "a name with spaces",
      { ...VALID_MARKETPLACE, name: "Acme Books" },
      'name is "Acme Books". Use a kebab-case marketplace name.',
    ],
    [
      "a missing owner",
      { ...VALID_MARKETPLACE, owner: undefined },
      'owner needs a name, such as {"name": "Acme Books"}.',
    ],
    [
      "an empty description",
      { ...VALID_MARKETPLACE, description: " " },
      "description is empty. Describe the marketplace or drop it.",
    ],
    [
      "no plugins",
      { ...VALID_MARKETPLACE, plugins: [] },
      "plugins needs at least one plugin entry.",
    ],
    [
      "a plugin that is not an object",
      { ...VALID_MARKETPLACE, plugins: ["acme-books"] },
      "plugins[0] is not an object.",
    ],
    [
      "a plugin name that is not kebab-case",
      {
        ...VALID_MARKETPLACE,
        plugins: [{ ...VALID_MARKETPLACE.plugins[0], name: "AcmeBooks" }],
      },
      'plugins[0].name is "AcmeBooks". Use a kebab-case name such as "acme-books".',
    ],
    [
      "a plugin without a description",
      {
        ...VALID_MARKETPLACE,
        plugins: [{ ...VALID_MARKETPLACE.plugins[0], description: "" }],
      },
      "plugins[0].description is missing. Copy the description from the plugin's plugin.json.",
    ],
    [
      "a source that is not a GitHub repository",
      {
        ...VALID_MARKETPLACE,
        plugins: [
          {
            ...VALID_MARKETPLACE.plugins[0],
            source: { source: "url", url: "https://example.com" },
          },
        ],
      },
      'plugins[0].source is {"source":"url","url":"https://example.com"}. Use {"source": "github", "repo": "owner/name"}.',
    ],
    [
      "a plugin listed twice",
      {
        ...VALID_MARKETPLACE,
        plugins: [VALID_MARKETPLACE.plugins[0], VALID_MARKETPLACE.plugins[0]],
      },
      "plugins lists acme-books more than once.",
    ],
  ])("flags %s", (_case, manifest, problem) => {
    expect(marketplaceProblems(manifest)).toEqual([problem]);
  });
});

describe("pluginEntries", () => {
  test("reads name, description and repository", () => {
    expect(pluginEntries(VALID_MARKETPLACE)).toEqual([ENTRY]);
  });

  test("skips entries without a GitHub source", () => {
    expect(
      pluginEntries({ plugins: [{ name: "a", description: "b" }, null] }),
    ).toEqual([]);
  });
});

describe("manifestMismatches", () => {
  test("accepts a matching manifest whose dependencies are listed", () => {
    expect(
      manifestMismatches(
        { ...ENTRY, name: "acme-reader" },
        {
          name: "acme-reader",
          description: ENTRY.description,
          dependencies: ["acme-books"],
        },
        ["acme-books", "acme-reader"],
      ),
    ).toEqual([]);
  });

  test("names a different description and the value to copy", () => {
    expect(
      manifestMismatches(
        ENTRY,
        { name: "acme-books", description: "Reads catalogs." },
        ["acme-books"],
      ),
    ).toEqual([
      'acme/acme-books-skill: the marketplace description of acme-books differs from plugin.json. Set it to "Reads catalogs.".',
    ]);
  });

  test("names a different plugin name", () => {
    expect(
      manifestMismatches(
        ENTRY,
        { name: "books", description: ENTRY.description },
        ["acme-books"],
      ),
    ).toEqual([
      'acme/acme-books-skill: plugin.json names the plugin "books", the marketplace lists it as "acme-books". Make them equal.',
    ]);
  });

  test("names a dependency the marketplace does not list", () => {
    expect(
      manifestMismatches(
        ENTRY,
        {
          name: "acme-books",
          description: ENTRY.description,
          dependencies: ["coding"],
        },
        ["acme-books"],
      ),
    ).toEqual([
      'acme/acme-books-skill: plugin.json depends on "coding", which the marketplace does not list.',
    ]);
  });

  test("rejects dependencies that are not a list", () => {
    expect(
      manifestMismatches(
        ENTRY,
        {
          name: "acme-books",
          description: ENTRY.description,
          dependencies: "coding",
        },
        ["acme-books"],
      ),
    ).toEqual([
      "acme/acme-books-skill: plugin.json dependencies is not a list of plugin names.",
    ]);
  });

  test("rejects a manifest that is not an object", () => {
    expect(manifestMismatches(ENTRY, null, [])).toEqual([
      "acme/acme-books-skill: .claude-plugin/plugin.json is not a JSON object.",
    ]);
  });
});

describe("cloudSetupPlugins", () => {
  test("reads the FGILIO_PLUGINS array", () => {
    expect(
      cloudSetupPlugins(
        "set -u\nreadonly FGILIO_PLUGINS=(coding  polish)\nreadonly X=1\n",
      ),
    ).toEqual(["coding", "polish"]);
  });

  test("names the line it expects when the array is missing", () => {
    expect(() => cloudSetupPlugins("set -u\n")).toThrow(
      "Unable to find the readonly FGILIO_PLUGINS=(...) line in cloud-setup.sh.",
    );
  });
});

describe("readmePlugins", () => {
  test("reads the bold plugin names of the list", () => {
    expect(
      readmePlugins(
        "# Acme\n\n- **acme-books** (link): reads.\n- **acme-reader**: shows.\n\nSee **bold** text.\n",
      ),
    ).toEqual(["acme-books", "acme-reader"]);
  });
});

describe("sourceProblems", () => {
  test("is empty when every plugin.json matches its entry", async () => {
    expect(
      await sourceProblems(VALID_MARKETPLACE, async () => ({
        name: "acme-books",
        description: "Reads Acme Books catalogs.",
      })),
    ).toEqual([]);
  });

  test("names a repository it cannot read", async () => {
    expect(
      await sourceProblems(VALID_MARKETPLACE, async (repo) => {
        throw new Error(`${repo} has no .claude-plugin/plugin.json`);
      }),
    ).toEqual(["acme/acme-books-skill has no .claude-plugin/plugin.json"]);
  });
});

async function marketplaceRepo(): Promise<string> {
  return gitRepo({
    ".claude-plugin/marketplace.json": JSON.stringify(VALID_MARKETPLACE),
  });
}

describe("main", () => {
  test("--check-sources passes when every source matches", async () => {
    const root = await marketplaceRepo();
    const output = captureOutput();

    try {
      expect(
        await main(["--check-sources", root], async () => ({
          name: "acme-books",
          description: "Reads Acme Books catalogs.",
        })),
      ).toBe(0);
    } finally {
      output.restore();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("--check-sources fails with one annotation per mismatch, naming the value to copy", async () => {
    const root = await marketplaceRepo();
    const output = captureOutput();

    try {
      expect(
        await main(["--check-sources", root], async () => ({
          name: "acme-books",
          description: "Reads catalogs.",
        })),
      ).toBe(1);
      expect(output.errors()).toEqual([
        '::error file=.claude-plugin/marketplace.json::acme/acme-books-skill: the marketplace description of acme-books differs from plugin.json. Set it to "Reads catalogs.".',
      ]);
    } finally {
      output.restore();
      await rm(root, { recursive: true, force: true });
    }
  });

  test.each<[string[]]>([[[]], [["--check-sources", "a", "b"]], [["--force"]]])(
    "refuses %p",
    async (argv) => {
      const output = captureOutput();

      try {
        expect(await main(argv, async () => null)).toBe(2);
        expect(output.errors()).toContain(
          "Usage: bun scripts/marketplace.ts --check-sources [repository]",
        );
      } finally {
        output.restore();
      }
    },
  );
});
