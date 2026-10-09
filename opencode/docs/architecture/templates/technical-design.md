# <Change title>

Design ID: <stable ID> · Revision: <positive integer> · Status: draft / agreed
Requirements ID/revision: <ID, revision> · Repository/base: <identity, full SHA>
Previous design/feedback: <references, or initial design>

Keep simple changes brief. Retain requirements, proposed solution, affected files
and test strategy; mark other sections not applicable or omit them with a reason.
Complex changes should fully describe interfaces and consequential decisions.
Agreement on this document is separate from approving exact execution artefacts.

## Requirements and context

- Objectives and acceptance criteria (stable criterion IDs).
- Constraints, exclusions, original ticket snapshot or conversation reference.
- Relevant environment and user behaviour; distinguish outcomes from mechanisms.

## Current implementation

Relevant paths, types, APIs and data flow, with evidence from the fixed base.
Describe current behaviour and the concrete defect/limitation.

## Proposed solution

Describe resulting behaviour and exact implementation steps another engineer can
follow. Include proposed code/algorithms where useful; source code stays inert in
this document and patch workspace. Identify error behaviour and edge cases.

## Architectural decisions and rationale

| Decision | Alternatives | Rationale and tradeoff | Human agreement |
|---|---|---|---|
| <decision> | <options> | <reason> | <agreed/open> |

## Interfaces, types and data flow

Signatures, input/output types, state transitions, compatibility and integrations.
Use a compact diagram only where it clarifies relationships or event order.

## Files and components affected

| Path | Create / modify / delete | Exact responsibility/change |
|---|---|---|
| <path> | <operation> | <details> |

## Test strategy and Review profile

Map every acceptance criterion to proposed test assertions or inspection evidence.
Specify build, format-check, lint/typecheck and test requirements, named trusted
check profile, fixtures and failure cases. Record expected test names/counts.
Do not claim tests were executed during Design. Never use format-fix in Review.

## Risks and unresolved questions

Security, migrations, compatibility, performance and operating assumptions.
Consequential open questions block execution approval. State intentional limits.

## Execution planning handoff

Plan ID/revision, one combined patch reference, manifest reference and base.
Approval must bind exact design/manifest/patch bytes and requirement revision.
List feedback addressed from earlier attempts, without erasing earlier history.
