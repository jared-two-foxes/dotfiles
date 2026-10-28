import { test } from 'node:test';
import assert from 'node:assert/strict';
import { meaningful } from '../pi/agent/extensions/conductor/feature-verification.mjs';

const marker = 'test result: ok. 13 passed; 0 failed';
const positive = marker + '; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s';
const empty = 'running 0 tests\ntest result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out';
const check = { name: 'test', successPattern: marker };
const output = (stdout, stderr = '', patch = {}) => ({ stdout, stderr, exit_code: 0, ...patch });

for (const [name, stdout, stderr] of [
  ['mixed Cargo workspace harnesses', [empty, 'running 13 tests', positive, 'test result: ok. 20 passed; 0 failed', 'test result: ok. 5 passed; 0 failed', 'Doc-tests messages', empty].join('\n'), ''],
  ['empty suites preceding substantive tests', empty + '\n' + positive, ''],
  ['empty suites following substantive tests', positive + '\n' + empty, ''],
  ['empty suite on stderr', positive, empty],
  ['positive suite on stderr', empty, positive],
]) test('meaningful coverage accepts ' + name, () => assert.equal(meaningful(check, output(stdout, stderr)), true));

for (const text of [empty, '0 tests ran\nworkspace finished', 'No tests found\nworkspace finished',
  'No tests collected\nworkspace finished', '0 passing\nworkspace finished', '# pass 0\nworkspace finished', 'Passed: 0\nworkspace finished', 'running 13 tests\n0 passed\nworkspace finished']) {
  test('meaningful coverage rejects all-zero output: ' + text.split('\n')[0], () => {
    assert.equal(meaningful({ name: 'test', successPattern: 'workspace finished' }, output(text + '\nworkspace finished')), false);
  });
}

test('meaningful coverage still requires the exact approved positive marker', () => {
  assert.equal(meaningful(check, output('test result: ok. 20 passed; 0 failed\n' + empty)), false);
});
test('meaningful coverage rejects a failing command despite positive output and marker', () => {
  assert.equal(meaningful(check, output(positive + '\n' + empty, '', { exit_code: 7 })), false);
});
test('meaningful coverage rejects incomplete commands despite positive output and marker', () => {
  for (const problem of ['TIMEOUT', 'CANCELLED', 'OUTPUT_LIMIT'])
    assert.equal(meaningful(check, output(positive, '', { problem })), false);
  assert.equal(meaningful(check, output(positive, '', { exit_code: null })), false);
});
test('meaningful coverage preserves custom nonempty success markers without an empty-run diagnostic', () => {
  assert.equal(meaningful({ name: 'messages smoke', successPattern: 'Messages checks exercised' }, output('Messages checks exercised')), true);
});
test('meaningful coverage keeps build success independent of test counts', () => {
  assert.equal(meaningful({ name: 'build' }, output(empty)), true);
});

for (const summary of ['13 passing', '# pass 13', 'Passed: 13', '13 tests passed']) {
  test('mixed empty output accepts a positive completed count: ' + summary, () => {
    assert.equal(meaningful({ name: 'test', successPattern: summary }, output(summary + '\n' + empty)), true);
  });
}

for (const separator of ['\n', '\r\n', '\r']) {
  test('a passed token cannot borrow a scheduled count across ' + JSON.stringify(separator), () => {
    const text = ['0 passed', '13 tests scheduled', 'workspace finished'].join(separator);
    assert.equal(meaningful({ name: 'test', successPattern: 'workspace finished' }, output(text)), false);
  });
  test('a custom passed marker cannot borrow a zero on the next line across ' + JSON.stringify(separator), () => {
    const text = ['Messages checks passed', '0 failures'].join(separator);
    assert.equal(meaningful({ name: 'messages', successPattern: 'Messages checks passed' }, output(text)), true);
  });
}
test('positive count summaries cannot span stdout and stderr', () => {
  assert.equal(meaningful({ name: 'test', successPattern: 'workspace finished' }, output('0 passed', '13 tests scheduled\nworkspace finished')), false);
});
test('zero count summaries cannot span stdout and stderr', () => {
  assert.equal(meaningful({ name: 'messages', successPattern: 'Messages checks passed' }, output('Messages checks passed', '0 failures')), true);
});
test('count summaries still permit horizontal spaces and tabs within a line', () => {
  const summary = '#\tpass: \t13';
  assert.equal(meaningful({ name: 'test', successPattern: summary }, output(summary + '\nrunning\t0\ttests\n0\tpassed')), true);
});
