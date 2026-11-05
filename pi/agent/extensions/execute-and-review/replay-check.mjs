import { isDeepStrictEqual as equal } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { snapshot } from "../../lib/git/snapshot.mjs";
import { checkEnvironment, reusableCheck } from "../../lib/verification/stage-reuse.mjs";
const requireValue = (ok, message) => { if (!ok) throw new Error(message); };
export async function replayCheck(stage) {
  const { reference, args, source, index, boundaryPath, last } = stage.reuse;
  requireValue(equal(await snapshot(stage.repository), source), 'Source changed before check reuse');
  requireValue(await checkEnvironment(stage.repository, args.checkEnvironmentInputs) === args.checkEnvironment,
    'Environment changed before check reuse');
  const check = await reusableCheck(stage.repository, reference, index, args, source);
  // Actual logs, including truncation checks, remain backed by the retained command.
  const stdout = await readFile(check.stdout_path), stderr = await readFile(check.stderr_path);
  if (last) {
    await writeFile(boundaryPath, JSON.stringify(await snapshot(stage.repository)), { flag: 'wx', mode: 0o600 });
  }
  process.stdout.write(stdout); process.stderr.write(stderr);
  return { exit_code: check.exit_code, signal: null, reusedFrom: { reference, index } };
}
