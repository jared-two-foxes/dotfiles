import { tool } from '@opencode-ai/plugin';
import { applyExecutor } from '../scripts/executor-runner.mjs';

export default tool({
  description: 'Apply approved executor operations from inline JSON to the current Git workspace using executor stdin. Returns APPLIED, APPLY_FAILED or ERROR. Partial changes may remain after failure.',
  args: {
    input: tool.schema.string().describe('Complete executor operations JSON, passed verbatim to executor apply - on stdin'),
  },
  async execute(args, context) {
    return JSON.stringify(await applyExecutor(args, context));
  },
});
