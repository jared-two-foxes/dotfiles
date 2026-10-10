import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, lstat, readlink } from 'node:fs/promises';
import path from 'node:path';
import { applyExecutor } from './executor-runner.mjs';
import { reviewChanges } from './review-runner.mjs';

const MAX_LOG_BYTES = 1024 * 1024;
const MAX_RETURN_CHARS = 16000;
const SHA = /^[0-9a-f]{40}$/i;

function bounded(value) {
  return value.length <= MAX_RETURN_CHARS ? value :
    value.slice(0, 1500) + '\n[... output truncated ...]\n' + value.slice(-12000);
}

async function run(command, args, { cwd, signal, timeoutMs = 180000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, signal, shell: false, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', bytes = 0, failure;
    const timer = setTimeout(() => {
      failure = new Error('Command exceeded its wall-clock deadline'); child.kill();
    }, timeoutMs);
    const collect = (which) => (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_LOG_BYTES) {
        failure = new Error('Command output exceeded 1 MiB'); child.kill(); return;
      }
      if (which === 'stdout') stdout += chunk.toString('utf8');
      else stderr += chunk.toString('utf8');
    };
    child.stdout.on('data', collect('stdout'));
    child.stderr.on('data', collect('stderr'));
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else resolve({ code, stdout, stderr });
    });
  });
}

async function git(cwd, args, signal) {
  const result = await run('git', args, { cwd, signal, timeoutMs: 15000 });
  if (result.code !== 0) throw new Error('Git preflight or snapshot failed: ' + args[0]);
  return result.stdout.trim();
}

function commandArgs(value, name) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64 ||
      value.some(x => typeof x !== 'string' || !x || x.includes('\0'))) {
    throw new Error(name + ' must be a nonempty executable-and-arguments array');
  }
  if (value.some(x => x.length > 8192)) throw new Error(name + ' argument is too long');
  // No shell parsing, interpolation, pipelines, redirects or command chaining.
  return value;
}

async function snapshot(repository, signal) {
  const hash = createHash('sha256');
  hash.update(await git(repository, ['diff', '--binary', '--no-ext-diff', '--no-textconv', 'HEAD', '--'], signal));
  hash.update(await git(repository, ['diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv', '--'], signal));
  const output = await git(repository, ['ls-files', '--others', '--exclude-standard', '-z'], signal);
  for (const file of output.split('\0').filter(Boolean).sort()) {
    const full = path.join(repository, file);
    const info = await lstat(full);
    hash.update(file + '\0');
    hash.update(info.isSymbolicLink() ? await readlink(full) : await readFile(full));
  }
  return hash.digest('hex');
}

function testCount(output, customPattern) {
  if (customPattern) {
    if (typeof customPattern !== 'string' || customPattern.length > 256) {
      throw new Error('testEvidencePattern must be a regex string of at most 256 characters');
    }
    const match = new RegExp(customPattern, 'm').exec(output);
    return match && match[1] !== undefined && /^\d+$/.test(match[1]) ? Number(match[1]) : 0;
  }
  // Test runner summaries only; never infer executed tests from a zero exit code.
  const patterns = [
    /test result: (?:ok|FAILED)\. (\d+) passed;/g, // cargo test
    /^# tests (\d+)\s*$/gm, // node --test (TAP)
    /^ℹ tests (\d+)\s*$/gm, // node --test (spec)
    /(?:^|[\s,])(\d+) passed(?:,|\s|$)/g, // pytest
    /Tests:\s*(\d+) passed/g, // jest
    /Tests\s+(\d+) passed/g, // vitest
    /Total tests:\s*(\d+)/g, // ctest
  ];
  let total = 0;
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(output)) !== null) total += Number(match[1]);
  }
  return total;
}

function result(status, stage, fields = {}) {
  return { schema: 'opencode.execute_and_review.result/v1', status, stage, ...fields };
}

/**
 * One deterministic attempt. No LLM is invoked except inside review-cli.
 * options injects the two existing adapters for isolated protocol tests.
 */
