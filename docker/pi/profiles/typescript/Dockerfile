# typescript profile — node/npm already in the base; just enable corepack
# so pnpm/yarn (declared via packageManager in a project's package.json)
# resolve without per-project global installs. Svelte projects also map
# here: svelte-check runs through npx, which the base node provides.
# Built FROM the shared base; tagged pi-typescript:local by bin/pi-docker.ps1.
FROM pi-base:local
RUN corepack enable