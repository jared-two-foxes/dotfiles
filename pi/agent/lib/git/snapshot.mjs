import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { implementationTree } from "./tree.mjs";
// Preserve the exact bytes used by historical snapshot fingerprints.
const git = (repository, args) =>
  execFileSync("git", args, {
    cwd: repository, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, windowsHide: true,
  });
const digest = value => createHash("sha256").update(value).digest("hex");
const scope = ["--", ".", ":(exclude).scaffold"];
// Include index, working diff and nonignored untracked contents. Scaffold state
// is bookkeeping, excluded from the implementation baseline. Ignored build
// artifacts are intentionally outside this recovery fingerprint.
export async function snapshot(repository) {
  const status = git(repository, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    ...scope,
  ]);
  const untracked = git(repository, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
    ...scope,
  ])
    .split("\0")
    .filter(Boolean)
    .sort();
  const files = [];
  for (const name of untracked) {
    const stat = await lstat(path.join(repository, name));
    if (!stat.isFile())
      throw new Error("Cannot fingerprint nonregular untracked file: " + name);
    files.push([name, digest(await readFile(path.join(repository, name)))]);
  }
  return {
    tree: await implementationTree(repository),
    head: git(repository, ["rev-parse", "HEAD"]).trim(),
    clean: !status,
    bookkeepingVisible: !!git(repository, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--",
      ".scaffold",
    ]).trim(),
    digest: digest(
      JSON.stringify([
        status,
        git(repository, [
          "diff",
          "--binary",
          "--no-ext-diff",
          "--no-textconv",
          "HEAD",
          ...scope,
        ]),
        git(repository, [
          "diff",
          "--cached",
          "--binary",
          "--no-ext-diff",
          "--no-textconv",
          ...scope,
        ]),
        files,
      ]),
    ),
  };
}
