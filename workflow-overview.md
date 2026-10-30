# Feature direction and issue delivery

Research → one overall design direction approval → recursive issue design →
implementation from leaves upward → full feature checks and independent review →
user reviews results.

`approve_feature_direction` is the single native confirmation after the direction
and local delivery scope are presented. It persists authority across sessions for
scoped design, implementation, checks, independent reviews, verified local commits
and recovery. No per-issue confirmation or separate execution prompt is required.
Detailed design decisions and review corrections within that direction are delegated
to Pi. Material changes to objectives, public behaviour or explicit constraints
return to the user. Publishing requires a user request; merging remains human-owned.

Use compact Scaffold summary/design-select/select/issue views to design the whole
graph before design-finish and implement one eligible issue at a time. Persist
agent-authored designs with an honest reference to the overall authorization,
not invented individual user approvals. Receipts retain exact attempts, criteria,
checks and baselines. Each verified issue is completed and checkpointed; parents
verify original integrated criteria after children. Discoveries use explicit native
suspension/design/resumption without losing source or resetting attempts.

Final independent review and meaningful full-feature checks are required. Findings
within scope become corrective issues and re-enter the same loop without another
approval. Report actual check/review results and reviewable commits/PR at completion.

See Pi's Design and Scaffold skills and the native Conductor README for detailed
contracts, context handoff and recovery procedures.

Issue verification uses explicit targeted `checks`: filtered regressions for leaves
and scoped integration checks for intermediate parents. Exclude the full repository
or workspace test command wherever the runner can select meaningful coverage.
Retain exact commands and coverage in issue designs; explain unavoidable broader
checks. Reserve the full test suite for final root/feature verification through
`validate_feature` after checkpoints, including revalidation after corrective work.
Keep a receipt chain's selected checks fixed across corrections.
