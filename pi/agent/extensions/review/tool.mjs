import { reviewChanges } from './adapter.mjs';

// Separate the tool definition from Pi's loader so it can be tested without Pi.
export function createReviewTool(Type, reviewer = reviewChanges) {
  return {
    name: 'review_changes',
    label: 'Review Changes (read-only)',
    description: 'Independently review existing Git changes without applying operations or running builds/tests. ' +
      'Research-mode review only; never a substitute for Conductor implementation verification. ' +
      'ERROR and INDETERMINATE never mean approval.',
    parameters: Type.Object({
      repository: Type.Optional(Type.String({ description: 'Repository path; defaults to the session repository' })),
      baseRef: Type.String({ description: 'Explicit base commit ref; use the merge-base for a PR-style review' }),
      headRef: Type.Optional(Type.String({ description: 'Committed target ref; omit or use :working for the working tree' })),
      requirements: Type.String({ description: 'Plain-text review scope, requirements and edge cases; not a file path' }),
      model: Type.Optional(Type.String({ description: 'Reviewer; explicit value overrides REVIEW_MODEL, then opencode/gpt-6.1-sol' })),
      wallClockBudgetSecs: Type.Optional(Type.Integer({ minimum: 1, maximum: 600, description: 'Review seconds; default 180' })),
      maxTurns: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: 'Model turns; default 20' })),
      maxCostUsd: Type.Optional(Type.Number({ minimum: 0, description: 'Optional cost ceiling in USD' })),
      maxToolCalls: Type.Optional(Type.Integer({ minimum: 1, maximum: 10000, description: 'Optional review tool-call limit' })),
      maxRepeatedActions: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: 'Optional identical-action limit' })),
      maxCompletionAttempts: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: 'Optional completion-attempt limit' })),
    }, { additionalProperties: false }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const result = await reviewer(params, { directory: ctx.cwd, abort: signal });
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        isError: result.status === 'ERROR' || result.status === 'INDETERMINATE',
        details: result,
      };
    },
  };
}
