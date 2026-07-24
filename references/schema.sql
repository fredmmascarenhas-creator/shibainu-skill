-- ShibaInu Schema — Hippocampal Memory Tables
-- Run in your Supabase SQL Editor
-- https://supabase.com/dashboard/project/<your-project>/editor

-- ── Core memory table ──────────────────────────────────────────────────────
-- One record per agent per memory_type (soul | memory | reflect | context)
-- PK: (agent_id, memory_type) — upsert-friendly

CREATE TABLE IF NOT EXISTS agent_memory (
  agent_id       TEXT        NOT NULL,
  memory_type    TEXT        NOT NULL CHECK (memory_type IN ('soul', 'memory', 'reflect', 'context')),
  content        TEXT        NOT NULL,
  content_hash   TEXT        NOT NULL,  -- SHA-256 of content (idempotency guard)
  version        INTEGER     DEFAULT 1,
  is_dirty       BOOLEAN     DEFAULT false, -- set true on every appendEvent()
  last_dream_at  TIMESTAMPTZ,              -- when Dream last consolidated this agent
  metadata       JSONB       DEFAULT '{}',
  updated_at     TIMESTAMPTZ DEFAULT now(),
  created_at     TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (agent_id, memory_type)
);

-- Index: fast delta scan (Dream filters WHERE is_dirty=true)
CREATE INDEX IF NOT EXISTS idx_agent_memory_dirty
  ON agent_memory(is_dirty)
  WHERE is_dirty = true;

-- Index: recency ordering
CREATE INDEX IF NOT EXISTS idx_agent_memory_updated
  ON agent_memory(updated_at DESC);

-- ── Version history table ───────────────────────────────────────────────────
-- Append-only. One record per Dream consolidation.
-- Full audit trail: who → what → when → why (dream_summary)

CREATE TABLE IF NOT EXISTS agent_memory_history (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id       TEXT        NOT NULL,
  memory_type    TEXT        NOT NULL,
  content        TEXT        NOT NULL,
  content_hash   TEXT        NOT NULL,
  version        INTEGER     NOT NULL,
  dream_summary  TEXT,                    -- LLM-generated summary of what changed
  created_at     TIMESTAMPTZ DEFAULT now()
);

-- Index: retrieve history for an agent in version order
CREATE INDEX IF NOT EXISTS idx_agent_memory_history
  ON agent_memory_history(agent_id, memory_type, version DESC);

-- Index: recency
CREATE INDEX IF NOT EXISTS idx_agent_memory_history_created
  ON agent_memory_history(created_at DESC);

-- ── Optional: agent_profiles ────────────────────────────────────────────────
-- Lightweight profile per agent. Not required for memory to work.

CREATE TABLE IF NOT EXISTS agent_profiles (
  id           TEXT        PRIMARY KEY,
  role         TEXT        NOT NULL,
  display_name TEXT,
  metadata     JSONB       DEFAULT '{}',
  active       BOOLEAN     DEFAULT true,
  created_at   TIMESTAMPTZ DEFAULT now(),
  updated_at   TIMESTAMPTZ DEFAULT now()
);

-- ── Optional: agent_messages ────────────────────────────────────────────────
-- Anti-loop inter-agent communication. Agents never call each other directly.
-- All messages go through this table (Supabase as message bus).

CREATE TABLE IF NOT EXISTS agent_messages (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  from_agent_id TEXT        NOT NULL,
  to_agent_id   TEXT        NOT NULL,
  type          TEXT        NOT NULL CHECK (type IN ('alert','recommendation','update','request','ack','summary')),
  subject       TEXT,
  content       TEXT        NOT NULL,
  priority      TEXT        DEFAULT 'normal' CHECK (priority IN ('low','normal','high','critical')),
  status        TEXT        DEFAULT 'sent' CHECK (status IN ('sent','read','processed','archived')),
  metadata      JSONB       DEFAULT '{}',
  created_at    TIMESTAMPTZ DEFAULT now(),
  processed_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_agent_messages_to
  ON agent_messages(to_agent_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_messages_priority
  ON agent_messages(priority, status, created_at DESC)
  WHERE status = 'sent';

-- ── REFLECT: queryable mirror of the metacognitive self-model ──────────────
-- Canonical storage is the 'reflect' row in agent_memory (versioned like all
-- layers). Dream mirrors claims here so you can query across agents:
--   "which agents have an active error_pattern with confidence > 0.7?"

CREATE TABLE IF NOT EXISTS agent_reflections (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id                TEXT        NOT NULL,
  claim_id                TEXT        NOT NULL,  -- 'r_' + sha256(claim)[:10] — stable dedup key
  claim                   TEXT        NOT NULL,
  category                TEXT        NOT NULL CHECK (category IN ('error_pattern','heuristic','calibration','preference','world_model')),
  confidence              REAL        DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
  evidence                JSONB       DEFAULT '[]',  -- [{ref: "memory-v12", quote: "- [ts] ..."}]
  status                  TEXT        DEFAULT 'active' CHECK (status IN ('active','expired','refuted')),
  ttl_cycles              INTEGER     DEFAULT 14,
  cycles_since_validation INTEGER     DEFAULT 0,
  refuted_reason          TEXT,
  last_validated_at       TIMESTAMPTZ,
  created_at              TIMESTAMPTZ DEFAULT now(),
  updated_at              TIMESTAMPTZ DEFAULT now(),
  UNIQUE (agent_id, claim_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_reflections_active
  ON agent_reflections(agent_id, confidence DESC)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_agent_reflections_category
  ON agent_reflections(category, status);

-- ── Migration for installs created before the REFLECT layer ────────────────
-- Run once if your agent_memory table predates this schema:
--
--   ALTER TABLE agent_memory DROP CONSTRAINT agent_memory_memory_type_check;
--   ALTER TABLE agent_memory ADD CONSTRAINT agent_memory_memory_type_check
--     CHECK (memory_type IN ('soul', 'memory', 'reflect', 'context'));
