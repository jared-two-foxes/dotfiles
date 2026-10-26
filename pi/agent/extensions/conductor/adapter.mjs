// Pi-local copy of the tested OpenCode -> Conductor protocol adapter.
// Pi extensions are deployed independently of ~/.config/opencode, so this must
// not import files from the OpenCode installation. Keep protocol behavior in sync.
// Conductor alone owns apply/check/review.
import { spawn } from 'node:child_process';
import { validateBinding, snapshot, readEvidence, retainEvidence, verifiedResult } from './evidence.mjs';
import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

// Load OPENCODE_API_KEY from ~/.secrets/opencode-key if not already set, so
// the review engine (review-cli via Conductor) can authenticate the opencode
// provider. Silent no-op if the file is absent or already set.
try {
  if (!process.env.OPENCODE_API_KEY) {
    const key = readFileSync(path.join(homedir(), '.secrets', 'opencode-key'), 'utf8').trim();
    if (key) process.env.OPENCODE_API_KEY = key;
  }
} catch {}

const SHA = /^[0-9a-f]{40}$/i;
const MAX_LOG_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

function outcome(status, stage, fields = {}) {
  return { schema: 'opencode.execute_and_review.result/v1', status, stage, ...fields };
}

function command(value, label) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64 ||
      value.some(part => typeof part !== 'string' || !part || part.includes('\0') || part.length > 8192)) {
    throw new Error(label + ' must be a nonempty executable-and-arguments array');
  }
  return value;
}

async function invoke(program, args, { cwd, signal, input, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      cwd, signal, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '', bytes = 0, failure;
    const timer = setTimeout(() => {
      failure = new Error('Conductor exceeded the workflow deadline; the working tree may be partially modified');
      child.kill();
    }, timeoutMs);
    const collect = (kind) => (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_LOG_BYTES) {
        failure = new Error('Process output exceeded 1 MiB; the working tree may be partially modified');
        child.kill();
        return;
      }
      if (kind === 'stdout') stdout += chunk.toString('utf8');
      else stderr += chunk.toString('utf8');
    };
    child.stdout.on('data', collect('stdout'));
    child.stderr.on('data', collect('stderr'));
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else resolve({ code, stdout, stderr });
    });
    child.stdin.on('error', error => {
      // EPIPE is expected if the child rejects input early; the close handler
      // reports its actual status. Other errors are process failures.
      if (error.code !== 'EPIPE') { failure = error; child.kill(); }
    });
    child.stdin.end(input);
  });
}

async function git(repository, args, signal) {
  const result = await invoke('git', args, { cwd: repository, signal, input: '', timeoutMs: 15000 });
  if (result.code !== 0) throw new Error('Git preflight failed: ' + args[0]);
  return result.stdout.trim();
}

/**
 * One attempt. The only process that may modify files or invoke review is Conductor.
 * The injected invocation seam is for protocol tests; no executor/review adapters.
 */
