# Base image — tagged pi-base:local by bin/pi-docker.ps1.
# Do NOT add project toolchains (cargo/python/...) here; per-toolchain
# profiles live in docker/pi/profiles/<profile>/Dockerfile and build
# `FROM pi-base:local`. The launcher picks one per cwd; this base is the
# fallback when no profile matches and the shared layer every profile
# inherits so a pi version bump happens once.
FROM node:24-bookworm-slim

# fd + rg back pi's `find`/`grep` tools (dist/utils/tools-manager.js
# ensureTool). pi downloads each from GitHub at startup if no system
# binary is on PATH; pre-installing both here means the container never
# hits that download path (and `find`/`grep` work under PI_OFFLINE=1).
# `rg` was already here; `fd` is new. Debian's `fd` package ships the
# binary as `fdfind`, which pi recognizes via systemBinaryNames
# ["fd","fdfind"] - but the agent's own bash calls usually invoke `fd`
# directly, hence the alias. curl + jq are general agent utilities
# (HTTP probes, JSON in bash), not pi-internal; included because every
# project session reaches for them and they're tiny. fzf/bat/git-delta/
# less/file are QoL for interactive sessions and agent bash usage - not
# required by pi core, but cheap and commonly reached for.
#
# Debian packaging quirks handled defensively:
#  - `fd`/`bat` ship as `fdfind`/`batcat` (name conflicts); alias them to
#    the short names, but only if the short name isn't already on PATH,
#    so we never shadow a real binary.
#  - `git-delta` is best-effort: not packaged in every Debian release,
#    so a missing package must not fail the image build.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       bash ca-certificates git ripgrep fd-find curl jq fzf bat less file \
  && (apt-get install -y --no-install-recommends git-delta \
        || echo 'git-delta not available in this Debian release; skipping') \
  && (command -v fd  >/dev/null 2>&1 || ln -sf /usr/bin/fdfind /usr/local/bin/fd) \
  && (command -v bat >/dev/null 2>&1 || ln -sf /usr/bin/batcat /usr/local/bin/bat) \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent

# Install pi-ollama-cloud extension into pi's managed npm directory.
# pi resolves "npm:pi-ollama-cloud" from settings.json to:
#   /root/.pi/agent/npm/node_modules/pi-ollama-cloud
# If this path doesn't exist at startup, pi tries to npm install it
# at runtime (requires network). Pre-installing avoids that.
RUN mkdir -p /root/.pi/agent/npm
WORKDIR /root/.pi/agent/npm
RUN echo '{"name":"pi-extensions","private":true,"dependencies":{"pi-ollama-cloud":"^0.6.0"}}' > package.json \
  && npm install --ignore-scripts

# Settings: tells pi to load ollama-cloud package and use it as default.
# No SYSTEM.md or AGENTS.md here — pi uses its built-in default prompt.
COPY settings.json /root/.pi/agent/settings.json

WORKDIR /workspace
ENTRYPOINT ["pi"]
