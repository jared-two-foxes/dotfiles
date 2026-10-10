import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
  assert.match(system, /direct-edit.*tdd/);
  assert.match(conductor, /\/skill:design/);
  assert.match(executor, /"operations"/);
  assert.match(executor, /`replace_file`/);
});
