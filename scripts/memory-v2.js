'use strict'
/**
 * ShibaInu Memory v2 — Core memory engine
 *
 * Three-layer hippocampal architecture:
 *   SOUL   = prefrontal cortex (fixed identity, never overwritten)
 *   MEMORY = hippocampus (dynamic state, last N events, is_dirty flag)
 *   DREAM  = REM sleep (nightly semantic consolidation)
 *
 * Usage:
 *   const memory = require('./memory-v2');
 *   await memory.initSoul('agent_id', { soul: '...', initialMemory: '...' });
 *   await memory.appendEvent('agent_id', 'event description');
 *
 * Requires env: SUPABASE_URL, SUPABASE_KEY
 */

var crypto = require('crypto')
var https  = require('https')

// ── Supabase REST client (zero deps) ─────────────────────────────────────────
var SUPABASE_URL = process.env.SUPABASE_URL || ''
var SUPABASE_KEY = process.env.SUPABASE_KEY || ''

function supabaseRequest(method, table, query, body) {
  return new Promise(function(resolve, reject) {
    var path = '/rest/v1/' + table + (query ? '?' + query : '')
    var data = body ? JSON.stringify(body) : null
    var u = new URL(SUPABASE_URL + path)
    var headers = {
      'apikey':        SUPABASE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_KEY,
      'Content-Type':  'application/json'
    }
    if (method === 'POST')  headers['Prefer'] = 'return=representation'
    if (method === 'PATCH') headers['Prefer'] = 'return=representation'
    if (data) headers['Content-Length'] = Buffer.byteLength(data)

    var req = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method: method, headers: headers },
      function(res) {
        var d = ''
        res.on('data', function(c) { d += c })
        res.on('end', function() {
          try { resolve(JSON.parse(d)) }
          catch(e) { resolve(d) }
        })
      }
    )
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

// ── SHA-256 idempotency guard ─────────────────────────────────────────────────
function sha256(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex')
}

// ── Core: write with delta check ──────────────────────────────────────────────
async function writeMemory(agentId, memType, content, meta) {
  var hash = sha256(content)
  var rows = await supabaseRequest('GET', 'agent_memory',
    'agent_id=eq.' + encodeURIComponent(agentId) +
    '&memory_type=eq.' + memType +
    '&select=version,content_hash')

  var existing = Array.isArray(rows) ? rows[0] : null
  var curVersion = existing ? existing.version : 0
  var curHash    = existing ? existing.content_hash : null

  // SHA-256 guard: skip if identical
  if (hash === curHash) {
    return { version: curVersion, hash: hash, changed: false }
  }

  var newVersion = curVersion + 1
  var now = new Date().toISOString()

  if (curVersion > 0) {
    await supabaseRequest('PATCH', 'agent_memory',
      'agent_id=eq.' + encodeURIComponent(agentId) + '&memory_type=eq.' + memType,
      { content: content, content_hash: hash, version: newVersion,
        is_dirty: true, metadata: meta || {}, updated_at: now })
  } else {
    await supabaseRequest('POST', 'agent_memory', null, {
      agent_id: agentId, memory_type: memType, content: content,
      content_hash: hash, version: 1, is_dirty: true,
      metadata: meta || {}, updated_at: now, created_at: now
    })
  }

  console.log('[shibainu] write ' + agentId + '/' + memType + ' v' + newVersion)
  return { version: newVersion, hash: hash, changed: true }
}

// ── Read ──────────────────────────────────────────────────────────────────────
async function readMemory(agentId, memType) {
  try {
    var rows = await supabaseRequest('GET', 'agent_memory',
      'agent_id=eq.' + encodeURIComponent(agentId) +
      '&memory_type=eq.' + memType +
      '&select=content,version,content_hash,is_dirty,updated_at')
    var row = Array.isArray(rows) ? rows[0] : null
    if (!row) return null
    return {
      content:    row.content,
      version:    row.version,
      hash:       row.content_hash,
      is_dirty:   row.is_dirty,
      updated_at: row.updated_at
    }
  } catch (e) {
    console.warn('[shibainu] readMemory failed ' + agentId + ': ' + e.message)
    return null
  }
}

// ── Delta query: only dirty agents ───────────────────────────────────────────
async function getDirtyAgents() {
  try {
    var rows = await supabaseRequest('GET', 'agent_memory',
      'is_dirty=eq.true&select=agent_id,memory_type,version,updated_at&order=updated_at.asc')
    return Array.isArray(rows) ? rows : []
  } catch (e) {
    console.warn('[shibainu] getDirtyAgents failed: ' + e.message)
    return []
  }
}

// ── Mark clean after Dream consolidation ─────────────────────────────────────
async function markClean(agentId, memType, dreamSummary) {
  try {
    var rows = await supabaseRequest('GET', 'agent_memory',
      'agent_id=eq.' + encodeURIComponent(agentId) +
      '&memory_type=eq.' + memType +
      '&select=content,content_hash,version')
    var cur = Array.isArray(rows) ? rows[0] : null
    if (!cur) return

    var now = new Date().toISOString()

    // Archive to history
    await supabaseRequest('POST', 'agent_memory_history', null, {
      agent_id:     agentId,
      memory_type:  memType,
      content:      cur.content,
      content_hash: cur.content_hash,
      version:      cur.version,
      dream_summary: dreamSummary || null,
      created_at:   now
    })

    // Mark clean
    await supabaseRequest('PATCH', 'agent_memory',
      'agent_id=eq.' + encodeURIComponent(agentId) + '&memory_type=eq.' + memType,
      { is_dirty: false, last_dream_at: now })

    console.log('[shibainu] markClean ' + agentId + '/' + memType + ' v' + cur.version)
  } catch (e) {
    console.warn('[shibainu] markClean failed ' + agentId + ': ' + e.message)
  }
}

// ── Bootstrap: initialize SOUL + MEMORY for a new agent ──────────────────────
async function initSoul(agentId, options) {
  var opts = options || {}
  var ts   = new Date().toISOString()

  var soulContent = opts.soul ||
    '# SOUL — ' + agentId + '\n\n' +
    '## Identity\n- Agent ID: ' + agentId + '\n\n' +
    '_Generated at ' + ts + '_'

  var memContent = opts.initialMemory ||
    '# MEMORY — ' + agentId + '\n\n' +
    '## Recent events\n_No events recorded yet._\n\n' +
    '_Initialized at ' + ts + '_'

  await writeMemory(agentId, 'soul',   soulContent,  { source: 'bootstrap' })
  await writeMemory(agentId, 'memory', memContent, { source: 'bootstrap' })
  console.log('[shibainu] initSoul complete for ' + agentId)
}

// ── Append event to MEMORY ────────────────────────────────────────────────────
async function appendEvent(agentId, event, meta) {
  try {
    var cur  = await readMemory(agentId, 'memory')
    var base = cur ? cur.content : '# MEMORY\n\n## Recent events\n'
    var ts   = new Date().toISOString().slice(0, 16).replace('T', ' ')
    var newContent = base + '\n- [' + ts + '] ' + event

    // Rolling window: keep last 200 lines max
    var lines = newContent.split('\n')
    if (lines.length > 200) newContent = lines.slice(lines.length - 200).join('\n')

    await writeMemory(agentId, 'memory', newContent, meta || {})
  } catch (e) {
    console.warn('[shibainu] appendEvent failed: ' + e.message)
  }
}

module.exports = {
  write:           writeMemory,
  read:            readMemory,
  getDirtyAgents:  getDirtyAgents,
  markClean:       markClean,
  initSoul:        initSoul,
  appendEvent:     appendEvent,
  sha256:          sha256
}
