'use strict'
/**
 * ShibaInu Memory v2 — Core memory engine
 *
 * AUTO-DETECT STORAGE MODE:
 *   SUPABASE_URL in env → uses Supabase (production, multi-agent)
 *   No SUPABASE_URL    → uses workspace files (zero config, personal use)
 *
 * Workspace layout (file mode):
 *   ~/.openclaw/workspace/memory/agents/<agent_id>/SOUL.md
 *   ~/.openclaw/workspace/memory/agents/<agent_id>/MEMORY.md
 *   ~/.openclaw/workspace/memory/agents/<agent_id>/history/<version>.md
 *
 * Usage:
 *   const memory = require('./memory-v2');
 *   await memory.initSoul('agent_id', { soul: '...', initialMemory: '...' });
 *   await memory.appendEvent('agent_id', 'something happened');
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

// ────────────────────────────────────────────────────────────────────────────
// WORKSPACE (file) backend
// ────────────────────────────────────────────────────────────────────────────
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

  read: function(agentId, memType) {
    var f = ws._file(agentId, memType)
    var m = ws._metaFile(agentId, memType)
    if (!fs.existsSync(f)) return null
    var content = fs.readFileSync(f, 'utf8')
    var meta = fs.existsSync(m) ? JSON.parse(fs.readFileSync(m, 'utf8')) : { version: 1, is_dirty: false }
    return { content: content, hash: sha256(content), version: meta.version, is_dirty: meta.is_dirty }
  },

  write: function(agentId, memType, content, extra) {
    var hash    = sha256(content)
    var cur     = ws.read(agentId, memType)
    var curHash = cur ? cur.hash : null
    var curVer  = cur ? cur.version : 0

    if (hash === curHash) return { version: curVer, hash: hash, changed: false }

    var newVer = curVer + 1
    fs.writeFileSync(ws._file(agentId, memType), content, 'utf8')
    fs.writeFileSync(ws._metaFile(agentId, memType), JSON.stringify({
      version: newVer, is_dirty: true, content_hash: hash,
      updated_at: new Date().toISOString(), metadata: extra || {}
    }, null, 2), 'utf8')

    console.log('[shibainu:ws] write ' + agentId + '/' + memType + ' v' + newVer)
    return { version: newVer, hash: hash, changed: true }
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
      ;['soul', 'memory', 'context'].forEach(function(t) {
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

  write: async function(agentId, memType, content, meta) {
    var hash = sha256(content)
    var rows = await supabaseReq('GET', 'agent_memory',
      'agent_id=eq.' + encodeURIComponent(agentId) + '&memory_type=eq.' + memType + '&select=version,content_hash')
    var existing = Array.isArray(rows) ? rows[0] : null
    var curVer  = existing ? existing.version : 0
    var curHash = existing ? existing.content_hash : null
    if (hash === curHash) return { version: curVer, hash: hash, changed: false }
    var newVer = curVer + 1
    var now = new Date().toISOString()
    if (curVer > 0) {
      await supabaseReq('PATCH', 'agent_memory',
        'agent_id=eq.' + encodeURIComponent(agentId) + '&memory_type=eq.' + memType,
        { content: content, content_hash: hash, version: newVer, is_dirty: true, metadata: meta || {}, updated_at: now })
    } else {
      await supabaseReq('POST', 'agent_memory', null,
        { agent_id: agentId, memory_type: memType, content: content, content_hash: hash, version: 1, is_dirty: true, metadata: meta || {}, updated_at: now, created_at: now })
    }
    console.log('[shibainu:sb] write ' + agentId + '/' + memType + ' v' + newVer)
    return { version: newVer, hash: hash, changed: true }
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
async function writeMemory(agentId, memType, content, meta) {
  return MODE === 'supabase' ? sb.write(agentId, memType, content, meta) : ws.write(agentId, memType, content, meta)
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
    var cur  = await readMemory(agentId, 'memory')
    var base = cur ? cur.content : '# MEMORY\n\n## Recent events\n'
    var ts   = new Date().toISOString().slice(0, 16).replace('T', ' ')
    var newContent = base + '\n- [' + ts + '] ' + event
    var lines = newContent.split('\n')
    if (lines.length > MAX_EVENTS) newContent = lines.slice(lines.length - MAX_EVENTS).join('\n')
    await writeMemory(agentId, 'memory', newContent, meta || {})
  } catch (e) {
    console.warn('[shibainu] appendEvent failed: ' + e.message)
  }
}

console.log('[shibainu] storage mode: ' + MODE + (MODE === 'workspace' ? ' (' + WORKSPACE_DIR + ')' : ''))

module.exports = {
  mode:           MODE,
  write:          writeMemory,
  read:           readMemory,
  getDirtyAgents: getDirtyAgents,
  markClean:      markClean,
  initSoul:       initSoul,
  appendEvent:    appendEvent,
  sha256:         sha256
}
