// Checks for .claude-plugin/marketplace.json and the files that repeat its
// plugin list. scripts/marketplace.test.ts runs them on the hub.

export interface PluginEntry {
  name: string;
  description: string;
  repo: string;
}

const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const GITHUB_REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function pluginProblems(plugin: unknown, index: number): string[] {
  const at = `plugins[${index}]`;

  if (!isRecord(plugin)) {
    return [`${at} is not an object.`];
  }

  const problems: string[] = [];
  const { name, description, source } = plugin;

  if (!isNonEmptyString(name) || !KEBAB_CASE.test(name)) {
    problems.push(
      `${at}.name is ${JSON.stringify(name)}. Use a kebab-case name such as "acme-books".`,
    );
  }

  if (!isNonEmptyString(description)) {
    problems.push(
      `${at}.description is missing. Copy the description from the plugin's plugin.json.`,
    );
  }

  if (
    !isRecord(source) ||
    source["source"] !== "github" ||
    typeof source["repo"] !== "string" ||
    !GITHUB_REPO.test(source["repo"])
  ) {
    problems.push(
      `${at}.source is ${JSON.stringify(source)}. Use {"source": "github", "repo": "owner/name"}.`,
    );
  }

  return problems;
}

/**
 * Checks the fields Claude Code reads from a marketplace manifest. Returns
 * one message per problem, each naming the field and the fix.
 */
export function marketplaceProblems(marketplace: unknown): string[] {
  if (!isRecord(marketplace)) {
    return ["The marketplace manifest is not a JSON object."];
  }

  const problems: string[] = [];
  const { name, owner, description, plugins } = marketplace;

  if (!isNonEmptyString(name) || !KEBAB_CASE.test(name)) {
    problems.push(
      `name is ${JSON.stringify(name)}. Use a kebab-case marketplace name.`,
    );
  }

  if (!isRecord(owner) || !isNonEmptyString(owner["name"])) {
    problems.push('owner needs a name, such as {"name": "Acme Books"}.');
  }

  if (description !== undefined && !isNonEmptyString(description)) {
    problems.push("description is empty. Describe the marketplace or drop it.");
  }

  if (!Array.isArray(plugins) || plugins.length === 0) {
    return [...problems, "plugins needs at least one plugin entry."];
  }

  problems.push(...plugins.flatMap(pluginProblems));

  const names = plugins.flatMap((plugin: unknown) =>
    isRecord(plugin) && typeof plugin["name"] === "string"
      ? [plugin["name"]]
      : [],
  );

  for (const duplicate of new Set(
    names.filter((pluginName, index) => names.indexOf(pluginName) !== index),
  )) {
    problems.push(`plugins lists ${duplicate} more than once.`);
  }

  return problems;
}

/**
 * The plugin entries of a marketplace manifest that marketplaceProblems
 * accepts.
 */
export function pluginEntries(marketplace: unknown): PluginEntry[] {
  if (!isRecord(marketplace) || !Array.isArray(marketplace["plugins"])) {
    return [];
  }

  return marketplace["plugins"].flatMap((plugin: unknown) => {
    if (!isRecord(plugin) || !isRecord(plugin["source"])) {
      return [];
    }

    const { name, description } = plugin;
    const { repo } = plugin["source"];

    return typeof name === "string" &&
      typeof description === "string" &&
      typeof repo === "string"
      ? [{ name, description, repo }]
      : [];
  });
}

/**
 * Compares a marketplace entry with the plugin.json in its repository.
 * The marketplace copies name and description, so both must match.
 */
export function manifestMismatches(
  entry: PluginEntry,
  manifest: unknown,
  marketplaceNames: string[],
): string[] {
  if (!isRecord(manifest)) {
    return [`${entry.repo}: .claude-plugin/plugin.json is not a JSON object.`];
  }

  const problems: string[] = [];

  if (manifest["name"] !== entry.name) {
    problems.push(
      `${entry.repo}: plugin.json names the plugin ${JSON.stringify(manifest["name"])}, the marketplace lists it as ${JSON.stringify(entry.name)}. Make them equal.`,
    );
  }

  if (manifest["description"] !== entry.description) {
    problems.push(
      `${entry.repo}: the marketplace description of ${entry.name} differs from plugin.json. Set it to ${JSON.stringify(manifest["description"])}.`,
    );
  }

  const dependencies = manifest["dependencies"] ?? [];

  if (!Array.isArray(dependencies)) {
    problems.push(
      `${entry.repo}: plugin.json dependencies is not a list of plugin names.`,
    );
  } else {
    for (const dependency of dependencies) {
      if (
        typeof dependency !== "string" ||
        !marketplaceNames.includes(dependency)
      ) {
        problems.push(
          `${entry.repo}: plugin.json depends on ${JSON.stringify(dependency)}, which the marketplace does not list.`,
        );
      }
    }
  }

  return problems;
}

/**
 * The plugin names cloud-setup.sh installs, from its FGILIO_PLUGINS array.
 */
export function cloudSetupPlugins(script: string): string[] {
  const list = /^readonly FGILIO_PLUGINS=\(([^)]*)\)$/m.exec(script)?.[1];

  if (list === undefined) {
    throw new Error(
      "Unable to find the readonly FGILIO_PLUGINS=(...) line in cloud-setup.sh. Keep the plugin list on that one line.",
    );
  }

  return list.split(/\s+/).filter((name) => name !== "");
}

/**
 * Plugin names the README's plugin list shows in bold, as "**name**".
 */
export function readmePlugins(readme: string): string[] {
  return [...readme.matchAll(/^- \*\*([a-z0-9-]+)\*\*/gm)].flatMap(([, name]) =>
    name === undefined ? [] : [name],
  );
}
