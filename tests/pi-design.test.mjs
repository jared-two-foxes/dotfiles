import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = p => readFileSync(path.join(root, p), 'utf8');

test('feature initialization owns the single direction approval and design-finish', () => {
  const init = read('pi/agent/skills/init-feature/SKILL.md');
  const delivery = read('pi/agent/skills/feature-delivery/SKILL.md');
  const system = read('pi/agent/SYSTEM.md');
  for (const phrase of ['linear_get_ticket', 'scaffold_tasks', 'approve_feature_direction',
    'design-record', 'design-finish', 'summary', 'existing', 'baseline', 'branch']) {
    assert.ok(init.includes(phrase), phrase);
  }
  assert.match(init, /Do not ask for per-issue design approval/);
  assert.match(init, /across sessions|session changes/);
  assert.match(init, /never.*execute_and_review|never.*calls.*execute_and_review/is);
  assert.match(delivery, /\/skill:init-feature/);
  assert.match(delivery, /execute_and_review/);
  assert.match(delivery, /design-finish/);
  assert.match(system, /Only native `execute_and_review`/);
});


const publishingPolicy = name => {
  const text = read(name).replace(/\r\n/g, '\n');
  const start = text.indexOf('## Git and GitHub publishing\n');
  assert.notEqual(start, -1, `missing publishing policy: ${name}`);
  return text.slice(start).split('\n## ')[0].trim();
};

test('Git and GitHub publishing policy stays aligned across shared and runtime prompts', () => {
  const core = publishingPolicy('shared/research-assistant/core.md');
  for (const name of ['pi/agent/SYSTEM.md', 'prompts/research-assistant.prompt.md']) {
    assert.equal(publishingPolicy(name), core, name);
  }
});

test('Publishing permits scoped commits and PR publication without granting merge authority', () => {
  const policy = publishingPolicy('shared/research-assistant/core.md').replace(/\s+/g, ' ');
  for (const phrase of [
    'instruction-level policy, not a credential or tool-enforcement boundary',
    'Read-only Git and GitHub CLI (`gh`) inspection needs no additional approval',
    'Only when explicitly requested',
    'create or use a feature branch',
    'stage or unstage selected existing changes',
    'create commits, push that feature branch with Git',
    '`gh pr create` or `gh pr edit`',
    'Confirm the repository, remote, head branch, base branch, selected changes and publishing scope before writes',
    'One clear publishing request authorizes that agreed sequence',
    'do not require approval for each command',
    'Do not infer publishing permission from design, implementation or review approval',
    'Inspect the working tree and index before staging or committing',
    'Never stage, commit or discard unrelated changes, including pre-existing staged changes',
    'Never merge PRs, enable auto-merge, enqueue PRs for merging',
    'through APIs, scripts, workflows or delegation',
    'Never bypass this restriction with local merges or direct pushes to protected branches',
    "Treat `main`, `master`, the repository's default branch and any other known protected branches as protected",
    'Never push directly to, force-push to, rewrite history of or delete a protected branch',
    'A normal publishing request does not authorize destructive operations, history rewriting, branch deletion or force-pushes',
    'These require separate explicit confirmation and must not affect protected branches',
    '`--force-with-lease` rather than an unconditional force-push',
    'Publishing permission does not authorize source edits, conflict-resolution edits, builds, tests or other Git/GitHub writes',
    'Never commit, change branches or otherwise change HEAD during an active implementation verification/correction loop',
    'finish or stop the loop before starting a publishing workflow',
  ]) {
    assert.ok(policy.includes(phrase), `missing publishing constraint: ${phrase}`);
  }
});

