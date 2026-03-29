# 🐕 ShibaInu — Hippocampal Memory for AI Agents

> *"The Shiba Inu remembers every path it has ever walked."*

An [OpenClaw](https://openclaw.ai) skill implementing a three-layer cognitive memory architecture inspired by neuroscience.

## Architecture

```
SOUL   = Prefrontal Cortex  → Fixed identity, never overwritten
MEMORY = Hippocampus        → Dynamic state, last N events, is_dirty flag  
DREAM  = REM Sleep          → Nightly semantic consolidation (03h cron)
```

**Named in honor of the Shiba Inu breed**, whose proportionally large hippocampus gives it exceptional spatial and episodic memory.

## Why it's different

| Existing approaches | ShibaInu |
|---|---|
| Simple context injection | 3-layer cognitive separation |
| RAG retrieval | Delta-only processing (is_dirty flag) |
| Manual memory management | Autonomous nightly Dream cycle |
| No idempotency | SHA-256 guard prevents redundant writes |
| Monolithic memory | SOUL (identity) + MEMORY (state) + HISTORY (audit) |

## Quick Start

### 1. Create tables
Run `references/schema.sql` in your Supabase SQL Editor.

### 2. Set environment variables
```bash
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_KEY=your-service-role-key
ANTHROPIC_API_KEY=sk-ant-...
```

### 3. Initialize an agent
```js
const memory = require('./scripts/memory-v2');

await memory.initSoul('my_agent_001', {
  soul: `# SOUL\nYou are a helpful assistant for João.`,
  initialMemory: `# MEMORY\n## Recent events\n_None yet._`
});

await memory.appendEvent('my_agent_001', 'User asked about medication schedule.');
```

### 4. Add the Dream cron
```bash
0 3 * * * /usr/bin/node /path/to/scripts/dream-v2.js >> dream.log 2>&1
```

## Files

| File | Purpose |
|---|---|
| `scripts/memory-v2.js` | Core engine: initSoul, appendEvent, writeMemory, markClean |
| `scripts/dream-v2.js` | REM consolidation cron: delta-only, versioned, LLM-powered |
| `references/schema.sql` | Supabase DDL: all required tables |
| `references/architecture.md` | Deep-dive: neuroscience analogy, design decisions |
| `references/multi-agent.md` | Wiring multiple agents (patient/doctor/pharmacist pattern) |
| `assets/soul-template.md` | Template for bootstrapping new agent identities |

## Install as OpenClaw Skill

```bash
# Download the .skill file and install via OpenClaw
```

## Why "Shiba Inu"?

The name comes from a real dog.

Dr. Frederico Mascarenhas — the architect of this system — owns a Shiba Inu. While working on the memory architecture for his autonomous oncology agents, he noticed something: his dog never forgot a route, a face, or a routine. Feed him at 7am once, and he'll be at the bowl at 6:59 every day after that. Walk a path once, and he'll remember every turn a year later.

That's the hippocampus at work. The Shiba Inu breed has a proportionally larger hippocampus than most dogs, giving it exceptional spatial and episodic memory — the ability to store *specific events in specific contexts*, not just patterns.

This skill is built on the same principle:

- **SOUL** = the prefrontal cortex — who the agent *is*, stable and rarely changing
- **MEMORY** = the hippocampus — what the agent *experienced*, updated constantly  
- **DREAM** = REM sleep — where the brain consolidates the day's events into long-term memory at 3am

The analogy isn't decorative. It drove real architectural decisions:
- Memory consolidation happens at night (Dream cron at 03h), not in real-time
- Only *changed* memories are processed (is_dirty flag = the hippocampus doesn't re-encode what it already knows)
- Identity (SOUL) and experience (MEMORY) are stored separately, because damaging one shouldn't destroy the other

The dog's name is kept private. But the architecture he inspired is here for everyone.

## Author

**Dr. Frederico Mascarenhas** — Urologist, Director of AI at the Brazilian Society of Urology (SBU), HealthTech founder.

Built and battle-tested in [OncoNet](https://github.com/fredmmascarenhas-creator/onconet) — an autonomous multi-agent oncology system with 20+ agents running in production.

## License

MIT — use freely, attribute appreciated.

---

*Part of the Mascarenhas HealthTech ecosystem 🦞*
