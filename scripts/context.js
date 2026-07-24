#!/usr/bin/env node
'use strict'
/**
 * ShibaInu Context CLI — budgeted context assembly for agent bootstrap.
 *
 * Prints SOUL (full) + REFLECT active claims + MEMORY tail for an agent,
 * sized to a character budget. Designed to be called from an OpenClaw
 * agent's session-start hook / heartbeat so the agent wakes up with
 * identity, self-model, and recent state already in context.
 *
 * Usage:
 *   node context.js <agent_id> [--budget 24000] [--claims 12]
 *
 * OpenClaw wiring (example — inside the agent's bootstrap step):
 *   CONTEXT=$(node /path/to/shibainu/scripts/context.js personal_fred)
 *   # inject $CONTEXT at the top of the agent's system/session prompt
 */

var memory = require('./memory-v2')

function parseArgs(argv) {
  var out = { agentId: null, budget: 24000, claims: 12 }
  for (var i = 0; i < argv.length; i++) {
    var a = argv[i]
    if (a === '--budget' && argv[i + 1]) { out.budget = parseInt(argv[++i], 10) }
    else if (a.indexOf('--budget=') === 0) out.budget = parseInt(a.split('=')[1], 10)
    else if (a === '--claims' && argv[i + 1]) { out.claims = parseInt(argv[++i], 10) }
    else if (a.indexOf('--claims=') === 0) out.claims = parseInt(a.split('=')[1], 10)
    else if (a.indexOf('--') !== 0 && !out.agentId) out.agentId = a
  }
  return out
}

var args = parseArgs(process.argv.slice(2))
if (!args.agentId) {
  console.error('usage: node context.js <agent_id> [--budget chars] [--claims n]')
  process.exit(2)
}

memory.getContext(args.agentId, { budgetChars: args.budget, maxClaims: args.claims })
  .then(function(ctx) {
    if (!ctx) {
      console.error('[shibainu] no memory found for agent: ' + args.agentId)
      process.exit(1)
    }
    process.stdout.write(ctx + '\n')
  })
  .catch(function(e) {
    console.error('[shibainu] context failed: ' + e.message)
    process.exit(1)
  })
