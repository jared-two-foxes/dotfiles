import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = p => readFileSync(path.join(root, p), 'utf8');

test('Pi uses one feature direction approval across its implementation phases', () => {
  const design = read('pi/agent/skills/design/SKILL.md'), system = read('pi/agent/SYSTEM.md');
  for (const text of [design, system]) {
    assert.match(text, /approve_feature_direction/);
    assert.match(text, /execute_and_review/);
    assert.match(text, /design-finish/);
    assert.match(text, /across sessions|session changes/);
  }
  assert.match(design, /Do not ask for per-issue design approval/);
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
    'pi/agent/skills/design/SKILL.md',
    'pi/agent/skills/conductor/SKILL.md',
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

test('Pi and OpenCode executor guides use the merged exact-text edit operation', () => {
  const pi = read('pi/agent/skills/executor/SKILL.md');
  const openCode = read('opencode/skills/executor/SKILL.md');
  for (const [name, guide] of [['Pi', pi], ['OpenCode', openCode]]) {
    assert.ok(guide.includes('\"type\": \"edit_file\"'), name);
    assert.ok(guide.includes('\"oldText\"'), name);
    assert.ok(guide.includes('\"newText\"'), name);
    assert.ok(guide.includes('The `patch` operation has been removed'), name);
    assert.ok(!guide.includes('| `patch` |'), name);
    assert.ok(guide.includes('occur exactly once'), name);
  }
  assert.ok(read('pi/agent/skills/design/SKILL.md').includes('Use `edit_file` for in-place text changes'));
  assert.ok(read('opencode/agents/design.md').includes('Use `edit_file` for in-place text changes'));
  assert.ok(read('pi/agent/skills/conductor/SKILL.md').includes('removed `patch` variants'));
});


test('delegated issue designs remain explicit and final review remains mandatory', () => {
  const design = read('pi/agent/skills/design/SKILL.md');
  for (const phrase of ['agent-authored', 'design-record', 'actual reference',
    'Never claim the user approved an individual issue', 'Final feature review is mandatory',
    'five total application attempts', 'previousAttempt', 'completed descendants']) assert.ok(design.includes(phrase), phrase);
  assert.match(design, /material scope changes|material commitments|material departures|material changes/);
});

test('native checkpoints, recovery and validation reuse the same durable direction authority', () => {
  const native = read('pi/agent/extensions/conductor/index.ts');
  assert.equal((native.match(/ui\.confirm\(/g) ?? []).length, 1);
  assert.match(native, /approveFeatureDirection/);
  assert.equal((native.match(/authorize: async \(\) => featureAuthorized/g) ?? []).length, 5);
  const adapter = read('pi/agent/extensions/conductor/adapter.mjs');
  assert.match(adapter, /options.issueWorkflowOnly\) await requireFeatureAuthorization/);
});

test('execution guides do not add a second approval after the overall direction', () => {
  for (const file of ['pi/agent/skills/design/SKILL.md', 'pi/agent/skills/executor/SKILL.md', 'pi/agent/skills/conductor/SKILL.md']) {
    const text = read(file);
    assert.doesNotMatch(text, /After \*\*separate explicit execution approval|Explicitly ask the user whether to \*\*execute/);
    assert.match(text, /full operations on request/);
  }
});
