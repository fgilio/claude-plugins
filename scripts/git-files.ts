import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Every file matching the pathspecs that a commit could carry: tracked, or
 * untracked and not ignored, in any directory. A nested repository (such
 * as a second checkout in CI) is skipped, as git skips it.
 */
export function filesGitWouldCommit(
  root: string,
  pathspecs: string[],
): string[] {
  const listed = Bun.spawnSync(
    [
      "git",
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      ...pathspecs,
    ],
    { cwd: root },
  );

  if (!listed.success) {
    throw new Error(
      `Unable to list ${pathspecs.join(", ")} with git in ${root}: ${listed.stderr.toString().trim()}`,
    );
  }

  return [...new Set(listed.stdout.toString().split("\0"))]
    .filter((path) => path !== "" && existsSync(join(root, path)))
    .toSorted();
}
