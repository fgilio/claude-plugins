# Fleet standards

Every repository in this marketplace (the hub and each plugin) checks its code and docs the same way. This directory holds the canonical config files, and [`scripts/fleet-sync.ts`](../scripts/fleet-sync.ts) copies them into each repository byte-identical. The checks themselves run in one shared workflow, [`fleet-ci.yml`](../.github/workflows/fleet-ci.yml), that each repository calls from its own `ci.yml`.

The hub follows the same standard, and a test fails when its own files drift from this directory.

## Profiles

Each repository picks one profile:

- **prose**: skill-only repositories with Markdown and JSON. Format, Markdown lint, prose rules and plugin validation.
- **code**: repositories with TypeScript. Everything in prose, plus lint, type checks and tests.

| File | prose | code | Canonical copy |
| --- | --- | --- | --- |
| `.oxfmtrc.json` | yes | yes | [shared/.oxfmtrc.json](shared/.oxfmtrc.json) |
| `.markdownlint-cli2.jsonc` | yes | yes | [shared/.markdownlint-cli2.jsonc](shared/.markdownlint-cli2.jsonc) |
| `bunfig.toml` | yes | yes | [shared/bunfig.toml](shared/bunfig.toml) |
| `.github/dependabot.yml` | yes | yes | [shared/.github/dependabot.yml](shared/.github/dependabot.yml) |
| `.github/pull_request_template.md` | yes | yes | [shared/.github/pull_request_template.md](shared/.github/pull_request_template.md) |
| `lefthook.yml` | format and Markdown | adds the TypeScript fixers | [prose/lefthook.yml](prose/lefthook.yml), [code/lefthook.yml](code/lefthook.yml) |
| `tsconfig.json` | no | yes | [code/tsconfig.json](code/tsconfig.json) |
| `.oxlintrc.json` | no | yes | [code/.oxlintrc.json](code/.oxlintrc.json) |

`package.json` and `.github/workflows/ci.yml` follow a fixed shape (below) but stay per repository, since the package name and the profile differ.

## Adopt the standard

Copy the files for your profile from a checkout of this hub:

```bash
bun scripts/fleet-sync.ts ../acme-books-skill --profile prose
```

Add the `package.json` for your profile. Every tool is pinned to an exact version, and `bun install` writes `bun.lock`:

```json
{
  "name": "acme-books-skill",
  "private": true,
  "type": "module",
  "packageManager": "bun@1.4.4",
  "scripts": {
    "check": "bun run fmt:check && bun run lint:md",
    "fmt": "oxfmt",
    "fmt:check": "oxfmt --check",
    "lint:md": "markdownlint-cli2"
  },
  "trustedDependencies": ["lefthook"],
  "devDependencies": {
    "lefthook": "2.2.2",
    "markdownlint-cli2": "0.24.0",
    "oxfmt": "0.75.0"
  }
}
```

The code profile adds `lint`, `lint:fix`, `typecheck`, `check:prose`, `knip` and `bun test` to the scripts, and `typescript` 7.0.2, `oxlint` 1.90.0, `oxlint-tsgolint` 7.0.2005, `@types/bun`, `@tsconfig/strictest` 2.0.8, `@tsconfig/bun` 1.0.11 and `knip` 6.44.1 to the dev dependencies. The hub's own [package.json](../package.json) is the reference.

Then call the shared workflow from `.github/workflows/ci.yml`, pinned to the full SHA of a commit on the hub's `main`:

```yaml
name: CI

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]
  workflow_dispatch:

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}

permissions:
  contents: read

jobs:
  checks:
    uses: fgilio/claude-plugins/.github/workflows/fleet-ci.yml@<commit-sha> # fleet-ci
    with:
      profile: prose
  ci-success:
    if: ${{ !cancelled() }}
    needs: [checks]
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: re-actors/alls-green@b5b5b37504aa4183270bd3d855c52a67f212be35 # v1.3.0
        with:
          jobs: ${{ toJSON(needs) }}
```

`ci-success` is the one required status check on `main`. Adding or renaming a gate in the shared workflow never touches a repository's ruleset.

To check a repository for drift, add `--check`. It exits 1 and prints each file that differs, with the command that fixes it:

```bash
bun scripts/fleet-sync.ts ../acme-books-skill --profile prose --check
```

## What each check enforces

### Formatting: oxfmt

`oxfmt --check` must pass on the whole tree. The config keeps each Markdown paragraph on one line (`proseWrap: never`), leaves code blocks inside Markdown alone, and keeps YAML wrapping as written. It came from the fleet's earlier Prettier config through `oxfmt --migrate prettier`, and both formatters agreed on the same tree before Prettier was removed.

### Lint: oxlint, type-aware

The `correctness`, `suspicious` and `perf` categories are errors, with the TypeScript, unicorn, oxc, import and node plugins. On top of them:

- `eqeqeq`: compare with `===`.
- `no-unused-vars`: an unused name is an error. Prefix an argument with `_` when a signature needs it.
- `typescript/consistent-type-imports`: import types with `import type`, so the import disappears at runtime.
- `typescript/switch-exhaustiveness-check`: a `switch` over a union handles every member.
- `typescript/restrict-template-expressions`: a template interpolates strings and numbers, never an object that prints as `[object Object]`.
- `typescript/consistent-type-assertions` with `assertionStyle: never`: `x as T` is an error. Write a type guard or validate the value. `as const` stays allowed. Where a cast is the only way, disable the rule on that line with the reason on the line above.

