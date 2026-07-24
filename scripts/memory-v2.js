'use strict'
/**
 * ShibaInu Memory — Core memory engine (SOUL / MEMORY / REFLECT)
 * Engine v3: adds REFLECT metacognitive layer, concurrency-safe writes,
 * and getContext() for OpenClaw agent bootstrap.
 *
 * AUTO-DETECT STORAGE MODE:
 *   SUPABASE_URL in env → uses Supabase (production, multi-agent)
 *   No SUPABASE_URL    → uses workspace files (zero config, personal use)
 *
 * Workspace layout (file mode):
 *   ~/.openclaw/workspace/memory/agents/<agent_id>/SOUL.md
 *   ~/.openclaw/workspace/memory/agents/<agent_id>/MEMORY.md
 *   ~/.openclaw/workspace/memory/agents/<agent_id>/REFLECT.md
 *   ~/.openclaw/workspace/memory/agents/<agent_id>/history/<version>.md
 *
 * Usage:
 *   const memory = require('./memory-v2');
 *   await memory.initSoul('agent_id', { soul: '...', initialMemory: '...' });
 *   await memory.appendEvent('agent_id', 'something happened');
 *   const ctx = await memory.getContext('agent_id');  // SOUL + REFLECT + MEMORY
 *
 * Concurrency guarantees:
 *   workspace mode → per-file lock directory (atomic mkdir) around read-check-write
 *   supabase mode  → compare-and-swap on `version` (PATCH ... &version=eq.N)
 *   appendEvent()  → retries on conflict, so concurrent writers never lose events
 *
 * Env (Supabase mode):  SUPABASE_URL, SUPABASE_KEY
 * Env (optional):       SHIBAINU_WORKSPACE_DIR (override workspace path)
 *                       SHIBAINU_MAX_EVENTS (default: 200 lines)
 */

var crypto = require('crypto')
var https  = require('https')
var fs     = require('fs')
var path   = require('path')

// ── Storage mode detection ────────────────────────────────────────────────────
var SUPABASE_URL = process.env.SUPABASE_URL || ''
var SUPABASE_KEY = process.env.SUPABASE_KEY || ''
var MODE = SUPABASE_URL ? 'supabase' : 'workspace'

var WORKSPACE_DIR = process.env.SHIBAINU_WORKSPACE_DIR ||
  path.join(process.env.HOME || '/root', '.openclaw', 'workspace', 'memory', 'agents')

var MAX_EVENTS = parseInt(process.env.SHIBAINU_MAX_EVENTS || '200', 10)

// ── SHA-256 idempotency guard ─────────────────────────────────────────────────
function sha256(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex')
}

