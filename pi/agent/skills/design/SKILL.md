---
name: design
description: >
  Produce a bounded engineering design contract for a proposed change without
  implementing, authorizing delivery, or changing persistent task state.
---

# Engineering design

Use this skill to design a change whether it is an informal human-led task or
an issue within an approved feature delivery workflow. This is an independent
design capability, **not** the entry point for implementation.

Inspect relevant existing source, tests, interfaces and project constraints.
Clarify consequential ambiguity in objectives, externally observable behavior,
cost, compatibility, or scope. Do not demand a complete feature decomposition
for a small, self-contained change. Be explicit when assumptions remain.

## Design output

Provide a proportionate engineering contract describing:
- Objective, acceptance criteria, scope and non-goals.
- Existing interfaces and constraints to preserve.
- Proposed components and ownership of responsibilities.
- Inputs, outputs, interactions and important data contracts.
- Invariants, lifecycle and failure/error behavior.
- Dependencies and ordering constraints, including missing prerequisites.
- Edge cases, risks and meaningful verification strategy.
- Concrete affected modules where identifiable from inspection.

Compare alternatives when there are material tradeoffs; explain the choice.
Use small illustrative snippets or focused diffs only to clarify interfaces.
Do not generate Executor operations or implement source changes as part of design.
A design can be discussed, revised, and handed to a human or an implementation
workflow without registering a Scaffold feature.

## Integration with autonomous feature delivery

When invoked within `/skill:init-feature` (or feature-level design recovery), design *one bounded selected
issue* using its requirements, ancestor contracts and prerequisite context.
Return a contract suitable for the delivery workflow to persist through
`scaffold_tasks design-record`, including a concise summary, verification
strategy, and whether to keep the issue as a leaf or decompose it. The caller
owns feature approval, decomposition/persistence, `design-finish`, execution,
review, checkpointing, recovery and final validation.

Do not mark a design as user-approved unless user approval actually occurred.
Design alone does not grant permission to edit source files, execute checks,
commit, publish, or advance Scaffold state. Those actions are governed by
the invoking workflow and `SYSTEM.md`.
