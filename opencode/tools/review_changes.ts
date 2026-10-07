import { tool } from '@opencode-ai/plugin';
import { reviewChanges } from '../scripts/review-runner.mjs';

export default tool({
  description: 'Review a Git change against acceptance criteria using review-cli. Returns JSON with verdict, blocking findings and suggestions. ERROR/INDETERMINATE never mean approval.',
  args: {
    repository: tool.schema.string().optional().describe('Repository path; defaults to the session worktree'),
    baseRef: tool.schema.string().describe('Fixed task-start commit SHA, or explicit review baseline'),
    headRef: tool.schema.string().optional().describe('Optional committed target; omit to review the working tree, including untracked files'),
    requirements: tool.schema.string().describe('Full acceptance criteria, plan, edge cases and review scope; plain text, not a file path'),
    model: tool.schema.string().optional().describe('Review provider/model; defaults to REVIEW_MODEL or opencode/gpt-5.6-terra'),
    wallClockBudgetSecs: tool.schema.number().int().min(1).max(600).optional(),
    maxTurns: tool.schema.number().int().min(1).max(100).optional(),
  },
  async execute(args, context) {
    return JSON.stringify(await reviewChanges(args, context));
  },
});
