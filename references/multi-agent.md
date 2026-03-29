# ShibaInu — Multi-Agent Wiring Guide

## The Patient/Doctor/Pharmacist Pattern

This is the production pattern used in OncoNet — a clinical oncology multi-agent system
with 20+ agents. Adapt the roles to your domain.

```
Patient (14 agents)
    ↓ appendEvent() → is_dirty=true
    ↓ INSERT agent_messages (type: alert, to: doctor)
Doctor Agent
    ↓ reads agent_messages every 30min
    ↓ INSERT agent_messages (type: recommendation, to: gestor)
    ↓ appendEvent() on own memory
GestorAgent / Orchestrator
    ↓ reads all escalations
    ↓ notifies human via Telegram
    ↓ appendEvent() on own memory
Dream (03h)
    ↓ processes all is_dirty=true agents
    ↓ consolidates, versions, markClean
```

---

## Setting Up Multiple Agents

### 1. Bootstrap all agents at startup

```js
const memory = require('./scripts/memory-v2');

const patients = [
  { id: 'patient_001', name: 'João Silva', context: 'mCRPC, cabazitaxel protocol' },
  { id: 'patient_002', name: 'Maria Costa', context: 'Breast HER2+, trastuzumab' },
];

for (const p of patients) {
  await memory.initSoul(p.id, {
    soul: `# SOUL — ${p.name}\n\n## Identity\n- Patient: ${p.name}\n- Context: ${p.context}\n\n## Rules\n- Never reveal clinical data to patient\n- Alert on fever > 38.5°C`,
    initialMemory: `# MEMORY — ${p.name}\n\n## Recent events\n_No events yet._`
  });
}
```

### 2. Agent cron pattern

Each agent type runs on its own schedule:

```bash
# Patient agents: check frequently (symptom reporting)
*/30 * * * * node patient-agent.js

# Doctor agent: analyze escalations
*/30 * * * * node doctor-agent.js

# Pharmacist: check drug interactions
0 */2 * * * node pharmacist-agent.js

# Nurse: vital sign check-ins
0 8,12,17 * * * node nurse-agent.js

# Coordinator: admin + scheduling
0 7 * * * node coordinator-agent.js

# Dream: nightly consolidation
0 3 * * * node dream-v2.js
```

### 3. Sending inter-agent messages

```js
// In patient-agent.js — report symptom to doctor
async function reportToDoctor(patientId, symptom, severity) {
  await supabaseInsert('agent_messages', {
    from_agent_id: patientId,
    to_agent_id:   'doctor_001',
    type:          'alert',
    subject:       'Symptom report: ' + symptom,
    content:       JSON.stringify({ symptom, severity, timestamp: new Date().toISOString() }),
    priority:      severity === 'critical' ? 'critical' : 'high',
    status:        'sent'
  });
  
  // Also append to own memory
  await memory.appendEvent(patientId, 'Reported symptom to doctor: ' + symptom + ' (severity: ' + severity + ')');
}
```

### 4. Reading messages in agent loop

```js
// In doctor-agent.js — process incoming messages
async function processInbox(doctorId) {
  const messages = await supabaseSelect('agent_messages',
    'to_agent_id=eq.' + doctorId + '&status=eq.sent&order=priority.desc,created_at.asc'
  );
  
  for (const msg of messages) {
    // Process...
    await memory.appendEvent(doctorId, 'Processed alert from ' + msg.from_agent_id + ': ' + msg.subject);
    
    // Mark as processed
    await supabaseUpdate('agent_messages', 'id=eq.' + msg.id, { status: 'processed', processed_at: new Date().toISOString() });
  }
}
```

---

## Naming Conventions

| Agent type | ID pattern | Example |
|---|---|---|
| Patient | `patient_<code>_<name>` | `patient_001_joao_silva` |
| Doctor | `doctor_<specialty>_<code>` | `doctor_onco_001` |
| Pharmacist | `pharmacist_<code>` | `pharmacist_001` |
| Coordinator | `coordinator_<code>` | `coordinator_001` |
| Personal | `personal_<person>` | `personal_fred` |
| Family | `family_<person>` | `family_rafael` |

---

## Separate Supabase Projects

If you have clinical + personal agents, use separate Supabase projects:

```js
// clinical-memory.js — for patient/doctor agents
process.env.SUPABASE_URL = process.env.CLINICAL_SUPABASE_URL;
process.env.SUPABASE_KEY = process.env.CLINICAL_SUPABASE_KEY;
const clinicalMemory = require('./scripts/memory-v2');

// personal-memory.js — for personal/family agents
process.env.SUPABASE_URL = process.env.PERSONAL_SUPABASE_URL;
process.env.SUPABASE_KEY = process.env.PERSONAL_SUPABASE_KEY;
const personalMemory = require('./scripts/memory-v2');
```

This enforces data segregation at the infrastructure level — clinical PHI never
touches the same database as personal data.
