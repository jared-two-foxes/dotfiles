// Conductor v2 transport. Domain policy lives here in the caller, not in the runner.
// Keep this file identical to opencode/scripts/conductor-protocol.mjs: both homes
// are independently installable and must not import each other's deployment.
import { mkdir, mkdtemp, writeFile, readFile, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual as equal } from 'node:util';

const requireValue = (ok, message) => { if (!ok) throw new Error(message); };
const exits = { PASSED: 0, FAILED: 1, BLOCKED: 2 };
const digest = value => createHash('sha256').update(value).digest('hex');
const guard = fileURLToPath(new URL('./input-guard.mjs', import.meta.url));
function guarded(name, program, args, files) {
  return { name, program: process.execPath, args: [guard, JSON.stringify({ program, args,
    inputs: files.map(([file, contents]) => ({ file, sha256: digest(contents) })) })] };
}

export function validateWorkflowPreparation(args) {
  reviewArguments(args, 'review.json', '.');
  for (const program of [process.env.EXECUTOR_BIN ?? 'executor', process.env.REVIEW_CLI_BIN ?? 'review-cli'])
    requireValue(typeof program === 'string' && program.trim() && !program.includes('\0'), 'Invalid tool executable');
  requireValue(Array.isArray(JSON.parse(args.input).operations), 'Invalid Executor operations');
}

function reviewArguments(args, requestPath, directory) {
  const model = args.reviewModel ?? 'opencode/gpt-6.1-sol';
  requireValue(typeof model === 'string' && model.trim() && !model.includes('\0') && model.length <= 512, 'Invalid review model');
  for (const field of ['reviewWallClockBudgetSecs', 'reviewMaxTurns', 'reviewMaxToolCalls', 'reviewMaxRepeatedActions', 'reviewMaxCompletionAttempts']) {
    requireValue(args[field] == null || (Number.isSafeInteger(args[field]) && args[field] > 0), 'Invalid ' + field);
  }
  requireValue(args.reviewMaxCostUsd == null || (typeof args.reviewMaxCostUsd === 'number' &&
    Number.isFinite(args.reviewMaxCostUsd) && args.reviewMaxCostUsd >= 0), 'Invalid reviewMaxCostUsd');
  const result = ['run', '--request', requestPath, '--format', 'json',
    '--model', model,
    '--wall-clock-budget-secs', String(args.reviewWallClockBudgetSecs ?? 180),
    '--max-turns', String(args.reviewMaxTurns ?? 20),
    '--ledger', path.join(directory, 'review-ledger.jsonl')];
  for (const [field, flag] of [
    ['reviewMaxCostUsd', '--max-cost-usd'], ['reviewMaxToolCalls', '--max-tool-calls'],
    ['reviewMaxRepeatedActions', '--max-repeated-actions'],
    ['reviewMaxCompletionAttempts', '--max-completion-attempts'],
  ]) if (args[field] != null) result.push(flag, String(args[field]));
  return result;
}

export async function prepareWorkflow(repository, root, args, checks) {
  validateWorkflowPreparation(args);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const stat = await lstat(root);
  requireValue(stat.isDirectory() && !stat.isSymbolicLink(), 'Unsafe Conductor runs directory');
  const directory = await realpath(await mkdtemp(path.join(root, 'attempt-')));
  const inputs = {
    execution: JSON.parse(args.input), requirements: args.requirements,
    review: { schema: 'review.request/v1', repository_path: repository,
      base_ref: args.baseRef, head_ref: ':working', requirements: path.join(directory, 'requirements.md') },
  };
  await writeFile(path.join(directory, 'executor.json'), JSON.stringify(inputs.execution), { mode: 0o600, flag: 'wx' });
  await writeFile(inputs.review.requirements, inputs.requirements, { mode: 0o600, flag: 'wx' });
  await writeFile(path.join(directory, 'review.json'), JSON.stringify(inputs.review), { mode: 0o600, flag: 'wx' });
  const request = {
    schema: 'conductor.request/v2', working_directory: repository, output_directory: directory,
    commands: [
      guarded('executor', process.env.EXECUTOR_BIN ?? 'executor', ['apply', path.join(directory, 'executor.json')],
        [[path.join(directory, 'executor.json'), JSON.stringify(inputs.execution)]]),
      ...checks,
      guarded('review', process.env.REVIEW_CLI_BIN ?? 'review-cli',
        reviewArguments(args, path.join(directory, 'review.json'), directory),
        [[path.join(directory, 'review.json'), JSON.stringify(inputs.review)], [inputs.review.requirements, inputs.requirements]]),
    ],
  };
  return { request, inputs };
}

