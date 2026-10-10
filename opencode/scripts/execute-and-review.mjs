// Thin OpenCode -> Conductor protocol adapter. Conductor alone owns apply/check/review.
import { spawn } from 'node:child_process';
import path from 'node:path';

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
export async function executeAndReview(args, context = {}, options = {}) {
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
        { name: 'test', program: test[0], args: test.slice(1) },
      ],
      review: {
        requirements: args.requirements,
        base_ref: base,
        model: args.reviewModel ?? 'opencode/gpt-6.1-sol',
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
