-- REVERSE MIGRATION for 20260424000001_schedule_flexible_times.sql
--
-- **Do NOT move this file into supabase/migrations/ — the runner would
-- try to apply it forward.** Apply MANUALLY via `psql` or inline pg
-- client if the forward migration needs to be rolled back.
--
-- Restores: time_block enum + columns, (day_of_week, time_block)
-- UNIQUE on template, (date, time_block) UNIQUE on overrides. Derives
-- time_block from the new start_time value (09:00=morning, 12:00=
-- afternoon, 00:00=all_day). Any non-standard time will round to the
-- nearest enum bucket — if Case has already added blocks at custom
-- times before rollback, those will be lossy.
--
-- Drops the new columns + trigger + indexes. Post-rollback, the
-- schema is identical to pre-20260424000001 state EXCEPT the
-- overrides table retains `reason` (it was never removed forward).
--
-- Rollback SEQUENCE:
--   1. Deploy a frontend bundle built against pre-Schedule-v2 code.
--   2. Run this script (psql or inline node/pg).
--   3. Verify `SELECT enum_range(NULL::public.time_block)` returns
--      {all_day,morning,afternoon}.
--   4. Delete the row from public._claude_migrations:
--      DELETE FROM public._claude_migrations WHERE version='20260424000001';

BEGIN;

-- Recreate the enum type.
CREATE TYPE public.time_block AS ENUM ('all_day', 'morning', 'afternoon');

-- Add time_block columns back, nullable so we can backfill.
ALTER TABLE public.schedule_template  ADD COLUMN time_block public.time_block;
ALTER TABLE public.schedule_overrides ADD COLUMN time_block public.time_block;

-- Derive time_block from start_time (lossy for non-standard times).
UPDATE public.schedule_template
   SET time_block = CASE
                      WHEN start_time = TIME '00:00' THEN 'all_day'::public.time_block
                      WHEN start_time <  TIME '12:00' THEN 'morning'::public.time_block
                      ELSE 'afternoon'::public.time_block
                    END;

UPDATE public.schedule_overrides
   SET time_block = CASE
                      WHEN start_time = TIME '00:00' THEN 'all_day'::public.time_block
                      WHEN start_time <  TIME '12:00' THEN 'morning'::public.time_block
                      ELSE 'afternoon'::public.time_block
                    END;

ALTER TABLE public.schedule_template  ALTER COLUMN time_block SET NOT NULL;
ALTER TABLE public.schedule_overrides ALTER COLUMN time_block SET NOT NULL;

-- Restore old unique constraints.
CREATE UNIQUE INDEX schedule_template_day_block_unique
  ON public.schedule_template (day_of_week, time_block);

ALTER TABLE public.schedule_overrides
  ADD CONSTRAINT schedule_overrides_date_time_block_key
    UNIQUE (date, time_block);

-- Drop the new unique indexes.
DROP INDEX IF EXISTS public.schedule_template_day_start_unique;
DROP INDEX IF EXISTS public.schedule_overrides_date_start_unique;

-- Drop the new CHECK constraints.
ALTER TABLE public.schedule_template
  DROP CONSTRAINT IF EXISTS schedule_template_time_window_check;
ALTER TABLE public.schedule_overrides
  DROP CONSTRAINT IF EXISTS schedule_overrides_time_window_check,
  DROP CONSTRAINT IF EXISTS schedule_overrides_kind_check;

-- Drop the new trigger.
DROP TRIGGER IF EXISTS trg_schedule_overrides_set_updated_at
  ON public.schedule_overrides;

-- Drop the new columns.
ALTER TABLE public.schedule_template
  DROP COLUMN IF EXISTS start_time,
  DROP COLUMN IF EXISTS end_time,
  DROP COLUMN IF EXISTS notes;

ALTER TABLE public.schedule_overrides
  DROP COLUMN IF EXISTS start_time,
  DROP COLUMN IF EXISTS end_time,
  DROP COLUMN IF EXISTS notes,
  DROP COLUMN IF EXISTS kind,
  DROP COLUMN IF EXISTS updated_at;

COMMIT;
