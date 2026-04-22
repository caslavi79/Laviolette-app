-- 20260423000001_work_log_sessions.sql
--
-- Log Work v2: add session grouping + time window to work_log.
--
-- Context (2026-04-22 plan — "reshape-log-work-and-schedule-ux"):
-- The LogWorkModal is being rewritten so Case can pick a time window
-- ("worked 9:00-11:15") and check multiple tasks he did during that
-- window. Each submit creates N rows (one per selected task) with a
-- shared session_id, started_at, ended_at, and notes.
--
-- Key design choice: KEEP performed_at. On insert it's set equal to
-- started_at. Every downstream consumer
-- (v_work_log_monthly view, generate-monthly-recaps edge fn, Today's
-- CT-boundary query, ActivityTab sort, Contacts BrandCard 30d query)
-- continues to use performed_at as the canonical timestamp. Zero
-- downstream query changes — sessions are invisible to the recap
-- aggregator (which groups by brand+service+month and sums count).
--
-- Backfill: zero rows in production today, so the new columns
-- simply start NULL-safe. Existing NULL-session rows are legal and
-- render as standalone entries in the UI.
--
-- Rollback: all three columns are nullable + additive. Safe to
-- DROP COLUMN after reverting the UI.

BEGIN;

ALTER TABLE public.work_log
  ADD COLUMN IF NOT EXISTS session_id uuid,
  ADD COLUMN IF NOT EXISTS started_at timestamptz,
  ADD COLUMN IF NOT EXISTS ended_at   timestamptz;

-- Window sanity: end >= start, within the existing +1h skew allowance
-- that performed_at already has (to tolerate clock drift).
ALTER TABLE public.work_log
  ADD CONSTRAINT work_log_time_window_check
  CHECK (
    (started_at IS NULL AND ended_at IS NULL)
    OR (
      started_at IS NOT NULL
      AND ended_at IS NOT NULL
      AND ended_at >= started_at
      AND ended_at <= now() + INTERVAL '1 hour'
    )
  );

-- session_id and started_at must co-vary — either both present
-- (session row) or both NULL (legacy/ad-hoc single-event row).
-- Belt-and-suspenders: the UI already enforces this invariant but
-- the CHECK defends against future callers that might forget.
ALTER TABLE public.work_log
  ADD CONSTRAINT work_log_session_coherence_check
  CHECK (
    (session_id IS NULL AND started_at IS NULL)
    OR (session_id IS NOT NULL AND started_at IS NOT NULL)
  );

-- Index for "fetch all rows in this session" (ActivityTab + future
-- delete-session flow). Partial index — no cost for legacy rows.
CREATE INDEX IF NOT EXISTS idx_work_log_session
  ON public.work_log (session_id)
  WHERE session_id IS NOT NULL;

COMMENT ON COLUMN public.work_log.session_id IS
  'Groups work_log rows logged together in a single session. NULL for legacy single-event rows. All rows sharing a session_id share started_at, ended_at, and notes.';

COMMENT ON COLUMN public.work_log.started_at IS
  'Session window start. When NULL (legacy single-event rows) performed_at alone is the timestamp. When non-NULL, the UI displays the row as part of a session window ("9:00-11:15 · Brand A").';

COMMENT ON COLUMN public.work_log.ended_at IS
  'Session window end. Co-varies with started_at — both or neither. CHECK ensures ended_at >= started_at and <= now() + 1h skew.';

COMMIT;
