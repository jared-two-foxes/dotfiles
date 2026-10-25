// Stateless adapter: Scaffold alone reads/writes task state. No execution or retries.
import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

export const OPERATIONS = ['init', 'add', 'list', 'next', 'start', 'complete', 'block', 'fail', 'retry', 'decompose'];
const taskActions = new Set(['start', 'complete', 'block', 'fail', 'retry', 'decompose']);
const inputActions = new Set(['init', 'add', 'complete', 'decompose']);
const reasonActions = new Set(['block', 'fail', 'retry']);
const statuses = new Set(['pending', 'in_progress', 'completed', 'blocked', 'failed', 'decomposed']);
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const text = x => typeof x === 'string' && !!x.trim() && !x.includes('\0');
const strings = x => Array.isArray(x) && x.every(text);
function requireValue(condition, message) { if (!condition) throw new Error(message); }
function fields(value, allowed) {
  requireValue(object(value) && Object.keys(value).every(k => allowed.includes(k)), 'Unexpected or invalid fields');
}
function definition(value, feature = false) {
  fields(value, ['id', 'title', 'objective', 'acceptance_criteria', 'context', 'constraints',
    ...(feature ? ['design_ref'] : ['dependencies'])]);
  requireValue(['id', 'title', 'objective', ...(feature ? ['design_ref'] : [])].every(k => text(value[k])), 'Definition requires nonempty id, title, objective and (for features) design_ref');
  requireValue(strings(value.acceptance_criteria) && value.acceptance_criteria.length > 0, 'acceptance_criteria must be a nonempty string array');
  requireValue(value.context === undefined || typeof value.context === 'string', 'context must be a string');
  requireValue(value.constraints === undefined || strings(value.constraints), 'constraints must be a string array');
  if (!feature) requireValue(value.dependencies === undefined || (strings(value.dependencies) && new Set(value.dependencies).size === value.dependencies.length), 'dependencies must be unique task IDs');
}

/** Validate and construct exactly one tasks command; payloads never become paths. */
export function buildCommand(params) {
  fields(params, ['operation', 'feature_id', 'task_id', 'payload', 'reason']);
  const { operation, feature_id, task_id, payload, reason } = params;
  requireValue(OPERATIONS.includes(operation), 'Unsupported operation');
  requireValue(text(feature_id), 'feature_id is required');
  requireValue(taskActions.has(operation) ? text(task_id) : task_id === undefined, 'task_id is required only for task transitions/decompose');
  requireValue(reasonActions.has(operation) ? text(reason) : reason === undefined, 'reason is required only for block/fail/retry');
  requireValue(inputActions.has(operation) ? payload !== undefined : payload === undefined, 'payload is required only for init/add/complete/decompose');
  if (operation === 'init') {
    definition(payload, true);
    requireValue(payload.id === feature_id, 'Feature payload id must match feature_id');
  } else if (operation === 'add' || operation === 'decompose') {
    requireValue(Array.isArray(payload) && payload.length > 0, 'payload must be a nonempty task array');
    payload.forEach(t => definition(t));
  } else if (operation === 'complete') {
    fields(payload, ['feature_id', 'task_id', 'result', 'source', 'reference', 'summary']);
    requireValue(payload.feature_id === feature_id && payload.task_id === task_id && payload.result === 'PASSED' && ['source', 'reference', 'summary'].every(k => text(payload[k])), 'Completion requires task-bound PASSED evidence with source, reference and summary');
  }
  const args = ['tasks', operation, '--feature=' + feature_id];
  if (taskActions.has(operation)) args.push('--task=' + task_id);
  // Use = to allow free-text reasons beginning with a dash without argparse ambiguity.
  if (reasonActions.has(operation)) args.push('--reason=' + reason);
  if (inputActions.has(operation)) args.push('--input', '-');
  return { args, input: inputActions.has(operation) ? JSON.stringify(payload) : '' };
}

function invoke(program, args, { cwd, signal, input = '' }) {
  return new Promise((resolve, reject) => {
    const child = execFile(program, args, { cwd, signal, shell: false, windowsHide: true,
      encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && (typeof error.code !== 'number' || error.killed)) reject(error);
      else resolve({ code: error?.code ?? 0, stdout, stderr });
    });
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') { child.kill(); reject(error); } });
    child.stdin.end(input);
  });
}

