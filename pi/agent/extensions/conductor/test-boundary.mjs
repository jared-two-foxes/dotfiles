// Transparent task-only final verification command wrapper. Capture the implementation after
// the last approved verification command finishes, before Conductor can start its review.
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { snapshot } from './evidence.mjs';
const { command, repository, output } = JSON.parse(process.argv[2]);
try {
  const code = await new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), {
      cwd: repository, shell: false, windowsHide: true, stdio: ['inherit', 'inherit', 'inherit'],
    });
    child.on('error', reject);
    child.on('exit', code => resolve(code ?? 1));
  });
  if (code !== 0) process.exitCode = code;
  else await writeFile(output, JSON.stringify(await snapshot(repository)), { flag: 'wx', mode: 0o600 });
} catch (error) {
  process.stderr.write('Pi verification boundary failed: ' + error.message + '\n');
  process.exitCode = 1;
}
