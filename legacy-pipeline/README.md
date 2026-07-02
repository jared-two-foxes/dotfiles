# Legacy script-based pipeline (frozen snapshot)

This is a verbatim copy of `bin/` and `prompts/` as they existed on
2026-07-02, immediately before the criteria-stack rewrite (see
`../criteria-stack-plan.md`). It exists as a fallback / reference, not
as a maintained codebase — nothing here receives further fixes or
feature work.

The scripts most relevant to the old workflow are `check-ticket.py`,
`write-tests.py`, `write-next-test.py`, `implement-tests.py`,
`resolve-ticket.py`, `validate-and-review.py`, and `tdd-pipeline.py`,
all built on `pipeline_lib.py`. To run any of them from this snapshot,
`cd` into `legacy-pipeline/bin` first — they resolve `prompts/` and
config relative to their own location, so running them from here uses
this copy of `pipeline_lib.py` and the prompt templates unchanged,
independent of whatever `../../bin` and `../../prompts` become.
