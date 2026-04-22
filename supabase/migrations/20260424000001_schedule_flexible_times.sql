-- 20260424000001_schedule_flexible_times.sql
--
-- Schedule v2: replace the rigid time_block enum with concrete
-- start_time + end_time. Add `kind` classification to overrides
-- (focus | event | blackout) + add `notes` + `updated_at` trigger.
-- Keep the two-table structure (template = recurring weekly; overrides
-- = per-date exceptions). Agenda UI replaces the AM/PM/all-day grid.
--
-- Context (2026-04-22 plan — "reshape-log-work-and-schedule-ux"):
-- Case's current UI complaints: "What is override day?" / "Why can
-- I only choose morning or afternoon or full day?" / "I want it to
-- function more like an agenda." The rigidity is rooted in the
-- time_block enum + the override-replaces-all-day logic. This
-- migration fixes the former; the UI rewrite (Schedule.jsx v2)
-- fixes the latter.
--
-- Strategy: additive columns → backfill → SET NOT NULL → drop old
-- columns + enum. Multi-step inside one transaction so a partial
-- apply cannot leave the schema in a mixed state.
--
-- Live data at migration time:
--   schedule_template:  8 rows
--   schedule_overrides: 10 rows (all auto-classifiable via label/brand)
--
-- Rollback plan lives in:
--   scripts/reverse-migrations/20260424000001_reverse.sql
-- (not in supabase/migrations/ to prevent the runner from applying
-- it in the forward direction).

BEGIN;

-- ====================================================================
-- (1) Additive columns — nullable so existing rows remain legal.
-- ====================================================================

ALTER TABLE public.schedule_template
  ADD COLUMN IF NOT EXISTS start_time time,
  ADD COLUMN IF NOT EXISTS end_time   time,
  ADD COLUMN IF NOT EXISTS notes      text;

ALTER TABLE public.schedule_overrides
  ADD COLUMN IF NOT EXISTS start_time time,
  ADD COLUMN IF NOT EXISTS end_time   time,
  ADD COLUMN IF NOT EXISTS notes      text,
  ADD COLUMN IF NOT EXISTS kind       text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- ====================================================================
-- (2) Backfill start_time + end_time from time_block enum.
-- morning = 09:00-12:00, afternoon = 12:00-17:00, all_day = 00:00-23:59:59
-- ====================================================================

UPDATE public.schedule_template
   SET start_time = CASE time_block
                      WHEN 'morning'   THEN TIME '09:00'
                      WHEN 'afternoon' THEN TIME '12:00'
                      WHEN 'all_day'   THEN TIME '00:00'
                    END,
       end_time   = CASE time_block
                      WHEN 'morning'   THEN TIME '12:00'
                      WHEN 'afternoon' THEN TIME '17:00'
                      WHEN 'all_day'   THEN TIME '23:59:59'
                    END
 WHERE start_time IS NULL;

UPDATE public.schedule_overrides
   SET start_time = CASE time_block
                      WHEN 'morning'   THEN TIME '09:00'
                      WHEN 'afternoon' THEN TIME '12:00'
                      WHEN 'all_day'   THEN TIME '00:00'
                    END,
       end_time   = CASE time_block
                      WHEN 'morning'   THEN TIME '12:00'
                      WHEN 'afternoon' THEN TIME '17:00'
                      WHEN 'all_day'   THEN TIME '23:59:59'
                    END
 WHERE start_time IS NULL;

