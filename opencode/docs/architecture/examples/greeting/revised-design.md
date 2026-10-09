# Trim whitespace in greeting names — revision 2

Design ID: greeting-design · Revision: 2 · Status: agreed fictional revision
Requirements: greeting-requirements, revision 1 (unchanged)
Supersedes design revision 1; responds to greeting-review-1 and finding AC-2.

Retain the API, str.strip() implementation, original base and two-test Review
profile described in design.md. Amend test_space_padding to use subTest for
space, tab and newline padded inputs, asserting `Hello, Ada` for each. This
preserves two discovered test methods with three AC-2 assertions. There are no
other implementation decisions or requirement changes. The original plan remains
immutable. r2/execution-manifest.json binds this document and a new combined patch
from the original base; a fresh human approval is required before execution.
This is a proposed correction, not a patch applied by Review. No execution or
review success is claimed for revision 2 in the example history.
