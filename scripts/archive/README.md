# scripts/archive

One-off analysis scripts from past sessions. Not run in CI. Kept for
history in case we want to re-run the same checks.

| File | Source session | What it did |
|---|---|---|
| `audit.js` | 2026-04-16 | Early repo/DB state probe |
| `audit_final.mjs` | 2026-04-16 | End-of-session consolidation pass |
| `audit_finish.mjs` | 2026-04-16 | Mid-session cleanup verification |
| `audit_migrations.js` | 2026-04-16 | Migration-table consistency check |
| `audit_migrations.mjs` | 2026-04-16 | Migration-table consistency check (Node variant) |
| `audit_migrations2.mjs` | 2026-04-16 | Follow-up run after a re-apply |

For live system audits, prefer `npm run db:verify` (canonical DB sanity
check + trigger smoke test) or the per-session audit agents pattern
used on 2026-04-21 (see HANDOFF.md for reference).
