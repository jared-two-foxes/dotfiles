# dependency-codegen

Lightweight CLI for dependency-driven code generation from acceptance criteria.

## Install (editable)

```bash
pip install -e ./ticket-pipeline
pip install -e ./dependency-codegen
```

## Usage

```bash
dep-scaffold --acceptance-criteria "Add endpoint X with validation Y"
```

Or from a file:

```bash
dep-scaffold --acceptance-criteria-file criteria.md --show-plan
```

The tool first asks the model for a compact dependency-first plan, then runs a tool-enabled implementation pass that can read and write repository files directly.
