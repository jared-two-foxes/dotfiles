# Toolchain

Optional reference for human use or external CI/CD pipelines. Agents do
not use this file — they discover test framework and conventions from
existing code in the repository.

Keep this file at the repo root as TOOLCHAIN.md if you want to document
your project's build and test commands for reference.

| Command | Value |
|---|---|
| BUILD_CMD | |
| TEST_CMD | |
| FMT_CHECK_CMD | |
| FMT_FIX_CMD | |
| LINT_CMD | |
| TYPECHECK_CMD | |
| GIT_WORKFLOW | trunk-based |

## Notes

- Leave a command blank, or write 
one, if it doesn't apply to this repo.
- GIT_WORKFLOW is 	runk-based or pr-based.
- This file is optional and for reference only. Agents infer commands and
  conventions from project files (package.json, Cargo.toml,
  pyproject.toml, Makefile, go.mod, etc.) and existing test files.
