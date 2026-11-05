import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { authenticateWorkflow } from '../pi/agent/lib/verification/workflow.mjs';
import { prepareWorkflow } from '../pi/agent/extensions/execute-and-review/workflow.mjs';
import { executeAndReview } from '../pi/agent/extensions/execute-and-review/adapter.mjs';
import { contract } from './helpers/conductor-contract.mjs';
contract('Pi', executeAndReview);

test('delivery authenticates retained workflows from the old extension layout', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-legacy-layout-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const args = { input: '{"operations":[]}', baseRef: 'a'.repeat(40), requirements: 'Requirements' };
  const checks = [{ name: 'check', program: 'cargo', args: ['check'] }];
  const workflow = await prepareWorkflow(root, root, args, checks);
  const executor = workflow.request.commands[0];
  const review = workflow.request.commands.at(-1);
  assert.equal(executor.args[0], fileURLToPath(new URL('../pi/agent/lib/verification/input-guard.mjs', import.meta.url)));
  assert.equal(review.success_condition.args[0], fileURLToPath(new URL('../pi/agent/lib/verification/review-condition.mjs', import.meta.url)));
  for (const extension of ['conductor', 'execute-and-review']) {
    const legacyPath = file => fileURLToPath(new URL(`../pi/agent/extensions/${extension}/${file}`, import.meta.url));
    executor.args[0] = legacyPath('input-guard.mjs');
    review.args[0] = legacyPath('input-guard.mjs');
    review.success_condition.args[0] = legacyPath('review-condition.mjs');
    assert.deepEqual(authenticateWorkflow(workflow, workflow.request, args, root), checks);
  }
  review.success_condition.args[0] = fileURLToPath(new URL('../pi/agent/extensions/conductor/review-condition.mjs', import.meta.url));
  assert.throws(() => authenticateWorkflow(workflow, workflow.request, args, root), /invocation mismatch/);
  review.args[0] = path.join(root, 'input-guard.mjs');
  assert.throws(() => authenticateWorkflow(workflow, workflow.request, args, root), /invocation mismatch/);
});
