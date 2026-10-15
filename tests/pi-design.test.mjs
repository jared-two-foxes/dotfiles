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
