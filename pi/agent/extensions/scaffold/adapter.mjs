// Stateless adapter: Scaffold alone reads/writes task state. No execution or retries.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

export const OPERATIONS = ['init', 'add', 'list', 'next', 'start', 'complete', 'block', 'fail', 'retry', 'decompose', 'design-next', 'design-record', 'design-finish', 'design-reopen', 'checkpoint-record', 'issue-resume'];
const taskActions = new Set(['start', 'complete', 'block', 'fail', 'retry', 'decompose', 'design-record', 'checkpoint-record', 'issue-resume']);
const inputActions = new Set(['init', 'add', 'complete', 'decompose', 'design-record', 'design-reopen', 'checkpoint-record', 'issue-resume']);
const reasonActions = new Set(['block', 'fail', 'retry']);
const statuses = new Set(['pending', 'in_progress', 'completed', 'blocked', 'failed', 'decomposed']);
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const text = x => typeof x === 'string' && !!x.trim() && !x.includes('\0');
const strings = x => Array.isArray(x) && x.every(text);
function requireValue(condition, message) { if (!condition) throw new Error(message); }
function fields(value, allowed) {
  requireValue(object(value) && Object.keys(value).every(k => allowed.includes(k)), 'Unexpected or invalid fields');
}
export function designReference(context) {
  return 'sha256:' + createHash('sha256').update(context, 'utf8').digest('hex');
}
function validateDesign(feature) {
  if (feature.design_ref?.startsWith('sha256:')) {
    requireValue(text(feature.context) && feature.design_ref === designReference(feature.context),
      'Approved design digest mismatch; recover original design before continuing');
  }
}
function definition(value, feature = false) {
  fields(value, ['id', 'title', 'objective', 'acceptance_criteria', 'context', 'constraints',
    ...(feature ? ['design_ref', 'baseline', 'branch'] : ['dependencies', 'origin'])]);
  requireValue(['id', 'title', 'objective', ...(feature ? ['design_ref'] : [])].every(k => text(value[k])), 'Definition requires nonempty id, title, objective and (for features) design_ref');
  requireValue(strings(value.acceptance_criteria) && value.acceptance_criteria.length > 0, 'acceptance_criteria must be a nonempty string array');
  requireValue(value.context === undefined || typeof value.context === 'string', 'context must be a string');
  requireValue(value.constraints === undefined || strings(value.constraints), 'constraints must be a string array');
  if (feature) requireValue( /^[a-f0-9]{40}$/.test(value.baseline) && text(value.branch), 'Issue workflow requires full baseline and feature branch');
  if (!feature && value.origin !== undefined) {
    fields(value.origin, ['kind', 'reference']);
    requireValue(['ticket', 'design', 'review', 'discovery'].includes(value.origin.kind) && text(value.origin.reference), 'Invalid issue origin');
  }
  if (!feature) requireValue(value.dependencies === undefined || (strings(value.dependencies) && new Set(value.dependencies).size === value.dependencies.length), 'dependencies must be unique task IDs');
}

/** Validate and construct exactly one tasks command; payloads never become paths. */
export function buildCommand(params) {
  fields(params, ['operation', 'feature_id', 'task_id', 'payload', 'reason']);
  const { operation, feature_id, task_id, reason } = params;
  let payload = params.payload;
  // Store the exact approved design in Scaffold itself; no second design store.
  if (operation === 'init' && payload?.design_ref === 'sha256:context') {
    requireValue(text(payload.context), 'Approved design context is required');
    payload = { ...payload, design_ref: designReference(payload.context) };
  }
  requireValue(OPERATIONS.includes(operation), 'Unsupported operation');
  requireValue(text(feature_id), 'feature_id is required');
  requireValue(operation === 'design-reopen' ? (task_id === undefined || text(task_id)) : taskActions.has(operation) ? text(task_id) : task_id === undefined, 'task_id is required only for task transitions/decompose');
  requireValue(reasonActions.has(operation) ? text(reason) : reason === undefined, 'reason is required only for block/fail/retry');
  requireValue(inputActions.has(operation) ? payload !== undefined : payload === undefined, 'payload is required only for init/add/complete/decompose');
  if (operation === 'init') {
    definition(payload, true);
    validateDesign(payload);
    requireValue(payload.id === feature_id, 'Feature payload id must match feature_id');
  } else if (operation === 'add' || operation === 'decompose') {
    requireValue(Array.isArray(payload) && payload.length > 0, 'payload must be a nonempty task array');
    payload.forEach(t => definition(t));
  } else if (operation === 'design-record') {
    fields(payload, ['summary', 'verification', 'approval', 'disposition']);
    requireValue(['summary', 'verification', 'approval'].every(k => text(payload[k])) && ['leaf', 'decomposed'].includes(payload.disposition), 'Invalid approved issue design');
  } else if (operation === 'design-reopen') {
    fields(payload, ['reason', 'reference']); requireValue(text(payload.reason) && (payload.reference === undefined || text(payload.reference)), 'Reason required');
  } else if (operation === 'checkpoint-record') {
    fields(payload, ['commit', 'reference']); requireValue(/^[a-f0-9]{40}$/.test(payload.commit) && text(payload.reference), 'Invalid checkpoint');
  } else if (operation === 'issue-resume') {
    fields(payload, ['reference', 'handoff']); requireValue(text(payload.reference) && text(payload.handoff), 'Suspension/handoff required');
  } else if (operation === 'complete') {
    fields(payload, ['feature_id', 'task_id', 'result', 'source', 'reference', 'summary']);
    requireValue(payload.feature_id === feature_id && payload.task_id === task_id && payload.result === 'PASSED' && ['source', 'reference', 'summary'].every(k => text(payload[k])), 'Completion requires task-bound PASSED evidence with source, reference and summary');
  }
  const args = ['tasks', operation, '--feature=' + feature_id];
  if (taskActions.has(operation) || (operation === 'design-reopen' && task_id !== undefined)) args.push('--task=' + task_id);
  // Use = to allow free-text reasons beginning with a dash without argparse ambiguity.
  if (reasonActions.has(operation)) args.push('--reason=' + reason);
  if (inputActions.has(operation)) args.push('--input', '-');
  return { args, input: inputActions.has(operation) ? JSON.stringify(payload) : '' };
}

