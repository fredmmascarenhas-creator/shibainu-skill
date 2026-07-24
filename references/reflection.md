# ShibaInu REFLECT — The Metacognitive Layer

## Why memories alone are not enough

MEMORY answers *"what happened?"*. DREAM compresses it into *"what does it mean?"*.
REFLECT answers the third question — *"how do I, this agent, actually behave, err,
and need to adjust?"* — and it is the difference between an agent that accumulates
history and an agent that learns from it.

The critical design rule: **REFLECT is a layer on top of memories, never a
replacement for them.** A self-model without the episodic substrate underneath is
confabulation — beliefs about oneself that nobody can audit, correct, or expire.
Every REFLECT claim therefore carries evidence pointers back into the versioned
memory history.

```
SOUL     = who I am           (fixed, human-authored)
MEMORY   = what happened      (episodic, rolling window)
REFLECT  = what I learned     (metacognitive, evidence-linked, expiring)
DREAM    = the consolidator   (nightly: compresses MEMORY, curates REFLECT)
```

## Anatomy of a claim

```json
{
  "id": "r_a1b2c3d4e5",
  "claim": "Tends to under-estimate task duration by ~2x on multi-step work",
  "category": "calibration",
  "confidence": 0.72,
  "evidence": [
    { "ref": "memory-v12", "quote": "- [2026-07-20 14:02] task estimated 1h, took 2h40" }
  ],
  "status": "active",
  "ttl_cycles": 14,
  "cycles_since_validation": 3,
  "created_at": "2026-07-10T03:00:11Z",
  "last_validated_at": "2026-07-21T03:00:09Z"
}
```

- **id** — `'r_' + sha256(claim)[:10]`. Stable dedup key: a refuted claim can
  never silently resurrect under the same wording.
- **category** — `error_pattern | heuristic | calibration | preference | world_model`.
- **evidence** — verbatim quotes from MEMORY event lines, plus the memory version
  (`memory-v12`) they came from. That version is permanently archived in
  `agent_memory_history` / `history/`, so every claim is auditable forever.
- **ttl_cycles / cycles_since_validation** — the expiry engine (below).

## Lifecycle: claims must earn their survival

```
            Dream proposes (with evidence)
                     │
                     ▼
                 ┌────────┐   revalidated by new events   ┌──────────────┐
                 │ active │ ────────────────────────────▶ │ counter := 0 │
                 └────────┘                               │ conf += 0.05 │
                  │      │                                └──────────────┘
   silent for TTL │      │ contradicted by events
        cycles    ▼      ▼
             ┌─────────┐ ┌─────────┐
             │ expired │ │ refuted │  (with reason, archived, never resurrects)
             └─────────┘ └─────────┘
```

Rules enforced in code (`applyReflectionLifecycle` in `dream-v2.js`):

1. **No evidence → no claim.** A proposed claim without verbatim quotes is dropped.
2. **Revalidation requires new events.** The prompt forbids revalidating a claim
   the current memory window does not support; each revalidation resets the decay
   counter and gently reinforces confidence (capped at 0.99).
3. **Decay is automatic.** Every Dream cycle without revalidation increments
   `cycles_since_validation`; at `ttl_cycles` (default 14) the claim expires.
   Yesterday's truth is not assumed to be today's.
4. **Refutation is permanent.** Refuted claims are archived with the reason and
   the dedup key prevents the same wording from being re-proposed.
5. **Bounded self-model.** At most `REFLECT_MAX_NEW` (3) new claims per cycle and
   `REFLECT_MAX_ACTIVE` (40) active claims per agent — overflow expires
   lowest-confidence first. A self-model that grows without bound is just a
   second memory, not metacognition.
6. **No LLM, no lifecycle.** If Dream runs without `ANTHROPIC_API_KEY`, the
   reflection pass is skipped entirely — decaying TTLs without any chance of
   revalidation would eventually expire every claim on keyless installs.

## Where claims live

Canonical storage is a `reflect` row in `agent_memory` (Supabase) or
`REFLECT.md` (workspace). The file is human-readable markdown with a fenced
` ```json shibainu-reflect ` block as the machine-readable source of truth —
you can open REFLECT.md, read the agent's self-model, and hand-edit a claim;
Dream keeps managing lifecycle fields around your edits.

Because REFLECT flows through the same write path as SOUL and MEMORY, it gets
everything for free: SHA-256 idempotency, versioning, `is_dirty`, and archival
to history on every Dream cycle (LGPD/HIPAA audit trail included).

In Supabase mode, Dream additionally mirrors claims to the `agent_reflections`
table so you can query across the fleet:

```sql
-- Which agents learned an error pattern with high confidence this month?
SELECT agent_id, claim, confidence
FROM agent_reflections
WHERE category = 'error_pattern' AND status = 'active' AND confidence > 0.7
ORDER BY confidence DESC;
```

## Injecting the self-model: getContext()

An agent that never *reads* its self-model learns nothing. `getContext()`
assembles the wake-up context in strict priority order:

```
SOUL (never truncated)
  → REFLECT active claims (top-confidence, default 12)
    → MEMORY tail (whatever fits the remaining budget)
```

```js
const memory = require('./scripts/memory-v2');
const ctx = await memory.getContext('personal_fred', { budgetChars: 24000, maxClaims: 12 });
```

Or from a shell (OpenClaw hooks, cron agents):

```bash
node scripts/context.js personal_fred --budget 24000
```

### OpenClaw wiring

OpenClaw agents keep their own workspace memory (`SOUL.md` / `MEMORY.md` read at
session start), which differs from Claude's built-in memory — ShibaInu leans into
that instead of fighting it:

1. **Same filesystem convention.** Workspace mode already writes to
   `~/.openclaw/workspace/memory/agents/<agent_id>/` — SOUL.md, MEMORY.md and
   REFLECT.md sit exactly where an OpenClaw agent expects its memory files.
2. **Session start / heartbeat.** Call `context.js <agent_id>` in the agent's
   bootstrap and prepend the output to the session prompt. The agent wakes up
   with identity + self-model + recent state, budgeted, in one call.
3. **During the session.** The agent (or its harness hooks) calls
   `appendEvent()` after meaningful interactions — concurrency-safe, so parallel
   sub-agents writing to the same memory never lose events.
4. **Overnight.** The 03h Dream cron consolidates and curates REFLECT. Next
   session start, the agent is measurably smarter about itself.

## Anti-confabulation checklist

When reviewing an agent's REFLECT.md, these invariants should always hold:

- [ ] Every active claim has ≥1 evidence quote with a `memory-vN` ref
- [ ] That version exists in history and contains the quoted line
- [ ] No claim restates a SOUL rule (the prompt forbids it; flag it if it slips through)
- [ ] Claims are about the *agent's behavior*, not general facts about the world
      (world facts belong in MEMORY/SOUL; only `world_model` claims about the
      agent's *modeling tendencies* are allowed)
- [ ] `last_validated_at` is recent for high-confidence claims
