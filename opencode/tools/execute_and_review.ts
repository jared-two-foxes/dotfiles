import { tool } from '@opencode-ai/plugin';
import { executeAndReview } from '../scripts/execute-and-review.mjs';

export default tool({
  description: 'Run one deterministic Conductor attempt: apply exact Design-authored executor operations, build, test, and review through the shared Rust CLI. Never retries or generates fixes.',
  args: {
    input: tool.schema.string().describe('Exact executor operations JSON authored by Design'),
    requirements: tool.schema.string().describe('Full approved design decisions and acceptance criteria'),
    baseRef: tool.schema.string().describe('Original task-start 40-character Git commit SHA, unchanged across corrections'),
    buildCommand: tool.schema.array(tool.schema.string()).min(1).describe('Build executable and arguments; e.g. ["cargo","build"]'),
    testCommand: tool.schema.array(tool.schema.string()).min(1).describe('Test executable and arguments; e.g. ["cargo","test"]'),
    reviewModel: tool.schema.string().optional().describe('Independent review model; default opencode/gpt-6.1-sol'),
  },
  async execute(args, context) {
    return JSON.stringify(await executeAndReview(args, context));
  },
});
