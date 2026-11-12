import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = p => readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');
const flat = p => read(p).replace(/\s+/g, ' ');

const publishingPolicy = name => {
  const text = read(name);
  const start = text.indexOf('## Git and GitHub publishing\n');
  assert.notEqual(start, -1, `missing publishing policy: ${name}`);
  return text.slice(start).split('\n## ')[0].trim();
};

test('Publishing permits scoped commits and PR publication without granting merge authority', () => {
  const policy = publishingPolicy('shared/pi/agent/APPEND_SYSTEM.md').replace(/\s+/g, ' ');
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
    'Never merge PRs',
  ]) {
    assert.ok(policy.includes(phrase), `missing publishing constraint: ${phrase}`);
  }
});

test('Pi policy files keep implementation gates without blanket publishing bans', () => {
  for (const name of ['shared/pi/agent/APPEND_SYSTEM.md', 'shared/pi/agent/AGENTS.md']) {
    const text = flat(name);
    assert.match(text, /Git\/GitHub publishing|Git and GitHub publishing/, name);
    assert.match(text, /active (?:implementation )?(?:verification\/correction loop|correction epoch)/, name);
    assert.match(text, /[Nn]ever merge PRs/, name);
    assert.match(text, /source edits/, name);
    assert.doesNotMatch(text, /do not commit or push|run build\/test commands, or commit|Feature branches may be created, committed to, pushed, rebased, and deleted freely|bash is for read-only inspection only|Bash access is for read-only discovery only/, name);
  }
});

test('AGENTS.md points at the delivery skills and the execution tool', () => {
  const agents = read('shared/pi/agent/AGENTS.md');
  assert.match(agents, /\/skill:init-feature/);
  assert.match(agents, /\/skill:feature-delivery/);
  assert.match(agents, /execute_and_review/);
  assert.match(agents, /scaffold_tasks/);
  assert.doesNotMatch(agents, /skill:tdd|writes tests and implementation code directly/);
  assert.doesNotMatch(agents, /(?<!APPEND_)SYSTEM\.md/);
});

test('the settings template installs the delivery-pipeline package', () => {
  const settings = JSON.parse(read('shared/pi/agent/settings.json.template'));
  assert.ok(settings.packages.includes('git:github.com/jared-two-foxes/delivery-pipeline'));
});
