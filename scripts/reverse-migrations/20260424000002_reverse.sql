-- REVERSE MIGRATION for 20260424000002_contracts_related_projects.sql
--
-- **Do NOT move this file into supabase/migrations/ — the runner would
-- try to apply it forward.** Apply MANUALLY via `psql` or inline pg
-- client if the forward migration needs to be rolled back.
--
-- Safety: rolling back is safe ONLY after contract-sign has been
-- reverted to the pre-20260424000002 version. With the old code
-- deployed, no reader touches `related_project_ids`; dropping it is
-- lossless.
--
-- Rollback SEQUENCE:
--   1. Deploy a contract-sign bundle built against pre-hybrid-fix code
--      (the old version that only advances contract.project_id).
--   2. Run this script (psql or inline node/pg).
--   3. Delete the row from public._claude_migrations:
--      DELETE FROM public._claude_migrations WHERE version='20260424000002';
--
-- Post-rollback, Madyson's retainer project (6f34ddf1-...) will again
-- be orphaned — it will NOT auto-advance on sign. This is the pre-fix
-- baseline behavior. (Her current scheduled status persists — the
-- column-drop doesn't touch projects.status.)

BEGIN;

DROP TRIGGER IF EXISTS trg_contracts_related_project_ids_fk ON public.contracts;
DROP FUNCTION IF EXISTS public.validate_contracts_related_project_ids();

ALTER TABLE public.contracts DROP COLUMN IF EXISTS related_project_ids;

COMMIT;
