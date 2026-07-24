'use strict'
/**
 * ShibaInu Dream — Nightly REM consolidation + REFLECT metacognition
 * Engine v3: one LLM call per dirty agent now produces BOTH the semantic
 * consolidation (dream summary, patterns, alerts) AND the metacognitive pass
 * (revalidate / refute / propose evidence-linked self-model claims).
 *
 * Runs at 03h daily via cron. Processes ONLY agents with is_dirty=true.
 *
 * Cron:
 *   0 3 * * * /usr/bin/node /path/to/dream-v2.js >> /path/to/dream.log 2>&1
 *
 * On demand:
 *   node dream-v2.js --agent assistant_alice
 *
 * Requires env:
 *   ANTHROPIC_API_KEY (plus SUPABASE_URL/SUPABASE_KEY in supabase mode)
 *   Optional: DREAM_MODEL        (default: claude-haiku-4-5-20251001)
 *             DREAM_MAX_AGENTS   (default: 50)
 *             DREAM_CONTEXT      (clinical|personal|generic, default: generic)
 *             DREAM_KEEP_EVENTS  (default: 30)
 *             DREAM_REFLECT      (on|off, default: on)
 *             REFLECT_TTL_CYCLES (default: 14 — cycles without revalidation before a claim expires)
 *             REFLECT_MAX_NEW    (default: 3 — max new claims per cycle)
 *             REFLECT_MAX_ACTIVE (default: 40 — cap of active claims per agent)
 */

var https  = require('https')
var memory = require('./memory-v2')
// memory.mode is 'workspace' or 'supabase' — dream works identically in both

var ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY || ''
var DREAM_MODEL    = process.env.DREAM_MODEL || 'claude-haiku-4-5-20251001'
var DREAM_MAX      = parseInt(process.env.DREAM_MAX_AGENTS || '50', 10)
var DREAM_CONTEXT  = process.env.DREAM_CONTEXT || 'generic'
var KEEP_EVENTS    = parseInt(process.env.DREAM_KEEP_EVENTS || '30', 10)
var REFLECT_ON     = (process.env.DREAM_REFLECT || 'on') !== 'off'
var TTL_CYCLES     = parseInt(process.env.REFLECT_TTL_CYCLES || '14', 10)
var MAX_NEW        = parseInt(process.env.REFLECT_MAX_NEW || '3', 10)
var MAX_ACTIVE     = parseInt(process.env.REFLECT_MAX_ACTIVE || '40', 10)