async function executeAttempt(args, context = {}, options = {}) {
  let repository;
  try {
    if (!args || typeof args.requirements !== 'string' || !args.requirements.trim() ||
        args.requirements.length > 200000) throw new Error('Nonempty requirements are required');
    if (typeof args.baseRef !== 'string' || !SHA.test(args.baseRef)) {
      throw new Error('baseRef must be the original full 40-character commit SHA');
    }
    const build = command(args.buildCommand, 'buildCommand');
    const test = command(args.testCommand, 'testCommand');
    if (typeof args.input !== 'string') throw new Error('input must be executor JSON');
    const execution = JSON.parse(args.input);
    if (!execution || !Array.isArray(execution.operations)) {
      throw new Error('input must contain an executor operations array');
    }
    if (args.reviewWallClockBudgetSecs != null &&
        (!Number.isInteger(args.reviewWallClockBudgetSecs) ||
         args.reviewWallClockBudgetSecs <= 0)) {
      throw new Error('reviewWallClockBudgetSecs must be a positive integer');
    }
    if (args.reviewMaxTurns != null &&
        (!Number.isInteger(args.reviewMaxTurns) || args.reviewMaxTurns <= 0)) {
      throw new Error('reviewMaxTurns must be a positive integer');
    }
    if (args.reviewMaxCostUsd != null &&
        (typeof args.reviewMaxCostUsd !== 'number' ||
         !Number.isFinite(args.reviewMaxCostUsd) || args.reviewMaxCostUsd < 0)) {
      throw new Error('reviewMaxCostUsd must be a finite non-negative number');
    }
    if (args.reviewMaxToolCalls != null &&
        (!Number.isInteger(args.reviewMaxToolCalls) || args.reviewMaxToolCalls <= 0)) {
      throw new Error('reviewMaxToolCalls must be a positive integer');
    }
    if (args.reviewMaxRepeatedActions != null &&
        (!Number.isInteger(args.reviewMaxRepeatedActions) ||
         args.reviewMaxRepeatedActions <= 0)) {
      throw new Error('reviewMaxRepeatedActions must be a positive integer');
    }
    if (args.reviewMaxCompletionAttempts != null &&
        (!Number.isInteger(args.reviewMaxCompletionAttempts) ||
         args.reviewMaxCompletionAttempts <= 0)) {
      throw new Error('reviewMaxCompletionAttempts must be a positive integer');
    }
    const directory = path.resolve(context.worktree ?? context.directory ?? '.');
    repository = path.resolve(await git(directory, ['rev-parse', '--show-toplevel'], context.abort));
    const head = await git(repository, ['rev-parse', 'HEAD'], context.abort);
    const base = await git(repository, ['rev-parse', '--verify', args.baseRef + '^{commit}'], context.abort);
    if (head !== base) {
      return outcome('BLOCKED', 'PRECHECK', { repository, reason: 'HEAD_CHANGED',
        message: 'HEAD differs from the task-start baseline; nothing was applied' });
    }

    const request = {
      schema: 'conductor.request/v1',
      repository_path: repository,
      execution,
      checks: [
        { name: 'build', program: build[0], args: build.slice(1) },
        { name: 'test', program: (options.testBoundary ?? test)[0], args: (options.testBoundary ?? test).slice(1) },
      ],
      // Pi-local addition: budget and limit passthrough fields forwarded to the
      // review engine via conductor.request/v1. Diverges from the upstream
      // OpenCode adapter, which does not expose these. All fields optional;
      // omitted fields are absent so Conductor applies review-cli defaults.
      // Forwarded: wall_clock_budget_secs, max_turns, max_cost_usd,
      // max_tool_calls, max_repeated_actions, max_completion_attempts.
      review: {
        requirements: args.requirements,
        base_ref: base,
        model: args.reviewModel ?? 'opencode/gpt-6.1-sol',
        ...(args.reviewWallClockBudgetSecs != null
          ? { wall_clock_budget_secs: args.reviewWallClockBudgetSecs }
          : {}),
        ...(args.reviewMaxTurns != null
          ? { max_turns: args.reviewMaxTurns }
          : {}),
        ...(args.reviewMaxCostUsd != null
          ? { max_cost_usd: args.reviewMaxCostUsd }
          : {}),
        ...(args.reviewMaxToolCalls != null
          ? { max_tool_calls: args.reviewMaxToolCalls }
          : {}),
        ...(args.reviewMaxRepeatedActions != null
          ? { max_repeated_actions: args.reviewMaxRepeatedActions }
          : {}),
        ...(args.reviewMaxCompletionAttempts != null
          ? { max_completion_attempts: args.reviewMaxCompletionAttempts }
          : {}),
      },
    };
    const binary = process.env.CONDUCTOR_BIN ?? 'conductor';
    const invokeConductor = options.invokeConductor ??
      ((requestJson) => invoke(binary, ['run', '--request', '-'], {
        cwd: repository, signal: context.abort, input: requestJson,
      }));
    const response = await invokeConductor(JSON.stringify(request));
    let conductor;
    try {
      conductor = JSON.parse(response.stdout);
    } catch {
      return outcome('BLOCKED', 'CONDUCTOR', { repository, reason: 'INVALID_RESPONSE',
        message: 'Conductor returned invalid JSON', stderr: response.stderr?.slice(0, 2000) });
    }
    const expectedExit = { PASSED: 0, NEEDS_DESIGN: 2, BLOCKED: 3 };
    if (conductor.schema !== 'conductor.result/v1' ||
        !Object.hasOwn(expectedExit, conductor.status) ||
        response.code !== expectedExit[conductor.status]) {
      return outcome('BLOCKED', 'CONDUCTOR', { repository, reason: 'PROTOCOL_MISMATCH',
        message: 'Conductor status, schema, and exit code disagree', conductor });
    }
    return outcome(conductor.status, conductor.phase?.toUpperCase() ?? 'CONDUCTOR',
      { repository, conductor });
  } catch (error) {
    return outcome('BLOCKED', 'PRECHECK_OR_CONDUCTOR', {
      ...(repository ? { repository } : {}),
      reason: error.code === 'ENOENT' ? 'EXECUTABLE_NOT_FOUND' : 'EXECUTION_ERROR',
      message: error.message + (repository ? '; inspect the working tree before retrying' : ''),
    });
  }
}

