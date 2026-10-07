import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { reviewChanges } from '../opencode/scripts/review-runner.mjs';

async function fixture(t, variant = 'APPROVED') {
  const dir = await mkdtemp(path.join(tmpdir(), 'review-tool-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  await writeFile(path.join(dir, 'code.txt'), 'before'); git('add', '.'); git('commit', '-qm', 'baseline');
  const baseRef = git('rev-parse', 'HEAD');
  await writeFile(path.join(dir, 'code.txt'), 'after');
  const stub = path.join(dir, 'fake-review.cjs');
  await writeFile(stub, `
const fs = require('node:fs');
const path = require('node:path');
const argv = process.argv.slice(2);
const requestPath = argv[argv.indexOf('--request') + 1];
const req = JSON.parse(fs.readFileSync(requestPath, 'utf8'));
const requirements = fs.readFileSync(req.requirements, 'utf8');
if (req.schema !== 'review.request/v1' || !requirements.includes('Acceptance Criteria')) process.exit(9);
fs.writeFileSync(path.join(req.repository_path, '.capture'), JSON.stringify({req, argv, requirements}));
const variant = ${JSON.stringify(variant)};
if (variant === 'MALFORMED') { console.log('not json'); process.exit(0); }
if (variant === 'MUTATE') fs.writeFileSync(path.join(req.repository_path, 'code.txt'), 'changed during review');
if (variant === 'UNTRACKED') fs.writeFileSync(path.join(req.repository_path, 'new.txt'), 'new change');
const status = ['APPROVED', 'CHANGES_REQUESTED', 'INDETERMINATE'].includes(variant) ? variant : 'APPROVED';
const findings = status === 'CHANGES_REQUESTED' ? [{blocking:true,message:'Fix requirement',severity:'high',path:'code.txt',line:1,recommendation:'Use expected content'}] : [{blocking:false,message:'Optional readability improvement',severity:'low'}];
if (variant === 'CONTRADICTION') findings[0].blocking = true;
if (variant === 'BAD_FINDING') findings[0].severity = 'banana';
console.log(JSON.stringify({schema:'review.result/v1',status,reason:'REVIEW_COMPLETED',review_id:'test',completed_at:'now',findings,usage:{input_tokens:1,output_tokens:1}}));
process.exit(variant === 'WRONG_EXIT' ? 1 : {APPROVED:0,CHANGES_REQUESTED:1,INDETERMINATE:3}[status]);
`);
  // Fixture artifacts are ignored so only intended mutations affect the review snapshot.
  await writeFile(path.join(dir, '.git/info/exclude'), 'fake-review.cjs\n.capture\n');
  return { dir, git, args: { repository: dir, baseRef, requirements: '# Acceptance Criteria\n- Expected content' },
    options: { executable: process.execPath, prefixArgs: [stub] } };
}

test('working review uses fixed refs, plain-text requirements, independent model and cleans scratch files', async (t) => {
  const f = await fixture(t);
  const result = await reviewChanges({...f.args, model:'ollama/test'}, {}, f.options);
  assert.equal(result.status, 'APPROVED'); assert.equal(result.blockingFindings.length, 0);
  assert.equal(result.suggestions.length, 1); assert.equal(result.baseRef, f.args.baseRef);
  const capture = JSON.parse(await readFile(path.join(f.dir, '.capture')));
  assert.equal(capture.req.head_ref, ':working'); assert.match(capture.requirements, /Acceptance Criteria/);
  assert.equal(capture.argv[capture.argv.indexOf('--model') + 1], 'ollama/test');
  await assert.rejects(access(capture.req.requirements));
  await assert.rejects(access(capture.argv[capture.argv.indexOf('--request') + 1]));
});
for (const status of ['CHANGES_REQUESTED', 'INDETERMINATE']) {
  test(`${status} remains a review outcome rather than success or process exception`, async (t) => {
    const f = await fixture(t, status); const result = await reviewChanges(f.args, {}, f.options);
    assert.equal(result.status, status);
    assert.equal(result.blockingFindings.length, status === 'CHANGES_REQUESTED' ? 1 : 0);
  });
}
for (const variant of ['MALFORMED', 'WRONG_EXIT', 'CONTRADICTION', 'BAD_FINDING', 'MUTATE', 'UNTRACKED']) {
  test(`${variant} cannot approve a change`, async (t) => {
    const f = await fixture(t, variant);
    assert.equal((await reviewChanges(f.args, {}, f.options)).status, 'ERROR');
  });
}
test('missing binary and missing requirements stop safely', async (t) => {
  const f = await fixture(t);
  assert.equal((await reviewChanges(f.args, {}, {executable:path.join(f.dir,'absent')})).reason, 'EXECUTABLE_NOT_FOUND');
  assert.equal((await reviewChanges({...f.args, requirements:''}, {}, f.options)).status, 'ERROR');
});
test('committed review resolves both refs and uses session worktree by default', async (t) => {
  const f = await fixture(t); f.git('add','code.txt'); f.git('commit','-qm','change');
  const result = await reviewChanges({...f.args, repository:undefined, headRef:'HEAD'}, {worktree:f.dir}, f.options);
  assert.equal(result.status, 'APPROVED'); assert.equal(result.headRef, f.git('rev-parse','HEAD'));
});
test('cancellation is never approval', async (t) => {
  const f = await fixture(t); const controller = new AbortController(); controller.abort();
  assert.equal((await reviewChanges(f.args, {abort:controller.signal}, f.options)).status, 'ERROR');
});
