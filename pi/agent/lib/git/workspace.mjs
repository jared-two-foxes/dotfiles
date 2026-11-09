// Scratch space for runs: Conductor command lists and logs, verification boundaries, finalization
// and issue handoffs. It is working data, not evidence (evidence lives in the Scaffold ledger), and
// it lives in `.scaffold/work/`, which is ignored and untracked, never inside `.git`.
import path from "node:path";
import { mkdir } from "node:fs/promises";

export const workDirectory = (repository, name) => path.join(repository, ".scaffold", "work", name);

export async function ensureWorkDirectory(repository, name) {
  const directory = workDirectory(repository, name);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return directory;
}
