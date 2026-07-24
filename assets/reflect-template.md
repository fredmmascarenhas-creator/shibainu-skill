# REFLECT — <agent_id>

> Metacognitive self-model. Every claim is evidence-linked and expires unless
> revalidated by Dream. Humans may edit claims; Dream preserves manual edits
> to `claim` text but manages lifecycle fields.

## Active claims
- **[calibration | conf 0.72]** Tends to under-estimate task duration by ~2x on multi-step work  _(validated 2026-07-21, evidence: memory-v12)_
- **[error_pattern | conf 0.65]** Forgets to confirm timezone before scheduling  _(validated 2026-07-19, evidence: memory-v11)_
- **[heuristic | conf 0.60]** Summaries land better when capped at 3 bullet points  _(validated 2026-07-18, evidence: memory-v10)_

## Archived (expired / refuted)
- ~~Always answers in English~~ _(refuted: replied in PT-BR twice on 2026-07-15)_

```json shibainu-reflect
{
  "claims": [
    {
      "id": "r_a1b2c3d4e5",
      "claim": "Tends to under-estimate task duration by ~2x on multi-step work",
      "category": "calibration",
      "confidence": 0.72,
      "evidence": [
        { "ref": "memory-v12", "quote": "- [2026-07-20 14:02] task estimated 1h, took 2h40" }
      ],
      "status": "active",
      "ttl_cycles": 14,
      "cycles_since_validation": 3,
      "created_at": "2026-07-10T03:00:11Z",
      "last_validated_at": "2026-07-21T03:00:09Z"
    }
  ]
}
```
