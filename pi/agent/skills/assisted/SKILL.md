---
name: assisted
description: >
  Compatibility guidance for the retired assisted Scaffold workflow.
  Use Design for implementation and Scaffold for persistent task state.
---

# Assisted workflow replacement

The former Scaffold execution pipeline has been retired. This skill grants no
source-edit, test execution or verification authority.

For discussion and user guidance, remain in Research mode. For requested
implementation load `/skill:design` and reuse the single overall feature direction approval; application changes and verification use only `execute_and_review`.
Load `/skill:scaffold` to inspect or explicitly manage persistent feature/task
state through `scaffold_tasks`. Pi owns reasoning, Scaffold owns persistence and
Conductor owns execution and verification. No automatic task loop is supplied.
