# ShibaInu — Architecture Deep Dive

## The Neuroscience Analogy

The ShibaInu architecture maps directly to human memory systems:

| Biological Structure | ShibaInu Component | Function |
|---|---|---|
| Prefrontal Cortex | SOUL | Identity, values, constraints — stable, rarely changes |
| Hippocampus | MEMORY | Recent events, state, context — updates constantly |
| REM Sleep | DREAM | Consolidation, compaction, pattern detection — nightly |
| Long-term Memory | agent_memory_history | Permanent versioned archive |

### Why Shiba Inu?
The Shiba Inu breed has a proportionally large hippocampus compared to other dogs, giving
it exceptional spatial memory and the ability to remember routes, people, and events with
unusual precision. This skill is named in honor of that trait — and of Dr. Mascarenhas'
own Shiba Inu, the inspiration for this architecture.

---

## The Three Layers

### Layer 1: SOUL (Prefrontal Cortex)
```
memory_type = 'soul'
is_dirty:   almost never (identity is stable)
version:    increments rarely
```
SOUL contains the agent's fixed identity:
- Who the agent is
- What the agent is allowed/not allowed to do
- Constraints and rules that never change
- Domain expertise and specialization

**SOUL should be written once at bootstrap and never overwritten by events.**
When you need to change the agent's identity, increment the version intentionally.

### Layer 2: MEMORY (Hippocampus)
```
memory_type = 'memory'
is_dirty:   true after every appendEvent()
version:    increments on every delta
```
MEMORY contains the agent's dynamic state:
- Recent events (rolling window, last 30 by default)
- Current status and metrics
- Active alerts and pending items
- Patterns observed this week

**appendEvent() is the primary write path.** It loads current MEMORY, appends a
timestamped event line, and writes back. The SHA-256 guard prevents redundant writes.

### Layer 3: DREAM (REM Sleep)
```
Runs: 0 3 * * * (03h daily cron)
Input: WHERE is_dirty = true
Output: compacted MEMORY + versioned history + markClean()
```
DREAM is the consolidation engine:
1. Queries all agents with `is_dirty = true` (delta-only — O(dirty), not O(all))
2. Loads SOUL + MEMORY for each dirty agent
3. Calls Claude Haiku to analyze patterns, detect alerts, generate summary
4. Compacts MEMORY to last 30 events + appends dream summary
5. Archives current version to `agent_memory_history`
6. Resets `is_dirty = false` and sets `last_dream_at`

---

## SHA-256 Idempotency Guard

Before every write, `memory-v2.js` computes:
```js
var hash = sha256(content)
if (hash === storedHash) return { changed: false }  // skip
```

This prevents:
- Redundant DB writes when content hasn't changed
- False `is_dirty=true` flags
- Unnecessary Dream processing cycles
- Double-billing on LLM calls

---

## Delta-Only Processing

The most important architectural decision: **Dream only processes what changed.**

```sql
SELECT * FROM agent_memory WHERE is_dirty = true
```

With 1,000 agents, if only 12 had activity today, Dream runs 12 consolidations — not 1,000.
This scales linearly with activity, not with total agent count.

---

## Anti-Loop Design

Agents never call each other directly. All inter-agent communication goes through
the `agent_messages` table:

```
PatientAgent → INSERT agent_messages (to: doctor) → DoctorAgent reads on next cycle
DoctorAgent  → INSERT agent_messages (to: gestor) → GestorAgent reads on next cycle
```

Benefits:
- No circular dependencies possible
- Audit trail of all inter-agent communication
- Agents are independently restartable
- Easy to replay/debug any message chain

---

## Version History

Every Dream consolidation creates a permanent record in `agent_memory_history`:

```json
{
  "id": "uuid",
  "agent_id": "patient_001",
  "memory_type": "memory",
  "content": "full content at that point",
  "content_hash": "sha256...",
  "version": 7,
  "dream_summary": "Patient reported stable condition. No critical events.",
  "created_at": "2026-03-29T03:00:12Z"
}
```

This gives you:
- Full point-in-time recovery for any agent
- Audit trail (LGPD/HIPAA compliance)
- Pattern analysis across versions
- Debugging of agent behavior over time

---

## Scaling Considerations

| Scale | Recommendation |
|---|---|
| < 100 agents | Single Supabase project, default config |
| 100–1000 agents | Separate Supabase project per domain (clinical vs personal) |
| > 1000 agents | Consider DREAM_MAX_AGENTS env + multiple Dream instances by domain |

### Multi-Project Separation (LGPD/HIPAA)
Always use separate Supabase projects for:
- Clinical data (patient agents) — regulated PHI
- Personal data (personal agents) — LGPD personal data
- Demo/test agents — no restrictions

---

## Context Modes

`DREAM_CONTEXT` environment variable controls the LLM prompt:

| Mode | Use for | Detects |
|---|---|---|
| `clinical` | Patient/doctor agents | Toxicity, critical symptoms, CTCAE alerts |
| `personal` | Personal/family agents | Deadlines, pending items, wellbeing |
| `generic` | Any other agent | Patterns, attention items, general summary |
