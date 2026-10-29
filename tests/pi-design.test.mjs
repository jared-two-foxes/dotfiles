import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = p => readFileSync(path.join(root, p), 'utf8');

test('Pi Design skill retains collaborative and separate approval gates', () => {
  const design = read('pi/agent/skills/design/SKILL.md');
  const openCode = read('opencode/agents/design.md');
  for (const phrase of [
    '## 1. Discovery',
    '## 4. Prepare executor handoff',
    '## 5. Own the execution and review loop',
    'separate explicit execution confirmation',
    'Maximum **five total application attempts**',
    'NEEDS_DESIGN',
    'BLOCKED',
  ]) {
    assert.ok(openCode.includes(phrase), `missing OpenCode reference: ${phrase}`);
    assert.ok(design.includes(phrase), `missing Pi behavior: ${phrase}`);
  }
  assert.match(design, /name: design/);
  assert.match(design, /execute_and_review/);
  assert.match(design, /skill:executor/);
  assert.match(design, /Never directly modify the repository/);
});

test('Pi system prompt and Conductor skill route collaborative workflow to Design', () => {
  const system = read('pi/agent/SYSTEM.md');
  const conductor = read('pi/agent/skills/conductor/SKILL.md');
  const executor = read('pi/agent/skills/executor/SKILL.md');
  assert.match(system, /\/skill:design/);
  assert.match(system, /separate\*\*[\s\S]*execution approval/);
  assert.match(system, /three phases: Research, Design and Implement/);
  assert.match(system, /Research → Design/);
  assert.match(system, /design-finish/);
  assert.match(system, /Only native `execute_and_review`/);
  assert.doesNotMatch(system, /### TDD mode|Entering TDD mode|Exiting TDD mode|\/skill:tdd/);
  assert.equal(existsSync(path.join(root, 'pi/agent/skills/tdd/SKILL.md')), false);
  assert.doesNotMatch(conductor, /alternative.*direct-edit/);
  assert.match(conductor, /\/skill:design/);
  assert.match(executor, /"operations"/);
  assert.match(executor, /`replace_file`/);
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


test('bounded issue design includes collaborative code discussion and confirmation', () => {
  const design = read('pi/agent/skills/design/SKILL.md');
  const discussion = design.split('### One bounded design pass')[1].split('## 3.')[0].replace(/\s+/g, ' ');
  for (const phrase of ['focused `diff` blocks', 'changed portions', 'illustrative design excerpts',
    'producers/consumers', 'ownership/lifecycle', 'implementation preview', 'acceptance criteria',
    'edge cases', 'approve or revise the design', 'user confirmation', 'design-record']) {
    assert.ok(discussion.includes(phrase), phrase);
  }
});

test('Pi retains exact operations and separate execution approval without default JSON presentation', () => {
  const design = read('pi/agent/skills/design/SKILL.md');
  const executor = read('pi/agent/skills/executor/SKILL.md');
  const conductor = read('pi/agent/skills/conductor/SKILL.md');
  const system = read('pi/agent/SYSTEM.md');
  for (const [name, text] of Object.entries({ design, executor, conductor, system })) {
    assert.match(text, /full operations on request/, name);
    assert.match(text, /not (?:display[\s\S]*by default|by default)/, name);
  }
  const handoff = design.split('## 4. Prepare executor handoff')[1].split('## 5. Own the execution and review loop')[0];
  assert.match(handoff, /Prepare and retain the complete executor input/);
  assert.match(handoff, /new consequential choice[\s\S]*return to the design conversation and obtain approval/);
  const execution = design.split('### Before the first attempt')[1].split('### Attempt and feedback')[0];
  assert.match(execution, /short execution confirmation[\s\S]*scope, affected files[\s\S]*build\/test commands/);
  assert.match(execution, /Explicitly ask the user whether to \*\*execute\*\*/);
  assert.match(execution, /Consequential differences require renewed design approval first/);
  assert.match(executor, /separate explicit execution approval[\s\S]*pass this exact JSON/);
  assert.match(executor, /when requested, return the complete JSON/);
  assert.match(conductor, /explicit design approval before generating executor operations/);
  assert.match(conductor, /permission \*\*to execute\*\*, separate from design approval/);
  assert.doesNotMatch(design, /Present the executor input separately|Present the proposed operations and explicitly ask/);
  assert.doesNotMatch(conductor, /Present the design, fixed acceptance criteria and proposed executor JSON/);
  assert.doesNotMatch(executor, /## Handoff\s+Return the JSON/);
});

// These contracts complement real Scaffold/Git integration tests; they do not simulate reasoning.
test('design walks bounded issues downward and gates implementation until all designs are approved', () => {
  const design = read('pi/agent/skills/design/SKILL.md').replace(/\s+/g, ' ');
  for (const phrase of ['root issue', 'recursive issue graph', 'design-next', 'design-record', 'design-finish',
    'immediate children', 'Definitions remain immutable', 'approval states exactly what the user confirmed',
    'No implementation may run before this entire graph design phase completes',
    'Small changes use the root itself as the leaf']) assert.ok(design.includes(phrase), phrase);
});

test('implementation walks upward with explicit issue commits and discovery returns to design', () => {
  const design = read('pi/agent/skills/design/SKILL.md').replace(/\s+/g, ' ');
  for (const phrase of ['Do not redo all design approvals', 'Each resolved node gets its own commit',
    'empty commit', 'parent remains incomplete', 'suspend_issue', 'resume_issue', 'handoffRef',
    'Three consumed attempts mean the next is four', 'Completed', 'original ticket criteria']) {
    assert.ok(design.toLowerCase().includes(phrase.toLowerCase()), phrase);
  }
  assert.match(design, /directly.*design-reopen|design-reopen.*directly/);
});

test('recovery retains designs, receipts and immutable criteria without inventing approvals', () => {
  const design = read('pi/agent/skills/design/SKILL.md').replace(/\s+/g, ' ');
  for (const phrase of ['Conversational memory is not authoritative', 'design_history',
    'never fabricate a record', 'same issue', 'criteria/findings', 'attempts',
    'original ticket criteria', 'must block rather than weaken them']) assert.ok(design.includes(phrase), phrase);
});