function validateTask(task, featureId, taskId) {
  requireValue(object(task) && text(task.id) && task.feature_id === featureId &&
    (taskId === undefined || task.id === taskId) && statuses.has(task.status) &&
    (task.parent_id === null || text(task.parent_id)) && strings(task.dependencies) &&
    Array.isArray(task.history), 'Invalid task response or task identity mismatch');
}
function validateResponse(data, params) {
  requireValue(object(data), 'Expected JSON object');
  requireValue(data.schema_version === 1, 'Unsupported schema_version');
  requireValue(!Object.hasOwn(data, 'error'), 'Error in successful response');
  const needsFeature = ['init', 'add', 'list', 'next', 'decompose'].includes(params.operation);
  if (needsFeature) {
    requireValue(object(data.feature) && data.feature.id === params.feature_id && object(data.feature.tasks), 'Invalid feature response or feature identity mismatch');
    for (const [id, task] of Object.entries(data.feature.tasks)) validateTask(task, params.feature_id, id);
  }
  if (params.operation === 'next') {
    requireValue(Object.hasOwn(data, 'task'), 'Missing next task');
    if (data.task !== null) {
      validateTask(data.task, params.feature_id);
      requireValue(isDeepStrictEqual(data.task, data.feature.tasks[data.task.id]), 'Next task does not match feature state');
    }
  } else if (!needsFeature) {
    validateTask(data.task, params.feature_id, params.task_id);
    const expected = { start: 'in_progress', complete: 'completed', block: 'blocked', fail: 'failed' }[params.operation];
    requireValue(expected ? data.task.status === expected : ['pending', 'decomposed'].includes(data.task.status), 'Unexpected transition status');
  }
}

// Reject state symlinks, so Scaffold cannot follow them into unrelated directories.
async function checkStatePaths(repository) {
  for (const suffix of ['.scaffold', '.scaffold/tasks.json', '.scaffold/.criteria-stack.lock']) {
    try {
      const stat = await lstat(path.join(repository, suffix));
      requireValue(!stat.isSymbolicLink(), 'Scaffold state paths must not be symlinks');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

/** One explicit lifecycle operation in Pi's current Git repository. Never auto-retry. */
export async function scaffoldTasks(params, context = {}, options = {}) {
  let stage = 'validation';
  const identity = { operation: params?.operation, feature_id: params?.feature_id,
    ...(params?.task_id !== undefined ? { task_id: params.task_id } : {}) };
  const failure = (reason, message, extra = {}) => ({ ok: false, ...identity, reason, message, ...extra });
  try {
    const command = buildCommand(params);
    stage = 'repository';
    requireValue(text(context.directory), 'Pi current directory is required');
    const cwd = await realpath(context.directory);
    const git = await invoke('git', ['rev-parse', '--show-toplevel'], { cwd, signal: context.abort });
    requireValue(git.code === 0, 'Current directory must be inside the target Git repository');
    const repository = await realpath(git.stdout.trim());
    await checkStatePaths(repository);
    stage = 'command';
    const response = await (options.invokeScaffold ?? invoke)('scaffold', command.args,
      { cwd: repository, signal: context.abort, input: command.input });
    if (response.code !== 0) {
      let error;
      try { error = JSON.parse(response.stderr); } catch {}
      return failure('COMMAND_FAILED', 'Scaffold command failed; inspect persisted state before retrying',
        { exit_code: response.code, stderr: response.stderr?.slice(0, 4000),
          ...(object(error) ? { scaffold_error: error } : {}) });
    }
    stage = 'response';
    let data;
    try { data = JSON.parse(response.stdout); }
    catch { return failure('INVALID_JSON', 'Scaffold returned invalid JSON; inspect persisted state before retrying'); }
    validateResponse(data, params);
    return { ok: true, ...identity, exit_code: 0, data };
  } catch (error) {
    return failure(stage === 'validation' ? 'INVALID_ARGUMENTS' :
      error.code === 'ENOENT' ? 'EXECUTABLE_NOT_FOUND' :
      stage === 'response' ? 'INVALID_RESPONSE' : 'EXECUTION_ERROR',
    error.message + (stage === 'command' || stage === 'response' ? '; inspect persisted state before retrying' : ''));
  }
}
