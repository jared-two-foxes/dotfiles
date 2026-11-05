// Execute an external tool only against the exact retained input files.
import { createHash } from 'node:crypto';
import { readFile, lstat } from 'node:fs/promises';
import { spawn } from 'node:child_process';

async function verify(inputs) {
  for (const { file, sha256 } of inputs) {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() ||
        createHash('sha256').update(await readFile(file)).digest('hex') !== sha256)
      throw new Error('Retained tool input changed: ' + file);
  }
}

async function main() {
  const { program, args, inputs } = JSON.parse(process.argv[2]);
  if (typeof program !== 'string' || !program || !Array.isArray(args) ||
      !Array.isArray(inputs)) throw new Error('Invalid guarded command');
  await verify(inputs);
  const code = await new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd: process.cwd(), shell: false, windowsHide: true,
      stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('error', reject);
    child.on('close', (exitCode, signal) => signal || exitCode === null ? reject(new Error('Tool interrupted')) : resolve(exitCode));
  });
  await verify(inputs);
  process.exitCode = code;
}

main().catch(error => {
  console.error(error.message);
  console.log(JSON.stringify({ schema: 'pi.tool-invocation-error/v1',
    category: error.code === 'ENOENT' ? 'invocation' : 'evidence_integrity',
    code: error.code === 'ENOENT' ? 'EXECUTABLE_NOT_FOUND' : 'GUARDED_TOOL_FAILED' }));
  process.exitCode = 125;
});
