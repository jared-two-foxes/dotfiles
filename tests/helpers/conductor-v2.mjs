// Lifecycle scenarios describe explicit test-domain outcomes, not an application
// wire protocol. Emit current Conductor v2 receipts with retained logs.
// Wire-contract tests import the production adapters directly.
function assertV2(request) { if (request.schema !== 'conductor.request/v2') throw new Error('Fixture requires a current v2 command list'); }
import { executeAndReview as pi } from '../../pi/agent/extensions/execute-and-review/adapter.mjs';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export async function requestView(request) {
  assertV2(request);
  const underlying = command => command.args[0].endsWith('input-guard.mjs') ? JSON.parse(command.args[1]) : command;
  const reviewCommand = underlying(request.commands.at(-1));
  const review = JSON.parse(await readFile(reviewCommand.args[reviewCommand.args.indexOf('--request') + 1], 'utf8'));
  const requirements = await readFile(review.requirements, 'utf8');
  const flag = name => reviewCommand.args[reviewCommand.args.indexOf(name) + 1];
  const settings = {};
  for (const [name, option] of [['wall_clock_budget_secs', '--wall-clock-budget-secs'], ['max_turns', '--max-turns'],
    ['max_cost_usd', '--max-cost-usd'], ['max_tool_calls', '--max-tool-calls'],
    ['max_repeated_actions', '--max-repeated-actions'], ['max_completion_attempts', '--max-completion-attempts']]) {
    if (reviewCommand.args.includes(option)) settings[name] = Number(flag(option));
  }
  return { schema: 'fixture.delivery-input/v1', repository_path: request.working_directory,
    execution: JSON.parse(await readFile(underlying(request.commands[0]).args[1], 'utf8')),
    checks: request.commands.slice(1, -1), review: { requirements, base_ref: review.base_ref,
      model: flag('--model'), ...settings } };
}

export async function domainResponse(request, response) {
  let value;
  try { value = JSON.parse(response.stdout); } catch { return response; }
  if (value.schema !== 'fixture.delivery-outcome/v1') return response;
  const view = await requestView(request);
  const directory = path.join(request.output_directory, 'fixture-' + randomUUID());
  await mkdir(directory);
  const records = [];
  async function add(index, data, code = 0, name = request.commands[index]?.name) {
    const spec = request.commands[index] ?? { name, program: 'unexpected', args: [] };
    const stdout = typeof data === 'string' ? data : JSON.stringify(data);
    const stdout_path = path.join(directory, String(index).padStart(6, '0') + '.stdout');
    const stderr_path = path.join(directory, String(index).padStart(6, '0') + '.stderr');
    await writeFile(stdout_path, stdout ?? ''); await writeFile(stderr_path, '');
    records.push({ ...spec, name, index, exit_code: code, status: code === 0 ? 'PASSED' : 'FAILED',
      ...(spec.success_condition ? { condition: { ...spec.success_condition,
        status: code === 0 ? 'PASSED' : 'FAILED', exit_code: code === 0 ? 0 : 1,
        stdout: '', stderr: '', stdout_truncated: false, stderr_truncated: false } } : {}),
      stdout: (stdout ?? '').slice(0, 16384), stderr: '', stdout_truncated: (stdout?.length ?? 0) > 16384,
      stderr_truncated: false, stdout_path, stderr_path });
  }
  const execution = value.execution ?? { success: value.phase !== 'execution' };
  await add(0, { operations_applied: execution.success ? view.execution.operations.length : 0, ...execution }, execution.success ? 0 : 1);
  let checks = value.checks;
  if (!checks) checks = view.checks.map((check, i) => ({ name: check.name,
    exit_code: value.phase === 'verification' && i === 0 ? 1 : 0, stdout: '' }));
  if (value.phase !== 'execution') {
    for (const check of checks) {
      await add(records.length, check.stdout ?? '', check.exit_code, check.name);
      if (check.exit_code !== 0 && value.status !== 'PASSED') break;
    }
    if (value.phase === 'review') {
      let review = value.review;
      if (review === undefined) review = { status: value.status === 'PASSED' ? 'APPROVED' :
        value.status === 'NEEDS_DESIGN' ? 'CHANGES_REQUESTED' : 'INDETERMINATE' };
      const code = { APPROVED: 0, CHANGES_REQUESTED: 1, INDETERMINATE: 3 }[review?.status] ?? 0;
      if (review) review = { schema: 'review.result/v1', review_id: 'fixture-review', completed_at: '2026-11-01T00:00:00Z',
        reason: review.status === 'INDETERMINATE' ? 'BUDGET_EXHAUSTED' : 'REVIEW_COMPLETED',
        findings: review.status === 'CHANGES_REQUESTED' ? [{ severity: 'high', blocking: true, message: 'Fixture correction required' }] : [], ...review };
      if (['APPROVED', 'CHANGES_REQUESTED'].includes(review?.status)) {
        const line = view.review.requirements.split('\n').find(l => l.startsWith('{"design":'));
        const context = line ? JSON.parse(line) : null;
        review.obligation_assessments ??= (context?.obligations ?? []).filter(o => o.status !== 'independently_verified')
          .map(o => ({ obligation_id: o.id, disposition: 'verified', evidence: 'Independent fixture inspected the correction and regression output' }));
      }
      if (review?.findings) review.findings = review.findings.map(f => ({
        severity: 'high', blocking: review.status === 'CHANGES_REQUESTED', ...f,
      }));
      await add(records.length, review, code, 'review');
    }
  }
  const status = { PASSED: 'PASSED', NEEDS_DESIGN: 'FAILED', BLOCKED: 'BLOCKED' }[value.status];
  if (status !== 'PASSED' && records.length) {
    records.at(-1).status = status;
    if (status === 'FAILED' && records.at(-1).exit_code === 0) records.at(-1).exit_code = 1;
    if (records.at(-1).condition) {
      records.at(-1).condition.status = status;
      records.at(-1).condition.exit_code = status === 'BLOCKED' ? null : 1;
    }
  }
  const runner = { schema: 'conductor.result/v2', status,
    phase: status === 'PASSED' ? 'completed' : 'commands', commands: records, output_directory: directory,
    ...(status === 'PASSED' ? {} : { failed_command_index: records.length - 1, error: 'Fixture failed' }) };
  const outcomeExit = { PASSED: 0, NEEDS_DESIGN: 2, BLOCKED: 3 }[value.status];
  const code = response.code === outcomeExit ? { PASSED: 0, FAILED: 1, BLOCKED: 2 }[status] : -1;
  return { code, stdout: JSON.stringify(runner), stderr: response.stderr ?? '' };
}

export async function successResponse(request, patch = {}) {
  return domainResponse(request, { code: 0, stderr: '', stdout: JSON.stringify({
    schema: 'fixture.delivery-outcome/v1', status: 'PASSED', phase: 'review', ...patch,
  }) });
}

function adapt(adapter) {
  return (args, context, options = {}) => adapter(args, context, { ...options,
    ...(options.invokeConductor ? { invokeConductor: async (json, timeoutMs) => {
      const request = JSON.parse(json);
      const response = await options.invokeConductor(JSON.stringify(await requestView(request)), timeoutMs);
      return domainResponse(request, response);
    } } : {}),
  });
}
export const executeAndReview = adapt(pi);
