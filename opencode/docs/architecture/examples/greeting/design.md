# Trim whitespace in greeting names

Design ID: greeting-design · Revision: 1 · Status: agreed for fictional example
Requirements: greeting-requirements, revision 1
Repository ID: example:greeting · Base: see execution-manifest.json

## Requirements and current implementation

AC-1: Ordinary names produce `Hello, Ada`.
AC-2: Space, tab and newline padding is ignored; the same greeting is produced.
The two-line greeting.py in base/ concatenates the name unchanged. Input is a
Python string; empty-after-trimming names retain `Hello, `. No type coercion.

## Proposed solution and decisions

Call Python str.strip() before concatenation. This covers whitespace characters
without a new dependency or API. Split/tokenize was rejected because internal
spaces must remain. Signature stays greet(name); data flow is string → trim outer
whitespace → greeting. Modify greeting.py and create test_greeting.py. No other
files, metadata, modes or behaviour change.

## Tests and Review

Propose unittest tests for an ordinary name and space padding. The trusted
`greeting-unit` Review profile runs `python -B -m unittest -v`, with two tests
expected; source remains read-only and bytecode writing disabled. Syntax is
covered by importing the module. No separate format/lint/typecheck requirement
for this fictional two-file task. AC-2 also requires tab/newline assertions.
Design has not run implementation code; Review owns verification.

## Risk and feedback

Revision 1 accidentally proposes only space-padding assertions. Review reports
this missing AC-2 evidence in review-result.json; neither Review nor Execution
adds the missing test. See revised-design.md and r2/ for the approved next
proposal, which adds the missing assertions and a new combined patch from the
same original base. An independent environmental publication-failure example is
execution-failed.json; it uses the same plan but another attempt ID, publishes no
reviewable ref, and pauses instead of causing a code repair.
