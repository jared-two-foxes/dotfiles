export const conductorFixture = `
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
let input = ''; for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input), commands = [];
const directory = fs.mkdtempSync(path.join(request.output_directory, 'runner-'));
let status = 'PASSED', error;
for (const [index, command] of request.commands.entries()) {
  const stdout_path = path.join(directory, String(index).padStart(6, '0') + '.stdout');
  const stderr_path = path.join(directory, String(index).padStart(6, '0') + '.stderr');
  const out = fs.openSync(stdout_path, 'wx'), err = fs.openSync(stderr_path, 'wx');
  const result = spawnSync(command.program, command.args, { cwd: request.working_directory, stdio: ['ignore', out, err] });
  fs.closeSync(out); fs.closeSync(err);
  status = result.error ? 'BLOCKED' : result.status === 0 ? 'PASSED' : 'FAILED';
  const stdout = fs.readFileSync(stdout_path, 'utf8'), stderr = fs.readFileSync(stderr_path, 'utf8');
  let condition;
  if (command.success_condition && result.status !== null) {
    const spec = command.success_condition;
    const cstdout_path = path.join(directory, String(index).padStart(6, '0') + '.condition.stdout');
    const cstderr_path = path.join(directory, String(index).padStart(6, '0') + '.condition.stderr');
    const co = fs.openSync(cstdout_path, 'wx'), ce = fs.openSync(cstderr_path, 'wx');
    const evaluated = spawnSync(spec.program, spec.args, { cwd: request.working_directory,
      stdio: ['ignore', co, ce], env: { ...process.env, CONDUCTOR_COMMAND_EXIT_CODE: String(result.status),
        CONDUCTOR_COMMAND_STDOUT_PATH: stdout_path, CONDUCTOR_COMMAND_STDERR_PATH: stderr_path,
        CONDUCTOR_COMMAND_INDEX: String(index), CONDUCTOR_COMMAND_NAME: command.name } });
    fs.closeSync(co); fs.closeSync(ce);
    status = evaluated.error ? 'BLOCKED' : evaluated.status === 0 ? 'PASSED' : 'FAILED';
    const cs = fs.readFileSync(cstdout_path, 'utf8'), es = fs.readFileSync(cstderr_path, 'utf8');
    condition = { ...spec, status, exit_code: evaluated.status, stdout: cs.slice(0, 16384), stderr: es.slice(0, 16384),
      stdout_truncated: cs.length > 16384, stderr_truncated: es.length > 16384,
      stdout_path: cstdout_path, stderr_path: cstderr_path };
  }
  commands.push({ ...command, index, status, exit_code: result.status, ...(condition ? { condition } : {}),
    stdout: stdout.slice(0, 16384), stderr: stderr.slice(0, 16384),
    stdout_truncated: stdout.length > 16384, stderr_truncated: stderr.length > 16384, stdout_path, stderr_path });
  if (status !== 'PASSED') { error = 'command failed'; break; }
}
console.log(JSON.stringify({ schema: 'conductor.result/v2', status, commands, output_directory: directory,
  phase: status === 'PASSED' ? 'completed' : 'commands',
  ...(error ? { error, failed_command_index: commands.length - 1 } : {}) }));
process.exitCode = { PASSED: 0, FAILED: 1, BLOCKED: 2 }[status];
`;
export const executorFixture = `
import fs from 'node:fs';
if (process.argv[2] !== 'apply') throw Error('executor invocation');
const input = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
for (const operation of input.operations) {
  if (operation.type !== 'edit_file') throw Error('fixture supports edit_file');
  let text = fs.readFileSync(operation.path, 'utf8');
  for (const edit of operation.edits) text = text.replace(edit.oldText, edit.newText);
  fs.writeFileSync(operation.path, text);
}
fs.appendFileSync('.git/trace', 'executor\\n');
console.log(JSON.stringify({ success: true, operations_applied: input.operations.length, affected_files: ['source.txt'] }));
`;
export const reviewFixture = `
import fs from 'node:fs';
const args = process.argv.slice(2), value = flag => args[args.indexOf(flag) + 1];
const request = JSON.parse(fs.readFileSync(value('--request'), 'utf8'));
if (request.schema !== 'review.request/v1' || (request.head_ref !== ':working' && !/^[a-f0-9]{40}$/.test(request.head_ref)) ||
  (process.env.EXPECTED_REVIEW_REQUIREMENTS !== '*' && fs.readFileSync(request.requirements, 'utf8') !==
    (process.env.EXPECTED_REVIEW_REQUIREMENTS ?? 'Complete immutable review requirements'))) throw Error('review contract');
fs.appendFileSync('.git/trace', 'review\\n');
if (process.env.REVIEW_FIXTURE_TERMINAL_LOCK) fs.writeFileSync(value('--request').slice(0, -'review.json'.length) + 'terminal.lock', 'owned claim');
if (process.env.REVIEW_FIXTURE_LOCK) fs.writeFileSync('.git/index.lock', 'existing lock');
if (process.env.REVIEW_FIXTURE_DRIFT) fs.writeFileSync('source.txt', 'unreviewed drift');
const status = process.env.REVIEW_FIXTURE_STATUS;
if (process.env.REVIEW_FIXTURE_MALFORMED) { console.log('{invalid JSON'); process.exit(0); }
if (process.env.REVIEW_FIXTURE_TAMPER) {
  const file = value('--request').slice(0, -'review.json'.length) + '0.receipt.json';
  const receipt = JSON.parse(fs.readFileSync(file, 'utf8')); receipt.program = 'unverified-command'; fs.writeFileSync(file, JSON.stringify(receipt));
}
console.log(JSON.stringify({ schema: 'review.result/v1', status, review_id: 'external-review',
  reason: status === 'INDETERMINATE' ? 'BUDGET_EXHAUSTED' : 'REVIEW_COMPLETED', completed_at: '2026-11-01T00:00:00Z',
  findings: status === 'CHANGES_REQUESTED' ? [{ severity: 'high', blocking: true, message: 'Correct the edge case' }] : [],
  padding: 'x'.repeat(40000) }));
process.exitCode = { APPROVED: 0, CHANGES_REQUESTED: 1, INDETERMINATE: 3 }[status];
`;

