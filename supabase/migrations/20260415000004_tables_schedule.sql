-- =============================================================
-- 20260415000004_tables_schedule.sql
-- Weekly schedule template, per-date overrides, and daily rounds.
-- =============================================================

-- ----- schedule_template -----
-- Repeating weekly pattern. One row per day_of_week + time_block.
CREATE TABLE IF NOT EXISTS public.schedule_template (
  id            uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  day_of_week   int          NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  time_block    time_block   NOT NULL,
  brand_id      uuid         REFERENCES public.brands(id) ON DELETE SET NULL,
  label         text,
  sort_order    int          NOT NULL DEFAULT 0,
  created_at    timestamptz  NOT NULL DEFAULT now(),
  updated_at    timestamptz  NOT NULL DEFAULT now()
);

-- One row per (day, time_block) at most — sort_order allows multiple only if truly needed.
-- Partial unique index lets us loosen this later without another migration.
CREATE UNIQUE INDEX IF NOT EXISTS schedule_template_day_block_unique
  ON public.schedule_template(day_of_week, time_block);

-- ----- schedule_overrides -----
-- Replace the template for a specific date.
CREATE TABLE IF NOT EXISTS public.schedule_overrides (
  id            uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  date          date         NOT NULL,
  time_block    time_block   NOT NULL,
  brand_id      uuid         REFERENCES public.brands(id) ON DELETE SET NULL,
  label         text,
  reason        text,
  created_at    timestamptz  NOT NULL DEFAULT now(),
  UNIQUE (date, time_block)
);

-- ----- daily_rounds -----
-- One row per (date, brand, platform). Generated at midnight for every brand
-- with an active retainer project.
CREATE TABLE IF NOT EXISTS public.daily_rounds (
  id               uuid             PRIMARY KEY DEFAULT gen_random_uuid(),
  date             date             NOT NULL,
  brand_id         uuid             NOT NULL REFERENCES public.brands(id) ON DELETE CASCADE,
  platform         rounds_platform  NOT NULL,
  status           rounds_status    NOT NULL DEFAULT 'pending',
  checked_at       timestamptz,
  response_count   int              NOT NULL DEFAULT 0 CHECK (response_count >= 0),
  notes            text,
  created_at       timestamptz      NOT NULL DEFAULT now(),
  UNIQUE (date, brand_id, platform)
);