export async function executeAndReview(args, context = {}, options = {}) {
  let stage = 'PRECHECK', repository, apply, build, tests;
  try {
    if (!args || typeof args.requirements !== 'string' || !args.requirements.trim() ||
        args.requirements.length > 200000) throw new Error('Nonempty requirements are required');
    if (typeof args.baseRef !== 'string' || !SHA.test(args.baseRef)) {
      throw new Error('baseRef must be the original full 40-character commit SHA');
    }
    const buildCommand = commandArgs(args.buildCommand, 'buildCommand');
    const testCommand = commandArgs(args.testCommand, 'testCommand');
    if (args.testEvidencePattern !== undefined) {
      if (typeof args.testEvidencePattern !== 'string' || args.testEvidencePattern.length > 256) {
        throw new Error('Invalid testEvidencePattern');
      }
      new RegExp(args.testEvidencePattern);
    }
    const timeoutMs = args.commandTimeoutMs ?? 180000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) {
      throw new Error('commandTimeoutMs must be between 1000 and 600000');
    }
    const directory = path.resolve(context.worktree ?? context.directory ?? '.');
    repository = path.resolve(await git(directory, ['rev-parse', '--show-toplevel'], context.abort));
    const head = await git(repository, ['rev-parse', 'HEAD'], context.abort);
    const base = await git(repository, ['rev-parse', '--verify', args.baseRef + '^{commit}'], context.abort);
    if (head !== base) {
      return result('BLOCKED', 'PRECHECK', { repository, reason: 'HEAD_CHANGED',
        message: 'HEAD differs from the original baseline; no changes were applied' });
    }
    // Fail before source modification when required binaries are absent.
    // Isolated tests inject both adapters and skip these real binary checks.
    if (!options.skipDependencyCheck) {
      for (const binary of [process.env.EXECUTOR_BIN ?? 'executor',
        process.env.REVIEW_CLI_BIN ?? 'review-cli']) {
        const check = await run(binary, ['--help'], { cwd: repository,
          signal: context.abort, timeoutMs: 15000 });
        if (check.code !== 0) throw new Error('Required binary is unavailable: ' + binary);
      }
    }
    // An empty operation list is valid for verification-only correction attempts.
    stage = 'APPLY';
    apply = await (options.apply ?? applyExecutor)({ input: args.input }, context,
      options.executorOptions ?? {});
    if (apply.status !== 'APPLIED') {
      return result(apply.status === 'APPLY_FAILED' ? 'NEEDS_DESIGN' : 'BLOCKED',
        'APPLY', { repository, apply, message: 'Executor may have left partial working-tree changes; inspect before retrying' });
    }
    const beforeChecks = await snapshot(repository, context.abort);
    stage = 'BUILD';
    build = await run(buildCommand[0], buildCommand.slice(1), { cwd: repository, signal: context.abort,
      timeoutMs });
    build = { exitCode: build.code, output: bounded(build.stdout + '\n' + build.stderr) };
    if (await git(repository, ['rev-parse', 'HEAD'], context.abort) !== base) {
      return result('BLOCKED', stage, { repository, apply, reason: 'HEAD_CHANGED',
        message: 'Build or test changed HEAD; review was not run' });
    }
    if (await snapshot(repository, context.abort) !== beforeChecks) {
      return result('BLOCKED', 'BUILD', { repository, apply, build, reason: 'SOURCE_CHANGED',
        message: 'Build changed tracked or non-ignored source; review was not run' });
    }
    if (build.exitCode !== 0) {
      return result('NEEDS_DESIGN', 'BUILD', { repository, apply, build });
    }
    stage = 'TEST';
    const executed = await run(testCommand[0], testCommand.slice(1), { cwd: repository,
      signal: context.abort, timeoutMs });
    const output = executed.stdout + '\n' + executed.stderr;
    tests = { exitCode: executed.code, executed: testCount(output, args.testEvidencePattern),
      output: bounded(output) };
    if (await git(repository, ['rev-parse', 'HEAD'], context.abort) !== base) {
      return result('BLOCKED', stage, { repository, apply, reason: 'HEAD_CHANGED',
        message: 'Build or test changed HEAD; review was not run' });
    }
    if (await snapshot(repository, context.abort) !== beforeChecks) {
      return result('BLOCKED', 'TEST', { repository, apply, build, tests, reason: 'SOURCE_CHANGED',
        message: 'Tests changed tracked or non-ignored source; review was not run' });
    }
    if (tests.exitCode !== 0) return result('NEEDS_DESIGN', 'TEST', { repository, apply, build, tests });
    if (tests.executed < 1) return result('BLOCKED', 'TEST', { repository, apply, build, tests,
      reason: 'NO_TEST_EVIDENCE', message: 'Test command succeeded but no executed tests could be confirmed' });
    stage = 'REVIEW';
    const review = await (options.review ?? reviewChanges)({
      repository, baseRef: base, requirements: args.requirements,
      model: args.reviewModel ?? 'opencode/gpt-6.1-sol',
    }, context, options.reviewOptions ?? {});
    if (review.status === 'APPROVED') {
      return result('PASSED', 'REVIEW', { repository, apply, build, tests, review });
    }
    if (review.status === 'CHANGES_REQUESTED') {
      return result('NEEDS_DESIGN', 'REVIEW', { repository, apply, build, tests, review });
    }
    return result('BLOCKED', 'REVIEW', { repository, apply, build, tests, review,
      reason: 'REVIEW_UNAVAILABLE' });
  } catch (error) {
    return result('BLOCKED', stage, { ...(repository ? { repository } : {}),
      ...(apply ? { apply } : {}), ...(build ? { build } : {}), ...(tests ? { tests } : {}),
      reason: error.code === 'ENOENT' ? 'EXECUTABLE_NOT_FOUND' : 'EXECUTION_ERROR',
      message: error.message + (stage === 'APPLY' ? '; application may have partially modified the worktree' : '') });
  }
}
