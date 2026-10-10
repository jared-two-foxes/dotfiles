import { tool } from '@opencode-ai/plugin';
import { executeAndReview } from '../scripts/execute-and-review.mjs';

export default tool({
  description: 'Run one deterministic attempt: apply Design-authored executor JSON, compile, test, then independently review with review-cli. Never retries or authors fixes. Returns PASSED, NEEDS_DESIGN or BLOCKED.',
  args: {
    input: tool.schema.string().describe('Exact executor operations JSON authored by Design'),
    requirements: tool.schema.string().describe('Full approved design decisions and acceptance criteria'),
    baseRef: tool.schema.string().describe('Original task-start 40-character Git commit SHA, unchanged across corrections'),
    buildCommand: tool.schema.array(tool.schema.string()).min(1).describe('Build executable and arguments, no shell; e.g. ["cargo","build"]'),
    testCommand: tool.schema.array(tool.schema.string()).min(1).describe('Test executable and arguments, no shell; e.g. ["cargo","test"]'),
    testEvidencePattern: tool.schema.string().optional().describe('Optional regex with capture group 1 as executed-test count when runner output is not recognized'),
    commandTimeoutMs: tool.schema.number().int().min(1000).max(600000).optional(),
    reviewModel: tool.schema.string().optional().describe('Independent review-cli model; default opencode/gpt-6.1-sol'),
  },
  async execute(args, context) {
    return JSON.stringify(await executeAndReview(args, context));
  },
});
