# Context Caching Implementation Backlog

This directory contains three implementation options for enabling automatic LLM context caching in OpenCode, reducing token costs and latency by ~90% for multi-phase pipeline runs.

## Quick Navigation

- **[option-a.md](option-a.md)** — **Minimal (30 min)** — Update pipeline-runner.md to pass stable context verbatim
  - ✅ Immediate ~90% token savings (all providers)
  - ✅ No config changes needed
  - ✅ Start here

- **[option-b.md](option-b.md)** — **Moderate (45 min)** — Add metadata config to opencode.json + docs
  - ✅ Formalizes caching intent
  - ✅ Enables discovery
  - ✅ Do this after Option A

- **[option-c.md](option-c.md)** — **Advanced (2–3 hours)** — Create provider-aware cache-control skill
  - ✅ Provider-specific optimization
  - ✅ Only needed for 50+ KB contexts with 8+ agent invocations
  - ✅ Optional; most tasks don't need it

## Implementation Path

### Phase 1: Option A (Quick Win)
1. Read option-a.md
2. Edit agents/pipeline-runner.md (6 invocation locations)
3. Commit and test
4. **Expected outcome:** ~90% token savings immediately

### Phase 2: Option B (Best Practice)
1. Read option-b.md
2. Edit opencode.json (add context_caching config)
3. Update AGENTS.md (add Context Caching section)
4. Commit
5. **Expected outcome:** Formalized caching intent, discoverable configuration

### Phase 3: Option C (Only if Needed)
1. Read option-c.md
2. Create skills/context-cache-control/SKILL.md
3. Update design.md (Phase 1f) + AGENTS.md
4. Test with large task
5. Monitor cache metrics
6. **Expected outcome:** Provider-specific cache headers (rarely needed)

## Quick Facts

| Aspect | Details |
|--------|---------|
| **Why cache?** | Large stable blocks (CODEBASE_CONTEXT, RECALLIUM_CONTEXT, TOOLCHAIN) are reused across 4+ agent phases |
| **How much savings?** | ~90% token reduction, ~90% latency improvement for cached blocks |
| **All providers?** | Yes — Claude, OpenAI, Ollama, and others all support automatic context caching |
| **Config needed?** | No — works automatically; Option B formalizes it |
| **When to skip?** | Small codebases (<10 KB), simple tasks (2–3 agents) — automatic caching still works but savings are minimal |

## Current Status

- [ ] Option A — Minimal context reuse directive
- [ ] Option B — Metadata config + docs
- [ ] Option C — Provider-aware skill (optional)

## References

- **Design Agent:** agents/design.md (Phase 1 discovery, context loading)
- **Pipeline Runner:** agents/pipeline-runner.md (Phases 1–6, subagent invocations)
- **Config:** opencode.json (new context_caching section in Option B)
- **Documentation:** AGENTS.md (new Context Caching section in Option B)

---

**Created:** 2026-06-05
**Type:** Architecture / Performance Optimization
**Priority:** High (token cost and latency savings)