// Optional task binding leaves legacy single-change callers unchanged. Receipts
// retain one attempt only; Pi still owns approvals, interpretation and lifecycle.
export async function executeAndReview(args, context = {}, options = {}) {
  if (!args?.task) {
    if (args?.previousAttempt) return outcome('BLOCKED', 'PRECHECK', { reason: 'TASK_REQUIRED' });
    return executeAttempt(args, context, options);
  }
  let repository, before, request, response, boundaryPath;
  let attempt = 1;
  try {
    validateBinding(args.task);
    repository = path.resolve(await git(path.resolve(context.worktree ?? context.directory ?? '.'),
      ['rev-parse', '--show-toplevel'], context.abort));
    before = await snapshot(repository);
    if (before.bookkeepingVisible) return outcome('BLOCKED', 'PRECHECK', {
      repository, reason: 'SCAFFOLD_REVIEW_SCOPE',
      message: 'Scaffold state would enter the review diff; establish an authorised ignore rule before execution',
    });
    if (args.previousAttempt) {
      const previous = await readEvidence(repository, args.previousAttempt);
      if (['featureId', 'taskId', 'designRef'].some(k => previous.task[k] !== args.task[k]) ||
          previous.args.baseRef !== args.baseRef || previous.args.requirements !== args.requirements ||
          JSON.stringify(previous.args.buildCommand) !== JSON.stringify(args.buildCommand) ||
          JSON.stringify(previous.args.testCommand) !== JSON.stringify(args.testCommand) ||
          previous.result.status === 'PASSED' || before.head !== previous.after.head ||
          before.digest !== previous.after.digest) {
        throw new Error('Previous attempt does not match this task, fixed requirements or current tree; reconcile before continuing');
      }
      attempt = previous.attempt + 1;
      if (!Number.isInteger(attempt) || attempt > 5) throw new Error('Five-attempt limit reached; stop this loop');
    } else if (!before.clean) {
      return outcome('BLOCKED', 'PRECHECK', { repository, reason: 'CHECKPOINT_REQUIRED',
        message: 'Implementation changes remain outside this task loop; reconcile and obtain an authorised Git checkpoint first' });
    }
    // Write intent before applying anything so a killed Pi session leaves the
    // original baseline, requirements and attempt count discoverable.
    const startedReference = await retainEvidence(repository, {
      repository, task: args.task, attempt, args, before, after: before,
      result: outcome('BLOCKED', 'STARTED', { reason: 'INTERRUPTED_OR_RUNNING' }),
    });
    boundaryPath = path.resolve(repository, await git(repository,
      ['rev-parse', '--git-path', 'pi-conductor-evidence'], context.abort), randomUUID() + '.boundary');
    const testBoundary = [process.execPath, fileURLToPath(new URL('./test-boundary.mjs', import.meta.url)),
      JSON.stringify({ command: args.testCommand, repository, output: boundaryPath })];
    const binary = process.env.CONDUCTOR_BIN ?? 'conductor';
    let result = await executeAttempt(args, context, {
      testBoundary,
      invokeConductor: async json => {
        request = JSON.parse(json);
        response = await (options.invokeConductor ?? (body => invoke(binary, ['run', '--request', '-'], {
          cwd: repository, signal: context.abort, input: body,
        })))(json);
        return response;
      },
    });
    if (result.status === 'PASSED' && !verifiedResult(result)) {
      result = outcome('BLOCKED', 'EVIDENCE', { repository, reason: 'INCOMPLETE_VERIFICATION',
        message: 'PASSED lacks successful execution, build/test checks or an APPROVED independent review', conductor: result.conductor });
    }
    const after = await snapshot(repository);
    let reviewSnapshot = null;
    try { reviewSnapshot = JSON.parse(await readFile(boundaryPath, 'utf8')); } catch {}
    if (result.status === 'PASSED' && (!reviewSnapshot || reviewSnapshot.head !== before.head ||
        reviewSnapshot.tree !== after.tree || reviewSnapshot.digest !== after.digest || reviewSnapshot.bookkeepingVisible)) {
      result = outcome('BLOCKED', 'EVIDENCE', { repository, reason: 'REVIEW_SNAPSHOT_CHANGED',
        message: 'Missing post-test review boundary or source/index changed during independent review', actualResult: result });
    }
    if (after.head !== before.head) result = outcome('BLOCKED', 'EVIDENCE', {
      repository, reason: 'HEAD_CHANGED', actualResult: result,
    });
    try {
      const reference = await retainEvidence(repository, {
        repository, task: args.task, attempt, args, before, after, startedReference,
        request: request ?? null, response: response ?? null, reviewSnapshot, result,
      });
      return { ...result, evidence: { reference, task: args.task, attempt } };
    } catch (error) {
      return outcome('BLOCKED', 'EVIDENCE', { repository, reason: 'EVIDENCE_RETENTION_FAILED',
        message: error.message, actualResult: result });
    }
  } catch (error) {
    return outcome('BLOCKED', 'PRECHECK_OR_EVIDENCE', { ...(repository ? { repository } : {}),
      reason: 'TASK_CONTEXT_INVALID', message: error.message + '; inspect persisted state and working tree before retrying' });
  } finally {
    if (boundaryPath) await rm(boundaryPath, { force: true }).catch(() => {});
  }
}
