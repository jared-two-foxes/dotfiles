// Default validator for recognized test runners. A zero exit with no tests is not success.
import { readFile, lstat } from 'node:fs/promises';
try {
  if (Number(process.env.CONDUCTOR_COMMAND_EXIT_CODE) !== 0) throw new Error('Test command failed');
  let output = '';
  for (const key of ['CONDUCTOR_COMMAND_STDOUT_PATH', 'CONDUCTOR_COMMAND_STDERR_PATH']) {
    const file = process.env[key], info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024) throw new Error('Unsafe test evidence');
    output += await readFile(file, 'utf8'); output += '\n';
  }
  const positive = /\b[1-9]\d*[ \t]+(?:passed|passing|tests?[ \t]+passed)\b|\b(?:pass|passed)[ \t]*[:=]?[ \t]*[1-9]\d*\b/i;
  if (!positive.test(output)) throw new Error('Meaningful test coverage missing: no positive completed test count');
  process.exitCode = 0;
} catch (error) { console.error(error.message); process.exitCode = 1; }
