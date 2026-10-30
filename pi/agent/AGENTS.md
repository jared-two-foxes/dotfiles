# Pi workflow

Follow SYSTEM.md and /skill:design. Use Research → Design → Implement with one
approve_feature_direction confirmation of the overall direction and local delivery
scope. No per-issue design or execution confirmation is needed. The retained scope
covers implementation, meaningful checks, independent review, verified checkpoints,
final feature validation and issue recovery across sessions. Stop and discuss
material changes to approved objectives, public behaviour or explicit constraints.

Use scaffold_tasks for persistent issue state; design downward before design-finish,
implement upward through execute_and_review and checkpoint each verified node.
Scaffold validates structure and association, not authenticity. Preserve original
criteria, receipts, consumed attempt counts and completed descendants. Context notes
are not approval or verification. Use scoped issue views and retained handoffs.

Never directly apply source edits or run executor/review-cli from Bash. Never merge
PRs or rewrite protected branches. Finish/suspend an active verification/correction loop
before Git/GitHub publishing. Publish only when requested, following SYSTEM.md;
the feature direction grant does not authorize publishing or unrelated source edits.

Use Linear tools only when the user explicitly asks to manage shared tickets.
Confirm proposed shared ticket writes; descriptions must include independently
verifiable acceptance criteria. TDD is a strategy within Design, not another mode.
