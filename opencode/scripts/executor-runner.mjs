import { spawn } from 'node:child_process';
import path from 'node:path';

const MAX_INPUT_BYTES = 4 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;

function run(executable, args, { cwd, input, signal, timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd, signal, shell: false, windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '', bytes = 0, failure;
    const timer = setTimeout(() => {
      failure = new Error('Process exceeded its wall-clock deadline');
      child.kill();
    }, timeoutMs);
    const collect = (stream) => (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) {
        failure = new Error('Process output exceeded 1 MiB');
        child.kill();
        return;
      }
      if (stream === 'stdout') stdout += chunk.toString('utf8');
      else stderr += chunk.toString('utf8');
    };
    child.stdout.on('data', collect('stdout'));
    child.stderr.on('data', collect('stderr'));
    child.stdin.on('error', (error) => {
      // EPIPE is expected if the executable exits before consuming its input.
      if (error.code !== 'EPIPE') failure = error;
    });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else resolve({ code, stdout, stderr });
    });
    if (input === undefined) child.stdin.end();
    else child.stdin.end(input);
  });
}

function validateInput(json) {
  if (typeof json !== 'string' || !json.trim() ||
      Buffer.byteLength(json, 'utf8') > MAX_INPUT_BYTES) {
    throw new Error('Executor input must be nonempty JSON of at most 4 MiB');
  }
  const parsed = JSON.parse(json);
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object' ||
      Object.keys(parsed).length !== 1 || !Array.isArray(parsed.operations)) {
    throw new Error('Expected a JSON object containing only an operations array');
  }
  // The Rust executor is authoritative for operation schemas.
  return { json, operationCount: parsed.operations.length };
}

function validateOutput(output, code, operationCount) {
  const result = JSON.parse(output);
  if (!result || typeof result.success !== 'boolean' ||
      !Number.isInteger(result.operations_applied) ||
      result.operations_applied < 0 || result.operations_applied > operationCount) {
    throw new Error('Invalid executor result');
  }
  if (result.success) {
    if (code !== 0 || result.operations_applied !== operationCount ||
        result.failed_operation !== undefined || result.error !== undefined) {
      throw new Error('Executor success contradicts exit code or operation count');
    }
  } else {
    if (code === 0 || (result.failed_operation !== undefined &&
        (!Number.isInteger(result.failed_operation) ||
         result.failed_operation !== result.operations_applied ||
         result.failed_operation >= operationCount))) {
      throw new Error('Executor failure contradicts exit code or operation count');
    }
  }
  return result;
}

export async function applyExecutor(args, context = {}, options = {}) {
  try {
    const { json, operationCount } = validateInput(args.input);
    // Never accept a caller-supplied repository path. Use the OpenCode session's
    // workspace, and let git locate its root.
    const directory = path.resolve(context.worktree ?? context.directory ?? '.');
    const git = await run('git', ['rev-parse', '--show-toplevel'], {
      cwd: directory, signal: context.abort, timeoutMs: 15000,
    });
    if (git.code !== 0) throw new Error('OpenCode workspace is not a Git repository');
    const repository = path.resolve(git.stdout.trim());
    const executable = options.executable ?? process.env.EXECUTOR_BIN ?? 'executor';
    const result = await run(executable, [...(options.prefixArgs ?? []), 'apply', '-'], {
      cwd: repository, input: json, signal: context.abort,
    });
    const parsed = validateOutput(result.stdout, result.code, operationCount);
    return {
      schema: 'opencode.executor.result/v1',
      status: parsed.success ? 'APPLIED' : 'APPLY_FAILED',
      repository,
      operationsApplied: parsed.operations_applied,
      ...(parsed.failed_operation !== undefined ? { failedOperation: parsed.failed_operation } : {}),
      ...(parsed.error !== undefined ? { error: parsed.error } : {}),
    };
  } catch (error) {
    return {
      schema: 'opencode.executor.result/v1',
      status: 'ERROR',
      reason: error.code === 'ENOENT' ? 'EXECUTABLE_NOT_FOUND' : 'EXECUTOR_INVOCATION_FAILED',
      message: error.message,
    };
  }
}
