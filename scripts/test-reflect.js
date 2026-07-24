'use strict'
/**
 * ShibaInu smoke test — workspace mode, no API key, no Supabase.
 *
 *   node scripts/test-reflect.js
 *
 * Covers:
 *   1. init + appendEvent basics
 *   2. concurrent appendEvent across PROCESSES (lock/CAS — no lost events)
 *   3. reflection lifecycle: propose → revalidate → decay → expire → refute
 *   4. REFLECT render/parse round-trip
 *   5. getContext assembly + budget truncation
 */

var os   = require('os')
var fs   = require('fs')
var path = require('path')
var cp   = require('child_process')

var TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'shibainu-test-'))
process.env.SHIBAINU_WORKSPACE_DIR = TMP
delete process.env.SUPABASE_URL

var memory = require('./memory-v2')
var dream  = require('./dream-v2')

var failures = []
function check(name, cond, detail) {
  if (cond) { console.log('  ✓ ' + name) }
  else { console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); failures.push(name) }
}

async function main() {
  var AG = 'test_agent'

  console.log('\n[1] init + appendEvent')
  await memory.initSoul(AG, { soul: '# SOUL — test\nRegra: seja objetivo.' })
  await memory.appendEvent(AG, 'first event')
  await memory.appendEvent(AG, 'second event')
  var mem = await memory.read(AG, 'memory')
  check('two events stored', (mem.content.match(/^- \[/gm) || []).length === 2)
  check('memory is dirty', mem.is_dirty === true)

  console.log('\n[2] concurrent appendEvent across processes (no lost events)')
  var script = 'process.env.SHIBAINU_WORKSPACE_DIR=' + JSON.stringify(TMP) + ';' +
    'var m=require(' + JSON.stringify(path.join(__dirname, 'memory-v2.js')) + ');' +
    '(async function(){for(var i=0;i<5;i++){await m.appendEvent("conc_agent","evt-"+process.argv[2]+"-"+i)}})()' +
    '.then(function(){process.exit(0)},function(e){console.error(e);process.exit(1)})'
  await memory.initSoul('conc_agent', {})
  var procs = ['a', 'b', 'c'].map(function(tag) {
    return new Promise(function(resolve) {
      var p = cp.spawn(process.execPath, ['-e', script, '--', tag], { stdio: 'ignore' })
      p.on('exit', resolve)
    })
  })
  await Promise.all(procs)
  var conc = await memory.read('conc_agent', 'memory')
  var got = (conc.content.match(/evt-/g) || []).length
  check('15/15 events survive 3 concurrent writers', got === 15, 'got ' + got)

  console.log('\n[3] reflection lifecycle')
  var now = new Date().toISOString()
  // cycle 1: propose two claims (one without evidence must be dropped)
  var r1 = dream.applyReflectionLifecycle([], {
    new: [
      { claim: 'Tends to underestimate task duration', category: 'calibration', confidence: 0.6, evidence: ['- [2026-07-24 10:00] task took 3x estimate'] },
      { claim: 'Hallucinated claim with no proof', category: 'heuristic', confidence: 0.9, evidence: [] }
    ]
  }, 'memory-v3', now, { ttlCycles: 2 })
  check('evidence-backed claim accepted', r1.claims.length === 1 && r1.stats.added === 1)
  check('evidence-free claim rejected (anti-confabulation)', r1.claims.every(function(c) { return c.evidence.length > 0 }))
  var id = r1.claims[0].id

  // cycle 2: revalidated → counter resets, confidence reinforced
  var r2 = dream.applyReflectionLifecycle(r1.claims, { revalidated: [id] }, 'memory-v4', now, { ttlCycles: 2 })
  check('revalidation resets counter', r2.claims[0].cycles_since_validation === 0 && r2.stats.revalidated === 1)
  check('confidence reinforced', r2.claims[0].confidence > 0.6)

  // cycles 3-4: silence → decay → expire (ttl 2)
  var r3 = dream.applyReflectionLifecycle(r2.claims, {}, 'memory-v5', now, { ttlCycles: 2 })
  var r4 = dream.applyReflectionLifecycle(r3.claims, {}, 'memory-v6', now, { ttlCycles: 2 })
  check('claim expires after TTL cycles of silence', r4.claims[0].status === 'expired' && r4.stats.expired === 1)

  // refutation
  var r5a = dream.applyReflectionLifecycle([], {
    new: [{ claim: 'Always answers in English', category: 'preference', confidence: 0.7, evidence: ['- [x] replied in English'] }]
  }, 'memory-v7', now, { ttlCycles: 5 })
  var rid = r5a.claims[0].id
  var r5b = dream.applyReflectionLifecycle(r5a.claims, { refuted: [{ id: rid, reason: 'replied in PT-BR twice' }] }, 'memory-v8', now, { ttlCycles: 5 })
  check('refuted claim archived with reason', r5b.claims[0].status === 'refuted' && /PT-BR/.test(r5b.claims[0].refuted_reason))

  // dedup: same claim (even refuted) is not re-added
  var r5c = dream.applyReflectionLifecycle(r5b.claims, {
    new: [{ claim: 'Always answers in English', category: 'preference', confidence: 0.7, evidence: ['- [x] quote'] }]
  }, 'memory-v9', now, { ttlCycles: 5 })
  check('refuted claim does not resurrect via dedup', r5c.stats.added === 0)

  console.log('\n[4] REFLECT render/parse round-trip + versioning')
  await memory.writeReflections(AG, r2.claims, { source: 'test' })
  var back = await memory.readReflections(AG)
  check('round-trip preserves claims', back.length === 1 && back[0].id === id)
  check('REFLECT.md exists on disk', fs.existsSync(path.join(TMP, AG, 'REFLECT.md')))
  var dirtyRows = memory.mode === 'workspace' ? require('./memory-v2').getDirtyAgents() : []
  var dirtyList = await dirtyRows
  check('reflect appears in dirty scan', dirtyList.some(function(d) { return d.agent_id === AG && d.memory_type === 'reflect' }))

  console.log('\n[5] getContext assembly + budget')
  var ctx = await memory.getContext(AG)
  check('context has SOUL', ctx.indexOf('IDENTITY (SOUL)') !== -1)
  check('context has REFLECT claims', ctx.indexOf('SELF-MODEL (REFLECT)') !== -1 && ctx.indexOf('underestimate task duration') !== -1)
  check('context has MEMORY', ctx.indexOf('STATE (MEMORY)') !== -1)
  for (var i = 0; i < 50; i++) await memory.appendEvent(AG, 'filler event number ' + i + ' with some padding text to grow memory size')
  var small = await memory.getContext(AG, { budgetChars: 2000 })
  check('budget respected (±10%)', small.length <= 2200, 'len ' + small.length)
  check('truncation keeps memory tail', small.indexOf('filler event number 49') !== -1)

  console.log('\n' + (failures.length === 0 ? 'ALL TESTS PASSED ✓' : 'FAILURES: ' + failures.join(', ')))
  fs.rmSync(TMP, { recursive: true, force: true })
  process.exit(failures.length === 0 ? 0 : 1)
}

main().catch(function(e) { console.error('FATAL', e); process.exit(1) })