// Authenticate retained request contents without depending on mutable request/log
// files still being present. The receipt retains these inputs and parsed tool output.
export function authenticateWorkflow(workflow, request, args, repository) {
  requireValue(equal(workflow?.request, request) && request.schema === 'conductor.request/v2' &&
    request.working_directory === repository && path.isAbsolute(request.output_directory), 'Retained workflow mismatch');
  const directory = request.output_directory;
  requireValue(equal(workflow.inputs.execution, JSON.parse(args.input)) && workflow.inputs.requirements === args.requirements &&
    equal(workflow.inputs.review, { schema: 'review.request/v1', repository_path: repository,
      base_ref: args.baseRef, head_ref: ':working', requirements: path.join(directory, 'requirements.md') }), 'Retained tool input mismatch');
  const first = request.commands[0], last = request.commands.at(-1);
  const executorProgram = JSON.parse(first.args[1]).program;
  const reviewProgram = JSON.parse(last.args[1]).program;
  requireValue([executorProgram, reviewProgram].every(program =>
    typeof program === 'string' && program.trim() && !program.includes('\0')) &&
    equal(first, guarded('executor', executorProgram, ['apply', path.join(directory, 'executor.json')],
    [[path.join(directory, 'executor.json'), JSON.stringify(workflow.inputs.execution)]])) &&
    equal(last, guarded('review', reviewProgram,
      reviewArguments(args, path.join(directory, 'review.json'), directory),
      [[path.join(directory, 'review.json'), JSON.stringify(workflow.inputs.review)], [workflow.inputs.review.requirements, workflow.inputs.requirements]])) &&
    first.args[0] === guard && last.args[0] === guard,
  'Retained Executor/Review invocation mismatch');
  return request.commands.slice(1, -1);
}

export function validateRunner(request, runner, code, expectedSchema = 'conductor.result/v2') {
  requireValue(runner?.schema === expectedSchema && Object.hasOwn(exits, runner.status) &&
    exits[runner.status] === code && Array.isArray(runner.commands), 'Conductor schema/status/exit code mismatch');
  const commands = runner.commands;
  requireValue(commands.length <= request.commands.length, 'Unexpected Conductor commands');
  for (const [index, result] of commands.entries()) {
    const expected = request.commands[index];
    requireValue(result.index === index && result.name === expected.name && result.program === expected.program &&
      equal(result.args, expected.args) && Object.hasOwn(exits, result.status) &&
      typeof result.stdout === 'string' && typeof result.stderr === 'string' &&
      typeof result.stdout_truncated === 'boolean' && typeof result.stderr_truncated === 'boolean',
    'Conductor command identity/output mismatch');
    if (index < commands.length - 1 || runner.status === 'PASSED') {
      requireValue(result.status === 'PASSED' && result.exit_code === 0 && !result.error,
        'Conductor continued after a failed command');
    }
  }
  if (runner.status === 'PASSED') {
    requireValue(runner.phase === 'completed' && commands.length === request.commands.length &&
      runner.failed_command_index === undefined && !runner.error, 'Incomplete Conductor success');
  } else if (commands.length) {
    const failed = commands.at(-1);
    requireValue(runner.phase === 'commands' && runner.failed_command_index === commands.length - 1 &&
      failed.status === runner.status && (runner.status !== 'FAILED' ||
        failed.exit_code === null || (Number.isInteger(failed.exit_code) && failed.exit_code !== 0)),
    'Conductor failure location/status mismatch');
  } else {
    requireValue(runner.status === 'BLOCKED' && ['input', 'output'].includes(runner.phase) &&
      runner.failed_command_index === undefined, 'Missing Conductor failure record');
  }
}

