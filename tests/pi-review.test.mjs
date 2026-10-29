import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { reviewChanges } from '../pi/agent/extensions/review/adapter.mjs';
import { createReviewTool } from '../pi/agent/extensions/review/tool.mjs';

async function fixture(t, variant = 'APPROVED') {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-review-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'repository');
  await mkdir(dir);
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  await writeFile(path.join(dir, 'code.txt'), 'before'); git('add', '.'); git('commit', '-qm', 'baseline');
  const baseRef = git('rev-parse', 'HEAD');
  await writeFile(path.join(dir, 'code.txt'), 'after');
  const capture = path.join(root, 'capture.json');
  const stub = path.join(root, 'review.cjs');
  await writeFile(stub, `
const fs = require('node:fs');
const cp = require('node:child_process');
const path = require('node:path');
const argv = process.argv.slice(2);
const requestPath = argv[argv.indexOf('--request') + 1];
const req = JSON.parse(fs.readFileSync(requestPath, 'utf8'));
const requirements = fs.readFileSync(req.requirements, 'utf8');
fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ req, argv, requestPath, requirements }));
const variant = ${JSON.stringify(variant)};
const git = (...args) => cp.execFileSync('git', ['-C', req.repository_path, ...args]);
if (variant === 'MUTATE') fs.writeFileSync(path.join(req.repository_path, 'code.txt'), 'mutated');
if (variant === 'UNTRACKED') fs.writeFileSync(path.join(req.repository_path, 'new.txt'), 'new');
if (variant === 'INDEX') git('add', 'code.txt');
if (variant === 'HEAD') { git('add', 'code.txt'); git('commit', '-qm', 'unexpected'); }
if (variant === 'MALFORMED') { console.log('not json'); process.exit(0); }
if (variant === 'OUTPUT') { process.stdout.write('x'.repeat(5 * 1024 * 1024)); setInterval(() => {}, 1000); return; }
if (variant === 'TIMEOUT') { setInterval(() => {}, 1000); return; }
const status = ['APPROVED', 'CHANGES_REQUESTED', 'INDETERMINATE'].includes(variant) ? variant : 'APPROVED';
const findings = [{ blocking: status === 'CHANGES_REQUESTED', message: 'Check expected behavior', severity: 'medium', path: 'code.txt', line: 1 }];
if (variant === 'CONTRADICTION') findings[0].blocking = true;
if (variant === 'BAD_FINDING') findings[0].severity = 'invalid';
const reason = variant === 'INCOMPLETE' || status === 'INDETERMINATE' ? 'BUDGET_EXHAUSTED' : 'REVIEW_COMPLETED';
console.log(JSON.stringify({ schema: 'review.result/v1', status, reason, review_id: 'test',
  completed_at: '2026-10-15T00:00:00Z', findings, usage: { input_tokens: 1, output_tokens: 1 } }));
process.exit(variant === 'WRONG_EXIT' ? 1 : { APPROVED: 0, CHANGES_REQUESTED: 1, INDETERMINATE: 3 }[status]);
`);
  return { dir, git, capture, args: { repository: dir, baseRef, requirements: 'Review expected behavior.' },
    options: { executable: process.execPath, prefixArgs: [stub] } };
}
async function captured(f) { return JSON.parse(await readFile(f.capture, 'utf8')); }
async function assertCleaned(capture) {
  await assert.rejects(access(capture.requestPath));
  await assert.rejects(access(capture.req.requirements));
}

test('working review freezes base, preserves source/index, forwards scope and cleans external requests', async t => {
  const f = await fixture(t);
  const before = f.git('status', '--porcelain');
  const result = await reviewChanges({ ...f.args, baseRef: 'HEAD', model: 'ollama/test' }, {}, f.options);
  assert.equal(result.status, 'APPROVED');
  assert.equal(result.baseRef, f.args.baseRef); assert.equal(result.headRef, ':working');
  assert.equal(result.model, 'ollama/test'); assert.equal(result.blockingFindings.length, 0);
  assert.equal(result.suggestions.length, 1); assert.equal(f.git('status', '--porcelain'), before);
  assert.equal(await readFile(path.join(f.dir, 'code.txt'), 'utf8'), 'after');
  const c = await captured(f);
  assert.equal(c.req.schema, 'review.request/v1'); assert.equal(c.req.base_ref, f.args.baseRef);
  assert.equal(c.req.head_ref, ':working'); assert.equal(c.requirements, f.args.requirements);
  assert.equal(path.relative(f.dir, c.requestPath).startsWith('..'), true);
  await assertCleaned(c);
});