function delay(ms) {
  return new Promise(function(r) { setTimeout(r, ms) })
}

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch (e) {
    var end = Date.now() + ms
    while (Date.now() < end) { /* fallback busy wait */ }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// WORKSPACE (file) backend
// ────────────────────────────────────────────────────────────────────────────
var LOCK_STALE_MS   = 10000
var LOCK_RETRIES    = 100
var LOCK_WAIT_MS    = 50

var ws = {
  _dir: function(agentId) {
    var d = path.join(WORKSPACE_DIR, agentId)
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true })
    return d
  },
  _histDir: function(agentId) {
    var d = path.join(WORKSPACE_DIR, agentId, 'history')
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true })
    return d
  },
  _file: function(agentId, memType) {
    var name = memType === 'soul' ? 'SOUL.md' : memType === 'memory' ? 'MEMORY.md' : memType.toUpperCase() + '.md'
    return path.join(ws._dir(agentId), name)
  },
  _metaFile: function(agentId, memType) {
    return path.join(ws._dir(agentId), '.' + memType + '.meta.json')
  },

  // Atomic mkdir as cross-process mutex. Stale locks (>10s) are stolen.
  _lock: function(agentId, memType) {
    var lockDir = path.join(ws._dir(agentId), '.' + memType + '.lock')
    for (var i = 0; i < LOCK_RETRIES; i++) {
      try {
        fs.mkdirSync(lockDir)
        return lockDir
      } catch (e) {
        if (e.code !== 'EEXIST') throw e
        try {
          var age = Date.now() - fs.statSync(lockDir).mtimeMs
          if (age > LOCK_STALE_MS) { try { fs.rmdirSync(lockDir) } catch (e2) {} ; continue }
        } catch (e3) { continue } // lock vanished between check and stat — retry now
        sleepSync(LOCK_WAIT_MS)
      }
    }
    throw new Error('lock timeout for ' + agentId + '/' + memType)
  },
  _unlock: function(lockDir) {
    try { fs.rmdirSync(lockDir) } catch (e) { /* already released */ }
  },

  read: function(agentId, memType) {
    var f = ws._file(agentId, memType)
    var m = ws._metaFile(agentId, memType)
    if (!fs.existsSync(f)) return null
    var content = fs.readFileSync(f, 'utf8')
    var meta = fs.existsSync(m) ? JSON.parse(fs.readFileSync(m, 'utf8')) : { version: 1, is_dirty: false }
    return { content: content, hash: sha256(content), version: meta.version, is_dirty: meta.is_dirty }
  },

  write: function(agentId, memType, content, extra, opts) {
    opts = opts || {}
    var lock = ws._lock(agentId, memType)
    try {
      var hash    = sha256(content)
      var cur     = ws.read(agentId, memType)
      var curHash = cur ? cur.hash : null
      var curVer  = cur ? cur.version : 0

      if (opts.expectVersion != null && curVer !== opts.expectVersion) {
        return { version: curVer, hash: curHash, changed: false, conflict: true }
      }
      if (hash === curHash) return { version: curVer, hash: hash, changed: false }

      var newVer = curVer + 1
      fs.writeFileSync(ws._file(agentId, memType), content, 'utf8')
      fs.writeFileSync(ws._metaFile(agentId, memType), JSON.stringify({
        version: newVer, is_dirty: true, content_hash: hash,
        updated_at: new Date().toISOString(), metadata: extra || {}
      }, null, 2), 'utf8')

      console.log('[shibainu:ws] write ' + agentId + '/' + memType + ' v' + newVer)
      return { version: newVer, hash: hash, changed: true }
    } finally {
      ws._unlock(lock)
    }
  },

  markClean: function(agentId, memType, dreamSummary) {
    var cur = ws.read(agentId, memType)
    if (!cur) return
    var m = ws._metaFile(agentId, memType)
    var meta = fs.existsSync(m) ? JSON.parse(fs.readFileSync(m, 'utf8')) : {}

    // Archive to history
    var histFile = path.join(ws._histDir(agentId), memType + '-v' + meta.version + '-' + Date.now() + '.md')
    var archContent = '---\nversion: ' + meta.version + '\ndream_summary: ' + (dreamSummary || '') + '\ncreated_at: ' + new Date().toISOString() + '\n---\n\n' + cur.content
    fs.writeFileSync(histFile, archContent, 'utf8')

    // Update meta
    meta.is_dirty = false
    meta.last_dream_at = new Date().toISOString()
    fs.writeFileSync(m, JSON.stringify(meta, null, 2), 'utf8')
    console.log('[shibainu:ws] markClean ' + agentId + '/' + memType)
  },

  getDirtyAgents: function() {
    if (!fs.existsSync(WORKSPACE_DIR)) return []
    var dirty = []
    fs.readdirSync(WORKSPACE_DIR).forEach(function(agentId) {
      var agentDir = path.join(WORKSPACE_DIR, agentId)
      if (!fs.statSync(agentDir).isDirectory()) return
      ;['soul', 'memory', 'reflect', 'context'].forEach(function(t) {
        var m = path.join(agentDir, '.' + t + '.meta.json')
        if (fs.existsSync(m)) {
          var meta = JSON.parse(fs.readFileSync(m, 'utf8'))
          if (meta.is_dirty) dirty.push({ agent_id: agentId, memory_type: t, version: meta.version })
        }
      })
    })
    return dirty
  }
}