Test fixtures are linted too. When a fixture must break a rule, add an `overrides` entry for its path with the reason in a `//` comment.

### Types: tsc

`tsc --noEmit` runs with `@tsconfig/strictest` and then `@tsconfig/bun`. The effective flags, from `tsc --showConfig`:

- On: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `isolatedModules`, `verbatimModuleSyntax`, `allowUnreachableCode: false`, `allowUnusedLabels: false`, `erasableSyntaxOnly`, `allowJs` with `checkJs`.
- Off: `noUnusedLocals` and `noUnusedParameters` (oxlint reports unused names, so tsc does not report them twice), `noPropertyAccessFromIndexSignature` (so `process.env.TOKEN` reads plainly).
- Module settings from `@tsconfig/bun`: `module: preserve`, `moduleResolution: bundler`, `target: esnext`, `types: ["bun"]`.

`erasableSyntaxOnly` rules out enums, parameter properties and namespaces with code, so every script runs under Bun as written, with no build step.

### Markdown: markdownlint

Every rule is on except line length (`MD013`), since the formatter keeps paragraphs on one line. The PR template is skipped because it is a copy of an upstream file whose body starts with a `Closes:` line.

### Prose

[`scripts/check-prose.ts`](../scripts/check-prose.ts) reads every Markdown file a commit could carry and flags, in prose only (code, code spans, HTML, link targets and quotes are skipped):

- an em dash, or a hyphen or en dash between spaces used as a separator. Use parentheses or split the sentence.
- a semicolon. Split it into two sentences.
- curly quotes. Use straight quotes.
- filler such as `it's worth noting`, `leverage` or `utilize`. Say it plainly.
- `invariant`. Say "rule" or "guarantee".

Each finding names the file and line, and CI attaches it to that line of the diff.

### Plugin

The plugin job validates what Claude Code loads:

- `claude plugin validate .`, from a pinned Claude Code release, checks the plugin or marketplace manifest, skills, agents, commands and hooks.
- [`scripts/validate-plugin.ts`](../scripts/validate-plugin.ts) adds what that command lets through: a `SKILL.md` whose frontmatter does not parse (Claude Code skips the skill without an error), a `name` that differs from the skill's directory, a missing or multi-line description, `user-invocable` or `disable-model-invocation` set to something other than a boolean, a malformed `hooks/hooks.json`, and a relative Markdown link to a missing file.
- [`scripts/validate-json.ts`](../scripts/validate-json.ts) parses every `*.json` and `*.jsonc` file (and the `.json` files their tools read as JSONC, such as `tsconfig.json`) and prints the parser's message.

A repository without a plugin turns the job off with `plugin: false`.

### Workflows: actionlint and zizmor

actionlint checks every workflow's syntax, expressions and inline scripts. zizmor audits them for security problems, such as a template expression in a `run:` script or a checkout that keeps its token. Any finding fails the job.

### Shell

With `shell: true`, ShellCheck runs on every tracked `*.sh` file.

## The pre-commit hook

`bun install` installs a lefthook pre-commit hook, through the `lefthook` package's install script (the only dependency trusted to run one). On the staged files it:

- runs `oxlint --fix`, then `oxfmt`, on TypeScript (code profile), and adds the fixes to the commit.
- runs `oxfmt` on JSON, JSONC, Markdown and YAML, and adds the fixes to the commit.
- runs markdownlint on Markdown.

A lint error the fixer cannot fix stops the commit. Type checks and tests run in CI only, so a commit stays fast. Never bypass the hook with `--no-verify`.

## Supply chain

- Every tool is an exact version in `package.json`, and `bun.lock` records its integrity hash. CI installs with `bun install --frozen-lockfile`.
- `bunfig.toml` refuses to resolve a release younger than 14 days, and Dependabot waits the same 14 days before it proposes one. It opens at most one grouped pull request a month for packages and one for actions, and never merges on its own.
- Every action is pinned by full commit SHA with its version in a comment, every checkout drops its token (`persist-credentials: false`), and every workflow starts with read-only `contents` permission.
- Tools the workflow downloads (Claude Code, actionlint) are pinned by version and checked against a SHA-256. Bump them by hand in `fleet-ci.yml`.

## The main branch

Each repository protects `main` with a ruleset: changes land through a pull request, `ci-success` must pass on a branch that is up to date with `main`, merges are squash only with linear history, and nobody can force-push, delete the branch or bypass the rules.

## Pull requests

The template is a copy of the public [Publica.la pull request template](https://github.com/publicala/.github/blob/main/PULL_REQUEST_TEMPLATE.md). The title is an imperative sentence that reads on its own in `git log`.

## Change the standard

Edit the file here, run `bun scripts/fleet-sync.ts . --profile code` so the hub's own copy matches, and open a pull request. The hub's CI runs `fleet-ci.yml` from the same commit, so the change proves itself before it merges. After it merges, each repository moves its `fleet-ci.yml` pin to the new commit and runs `fleet-sync` again.
