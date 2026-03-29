'use strict'
/**
 * ShibaInu Dream v2 — Nightly REM consolidation
 *
 * Runs at 03h daily via cron. Processes ONLY agents with is_dirty=true.
 * Consolidates memory using Claude Haiku, versions to history, marks clean.
 *
 * Cron:
 *   0 3 * * * /usr/bin/node /path/to/dream-v2.js >> /path/to/dream.log 2>&1
 *
 * Requires env:
 *   SUPABASE_URL, SUPABASE_KEY, ANTHROPIC_API_KEY
 *   Optional: DREAM_MODEL (default: claude-haiku-4-5-20251001)
 *             DREAM_MAX_AGENTS (default: 50)
 *             DREAM_CONTEXT (clinical|personal|generic, default: generic)
 */

var https  = require('https')
var memory = require('./memory-v2')

var ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY || ''
var DREAM_MODEL    = process.env.DREAM_MODEL || 'claude-haiku-4-5-20251001'
var DREAM_MAX      = parseInt(process.env.DREAM_MAX_AGENTS || '50', 10)
var DREAM_CONTEXT  = process.env.DREAM_CONTEXT || 'generic'

// ── Claude API (zero deps) ────────────────────────────────────────────────────
function callClaude(system, user) {
  return new Promise(function(resolve, reject) {
    var body = JSON.stringify({
      model:      DREAM_MODEL,
      max_tokens: 1024,
      system:     system,
      messages:   [{ role: 'user', content: user }]
    })
    var req = https.request({
      hostname: 'api.anthropic.com',
      path:     '/v1/messages',
      method:   'POST',
      headers: {
        'Content-Type':       'application/json',
        'x-api-key':          ANTHROPIC_KEY,
        'anthropic-version':  '2023-06-01',
        'Content-Length':     Buffer.byteLength(body)
      }
    }, function(res) {
      var d = ''
      res.on('data', function(c) { d += c })
      res.on('end', function() {
        try {
          var r = JSON.parse(d)
          resolve(r.content && r.content[0] ? r.content[0].text : '')
        } catch(e) { resolve('') }
      })
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

// ── System prompt by context ──────────────────────────────────────────────────
function getSystemPrompt(context) {
  if (context === 'clinical') {
    return [
      'You are a precise clinical AI memory consolidator.',
      'Analyze the agent memory and identify:',
      '1. Recurring patterns (symptoms, adherence issues, mood changes)',
      '2. Critical alerts (fever >38.5, neutropenia, bleeding, pain >7)',
      '3. Events requiring medical attention in the next 24h',
      'Respond in JSON: {"patterns":[],"critical":[],"alert":bool,"summary":"..."}',
      'Be precise. No speculation. Cite specific events from memory.'
    ].join('\n')
  }
  if (context === 'personal') {
    return [
      'You are a personal AI memory consolidator.',
      'Analyze the agent memory and identify:',
      '1. Pending items and upcoming deadlines',
      '2. Emotional patterns and wellbeing signals',
      '3. Action items for the next 24-48h',
      'Respond in JSON: {"pending":[],"deadlines":[],"action_items":[],"summary":"..."}',
      'Be helpful and concise.'
    ].join('\n')
  }
  // generic
  return [
    'You are an AI memory consolidator.',
    'Analyze the agent memory below and produce:',
    '1. Key patterns and recurring themes',
    '2. Items that need attention',
    '3. A concise summary (2-3 sentences)',
    'Respond in JSON: {"patterns":[],"attention":[],"alert":bool,"summary":"..."}',
    'Be concise and precise.'
  ].join('\n')
}

// ── Consolidate one agent ─────────────────────────────────────────────────────
async function consolidateAgent(agentId, dirtyTypes) {
  console.log('[dream] consolidating ' + agentId + ' (dirty: ' + dirtyTypes.join(', ') + ')')

  var soulData = await memory.read(agentId, 'soul')
  var memData  = await memory.read(agentId, 'memory')

  if (!memData) {
    console.warn('[dream] no memory for ' + agentId + ', skipping')
    return null
  }

  var soulCtx = soulData ? soulData.content : '(no soul registered)'
  var system  = getSystemPrompt(DREAM_CONTEXT)
  var userMsg = 'SOUL:\n' + soulCtx + '\n\nMEMORY:\n' + memData.content

  var analysis = ''
  try {
    if (ANTHROPIC_KEY) {
      analysis = await callClaude(system, userMsg)
    } else {
      console.warn('[dream] no ANTHROPIC_API_KEY — skipping LLM consolidation')
    }
  } catch (e) {
    console.warn('[dream] claude failed for ' + agentId + ': ' + e.message)
  }

  var parsed = { patterns: [], attention: [], alert: false, summary: '' }
  try {
    var m = analysis.match(/\{[\s\S]+\}/)
    if (m) parsed = JSON.parse(m[0])
  } catch(e) { /* use empty parsed */ }

  // ── Compact memory: keep last 30 events ──────────────────────────────────
  var lines       = memData.content.split('\n')
  var eventLines  = lines.filter(function(l) { return /^- \[/.test(l) })
  var recentEvents = eventLines.slice(-30)

  var headerEnd = lines.findIndex(function(l) { return /^- \[/.test(l) })
  var header    = headerEnd > 0 ? lines.slice(0, headerEnd) : ['# MEMORY', '', '## Recent events']

  var compacted = header.join('\n') + '\n' + recentEvents.join('\n')

  if (parsed.summary) {
    compacted += '\n\n## Dream summary ' + new Date().toISOString().slice(0, 10)
    compacted += '\n' + parsed.summary
  }

  var patternsArr = parsed.patterns || parsed.pending || []
  if (patternsArr.length > 0) {
    compacted += '\n\n## Detected patterns\n'
    patternsArr.forEach(function(p) { compacted += '- ' + p + '\n' })
  }

  // Write compacted memory
  await memory.write(agentId, 'memory', compacted, {
    dream_version:  2,
    compacted_at:   new Date().toISOString(),
    events_kept:    recentEvents.length
  })

  // Mark all dirty types clean
  for (var i = 0; i < dirtyTypes.length; i++) {
    await memory.markClean(agentId, dirtyTypes[i], parsed.summary || null)
  }

  return {
    agentId:      agentId,
    events_total: eventLines.length,
    events_kept:  recentEvents.length,
    patterns:     patternsArr,
    alert:        parsed.alert || parsed.doctor_alert || false,
    summary:      parsed.summary || ''
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────
async function run() {
  var ts = new Date().toISOString().slice(0, 16)
  console.log('\n=== ShibaInu Dream v2 — ' + ts + ' ===')
  console.log('Context: ' + DREAM_CONTEXT + ' | Model: ' + DREAM_MODEL)

  var dirty = await memory.getDirtyAgents()

  if (dirty.length === 0) {
    console.log('No dirty agents. Dream complete.')
    process.exit(0)
  }

  // Group by agent
  var byAgent = {}
  dirty.forEach(function(row) {
    if (!byAgent[row.agent_id]) byAgent[row.agent_id] = []
    byAgent[row.agent_id].push(row.memory_type)
  })

  var agentIds = Object.keys(byAgent).slice(0, DREAM_MAX)
  console.log('Agents to consolidate: ' + agentIds.length + '\n')

  var results = []
  for (var i = 0; i < agentIds.length; i++) {
    try {
      var result = await consolidateAgent(agentIds[i], byAgent[agentIds[i]])
      if (result) results.push(result)
    } catch (e) {
      console.warn('[dream] error on ' + agentIds[i] + ': ' + e.message)
    }
    // Rate limit: 1s between agents
    await new Promise(function(r) { setTimeout(r, 1000) })
  }

  console.log('\n=== Dream complete ===')
  console.log('Consolidated: ' + results.length + ' agents')
  results.forEach(function(r) {
    var line = '  ' + r.agentId + ': ' +
      r.events_total + '->' + r.events_kept + ' events'
    if (r.patterns.length > 0) line += ' | patterns: ' + r.patterns.slice(0, 2).join(', ')
    if (r.alert) line += ' | ⚠️ ALERT'
    console.log(line)
  })

  process.exit(0)
}

run().catch(function(e) {
  console.error('[dream] FATAL:', e.message)
  process.exit(1)
})