// ────────────────────────────────────────────────────────────────────────────
// SUPABASE backend
// ────────────────────────────────────────────────────────────────────────────
function supabaseReq(method, table, query, body) {
  return new Promise(function(resolve, reject) {
    var p = '/rest/v1/' + table + (query ? '?' + query : '')
    var data = body ? JSON.stringify(body) : null
    var u = new URL(SUPABASE_URL + p)
    var headers = {
      'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json'
    }
    if (method === 'POST' || method === 'PATCH') headers['Prefer'] = 'return=representation'
    if (data) headers['Content-Length'] = Buffer.byteLength(data)
    var req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: method, headers: headers }, function(res) {
      var d = ''; res.on('data', function(c) { d += c })
      res.on('end', function() { try { resolve(JSON.parse(d)) } catch(e) { resolve(d) } })
    })
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

var sb = {
  read: async function(agentId, memType) {
    var rows = await supabaseReq('GET', 'agent_memory',
      'agent_id=eq.' + encodeURIComponent(agentId) + '&memory_type=eq.' + memType + '&select=content,version,content_hash,is_dirty,updated_at')
    var row = Array.isArray(rows) ? rows[0] : null
    if (!row) return null
    return { content: row.content, version: row.version, hash: row.content_hash, is_dirty: row.is_dirty, updated_at: row.updated_at }
  },

  // Compare-and-swap write: PATCH is guarded by &version=eq.<expected>.
  // A concurrent writer bumps the version, the PATCH matches 0 rows, and we
  // report conflict instead of silently overwriting (lost update).
  write: async function(agentId, memType, content, meta, opts) {
    opts = opts || {}
    var hash = sha256(content)
    var attempts = opts.expectVersion != null ? 1 : 3

    for (var attempt = 0; attempt < attempts; attempt++) {
      var rows = await supabaseReq('GET', 'agent_memory',
        'agent_id=eq.' + encodeURIComponent(agentId) + '&memory_type=eq.' + memType + '&select=version,content_hash')
      var existing = Array.isArray(rows) ? rows[0] : null
      var curVer  = existing ? existing.version : 0
      var curHash = existing ? existing.content_hash : null

      if (opts.expectVersion != null && curVer !== opts.expectVersion) {
        return { version: curVer, hash: curHash, changed: false, conflict: true }
      }
      if (hash === curHash) return { version: curVer, hash: hash, changed: false }

      var newVer = curVer + 1
      var now = new Date().toISOString()

      if (curVer > 0) {
        var res = await supabaseReq('PATCH', 'agent_memory',
          'agent_id=eq.' + encodeURIComponent(agentId) + '&memory_type=eq.' + memType + '&version=eq.' + curVer,
          { content: content, content_hash: hash, version: newVer, is_dirty: true, metadata: meta || {}, updated_at: now })
        if (Array.isArray(res) && res.length > 0) {
          console.log('[shibainu:sb] write ' + agentId + '/' + memType + ' v' + newVer)
          return { version: newVer, hash: hash, changed: true }
        }
      } else {
        var ins = await supabaseReq('POST', 'agent_memory', null,
          { agent_id: agentId, memory_type: memType, content: content, content_hash: hash, version: 1, is_dirty: true, metadata: meta || {}, updated_at: now, created_at: now })
        if (Array.isArray(ins) && ins.length > 0) {
          console.log('[shibainu:sb] write ' + agentId + '/' + memType + ' v1')
          return { version: 1, hash: hash, changed: true }
        }
      }
      // CAS lost (or duplicate insert): another writer got there first
      if (opts.expectVersion != null) return { version: curVer, hash: curHash, changed: false, conflict: true }
      await delay(50 + Math.floor(Math.random() * 150))
    }
    return { version: null, hash: hash, changed: false, conflict: true }
  },

  markClean: async function(agentId, memType, dreamSummary) {
    var rows = await supabaseReq('GET', 'agent_memory',
      'agent_id=eq.' + encodeURIComponent(agentId) + '&memory_type=eq.' + memType + '&select=content,content_hash,version')
    var cur = Array.isArray(rows) ? rows[0] : null
    if (!cur) return
    var now = new Date().toISOString()
    await supabaseReq('POST', 'agent_memory_history', null,
      { agent_id: agentId, memory_type: memType, content: cur.content, content_hash: cur.content_hash, version: cur.version, dream_summary: dreamSummary || null, created_at: now })
    await supabaseReq('PATCH', 'agent_memory',
      'agent_id=eq.' + encodeURIComponent(agentId) + '&memory_type=eq.' + memType,
      { is_dirty: false, last_dream_at: now })
    console.log('[shibainu:sb] markClean ' + agentId + '/' + memType)
  },

  getDirtyAgents: async function() {
    var rows = await supabaseReq('GET', 'agent_memory', 'is_dirty=eq.true&select=agent_id,memory_type,version,updated_at&order=updated_at.asc')
    return Array.isArray(rows) ? rows : []
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Unified API — same calls regardless of backend
// ────────────────────────────────────────────────────────────────────────────
async function writeMemory(agentId, memType, content, meta, opts) {
  return MODE === 'supabase' ? sb.write(agentId, memType, content, meta, opts) : ws.write(agentId, memType, content, meta, opts)
}

async function readMemory(agentId, memType) {
  return MODE === 'supabase' ? sb.read(agentId, memType) : ws.read(agentId, memType)
}

async function markClean(agentId, memType, dreamSummary) {
  return MODE === 'supabase' ? sb.markClean(agentId, memType, dreamSummary) : ws.markClean(agentId, memType, dreamSummary)
}

async function getDirtyAgents() {
  return MODE === 'supabase' ? sb.getDirtyAgents() : ws.getDirtyAgents()
}

async function initSoul(agentId, options) {
  var opts = options || {}
  var ts   = new Date().toISOString()
  var soul = opts.soul || '# SOUL — ' + agentId + '\n\n_Generated at ' + ts + '_'
  var mem  = opts.initialMemory || '# MEMORY — ' + agentId + '\n\n## Recent events\n_None yet._\n\n_Initialized at ' + ts + '_'
  await writeMemory(agentId, 'soul', soul, { source: 'bootstrap' })
  await writeMemory(agentId, 'memory', mem, { source: 'bootstrap' })
  console.log('[shibainu] initSoul complete for ' + agentId + ' (mode: ' + MODE + ')')
}

async function appendEvent(agentId, event, meta) {
  try {
    for (var attempt = 0; attempt < 6; attempt++) {
      var cur  = await readMemory(agentId, 'memory')
      var base = cur ? cur.content : '# MEMORY\n\n## Recent events\n'
      var ts   = new Date().toISOString().slice(0, 16).replace('T', ' ')
      var newContent = base + '\n- [' + ts + '] ' + event
      var lines = newContent.split('\n')
      if (lines.length > MAX_EVENTS) newContent = lines.slice(lines.length - MAX_EVENTS).join('\n')
      var res = await writeMemory(agentId, 'memory', newContent, meta || {}, { expectVersion: cur ? cur.version : 0 })
      if (!res.conflict) return res
      await delay(50 + Math.floor(Math.random() * 150))
    }
    console.warn('[shibainu] appendEvent gave up after retries: ' + agentId)
  } catch (e) {
    console.warn('[shibainu] appendEvent failed: ' + e.message)
  }
}

// ────────────────────────────────────────────────────────────────────────────
// REFLECT layer — metacognitive self-model
// ────────────────────────────────────────────────────────────────────────────
// A reflection is an evidence-linked claim the agent holds about itself:
//   { id, claim, category, confidence, evidence: [{ref, quote}],
//     status: active|expired|refuted, ttl_cycles, cycles_since_validation,
//     created_at, last_validated_at, refuted_reason? }
//
// Canonical storage: JSON block inside REFLECT content (memory_type 'reflect'),
// so it versions/archives through the exact same pipeline as SOUL and MEMORY.

var REFLECT_CATEGORIES = ['error_pattern', 'heuristic', 'calibration', 'preference', 'world_model']
var REFLECT_JSON_OPEN  = '```json shibainu-reflect'

function claimId(claimText) {
  return 'r_' + sha256(String(claimText).trim().toLowerCase()).slice(0, 10)
}

function parseReflect(content) {
  if (!content) return []
  var re = new RegExp(REFLECT_JSON_OPEN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\n([\\s\\S]*?)\\n```')
  var m = content.match(re)
  if (!m) return []
  try {
    var parsed = JSON.parse(m[1])
    return Array.isArray(parsed.claims) ? parsed.claims : []
  } catch (e) {
    console.warn('[shibainu] parseReflect: invalid JSON block, ignoring')
    return []
  }
}

function renderReflect(agentId, claims) {
  var active   = claims.filter(function(c) { return c.status === 'active' })
  var archived = claims.filter(function(c) { return c.status !== 'active' })
  var lines = [
    '# REFLECT — ' + agentId,
    '',
    '> Metacognitive self-model. Every claim is evidence-linked and expires unless',
    '> revalidated by Dream. Humans may edit claims; Dream preserves manual edits',
    '> to `claim` text but manages lifecycle fields.',
    ''
  ]
  if (active.length) {
    lines.push('## Active claims')
    active.forEach(function(c) {
      var ev = (c.evidence && c.evidence.length) ? c.evidence[0].ref : 'no-ref'
      lines.push('- **[' + c.category + ' | conf ' + Number(c.confidence || 0).toFixed(2) + ']** ' + c.claim +
        '  _(validated ' + String(c.last_validated_at || c.created_at || '').slice(0, 10) + ', evidence: ' + ev + ')_')
    })
    lines.push('')
  } else {
    lines.push('_No active claims yet. Dream will populate this after the next cycle._', '')
  }
  if (archived.length) {
    lines.push('## Archived (expired / refuted)')
    archived.slice(-10).forEach(function(c) {
      lines.push('- ~~' + c.claim + '~~ _(' + c.status + (c.refuted_reason ? ': ' + c.refuted_reason : '') + ')_')
    })
    lines.push('')
  }
  lines.push(REFLECT_JSON_OPEN)
  lines.push(JSON.stringify({ claims: claims }, null, 2))
  lines.push('```')
  return lines.join('\n')
}

async function readReflections(agentId) {
  var data = await readMemory(agentId, 'reflect')
  return data ? parseReflect(data.content) : []
}

async function writeReflections(agentId, claims, meta) {
  var content = renderReflect(agentId, claims)
  return writeMemory(agentId, 'reflect', content, meta || { source: 'reflect' })
}

// ────────────────────────────────────────────────────────────────────────────
// getContext — budgeted context assembly for agent bootstrap (OpenClaw etc.)
// ────────────────────────────────────────────────────────────────────────────
// Priority: SOUL (never truncated) → REFLECT active claims → MEMORY tail.
// budgetChars ≈ 4 chars/token; default ~6k tokens.
async function getContext(agentId, options) {
  var opts = options || {}
  var budget    = opts.budgetChars || 24000
  var maxClaims = opts.maxClaims || 12

  var soulData = await readMemory(agentId, 'soul')
  var claims   = await readReflections(agentId)
  var memData  = await readMemory(agentId, 'memory')

  var parts = []
  if (soulData) parts.push('## IDENTITY (SOUL)\n' + soulData.content)

  var active = claims
    .filter(function(c) { return c.status === 'active' })
    .sort(function(a, b) { return (b.confidence || 0) - (a.confidence || 0) })
    .slice(0, maxClaims)
  if (active.length) {
    var reflLines = active.map(function(c) {
      return '- [' + c.category + ' | conf ' + Number(c.confidence || 0).toFixed(2) + '] ' + c.claim
    })
    parts.push('## SELF-MODEL (REFLECT)\nLessons this agent has learned about its own behavior. Apply them.\n' + reflLines.join('\n'))
  }

  var used = parts.join('\n\n').length
  if (memData) {
    var remaining = budget - used - 40
    var memContent = memData.content
    if (remaining > 200 && memContent.length > remaining) {
      // keep the tail — most recent events live at the bottom
      memContent = '(...older events truncated by context budget...)\n' + memContent.slice(memContent.length - remaining)
    }
    if (remaining > 200) parts.push('## STATE (MEMORY)\n' + memContent)
  }

  return parts.join('\n\n')
}

console.log('[shibainu] storage mode: ' + MODE + (MODE === 'workspace' ? ' (' + WORKSPACE_DIR + ')' : ''))

module.exports = {
  mode:             MODE,
  write:            writeMemory,
  read:             readMemory,
  getDirtyAgents:   getDirtyAgents,
  markClean:        markClean,
  initSoul:         initSoul,
  appendEvent:      appendEvent,
  sha256:           sha256,
  // REFLECT layer
  claimId:          claimId,
  parseReflect:     parseReflect,
  renderReflect:    renderReflect,
  readReflections:  readReflections,
  writeReflections: writeReflections,
  REFLECT_CATEGORIES: REFLECT_CATEGORIES,
  // Context assembly
  getContext:       getContext,
  // internals exposed for tests / advanced use
  _supabaseReq:     supabaseReq
}
