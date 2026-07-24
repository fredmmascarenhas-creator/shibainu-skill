---
name: shibainu
description: >
  Hippocampal memory + metacognition architecture for autonomous AI agents. Implements
  a four-layer cognitive model (SOUL/MEMORY/REFLECT/DREAM): SOUL for fixed identity,
  MEMORY for dynamic state, REFLECT for an evidence-linked metacognitive self-model,
  and DREAM for nightly semantic consolidation that also curates REFLECT. Use when
  building agents (OpenClaw or any harness) that need persistent, versioned,
  concurrency-safe memory across sessions; evidence-linked self-improvement with
  claim expiry; delta-based consolidation with SHA-256 idempotency; or multi-agent
  systems with shared memory. Works locally via filesystem (zero config) or with
  Supabase for production.
---

# ShibaInu 🐕 — Hippocampal Memory + Metacognition Skill

> *"The Shiba Inu remembers every path it has ever walked — and learns which ones it walks badly."*

A production-grade, four-layer cognitive memory architecture for autonomous AI agents.
Works out of the box with local filesystem (zero config) or Supabase for production.

> **Zero-config default:** If `SUPABASE_URL` is not set, ShibaInu automatically uses
> local filesystem at `~/.openclaw/workspace/memory/agents/`. No setup required.

---

## Architecture Overview

```
SOUL    = Prefrontal Cortex  → Fixed identity, never overwritten
MEMORY  = Hippocampus        → Dynamic state, last N events, is_dirty flag
REFLECT = Metacognition      → Evidence-linked self-model: what the agent learned about itself
DREAM   = REM Sleep          → Nightly consolidation (03h cron): compacts MEMORY, curates REFLECT
```

**Anti-pattern avoided:** Simple context injection. ShibaInu stores memory *outside* the
context window and loads only what's needed, allowing agents to run indefinitely without
context bloat.

**Anti-pattern avoided (REFLECT):** Distilling memories into opaque behavior and throwing
the episodes away. Every REFLECT claim cites verbatim evidence from versioned memory,
decays unless revalidated, and can be refuted — metacognition on top of memories, never
instead of them. See `references/reflection.md`.

---

## Quick Start

### Zero-config (workspace mode)

No Supabase, no setup. Just install and run.

### With Supabase (production mode)

Run `references/schema.sql` in your Supabase SQL Editor, then set `SUPABASE_URL` + `SUPABASE_KEY`.

### Initialize an Agent

```js
const memory = require('./scripts/memory-v2.js');

// Bootstrap: create SOUL + MEMORY for a new agent
await memory.initSoul('assistant_alice', {
  soul: `You are Alice, a helpful assistant agent.
         Always respond in a friendly, concise tone.`,
  initialMemory: `Agent: assistant_alice | Status: active | Last contact: today`
});
```

### Append Events During the Day

```js
// Call after every meaningful interaction
await memory.appendEvent('assistant_alice', 'User asked about project deadlines. Responded with summary.');
await memory.appendEvent('assistant_alice', 'Reminder set for tomorrow 10h meeting.');
```

### Dream Cron (03h daily)

```bash
# Add to crontab
0 3 * * * /usr/bin/node /path/to/scripts/dream-v2.js >> /path/to/logs/dream.log 2>&1
```

Dream processes only agents with `is_dirty=true`, consolidates with Claude Haiku,
versions the result in `agent_memory_history`, then marks clean. In the same LLM call
it runs the REFLECT pass: revalidates, refutes, or proposes evidence-linked self-model
claims (disable with `DREAM_REFLECT=off`).

### Dream on Demand

Run Dream manually for a specific agent at any time — no need to wait for the 03h cron:

```bash
# Consolidate a single agent immediately
node scripts/dream-v2.js --agent assistant_alice

# Or run the full cycle for all dirty agents
node scripts/dream-v2.js
```

---

### Wake an agent up with full context (OpenClaw bootstrap)

```js
// SOUL (full) + REFLECT active claims + MEMORY tail, sized to a budget
const ctx = await memory.getContext('assistant_alice', { budgetChars: 24000, maxClaims: 12 });
```

```bash
# Same thing from a shell — ideal for OpenClaw session-start hooks / heartbeats
node scripts/context.js assistant_alice --budget 24000
```

### Read / edit the self-model

```js
const claims = await memory.readReflections('assistant_alice');   // parsed claims
await memory.writeReflections('assistant_alice', claims);         // versioned write
```

Or just open `REFLECT.md` — it is human-readable markdown with a fenced
`json shibainu-reflect` block as the machine source of truth.

---

## Core Concepts

