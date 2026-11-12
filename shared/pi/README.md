# Pi configuration

The repository stores the personal agent instructions (`agent/AGENTS.md`,
`agent/APPEND_SYSTEM.md`), the lsp extension config and
`agent/settings.json.template`. Pi owns the files it writes while installing,
updating and running:

- `agent/bin/` and `agent/install/`: generated launchers, active version,
  installation metadata and installed release manifests/lockfiles.
- `agent/settings.json`: live preferences, installed package list, device ID and
  last viewed changelog version.
- `agent/cache/` and `agent/models-store.json`: generated extension/model data.
- `agent/npm/` and `agent/git/`: downloaded extension packages (already ignored).

These runtime paths are ignored so Pi and downloaded extension updates do not
require dotfiles commits. Package manifests and lockfiles belonging to extension
source under `agent/extensions/` remain tracked.

## Delivery pipeline

The research/design/implement orchestration (Scaffold-backed delivery tools,
guard, skills and the orchestrator rules) lives in
[jared-two-foxes/delivery-pipeline](https://github.com/jared-two-foxes/delivery-pipeline)
and is installed as a Pi package listed in `agent/settings.json.template`:
`pi install git:github.com/jared-two-foxes/delivery-pipeline`. It adds its rules
to Pi's system prompt; `agent/APPEND_SYSTEM.md` holds the personal Git and GitHub
publishing, communication and planning policy that complements them.

## Fresh installation

Install Pi using its installer, then copy `agent/settings.json.template` to
`agent/settings.json` if no settings file exists. If your runtime agent directory
is elsewhere, copy the template there instead. Keep existing settings when
reinstalling; the template is only a starting point. Install the packages listed
in the template through Pi's package manager. Generated launchers and installed
releases are created by the installer, not supplied by this repository.

To share a deliberate preference or package-list change, edit the template.
Pi's automatic changes to the live settings stay local.

## Existing installations: first pull after this change

Before pulling this change on a machine using this checkout as its Pi agent
directory (including through a symlink), back up `agent/bin/`, `agent/install/`,
`agent/settings.json`, `agent/cache/` and `agent/models-store.json` outside the
checkout. Git removes previously tracked files when applying their removal;
ignore rules alone cannot preserve those files on other machines.

After pulling, restore the backed-up runtime paths to the same locations. They
are now ignored. Alternatively, reinstall Pi to regenerate its installation and
launchers, and restore your live settings. If Git reports local modifications,
keep the backup before resolving those changes; do not discard live settings or
installation metadata without a copy.

## Moved to `shared/pi/`

This directory was previously `pi/` at the repository root. A machine whose Pi
agent directory (`PI_CODING_AGENT_DIR` or a symlink) points at this checkout must
be repointed to `shared/pi/agent`. The ignored runtime files (`settings.json`,
`bin/`, `install/`, `cache/`, `git/`, `npm/`, `models-store.json`) do not move with
git; copy them from the old `pi/agent` directory or reinstall Pi and the packages.