test('committed review uses session directory and freezes head even with a dirty working tree', async t => {
  const f = await fixture(t); f.git('add', 'code.txt'); f.git('commit', '-qm', 'change');
  const head = f.git('rev-parse', 'HEAD');
  await writeFile(path.join(f.dir, 'code.txt'), 'unrelated local edit');
  const result = await reviewChanges({ ...f.args, repository: undefined, headRef: 'HEAD' }, { directory: f.dir }, f.options);
  assert.equal(result.status, 'APPROVED'); assert.equal(result.headRef, head);
  assert.equal((await captured(f)).req.head_ref, head);
  assert.equal(await readFile(path.join(f.dir, 'code.txt'), 'utf8'), 'unrelated local edit');
});
for (const status of ['CHANGES_REQUESTED', 'INDETERMINATE']) {
  test(`${status} is preserved without retrying`, async t => {
    const f = await fixture(t, status);
    const result = await reviewChanges(f.args, {}, f.options);
    assert.equal(result.status, status);
    assert.equal(result.blockingFindings.length, status === 'CHANGES_REQUESTED' ? 1 : 0);
    await assertCleaned(await captured(f));
  });
}
for (const variant of ['MALFORMED', 'WRONG_EXIT', 'CONTRADICTION', 'BAD_FINDING', 'INCOMPLETE']) {
  test(`${variant} cannot approve and removes temporary files`, async t => {
    const f = await fixture(t, variant);
    assert.equal((await reviewChanges(f.args, {}, f.options)).status, 'ERROR');
    await assertCleaned(await captured(f));
  });
}
for (const headRef of [undefined, 'HEAD']) {
  for (const variant of ['MUTATE', 'UNTRACKED', 'INDEX', 'HEAD']) {
    test(`${variant} is rejected for ${headRef ?? 'working'} reviews`, async t => {
      const f = await fixture(t, variant);
      const result = await reviewChanges({ ...f.args, headRef }, {}, f.options);
      assert.equal(result.status, 'ERROR'); assert.equal(result.reason, 'REPOSITORY_CHANGED');
      await assertCleaned(await captured(f));
    });
  }
}
test('budgets are forwarded precisely; omitted optional limits are not invented', async t => {
  const f = await fixture(t);
  const limits = { wallClockBudgetSecs: 240, maxTurns: 40, maxCostUsd: 0,
    maxToolCalls: 120, maxRepeatedActions: 4, maxCompletionAttempts: 5 };
  assert.equal((await reviewChanges({ ...f.args, ...limits }, {}, f.options)).status, 'APPROVED');
  let c = await captured(f);
  for (const [flag, value] of [['--wall-clock-budget-secs', '240'], ['--max-turns', '40'],
    ['--max-cost-usd', '0'], ['--max-tool-calls', '120'], ['--max-repeated-actions', '4'], ['--max-completion-attempts', '5']]) {
    assert.equal(c.argv[c.argv.indexOf(flag) + 1], value);
  }
  assert.equal((await reviewChanges(f.args, {}, f.options)).status, 'APPROVED');
  c = await captured(f);
  assert.equal(c.argv[c.argv.indexOf('--wall-clock-budget-secs') + 1], '180');
  assert.equal(c.argv[c.argv.indexOf('--max-turns') + 1], '20');
  for (const flag of ['--max-cost-usd', '--max-tool-calls', '--max-repeated-actions', '--max-completion-attempts']) {
    assert.equal(c.argv.includes(flag), false);
  }
});
test('invalid scope, refs and limits stop before invoking the reviewer', async t => {
  const f = await fixture(t);
  for (const patch of [{ requirements: '' }, { requirements: 'x'.repeat(200001) }, { baseRef: '--help' },
    { headRef: '' }, { headRef: ':staged' }, { maxTurns: 0 }, { maxTurns: 101 },
    { wallClockBudgetSecs: 601 }, { maxToolCalls: 0 }, { maxRepeatedActions: 1.5 },
    { maxCompletionAttempts: 101 }, { maxCostUsd: NaN }, { maxCostUsd: -1 }, { model: '' }]) {
    assert.equal((await reviewChanges({ ...f.args, ...patch }, {}, f.options)).status, 'ERROR');
  }
  await assert.rejects(access(f.capture));
});
test('missing binary, cancellation, timeout and output bounds never approve', async t => {
  const f = await fixture(t);
  assert.equal((await reviewChanges(f.args, {}, { executable: path.join(f.dir, 'absent') })).reason, 'EXECUTABLE_NOT_FOUND');
  const controller = new AbortController(); controller.abort();
  assert.equal((await reviewChanges(f.args, { abort: controller.signal }, f.options)).reason, 'CANCELLED');
  for (const variant of ['TIMEOUT', 'OUTPUT']) {
    const slow = await fixture(t, variant);
    const result = await reviewChanges(slow.args, {}, { ...slow.options, timeoutMs: 2000 });
    assert.equal(result.status, 'ERROR'); assert.equal(result.reason, variant === 'TIMEOUT' ? 'TIMEOUT' : 'OUTPUT_LIMIT');
    await assertCleaned(await captured(slow));
  }
});
test('model precedence is explicit, environment, then GPT-6.1 Sol', async t => {
  const previous = process.env.REVIEW_MODEL;
  t.after(() => { if (previous === undefined) delete process.env.REVIEW_MODEL; else process.env.REVIEW_MODEL = previous; });
  const f = await fixture(t);
  for (const [env, model, expected] of [[undefined, undefined, 'opencode/gpt-6.1-sol'],
    ['ollama/env', undefined, 'ollama/env'], ['ollama/env', 'ollama/explicit', 'ollama/explicit']]) {
    if (env === undefined) delete process.env.REVIEW_MODEL; else process.env.REVIEW_MODEL = env;
    const result = await reviewChanges({ ...f.args, model }, {}, f.options);
    assert.equal(result.status, 'APPROVED'); assert.equal(result.model, expected);
    const c = await captured(f); assert.equal(c.argv[c.argv.indexOf('--model') + 1], expected);
  }
});