### REFLECT — Evidence-Linked Metacognition
Dream maintains a bounded self-model per agent: claims like *"under-estimates task
duration ~2x"* with category (`error_pattern|heuristic|calibration|preference|world_model`),
confidence, and verbatim quotes from versioned memory as evidence. Claims decay and
expire after `REFLECT_TTL_CYCLES` (default 14) cycles without revalidation; refuted
claims archive permanently and never resurrect (SHA-based dedup). No evidence → the
claim is dropped. Full design: `references/reflection.md`.

### Concurrency-Safe Writes
Workspace mode wraps read-check-write in an atomic per-file lock (mkdir mutex, stale
locks stolen after 10s). Supabase mode uses compare-and-swap on `version`
(`PATCH ... &version=eq.N`) and reports conflicts instead of overwriting.
`appendEvent()` retries on conflict — concurrent writers (parallel sub-agents,
heartbeat + session) never lose events.

### SHA-256 Idempotency Guard
`memory-v2.js` computes `content_hash` before every write. If content is identical to
the stored hash, the write is skipped. This prevents redundant DB writes and ensures
`is_dirty` only becomes `true` when something actually changed.

### Delta-Only Consolidation
Dream never reprocesses clean agents. Only `WHERE is_dirty = true` agents are touched.
This makes the system O(dirty agents) not O(all agents) — scales to thousands of agents.

### Version History
Every Dream consolidation appends a record to `agent_memory_history` with the full content,
hash, version number, and a `dream_summary` generated by the LLM. Full audit trail included.

### Anti-Loop Design
Agents communicate exclusively via the `agent_messages` table in Supabase.
No direct agent-to-agent function calls. Unidirectional flow prevents infinite loops.

---

## Files

| File | Purpose |
|------|---------|
| `scripts/memory-v2.js` | Core memory engine: initSoul, appendEvent, reflections, getContext, markClean |
| `scripts/dream-v2.js` | Nightly consolidation cron: consolidates MEMORY + curates REFLECT, versions |
| `scripts/context.js` | CLI: budgeted SOUL+REFLECT+MEMORY context for agent bootstrap (OpenClaw) |
| `scripts/test-reflect.js` | Smoke tests: concurrency, reflection lifecycle, context assembly |
| `references/schema.sql` | Supabase DDL: agent_memory + history + agent_reflections tables |
| `references/architecture.md` | Deep-dive: neuroscience analogy, design decisions, anti-patterns |
| `references/reflection.md` | REFLECT deep-dive: claim anatomy, lifecycle, anti-confabulation rules |
| `references/multi-agent.md` | How to wire multiple agents (patient/doctor/pharmacist pattern) |
| `assets/soul-template.md` | SOUL.md template for bootstrapping new agent identities |
| `assets/reflect-template.md` | REFLECT.md annotated example of a healthy self-model |

---

## Storage Mode — Auto-Detected

ShibaInu detects which backend to use automatically:

| Condition | Mode | Storage |
|---|---|---|
| No `SUPABASE_URL` in env | **workspace** | `~/.openclaw/workspace/memory/agents/` |
| `SUPABASE_URL` set | **supabase** | Supabase REST API (production) |

### Workspace mode (zero config)
```bash
# No configuration needed. Just run:
node scripts/dream-v2.js

# Files are created automatically at:
# ~/.openclaw/workspace/memory/agents/<agent_id>/SOUL.md
# ~/.openclaw/workspace/memory/agents/<agent_id>/MEMORY.md
# ~/.openclaw/workspace/memory/agents/<agent_id>/history/
```

### Supabase mode (production / multi-agent)
```bash
# 1. Run references/schema.sql in your Supabase SQL Editor
# 2. Set env vars:
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_KEY=your-service-role-key       # service_role bypasses RLS
ANTHROPIC_API_KEY=sk-ant-...             # for Dream LLM consolidation
DREAM_MODEL=claude-haiku-4-5-20251001    # recommended: haiku for cost
DREAM_MAX_AGENTS=50                      # agents per Dream cycle
DREAM_KEEP_EVENTS=30                     # events kept after compaction
DREAM_REFLECT=on                         # off → disable metacognitive pass
REFLECT_TTL_CYCLES=14                    # cycles without revalidation before expiry
REFLECT_MAX_NEW=3                        # max new claims per cycle
REFLECT_MAX_ACTIVE=40                    # active-claim cap per agent
```

### Override workspace path
```bash
SHIBAINU_WORKSPACE_DIR=/custom/path/agents
```

---

## Node.js ESM Compatibility

If your project has `"type": "module"` in `package.json`, use the `.cjs` versions:

```js
const memory = require('./scripts/memory-v2.cjs');
```

```bash
0 3 * * * node /path/to/scripts/dream-v2.cjs >> dream.log 2>&1
```

Both `.js` and `.cjs` versions are included and functionally identical.

---

## Privacy Rules

- Never store raw PII or sensitive data in `content` without encryption
- Use separate Supabase projects to isolate different agent populations
- See `references/architecture.md` for compliance and data isolation guidance
