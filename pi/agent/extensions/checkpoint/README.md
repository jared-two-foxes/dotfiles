# Verified task checkpoints

This extension registers `checkpoint_verified_task`. The tool retries automatic
finalization from a successful implementation receipt through Execution Recovery's
Conductor invocation.

`finalization.mjs` authenticates the task result and records matching Scaffold
completion. `scaffold.mjs` supplies current feature data, calls `commit.mjs`,
and records the resulting checkpoint. The commit implementation preserves the
index, validates the exact reviewed tree, checks branch protection and authority,
and recovers an already-created matching commit.

The shared verification library authenticates receipts and checkpoint ancestry.
Install this extension alongside Execution Recovery, Scaffold, and the complete
`lib/` tree. See [the shared boundaries](../../lib/README.md).
