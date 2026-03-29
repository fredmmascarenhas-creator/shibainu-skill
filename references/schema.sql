-- ShibaInu Schema — Hippocampal Memory Tables
-- Run in your Supabase SQL Editor
-- https://supabase.com/dashboard/project/<your-project>/editor

-- ── Core memory table ──────────────────────────────────────────────────────
-- One record per agent per memory_type (soul | memory | context)
-- PK: (agent_id, memory_type) — upsert-friendly

CREATE TABLE IF NOT EXISTS agent_memory (
  agent_id       TEXT        NOT NULL,
  memory_type    TEXT        NOT NULL CHECK (memory_type IN ('soul', 'memory', 'context')),
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
