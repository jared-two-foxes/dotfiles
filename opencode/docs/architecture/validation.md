# Contract validation

From the repository root, using Python 3.10+ and Git:

```sh
python -m venv .venv-workflow-contracts
# Activate the environment using your platform's usual command.
python -m pip install -r tests/workflow-contracts-requirements.txt
python tests/workflow-contracts.test.py -v
node --test tests/review-runner.test.mjs
```

On Windows the existing installer regression suite is available separately:

```powershell
pwsh -NoProfile -File tests/install-opencode.ps1
```

Python unittest is already used in this repository. jsonschema is the sole new
**development-only** top-level dependency, pinned in the validation requirements;
it provides actual Draft 2020-12 validation instead of an incomplete custom schema
interpreter. It is not installed by OpenCode installers or used at runtime. The
invalid-domain schema IDs are identifiers, not network retrieval endpoints;
schemas contain no remote references. Validation is offline after installation.

The tests validate schema definitions, all manifest/execution/review fixtures,
required fields, version rejection, checksum and artefact linkage, both combined
patches against a reproducible Git base, original candidate commit, actual two-test
execution, and negative schema/patch cases. Temporary fixture repositories use
fixed Git identity/time, LF contents, SHA-1 and disabled hooks/host config. They
never execute scripts from a user's target project. Every temporary repository is
removed on exit. This is fixture validation, not a prototype executor.

JSON Schema does not prove path safety, Git state, approval authenticity, inventory
completeness, unique operation ordering or cross-document identity. Examples check
several of these relationships, but adversarial executor behaviour, filesystem
race/symlink handling, no-offset parsing, worktrees and sandboxed Review are future
implementation tests. Do not mistake these passing fixtures for runtime safety.