-- ====================================================================
-- (3) Auto-classify kind on overrides.
--
-- Heuristic:
--   - brand_id NOT NULL → 'focus' (a specific brand's time block; deep-
--     work pattern — Case's most common override use).
--   - Off/blackout reason or label → 'blackout' (out-of-office, day off).
--   - Else → 'event' (one-off meeting/appointment with no brand tied).
--
-- Case can reclassify any row via the UI modal after migration.
-- ====================================================================

UPDATE public.schedule_overrides
   SET kind = CASE
                WHEN brand_id IS NOT NULL THEN 'focus'
                WHEN COALESCE(reason, '') ILIKE '%off%'
                  OR COALESCE(reason, '') ILIKE '%blackout%'
                  OR COALESCE(label, '')  ILIKE 'off%'
                  THEN 'blackout'
                ELSE 'event'
              END
 WHERE kind IS NULL;

-- Populate the new `notes` column from `reason` as a bridge. `reason`
-- stays as a column for now (non-breaking) — dropped in a follow-up
-- migration once Case confirms notes is the preferred narrative field.
UPDATE public.schedule_overrides
   SET notes = reason
 WHERE notes IS NULL AND reason IS NOT NULL AND reason <> '';

-- ====================================================================
-- (4) Tighten NOT NULL after backfill.
-- ====================================================================

ALTER TABLE public.schedule_template
  ALTER COLUMN start_time SET NOT NULL,
  ALTER COLUMN end_time   SET NOT NULL;

ALTER TABLE public.schedule_overrides
  ALTER COLUMN start_time SET NOT NULL,
  ALTER COLUMN end_time   SET NOT NULL,
  ALTER COLUMN kind       SET NOT NULL;

-- ====================================================================
-- (5) CHECK constraints: time-window sanity + kind domain.
-- ====================================================================

ALTER TABLE public.schedule_template
  ADD CONSTRAINT schedule_template_time_window_check
    CHECK (end_time > start_time);

ALTER TABLE public.schedule_overrides
  ADD CONSTRAINT schedule_overrides_time_window_check
    CHECK (end_time > start_time),
  ADD CONSTRAINT schedule_overrides_kind_check
    CHECK (kind IN ('focus', 'event', 'blackout'));

-- ====================================================================
-- (6) Drop old enum-based UNIQUE constraints.
-- ====================================================================

DROP INDEX IF EXISTS public.schedule_template_day_block_unique;
ALTER TABLE public.schedule_overrides
  DROP CONSTRAINT IF EXISTS schedule_overrides_date_time_block_key;

-- ====================================================================
-- (7) Drop time_block columns from both tables.
-- ====================================================================

ALTER TABLE public.schedule_template  DROP COLUMN IF EXISTS time_block;
ALTER TABLE public.schedule_overrides DROP COLUMN IF EXISTS time_block;

-- ====================================================================
-- (8) Drop the time_block enum type (no remaining users).
-- ====================================================================

DROP TYPE IF EXISTS public.time_block;

-- ====================================================================
-- (9) New UNIQUE indexes — allow multiple blocks per day, reject
-- accidental double-click duplicates at exact start_time collision.
-- ====================================================================

CREATE UNIQUE INDEX IF NOT EXISTS schedule_template_day_start_unique
  ON public.schedule_template (day_of_week, start_time);

CREATE UNIQUE INDEX IF NOT EXISTS schedule_overrides_date_start_unique
  ON public.schedule_overrides (date, start_time);

-- ====================================================================
-- (10) updated_at trigger on schedule_overrides (was missing entirely
-- — latent bug; overrides had no audit trail on label/notes edits).
-- ====================================================================

DROP TRIGGER IF EXISTS trg_schedule_overrides_set_updated_at
  ON public.schedule_overrides;

CREATE TRIGGER trg_schedule_overrides_set_updated_at
  BEFORE UPDATE ON public.schedule_overrides
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ====================================================================
-- (11) Comments on the new columns.
-- ====================================================================

COMMENT ON COLUMN public.schedule_template.start_time IS
  'Local-time start of this recurring block (America/Chicago). No timezone on the column — the schedule is calendar-local so it does not shift when DST changes. Any TZ-dependent query logic lives in the caller.';
COMMENT ON COLUMN public.schedule_template.end_time IS
  'Local-time end. CHECK (end_time > start_time) — no zero-duration blocks.';
COMMENT ON COLUMN public.schedule_template.notes IS
  'Freeform narrative for a recurring block (e.g., "Social posts + review replies"). Renders in the detail pane.';

COMMENT ON COLUMN public.schedule_overrides.start_time IS
  'Local-time start of this override (America/Chicago).';
COMMENT ON COLUMN public.schedule_overrides.end_time IS
  'Local-time end. CHECK (end_time > start_time).';
COMMENT ON COLUMN public.schedule_overrides.kind IS
  'event = one-off meeting/appointment (no brand needed); focus = deep-work block for a specific brand; blackout = no-work window (OOO, holiday). Blackouts hide overlapping template blocks when they fully cover the template''s time range.';
COMMENT ON COLUMN public.schedule_overrides.notes IS
  'Freeform narrative for this override. Replaces `reason` as the primary field; `reason` kept as a column until a follow-up migration drops it.';
COMMENT ON COLUMN public.schedule_overrides.updated_at IS
  'BEFORE UPDATE trigger trg_schedule_overrides_set_updated_at keeps this current. Added 2026-04-22 migration 20260424000001 — overrides previously had no updated_at column.';

COMMENT ON TABLE public.schedule_overrides IS
  'Date-specific exceptions to the weekly template. Each row is one event/focus/blackout on a specific date. Overrides OVERLAY on top of the template — they no longer "replace the entire day" (old pre-2026-04-22 behavior). Schedule.jsx resolves template + overrides by kind: blackouts hide fully-overlapping template blocks; focus/event layer on top and dim overlapping template visually. See app/src/pages/Schedule.jsx resolvedBlocks() for the exact merge semantics.';

COMMIT;