function reviewResult(value, code) {
  const expected = { APPROVED: 0, CHANGES_REQUESTED: 1, INDETERMINATE: 3 };
  requireValue(value?.schema === 'review.result/v1' && Object.hasOwn(expected, value.status) &&
    expected[value.status] === code && Array.isArray(value.findings) &&
    typeof value.reason === 'string' && value.reason.trim() &&
    typeof value.review_id === 'string' && value.review_id.trim() &&
    typeof value.completed_at === 'string' && value.completed_at.trim(), 'Review schema/status/exit code mismatch');
  requireValue(value.status === 'INDETERMINATE' || value.reason === 'REVIEW_COMPLETED', 'Review did not complete');
  for (const finding of value.findings) requireValue(finding && typeof finding.blocking === 'boolean' &&
    typeof finding.message === 'string' && finding.message.trim() && ['high', 'medium', 'low'].includes(finding.severity) &&
    (finding.path == null || typeof finding.path === 'string') &&
    (finding.line == null || (Number.isInteger(finding.line) && finding.line >= 0)) &&
    (finding.recommendation == null || typeof finding.recommendation === 'string'),
  'Invalid Review finding');
  const blocking = value.findings.some(f => f.blocking);
  requireValue(value.status === 'INDETERMINATE' || (value.status === 'APPROVED' ? !blocking : blocking), 'Review verdict contradicts findings');
  return value;
}

// Pure reconstruction also authenticates the immutable normalized receipt later.
export function normalizeWorkflow(request, runner, toolOutputs, code, expectedSchema = 'conductor.result/v2', expectedOperations) {
  validateRunner(request, runner, code, expectedSchema);
  requireValue(Number.isSafeInteger(expectedOperations) && expectedOperations >= 0, 'Missing retained operation count');
  if (expectedSchema === 'pi.command-results/v1') {
    requireValue(Array.isArray(runner.receipts) && runner.receipts.length === runner.commands.length, 'Missing command receipts');
    for (const [index, record] of runner.commands.entries()) {
      const receipt = runner.receipts[index];
      if (!receipt) { requireValue(record.status === 'BLOCKED', 'Missing successful command receipt'); continue; }
      requireValue(receipt.schema === 'pi.command-receipt/v1' && receipt.index === index &&
        receipt.name === record.name && receipt.program === record.program && equal(receipt.args, record.args) &&
        receipt.exit_code === record.exit_code &&
        receipt.status === (receipt.error || receipt.signal || receipt.exit_code === null ? 'BLOCKED' : receipt.exit_code === 0 ? 'PASSED' : 'FAILED') &&
        (record.status === 'BLOCKED' || receipt.status === record.status), 'Command receipt mismatch');
    }
  }
  const results = runner.commands;
  let execution = null, review = null, status = 'BLOCKED', phase = 'execution';
  if (results[0]?.exit_code != null) {
    execution = JSON.parse(toolOutputs.execution);
    requireValue(typeof execution?.success === 'boolean' && Number.isInteger(execution.operations_applied) &&
      execution.operations_applied >= 0 && results[0].exit_code === (execution.success ? 0 : 1) &&
      (!execution.success || execution.operations_applied === expectedOperations), 'Executor outcome/exit code/count mismatch');
  }
  const checks = results.slice(1, request.commands.length - 1);
  if (results.length > 1) phase = 'verification';
  if (results.length === request.commands.length) {
    phase = 'review';
    const last = results.at(-1);
    // Validation/setup errors from Review are BLOCKED, not correction requests.
    if (last.exit_code != null && [0, 1, 3].includes(last.exit_code)) review = reviewResult(JSON.parse(toolOutputs.review), last.exit_code);
  }
  if (runner.status !== 'BLOCKED') {
    if (phase === 'review') status = review?.status === 'APPROVED' && runner.status === 'PASSED'
      ? 'PASSED' : review?.status === 'CHANGES_REQUESTED' ? 'NEEDS_DESIGN' : 'BLOCKED';
    else if (runner.status === 'FAILED') status = results.at(-1)?.exit_code == null ? 'BLOCKED' : 'NEEDS_DESIGN';
  }
  return { schema: 'pi.conductor-result/v1', status, phase, execution, checks, review,
    request, runner, toolOutputs, expectedOperations, ...(runner.error ? { error: runner.error } : {}) };
}