export function invoke(program, args, { cwd, signal, input = '' }) {
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
  requireValue(data.schema_version === 2, 'Unsupported schema_version');
  requireValue(!Object.hasOwn(data, 'error'), 'Error in successful response');
  const needsFeature = ['init', 'add', 'list', 'next', 'decompose', 'design-next', 'design-record', 'design-finish', 'design-reopen', 'checkpoint-record', 'issue-resume'].includes(params.operation);
  if (needsFeature) {
    requireValue(object(data.feature) && data.feature.id === params.feature_id && object(data.feature.tasks), 'Invalid feature response or feature identity mismatch');
    validateDesign(data.feature);
    requireValue(object(data.feature.workflow), 'Recursive issue graph required');
    {
      requireValue(data.schema_version === 2 && data.feature.workflow.kind === 'recursive-issues/v1' &&
        ['design', 'implement'].includes(data.feature.workflow.phase) &&
        data.feature.tasks[data.feature.workflow.root_id] && data.feature.original_baseline === data.feature.baseline &&
        /^[a-f0-9]{40}$/.test(data.feature.baseline) && text(data.feature.branch), 'Unsupported issue workflow response');
      for (const task of Object.values(data.feature.tasks)) for (const d of task.designs ?? []) {
        const { reference, ...body } = d;
        const canonical = JSON.stringify(Object.fromEntries(Object.entries(body).sort(([a], [b]) => a.localeCompare(b))));
        requireValue(['summary', 'verification', 'approval'].every(k => text(d[k])) &&
          ['leaf', 'decomposed'].includes(d.disposition) && strings(d.children) &&
          reference === designReference(canonical), 'Issue design digest mismatch');
      }
    }
    for (const [id, task] of Object.entries(data.feature.tasks)) validateTask(task, params.feature_id, id);
  }
  if (['next', 'design-next'].includes(params.operation)) {
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
export async function checkStatePaths(repository) {
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
    if (['design-reopen', 'checkpoint-record', 'issue-resume'].includes(params.operation)) {
      const { issueFeature } = await import('../conductor/issue-state.mjs');
      const feature = await issueFeature(repository, { featureId: params.feature_id,
        designRef: await featureDesignRef(repository, params.feature_id) }, { scaffoldOptions: options });
      if (feature) await authenticateIssueMutation(repository, feature, params);
    }
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

async function featureDesignRef(repository, featureId) {
  try { return JSON.parse(await (await import('node:fs/promises')).readFile(path.join(repository, '.scaffold/tasks.json'), 'utf8')).features?.[featureId]?.design_ref; }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}
async function authenticateIssueMutation(repository, feature, params) {
  const { snapshot, readEvidence } = await import('../conductor/evidence.mjs');
  const current = await snapshot(repository);
  const binding = { featureId: feature.id, taskId: params.task_id, designRef: feature.design_ref };
  if (params.operation === 'design-reopen') {
    requireValue(current.clean && !current.bookkeepingVisible, 'Park unfinished source with suspend_issue before reopening design');
    if (params.payload.reference) {
      const r = await readEvidence(repository, params.payload.reference);
      const { git } = await import('../conductor/git-tree.mjs');
      requireValue(r.kind === 'issue-suspension' && isDeepStrictEqual(r.task, binding) &&
        r.before.head === current.head && git(repository, ['rev-parse', 'refs/pi-issue-suspensions/' + params.payload.reference.split(':').at(-1) + '^{tree}']) === r.before.tree,
      'Authenticated saved issue suspension required');
    }
  } else if (params.operation === 'issue-resume') {
    const { readTaskHandoff } = await import('../conductor/task-chain.mjs');
    const h = await readTaskHandoff(repository, params.payload.handoff, binding);
    requireValue(h.kind === 'issue-handoff' && h.recovery.suspensionRef === params.payload.reference && isDeepStrictEqual(current, h.after), 'Authenticated issue restore required');
  } else {
    const { authenticateTaskEvidence } = await import('../conductor/task-evidence.mjs');
    const { checkpointProvenance } = await import('../conductor/history.mjs');
    const { git } = await import('../conductor/git-tree.mjs');
    const record = await authenticateTaskEvidence(repository, params.payload.reference, binding);
    const p = checkpointProvenance(repository, params.payload.commit);
    requireValue(p.evidenceRef === params.payload.reference && p.taskId === params.task_id && p.featureId === feature.id &&
      p.designRef === feature.design_ref && p.tree === record.after.tree &&
      git(repository, ['rev-parse', params.payload.commit + '^{tree}']) === record.after.tree &&
      git(repository, ['show', '-s', '--format=%P', params.payload.commit]) === record.args.baseRef && current.head === params.payload.commit && current.clean,
    'Authentic current verified checkpoint required');
  }
}
