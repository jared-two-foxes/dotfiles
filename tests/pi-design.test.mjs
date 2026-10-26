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
    '## 2. Collaborative technical design',
    '## 3. Design confirmation',
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
  assert.match(system, /one of two modes/);
  assert.match(system, /Research → Design/);
  assert.match(system, /ticket-driven TDD task/);
  assert.match(system, /sole repository-writing/);
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
    assert.match(text, /active (?:implementation )?verification\/correction loop/, name);
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


test('Pi Design discusses code and data usage iteratively before operation generation', () => {
  const design = read('pi/agent/skills/design/SKILL.md');
  const discussion = design.split('## 2. Collaborative technical design')[1].split('## 3. Design confirmation')[0];
  assert.match(discussion, /focused code samples[\s\S]*before generating operations/);
  assert.match(discussion, /`diff` blocks[\s\S]*changed portions/);
  assert.match(discussion, /Label new-code samples as additions/);
  assert.match(discussion, /tradeoffs[\s\S]*wait for the user's choice or explicit delegation/);
  assert.match(discussion, /representation and how the data is used/);
  assert.match(discussion, /construction\/population[\s\S]*validation and invariants[\s\S]*producers and consumers[\s\S]*ownership and lifecycle/);
  assert.match(discussion, /illustrative design excerpts, not executable operations/);
  assert.match(discussion, /Mark omitted context explicitly/);
  assert.match(discussion, /documentation\/configuration changes[\s\S]*focused text\/configuration excerpts/);
  assert.match(discussion, /trivial changes[\s\S]*proportionate/);
});

test('Pi design approval covers a concise implementation preview, not an operation dump', () => {
  const design = read('pi/agent/skills/design/SKILL.md');
  const confirmation = design.split('## 3. Design confirmation')[1].split('## 4. Prepare executor handoff')[0];
  assert.match(confirmation, /implementation preview/);
  assert.match(confirmation, /representative code\/text excerpts and changed portions clearly marked/);
  assert.match(confirmation, /how new or changed data is created and used/);
  assert.match(confirmation, /Acceptance criteria[\s\S]*edge cases/);
  assert.match(confirmation, /do not introduce consequential choices for the first time/);
  assert.match(confirmation, /approve or revise the design before generating implementation operations/);
  assert.match(confirmation, /separate explicit execution confirmation/);
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

// These are instruction-contract tests, not simulations of model reasoning.
const designSection = heading => {
  const design = read('pi/agent/skills/design/SKILL.md');
  const start = design.indexOf(heading);
  assert.notEqual(start, -1, heading);
  const end = design.indexOf('\n### ', start + heading.length);
  return design.slice(start, end < 0 ? undefined : end).replace(/\s+/g, ' ');
};

test('complex feature approves shared architecture and persists tasks before detailed design', () => {
  const design = read('pi/agent/skills/design/SKILL.md');
  const headings = ['### Feature-level architectural design', '### Approve the shared architecture',
    '### Feature planning and decomposition', '### Select exactly one eligible task',
    '### Task-level detailed design and approval', '## 4. Prepare executor handoff'];
  const positions = headings.map(h => design.indexOf(h));
  assert.ok(positions.every((p, i) => p >= 0 && (!i || p > positions[i - 1])));
  const architecture = designSection(headings[0]);
  for (const contract of ['objectives and acceptance criteria', 'component/domain ownership',
    'public interfaces', 'cross-component invariants', 'persistence/consistency',
    'security', 'compatibility', 'algorithmic choices affecting task boundaries',
    'integration risks', 'feature-level verification', 'defer internal algorithms',
    'Do not produce exhaustive implementations, exact Executor operations']) {
    assert.ok(architecture.includes(contract), contract);
  }
  const plan = designSection(headings[2]);
  assert.match(plan, /architecture approval[\s\S]*before any task-level detailed design/);
  assert.match(plan, /complete internal implementation design before persistence/);
  assert.match(plan, /`id`[\s\S]*`objective`[\s\S]*`acceptance_criteria`[\s\S]*`context`[\s\S]*`constraints`[\s\S]*`dependencies`/);
  assert.match(plan, /Never split solely by file/);
  assert.match(plan, /never generate a feature-wide operation set/);
});

test('selected task has focused detailed design and distinct design/execution approvals', () => {
  const task = designSection('### Task-level detailed design and approval');
  for (const phrase of ['selected task', 'previously established interfaces',
    'detailed data structures and usage', 'algorithms and edge cases',
    'validation/error handling', 'testing strategy', 'compatibility with completed tasks',
    'Avoid loading implementation details for unrelated future tasks',
    'explicit task design approval', 'separate explicit execution confirmation',
    'Every next task returns here for its own design and execution approvals']) {
    assert.ok(task.includes(phrase), phrase);
  }
  assert.match(designSection('### Approve the shared architecture'), /Architecture approval does not approve new consequential task-level design decisions or task execution/);
});

test('small change keeps one design approval round without artificial decomposition', () => {
  const design = read('pi/agent/skills/design/SKILL.md').replace(/\s+/g, ' ');
  assert.match(design, /small change[\s\S]*streamlined process:[\s\S]*detailed design[\s\S]*separate execution approval/);
  assert.match(design, /No artificial decomposition or extra architecture approval is required/);
  assert.match(design, /not file counts, line counts or number of acceptance criteria/);
});

test('design can recursively split a pending task without execution and retains parent verification', () => {
  const split = designSection('### Recursive decomposition during design');
  for (const phrase of ['before generating operations or calling `start`',
    'No failed execution attempt is required', '`decompose` on the pending parent',
    'Children inherit the approved architecture', 'ancestor dependencies',
    'original parent objective, acceptance criteria, history', 'completed descendants',
    'parent remains incomplete', 'own Conductor verification of original criteria and checkpoint']) {
    assert.ok(split.includes(phrase), phrase);
  }
});

test('architectural conflict stops work without rebinding immutable design or criteria', () => {
  const conflict = designSection('### Architectural conflict and immutable references');
  assert.match(conflict, /stop and return to feature-level design before operations/);
  assert.match(conflict, /explicit user approval/);
  assert.match(conflict, /Do not silently replace the original approved design, weaken original acceptance criteria/);
  assert.match(conflict, /original feature baseline, design reference, receipts and checkpoints/);
  assert.match(conflict, /cannot be reconciled in place[\s\S]*Block affected work/);
  assert.match(conflict, /Do not initialize a replacement feature or fabricate revised evidence/);
});

test('recovery uses retained task decisions and never infers missing approval or replays completed work', () => {
  const recovery = designSection('### Retain and recover task design decisions');
  for (const phrase of ['Do not overwrite task definitions', 'Conductor `requirements`',
    'approval record (what the user explicitly approved)', 'Keep this text fixed across corrections',
    'receipt authenticates retained bytes, not consent', 'not `next` alone',
    'Missing task design approval must not be inferred', 'task design reapproval',
    'do not replay completed work', 'no separate task-design note/approval operation',
    'Do not issue dummy attempts']) {
    assert.ok(recovery.includes(phrase), phrase);
  }
  const final = read('pi/agent/skills/design/SKILL.md').split('## Final feature verification')[1];
  assert.match(final, /original[\s\S]*approved feature architecture and acceptance criteria/);
  assert.match(final, /Task-level decisions are[\s\S]*supporting evidence only/);
  assert.match(final, /never reconstruct them[\s\S]*silently replace acceptance criteria/);
});
