-- =============================================================
-- 20260415000001_enums.sql
-- All enum types used by the Laviolette app schema.
-- Source of truth: app/app-laviolette-design-spec-v2.md
-- =============================================================

-- People / parties
DO $$ BEGIN
  CREATE TYPE preferred_contact AS ENUM ('phone', 'email', 'text');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE party_status AS ENUM ('lead', 'active', 'past');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE brand_status AS ENUM ('active', 'paused', 'offboarded');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE payment_method AS ENUM ('stripe_ach', 'zelle', 'check', 'cash', 'other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Projects
DO $$ BEGIN
  CREATE TYPE project_type AS ENUM ('buildout', 'retainer');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE project_status AS ENUM ('draft', 'active', 'paused', 'complete', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE deliverable_status AS ENUM ('not_started', 'in_progress', 'complete');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE retainer_cadence AS ENUM ('daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'ongoing', 'as_needed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE retainer_task_period AS ENUM ('weekly', 'monthly');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE retainer_task_status AS ENUM ('pending', 'complete', 'skipped', 'deferred');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Schedule
DO $$ BEGIN
  CREATE TYPE time_block AS ENUM ('all_day', 'morning', 'afternoon');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Daily rounds
DO $$ BEGIN
  CREATE TYPE rounds_platform AS ENUM ('instagram', 'facebook', 'gbp', 'yelp', 'apple_maps');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE rounds_status AS ENUM ('pending', 'checked', 'skipped');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Contracts
DO $$ BEGIN
  CREATE TYPE contract_type AS ENUM ('buildout', 'retainer');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE contract_status AS ENUM ('draft', 'sent', 'signed', 'active', 'expired', 'terminated');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Invoices
DO $$ BEGIN
  CREATE TYPE invoice_status AS ENUM ('draft', 'sent', 'pending', 'paid', 'overdue', 'void', 'partially_paid');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Expenses
DO $$ BEGIN
  CREATE TYPE expense_category AS ENUM (
    'software', 'domains', 'hosting', 'meals', 'home_office',
    'equipment', 'phone', 'supplies', 'travel', 'professional',
    'marketing', 'other'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Leads
DO $$ BEGIN
  CREATE TYPE lead_source AS ENUM ('referral', 'website_form', 'cold_outreach', 'instagram_dm', 'phone_call', 'other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE lead_temperature AS ENUM ('cold', 'warm', 'hot');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE lead_stage AS ENUM ('initial_contact', 'discovery', 'quoted', 'negotiating', 'ready_to_sign', 'lost');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