export async function toolOutput(request, runner, record) {
  if (!record || record.exit_code == null) return undefined;
  if (!record.stdout_path) {
    requireValue(!record.stdout_truncated, 'Complete tool output unavailable; upgrade Conductor for retained logs');
    return record.stdout;
  }
  const file = record.stdout_path;
  requireValue(typeof file === 'string' && path.isAbsolute(file) && typeof runner.output_directory === 'string', 'Invalid command log path');
  const root = await realpath(request.output_directory), logs = await realpath(runner.output_directory);
  const relative = path.relative(root, logs);
  requireValue(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Command logs outside retained attempt');
  const stat = await lstat(file);
  requireValue(stat.isFile() && !stat.isSymbolicLink() && await realpath(file) ===
    path.join(logs, String(record.index).padStart(6, '0') + '.stdout'), 'Unsafe command log');
  // Only structured Executor/Review output is loaded. Arbitrarily large check
  // diagnostics stay in their complete log files, outside model context/receipts.
  requireValue(stat.size <= 16 * 1024 * 1024, 'Structured tool output exceeds 16 MiB; inspect retained logs');
  return new TextDecoder('utf-8', { fatal: true }).decode(await readFile(file));
}

export async function decodeWorkflow(request, response, inputs) {
  const runner = JSON.parse(response.stdout);
  validateRunner(request, runner, response.code);
  const toolOutputs = {};
  const execution = await toolOutput(request, runner, runner.commands[0]);
  if (execution !== undefined) toolOutputs.execution = execution;
  if (runner.commands.length === request.commands.length) {
    const review = await toolOutput(request, runner, runner.commands.at(-1));
    if (review !== undefined) toolOutputs.review = review;
  }
  return normalizeWorkflow(request, runner, toolOutputs, response.code, 'conductor.result/v2', inputs.execution.operations.length);
}

export function authenticNormalized(conductor) {
  try {
    const schema = conductor.runner.schema;
    if (!['conductor.result/v2', 'pi.command-results/v1'].includes(schema)) return false;
    return equal(conductor, normalizeWorkflow(conductor.request, conductor.runner, conductor.toolOutputs,
      exits[conductor.runner.status], schema, conductor.expectedOperations));
  }
  catch { return false; }
}

export function executionSummary(result) {
  if (result.actualResult) return { ...result, actualResult: executionSummary(result.actualResult) };
  const c = result.conductor;
  if (!c || c.schema !== 'pi.conductor-result/v1') {
    if (!result.response) return result;
    const { request, response, ...summary } = result;
    return { ...summary, response: { code: response.code, stderr: response.stderr?.slice(0, 2000) },
      note: 'Raw protocol and request retained in evidence; inspect before retrying.' };
  }
  return { ...result, conductor: { status: c.status, phase: c.phase, execution: c.execution,
    checks: c.checks.map(check => ({ name: check.name, exit_code: check.exit_code,
      stdout: check.stdout.slice(0, 2000), stderr: check.stderr.slice(0, 2000),
      stdout_path: check.stdout_path, stderr_path: check.stderr_path })),
    review: c.review && { status: c.review.status, reason: c.review.reason, review_id: c.review.review_id,
      findings: c.review.findings.slice(0, 24).map(f => ({ ...f, message: f.message.slice(0, 1000) })),
      excerpted: c.review.findings.length > 24 || c.review.findings.some(f => f.message.length > 1000) },
    failed_command: c.runner.failed_command_index === undefined ? undefined : c.runner.commands.at(-1),
    error: c.error, output_directory: c.runner.output_directory,
    note: 'Complete diagnostics and raw protocol are retained in the evidence/log files.' } };
}