test('native tool exposes review-only parameters, propagates context and distinguishes failed reviews', async () => {
  const Type = {
    String: options => ({ type: 'string', ...options }), Integer: options => ({ type: 'integer', ...options }),
    Number: options => ({ type: 'number', ...options }), Optional: schema => ({ ...schema, optional: true }),
    Object: (properties, options) => ({ properties, ...options }),
  };
  const controller = new AbortController();
  for (const status of ['APPROVED', 'CHANGES_REQUESTED', 'INDETERMINATE', 'ERROR']) {
    const params = { baseRef: 'HEAD~1', headRef: 'HEAD', requirements: 'Review correctness' };
    const definition = createReviewTool(Type, async (args, context) => {
      assert.equal(args, params); assert.equal(context.directory, '/session'); assert.equal(context.abort, controller.signal);
      return { status, findings: [] };
    });
    assert.equal(definition.name, 'review_changes'); assert.equal(definition.parameters.additionalProperties, false);
    for (const field of ['input', 'operations', 'buildCommand', 'testCommand']) {
      assert.equal(Object.hasOwn(definition.parameters.properties, field), false);
    }
    const result = await definition.execute('id', params, controller.signal, undefined, { cwd: '/session' });
    assert.equal(result.isError, status === 'ERROR' || status === 'INDETERMINATE');
    assert.equal(JSON.parse(result.content[0].text).status, status); assert.equal(result.details.status, status);
  }
});
test('Pi and shared policies allow standalone review without weakening implementation gates', async () => {
  const read = async name => readFile(new URL('../' + name, import.meta.url), 'utf8');
  const system = await read('pi/agent/SYSTEM.md');
  const agents = await read('pi/agent/AGENTS.md');
  const skill = await read('pi/agent/skills/review/SKILL.md');
  assert.match(system, /Standalone\s+review stays in Research mode/);
  assert.match(system, /review_changes/); assert.match(system, /Only native `execute_and_review`/);
  assert.match(system, /Do not run builds, tests, review-cli, executor, Conductor/);
  assert.match(skill, /Use the native `review_changes` tool/);
  assert.match(agents, /execute_and_review/); assert.doesNotMatch(agents, /skill:tdd|writes tests and implementation code directly/);
  for (const name of ['shared/research-assistant/core.md', 'prompts/research-assistant.prompt.md']) {
    assert.match(await read(name), /read-only code reviews/);
  }
  assert.match(await read('pi/agent/extensions/review/index.ts'), /pi\.registerTool\(createReviewTool\(Type\)\)/);
  assert.match(await read('.github/workflows/opencode.yml'), /tests\/pi-review\.test\.mjs/);
});
