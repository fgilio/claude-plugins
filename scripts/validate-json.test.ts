import { describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  annotation,
  isJsonc,
  jsonFiles,
  main,
  parseError,
  validateJson,
} from "./validate-json";
import { gitRepo } from "./test-support";

const HUB = join(import.meta.dir, "..");

describe("isJsonc", () => {
  test.each<[string, boolean]>([
    ["wrangler.jsonc", true],
    ["tsconfig.json", true],
    ["packages/app/tsconfig.build.json", true],
    [".oxlintrc.json", true],
    [".oxfmtrc.json", true],
    ["package.json", false],
    [".claude-plugin/plugin.json", false],
  ])("%p is %p", (path, expected) => {
    expect(isJsonc(path)).toBe(expected);
  });
});

describe("parseError", () => {
  test("accepts valid JSON", () => {
    expect(parseError("package.json", '{"name": "acme-books"}')).toBeNull();
  });

  test("returns the parser's message for invalid JSON", () => {
    expect(parseError("package.json", '{"name": "acme-books",}')).toContain(
      "JSON Parse error",
    );
  });

  test("rejects a comment in a strict JSON file", () => {
    expect(parseError("plugin.json", '{\n  // note\n  "a": 1\n}')).toContain(
      "JSON Parse error",
    );
  });

  test("accepts comments and trailing commas in JSONC", () => {
    expect(
      parseError("wrangler.jsonc", '{\n  // note\n  "a": 1,\n}'),
    ).toBeNull();
  });

  test("returns the parser's message for invalid JSONC", () => {
    expect(parseError("wrangler.jsonc", '{"a": }')).toContain(
      "JSONC Parse error",
    );
  });
});

describe("validateJson", () => {
  test("parses every JSON and JSONC file git would commit", async () => {
    const root = await gitRepo({
      ".gitignore": "node_modules\nignored.json\n",
      "package.json": '{"name": "acme-books"}\n',
      ".claude-plugin/plugin.json": '{"name": "demo",}\n',
      "worker/wrangler.jsonc": '{\n  // a comment\n  "name": "demo",\n}\n',
      "node_modules/dep/package.json": "{",
      "ignored.json": "{",
    });

    try {
      const { checked, problems } = await validateJson(root);

      expect(checked).toBe(3);
      expect(problems.map(({ path }) => path)).toEqual([
        ".claude-plugin/plugin.json",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("names the folder when git cannot list it", async () => {
    const root = await mkdtemp(join(tmpdir(), "validate-json-"));

    try {
      expect(() => jsonFiles(root)).toThrow(
        `Unable to list *.json, *.jsonc with git in ${root}:`,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("annotation", () => {
  test("names the file, the format and the parser's message", () => {
    expect(
      annotation({
        path: "wrangler.jsonc",
        message: "JSONC Parse error: Unexpected }",
      }),
    ).toBe(
      "::error file=wrangler.jsonc::wrangler.jsonc does not parse as JSONC: JSONC Parse error: Unexpected }",
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

  test("fails and reports each file that does not parse", async () => {
    const root = await gitRepo({ "package.json": "{" });
    const error = spyOn(console, "error").mockImplementation(() => undefined);

    try {
      expect(await main(root)).toBe(1);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining(
          "::error file=package.json::package.json does not parse as JSON: JSON Parse error",
        ),
      );
    } finally {
      error.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });
});
