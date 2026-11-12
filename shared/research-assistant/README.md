# Research Assistant Policy

- `shared/research-assistant/core.md` defines the shared behavioral policy
  for research and architecture assistance.
- `pi/agent/APPEND_SYSTEM.md` carries that policy's Git and GitHub publishing,
  communication and planning sections into native Pi. The delivery rules and
  Pi runtime tool rules live in the
  [delivery-pipeline](https://github.com/jared-two-foxes/delivery-pipeline)
  package, which adds them to Pi's system prompt.

Keep the Git and GitHub publishing rules aligned between the shared core and
`APPEND_SYSTEM.md` (`tests/pi-prompt.test.mjs` checks this). Update the shared
core first, then propagate changes to the Pi policy.
