-- 20260424000002_contracts_related_projects.sql
--
-- PURPOSE
-- -------
-- Hybrid contracts (e.g. buildout + retainer under one sign event) today
-- only link to ONE project via `contracts.project_id`. Their "second"
-- project (e.g. the retainer) lives in the notes field and is invisible
-- to downstream lifecycle code. On sign, contract-sign advances only
-- `contract.project_id` out of 'draft'; the secondary project stays in
-- 'draft' and `advance-contract-status`/`generate-retainer-invoices`
-- skip it.
--
-- Fix: add `related_project_ids uuid[]` so a single contract can carry
-- any number of additional project links without re-shaping the whole
-- schema with a join table. contract-sign iterates this array on sign
-- and applies the same draft→scheduled|active transition logic it
-- already applies to `contract.project_id`.
--
-- MIGRATION PATTERN
-- -----------------
-- Additive, defaulted-empty column → backfill Madyson's retainer
-- project → validate-on-write trigger. No existing rows change shape
-- (all get `{}`). No FK array-validation pattern existed in prior
-- migrations (checked), so a BEFORE INSERT/UPDATE trigger is introduced
-- here as the idiomatic way to enforce referential integrity on an
-- array column (Postgres has no native array-FK).
--
-- REVERSAL
-- --------
-- Forward migration is safe to roll back via
-- `scripts/reverse-migrations/20260424000002_reverse.sql` once the
-- consumer (contract-sign) no longer reads the column. Column-drop is
-- lossless because the data here only *extends* status-advance behavior
-- that previously silently failed.

BEGIN;

-- ================================================================
-- (1) Add the column. NOT NULL + DEFAULT '{}' means zero impact on
-- existing rows — every contract immediately gets an empty array.
-- ================================================================

ALTER TABLE public.contracts
  ADD COLUMN IF NOT EXISTS related_project_ids uuid[] NOT NULL DEFAULT '{}';

-- ================================================================
-- (2) COMMENT ON COLUMN — follows the OPS convention of prose-heavy
-- docstrings explaining intent + consumer contract.
-- ================================================================

COMMENT ON COLUMN public.contracts.related_project_ids IS
  'Additional project ids linked by this contract beyond the primary contracts.project_id. Used for hybrid contracts (e.g. buildout + retainer under one sign event). contract-sign iterates this on sign to apply the same draft→scheduled|active project-status advance logic it applies to contract.project_id. Empty array for standard single-project contracts. Validated by trg_contracts_related_project_ids_fk on insert/update — every uuid must exist in public.projects.';

-- ================================================================
-- (3) Validate-on-write trigger. Postgres has no native FK-on-array,
-- so this is the equivalent: a BEFORE INSERT/UPDATE trigger that
-- rejects the row if any uuid in related_project_ids doesn't match a
-- real project. Self-reference (a contract listing its own
-- contract.project_id again) is also rejected to keep the semantic
-- clean — related_project_ids is strictly "projects BEYOND the
-- primary one."
-- ================================================================

CREATE OR REPLACE FUNCTION public.validate_contracts_related_project_ids()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  bad_id uuid;
BEGIN
  IF NEW.related_project_ids IS NULL OR array_length(NEW.related_project_ids, 1) IS NULL THEN
    RETURN NEW; -- empty array is the common case — skip the existence check
  END IF;

  -- Reject self-reference: the primary project_id must not also appear
  -- in related_project_ids (it'd double-advance on sign).
  IF NEW.project_id IS NOT NULL AND NEW.project_id = ANY(NEW.related_project_ids) THEN
    RAISE EXCEPTION 'contracts.related_project_ids must not contain contracts.project_id (%).', NEW.project_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- Reject any uuid that isn't a real project.
  SELECT rid INTO bad_id
    FROM unnest(NEW.related_project_ids) AS rid
   WHERE NOT EXISTS (SELECT 1 FROM public.projects p WHERE p.id = rid)
   LIMIT 1;
  IF bad_id IS NOT NULL THEN
    RAISE EXCEPTION 'contracts.related_project_ids contains unknown project id %.', bad_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_contracts_related_project_ids_fk ON public.contracts;
CREATE TRIGGER trg_contracts_related_project_ids_fk
  BEFORE INSERT OR UPDATE OF related_project_ids, project_id ON public.contracts
  FOR EACH ROW EXECUTE FUNCTION public.validate_contracts_related_project_ids();

COMMENT ON FUNCTION public.validate_contracts_related_project_ids() IS
  'Equivalent of an FK-on-array for contracts.related_project_ids. Rejects unknown project ids and self-reference (the primary project_id). Fires on INSERT and on any UPDATE that touches related_project_ids or project_id.';

-- ================================================================
-- (4) Madyson backfill. Her hybrid contract is
--     bfd7dea2-b34a-42f2-aeee-e8da4e9fff16 (buildout + retainer).
-- The retainer project id is 6f34ddf1-62cb-40ff-becc-24013b445da0.
-- Inline so the fix is atomic with the schema change.
-- ================================================================

UPDATE public.contracts
   SET related_project_ids = ARRAY['6f34ddf1-62cb-40ff-becc-24013b445da0'::uuid]
 WHERE id = 'bfd7dea2-b34a-42f2-aeee-e8da4e9fff16';

COMMIT;