test('Pi workflow guidance retains implementation gates without blanket publishing bans', () => {
  for (const name of [
    'pi/agent/SYSTEM.md',
    'pi/agent/AGENTS.md',
    'pi/agent/skills/feature-delivery/SKILL.md',
    'pi/agent/skills/implement-task/SKILL.md',
  ]) {
    const text = read(name).replace(/\s+/g, ' ');
    assert.match(text, /Git\/GitHub publishing|Git and GitHub publishing/, name);
    assert.match(text, /active (?:implementation )?(?:verification\/correction loop|correction epoch)/, name);
    assert.match(text, /[Nn]ever merge PRs/, name);
    assert.match(text, /source edits/, name);
    assert.doesNotMatch(text, /do not commit or push|run build\/test commands, or commit|Feature branches may be created, committed to, pushed, rebased, and deleted freely|bash is for read-only inspection only|Bash access is for read-only discovery only/, name);
  }
  for (const name of ['shared/research-assistant/core.md', 'prompts/research-assistant.prompt.md']) {
    assert.doesNotMatch(read(name).replace(/\s+/g, ' '), /You do not implement changes, modify files, create commits/, name);
  }
});

test('Pi executor guide uses the merged exact-text edit operation', () => {
  const pi = read('pi/agent/skills/executor/SKILL.md');
  for (const [name, guide] of [['Pi', pi]]) {
    assert.ok(guide.includes('\"type\": \"edit_file\"'), name);
    assert.ok(guide.includes('\"oldText\"'), name);
    assert.ok(guide.includes('\"newText\"'), name);
    assert.ok(guide.includes('The `patch` operation has been removed'), name);
    assert.ok(!guide.includes('| `patch` |'), name);
    assert.ok(guide.includes('occur exactly once'), name);
  }
  assert.ok(read('pi/agent/skills/implement-task/SKILL.md').includes('Use `edit_file` for in-place text changes'));
  assert.doesNotMatch(read('pi/agent/skills/feature-delivery/SKILL.md'), /### Select checks for the current issue|#### Checkpoint recovery/);
  assert.ok(read('pi/agent/skills/implement-task/SKILL.md').includes('removed `patch` variants'));
});


test('delegated issue designs remain explicit and final review remains mandatory', () => {
  const init = read('pi/agent/skills/init-feature/SKILL.md');
  const delivery = read('pi/agent/skills/feature-delivery/SKILL.md');
  for (const phrase of ['agent-authored', 'design-record', 'actual reference',
    'Never claim the user approved an individual issue', 'completed descendants']) assert.ok(init.includes(phrase), phrase);
  for (const phrase of ['Final feature review is mandatory', 'no per-issue attempt limit',
    'previousAttempt', 'completed descendants']) assert.ok(delivery.includes(phrase), phrase);
  assert.match(delivery, /material scope changes|material commitments|material departures|material changes/);
});

test('native checkpoints, recovery and validation reuse the same durable direction authority', () => {
  const native = read('pi/agent/extensions/execute-and-review/index.ts');
  assert.equal((native.match(/ui\.confirm\(/g) ?? []).length, 2, 'one routine direction confirmation and one explicit material-amendment confirmation');
  assert.match(native, /approveFeatureDirection/);
  assert.doesNotMatch(native, /registerRecoveryTools|name: "(?:validate_feature|checkpoint_verified_task)"/);
  const recovery = read('pi/agent/extensions/execution-recovery/index.ts');
  const validation = read('pi/agent/extensions/feature-validation/index.ts');
  const checkpoint = read('pi/agent/extensions/checkpoint/index.ts');
  assert.match(checkpoint, /name: "checkpoint_verified_task"/);
  assert.doesNotMatch(recovery, /name: "checkpoint_verified_task"/);
  assert.match(validation, /name: "validate_feature"/);
  assert.equal(((native + recovery + validation).match(/authorize: async \(\) =>\s*featureAuthorized/g) ?? []).length, 4);
  assert.match(read('pi/agent/extensions/execute-and-review/delivery.mjs'), /requireFeatureAuthorization/);
  assert.match(read('pi/agent/extensions/checkpoint/finalization.mjs'), /featureAuthorized/);
  const adapter = read('pi/agent/extensions/execute-and-review/adapter.mjs');
  assert.match(adapter, /options.issueWorkflowOnly\)\s+await requireFeatureAuthorization/);
});

test('execution guides do not add a second approval after the overall direction', () => {
  for (const file of ['pi/agent/skills/feature-delivery/SKILL.md', 'pi/agent/skills/executor/SKILL.md', 'pi/agent/skills/implement-task/SKILL.md']) {
    const text = read(file);
    assert.doesNotMatch(text, /After \*\*separate explicit execution approval|Explicitly ask the user whether to \*\*execute/);
    assert.match(text, /full operations on request/);
  }
});

test('standalone design contract is independent of delivery orchestration', () => {
  const design = read('pi/agent/skills/design/SKILL.md');
  const delivery = read('pi/agent/skills/feature-delivery/SKILL.md');
  assert.match(design, /name: design/);
  assert.match(design, /inputs, outputs|Inputs, outputs/i);
  assert.match(design, /verification strategy/);
  assert.doesNotMatch(design, /approve_feature_direction|execute_and_review|checkpoint_verified_task|validate_feature/);
  assert.match(delivery, /name: feature-delivery/);
  assert.match(read('pi/agent/skills/init-feature/SKILL.md'), /\/skill:design/);
  assert.match(delivery, /\/skill:init-feature/);
  assert.match(delivery, /execute_and_review/);
  assert.match(read('pi/agent/SYSTEM.md'), /\/skill:feature-delivery/);
});

test('feature-delivery delegates exactly one task to implement-task without re-owning attempt internals', () => {
  const delivery = read('pi/agent/skills/feature-delivery/SKILL.md');
  const task = read('pi/agent/skills/implement-task/SKILL.md');
  const system = read('pi/agent/SYSTEM.md');
  assert.match(delivery, /\/skill:implement-task/);
  assert.match(delivery, /design-finish/);
  assert.match(delivery, /validate_feature/);
  assert.match(delivery, /discovery exit hatch/i);
  assert.doesNotMatch(delivery, /#### Checkpoint recovery|### Select checks for the current issue/);
  assert.match(task, /name: implement-task/);
  assert.match(task, /featureId/);
  assert.match(task, /taskId/);
  assert.match(task, /execute_and_review/);
  assert.match(task, /previousAttempt/);
  assert.match(task, /checkpoint_verified_task/);
  assert.match(task, /stage: COMMITTED/);
  assert.match(task, /missing prerequisites|NEEDS_DECOMPOSITION/i);
  assert.match(system, /\/skill:implement-task/);
  assert.match(read('pi/agent/skills/conductor/SKILL.md'), /\/skill:implement-task/);
  assert.match(read('pi/agent/extensions/execute-and-review/README.md'), /\/skill:implement-task/);
});

test('init-feature supports independent Linear preparation and safe reuse', () => {
  const init = read('pi/agent/skills/init-feature/SKILL.md');
  const delivery = read('pi/agent/skills/feature-delivery/SKILL.md');
  for (const phrase of ['Linear identifier', 'linear_get_ticket', 'origin:', 'init',
    'summary', 'source identifier', 'design_ref', 'approval', 'design-finish',
    'original baseline', 'without implementing']) {
    assert.ok(init.includes(phrase), `init-feature missing: ${phrase}`);
  }
  assert.match(init, /Never call|Never.*call/i);
  assert.match(init, /never.*execute_and_review/is);
  assert.match(delivery, /prepared feature/);
  assert.match(delivery, /validate_feature/);
  assert.doesNotMatch(delivery, /### Feature planning and the single approval|## 2\. Design the issue graph downward/);
  assert.match(read('pi/agent/AGENTS.md'), /\/skill:init-feature/);
  assert.match(read('pi/agent/skills/scaffold/SKILL.md'), /\/skill:init-feature/);
});