// ── Claude API (zero deps) ────────────────────────────────────────────────────
function callClaude(system, user) {
  return new Promise(function(resolve, reject) {
    var body = JSON.stringify({
      model:      DREAM_MODEL,
      max_tokens: 2048,
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
function getSystemPrompt(context, withReflect) {
  var base
  if (context === 'clinical') {
    base = [
      'You are a precise clinical AI memory consolidator.',
      'Analyze the agent memory and identify:',
      '1. Recurring patterns (symptoms, adherence issues, mood changes)',
      '2. Critical alerts (fever >38.5, neutropenia, bleeding, pain >7)',
      '3. Events requiring medical attention in the next 24h',
      'Respond in JSON: {"patterns":[],"critical":[],"alert":bool,"summary":"..."}',
      'Be precise. No speculation. Cite specific events from memory.'
    ]
  } else if (context === 'personal') {
    base = [
      'You are a personal AI memory consolidator.',
      'Analyze the agent memory and identify:',
      '1. Pending items and upcoming deadlines',
      '2. Emotional patterns and wellbeing signals',
      '3. Action items for the next 24-48h',
      'Respond in JSON: {"pending":[],"deadlines":[],"action_items":[],"summary":"..."}',
      'Be helpful and concise.'
    ]
  } else {
    base = [
      'You are an AI memory consolidator.',
      'Analyze the agent memory below and produce:',
      '1. Key patterns and recurring themes',
      '2. Items that need attention',
      '3. A concise summary (2-3 sentences)',
      'Respond in JSON: {"patterns":[],"attention":[],"alert":bool,"summary":"..."}',
      'Be concise and precise.'
    ]
  }

  if (withReflect) {
    base = base.concat([
      '',
      'REFLECTION (metacognition): you also maintain the agent\'s self-model —',
      'evidence-linked claims about how this agent behaves, errs, and should adjust.',
      'You receive ACTIVE_REFLECTIONS (current claims). Using ONLY events present in MEMORY:',
      '- revalidated: ids of existing claims that THIS memory window supports again',
      '- refuted: existing claims clearly contradicted by events, with a short reason',
      '- new: at most ' + MAX_NEW + ' new claims. Each needs: claim (one sentence about the',
      '  agent\'s own behavior/performance, not about the world), category',
      '  (error_pattern|heuristic|calibration|preference|world_model), confidence 0..1,',
      '  and evidence: 1-3 quotes copied VERBATIM from memory event lines.',
      'HARD RULES: no evidence quote → do not propose the claim. Never restate SOUL',
      'rules as claims. Do not revalidate a claim without supporting events this window.',
      'ADD to your JSON response the key:',
      '"reflections":{"revalidated":["id"],"refuted":[{"id":"","reason":""}],"new":[{"claim":"","category":"","confidence":0.5,"evidence":["..."]}]}'
    ])
  }
  return base.join('\n')
}

// ── Reflection lifecycle (pure — unit-testable) ──────────────────────────────
// existing: current claims array; parsed: model's "reflections" object;
// memRef: evidence ref for this cycle (e.g. "memory-v12"); nowIso: timestamp.
function applyReflectionLifecycle(existing, parsed, memRef, nowIso, opts) {
  opts = opts || {}
  var ttl       = opts.ttlCycles  != null ? opts.ttlCycles  : TTL_CYCLES
  var maxNew    = opts.maxNew     != null ? opts.maxNew     : MAX_NEW
  var maxActive = opts.maxActive  != null ? opts.maxActive  : MAX_ACTIVE

  var p = parsed || {}
  var revalidated = Array.isArray(p.revalidated) ? p.revalidated : []
  var refuted     = Array.isArray(p.refuted)     ? p.refuted     : []
  var proposed    = Array.isArray(p.new)         ? p.new         : []

  var refutedById = {}
  refuted.forEach(function(r) { if (r && r.id) refutedById[r.id] = r.reason || 'contradicted by events' })

  var claims = existing.map(function(c) { return JSON.parse(JSON.stringify(c)) })
  var stats = { revalidated: 0, refuted: 0, expired: 0, added: 0 }

  claims.forEach(function(c) {
    if (c.status !== 'active') return
    if (refutedById[c.id]) {
      c.status = 'refuted'
      c.refuted_reason = String(refutedById[c.id]).slice(0, 200)
      stats.refuted++
      return
    }
    if (revalidated.indexOf(c.id) !== -1) {
      c.cycles_since_validation = 0
      c.last_validated_at = nowIso
      // gentle confidence reinforcement, capped
      c.confidence = Math.min(0.99, (c.confidence || 0.5) + 0.05)
      stats.revalidated++
      return
    }
    c.cycles_since_validation = (c.cycles_since_validation || 0) + 1
    if (c.cycles_since_validation >= (c.ttl_cycles || ttl)) {
      c.status = 'expired'
      stats.expired++
    }
  })

  var existingIds = {}
  claims.forEach(function(c) { existingIds[c.id] = true })

  proposed.slice(0, maxNew).forEach(function(n) {
    if (!n || !n.claim) return
    var evidence = Array.isArray(n.evidence) ? n.evidence.filter(Boolean) : []
    if (evidence.length === 0) return // anti-confabulation: no evidence, no claim
    var cat = memory.REFLECT_CATEGORIES.indexOf(n.category) !== -1 ? n.category : 'heuristic'
    var id  = memory.claimId(n.claim)
    if (existingIds[id]) return // dedup — includes previously refuted/expired claims
    claims.push({
      id: id,
      claim: String(n.claim).slice(0, 300),
      category: cat,
      confidence: Math.max(0, Math.min(1, Number(n.confidence) || 0.5)),
      evidence: evidence.slice(0, 3).map(function(q) { return { ref: memRef, quote: String(q).slice(0, 200) } }),
      status: 'active',
      ttl_cycles: ttl,
      cycles_since_validation: 0,
      created_at: nowIso,
      last_validated_at: nowIso
    })
    existingIds[id] = true
    stats.added++
  })

  // Cap active claims: keep highest-confidence, expire the overflow
  var active = claims.filter(function(c) { return c.status === 'active' })
  if (active.length > maxActive) {
    active.sort(function(a, b) { return (a.confidence || 0) - (b.confidence || 0) })
    active.slice(0, active.length - maxActive).forEach(function(c) {
      c.status = 'expired'
      stats.expired++
    })
  }

  return { claims: claims, stats: stats }
}

// ── Optional: mirror claims to agent_reflections table (supabase mode) ───────
async function syncReflectionsTable(agentId, claims) {
  if (memory.mode !== 'supabase') return
  try {
    for (var i = 0; i < claims.length; i++) {
      var c = claims[i]
      var rows = await memory._supabaseReq('GET', 'agent_reflections',
        'agent_id=eq.' + encodeURIComponent(agentId) + '&claim_id=eq.' + c.id + '&select=claim_id')
      var body = {
        agent_id: agentId, claim_id: c.id, claim: c.claim, category: c.category,
        confidence: c.confidence, evidence: c.evidence || [], status: c.status,
        ttl_cycles: c.ttl_cycles, cycles_since_validation: c.cycles_since_validation,
        refuted_reason: c.refuted_reason || null,
        last_validated_at: c.last_validated_at || null, updated_at: new Date().toISOString()
      }
      if (Array.isArray(rows) && rows.length > 0) {
        await memory._supabaseReq('PATCH', 'agent_reflections',
          'agent_id=eq.' + encodeURIComponent(agentId) + '&claim_id=eq.' + c.id, body)
      } else {
        body.created_at = c.created_at || new Date().toISOString()
        await memory._supabaseReq('POST', 'agent_reflections', null, body)
      }
    }
  } catch (e) {
    console.warn('[dream] agent_reflections sync failed (non-fatal): ' + e.message)
  }
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

  var claims       = REFLECT_ON ? await memory.readReflections(agentId) : []
  var activeClaims = claims.filter(function(c) { return c.status === 'active' })

  var soulCtx = soulData ? soulData.content : '(no soul registered)'
  var system  = getSystemPrompt(DREAM_CONTEXT, REFLECT_ON)
  var userMsg = 'SOUL:\n' + soulCtx + '\n\nMEMORY:\n' + memData.content
  if (REFLECT_ON) {
    userMsg += '\n\nACTIVE_REFLECTIONS:\n' + JSON.stringify(
      activeClaims.map(function(c) { return { id: c.id, category: c.category, claim: c.claim } }), null, 2)
  }

  var analysis = ''
  var llmRan   = false
  try {
    if (ANTHROPIC_KEY) {
      analysis = await callClaude(system, userMsg)
      llmRan = true
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

  // ── Compact memory: keep last N events ───────────────────────────────────
  var lines       = memData.content.split('\n')
  var eventLines  = lines.filter(function(l) { return /^- \[/.test(l) })
  var recentEvents = eventLines.slice(-KEEP_EVENTS)

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
    dream_version:  3,
    compacted_at:   new Date().toISOString(),
    events_kept:    recentEvents.length
  })

  // ── REFLECT pass — only when the LLM actually ran this cycle. Without it
  // there is no revalidation signal, and decaying TTLs blindly would expire
  // every claim on keyless installs.
  var reflectStats = null
  if (REFLECT_ON && llmRan) {
    var nowIso = new Date().toISOString()
    var memRef = 'memory-v' + memData.version
    var result = applyReflectionLifecycle(claims, parsed.reflections, memRef, nowIso)
    reflectStats = result.stats
    var changed = reflectStats.revalidated + reflectStats.refuted + reflectStats.expired + reflectStats.added > 0
    if (changed || claims.length === 0) {
      await memory.writeReflections(agentId, result.claims, { source: 'dream', cycle_at: nowIso })
      await memory.markClean(agentId, 'reflect',
        'reflect: +' + reflectStats.added + ' new, ' + reflectStats.revalidated + ' revalidated, ' +
        reflectStats.refuted + ' refuted, ' + reflectStats.expired + ' expired')
      await syncReflectionsTable(agentId, result.claims)
    }
  }

  // Mark all dirty types clean
  for (var i = 0; i < dirtyTypes.length; i++) {
    if (dirtyTypes[i] === 'reflect') continue // handled above with its own summary
    await memory.markClean(agentId, dirtyTypes[i], parsed.summary || null)
  }

  return {
    agentId:      agentId,
    events_total: eventLines.length,
    events_kept:  recentEvents.length,
    patterns:     patternsArr,
    alert:        parsed.alert || parsed.doctor_alert || false,
    summary:      parsed.summary || '',
    reflect:      reflectStats
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────
function parseArgs(argv) {
  var out = { agent: null }
  for (var i = 0; i < argv.length; i++) {
    if (argv[i] === '--agent' && argv[i + 1]) { out.agent = argv[i + 1]; i++ }
    else if (argv[i].indexOf('--agent=') === 0) out.agent = argv[i].split('=')[1]
  }
  return out
}

async function run() {
  var args = parseArgs(process.argv.slice(2))
  var ts = new Date().toISOString().slice(0, 16)
  console.log('\n=== ShibaInu Dream v3 — ' + ts + ' ===')
  console.log('Context: ' + DREAM_CONTEXT + ' | Model: ' + DREAM_MODEL + ' | Reflect: ' + (REFLECT_ON ? 'on' : 'off'))

  var byAgent = {}
  if (args.agent) {
    // On-demand: consolidate a single agent regardless of dirty state
    byAgent[args.agent] = ['memory']
    console.log('On-demand run for agent: ' + args.agent)
  } else {
    var dirty = await memory.getDirtyAgents()
    if (dirty.length === 0) {
      console.log('No dirty agents. Dream complete.')
      process.exit(0)
    }
    dirty.forEach(function(row) {
      if (!byAgent[row.agent_id]) byAgent[row.agent_id] = []
      byAgent[row.agent_id].push(row.memory_type)
    })
  }

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
    if (r.reflect) line += ' | reflect: +' + r.reflect.added + '/' + r.reflect.revalidated + 'rv/' + r.reflect.refuted + 'rf/' + r.reflect.expired + 'exp'
    if (r.alert) line += ' | ⚠️ ALERT'
    console.log(line)
  })

  process.exit(0)
}

module.exports = {
  applyReflectionLifecycle: applyReflectionLifecycle,
  consolidateAgent:         consolidateAgent,
  getSystemPrompt:          getSystemPrompt,
  parseArgs:                parseArgs,
  run:                      run
}

if (require.main === module) {
  run().catch(function(e) {
    console.error('[dream] FATAL:', e.message)
    process.exit(1)
  })
}
