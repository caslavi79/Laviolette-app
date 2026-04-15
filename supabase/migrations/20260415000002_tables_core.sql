-- =============================================================
-- 20260415000002_tables_core.sql
-- Core three-tier model: contacts → clients → brands
-- =============================================================

-- ----- contacts -----
CREATE TABLE IF NOT EXISTS public.contacts (
  id                 uuid              PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text              NOT NULL CHECK (length(trim(name)) > 0),
  email              text,
  phone              text,
  preferred_contact  preferred_contact,
  status             party_status      NOT NULL DEFAULT 'lead',
  notes              text,
  created_at         timestamptz       NOT NULL DEFAULT now(),
  updated_at         timestamptz       NOT NULL DEFAULT now()
);

-- ----- clients -----
CREATE TABLE IF NOT EXISTS public.clients (
  id                    uuid              PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id            uuid              NOT NULL REFERENCES public.contacts(id) ON DELETE RESTRICT,
  name                  text              NOT NULL CHECK (length(trim(name)) > 0),
  legal_name            text,
  billing_email         text,
  billing_address       text,
  ein                   text,
  payment_method        payment_method    NOT NULL DEFAULT 'stripe_ach',
  stripe_customer_id    text,
  bank_info_on_file     boolean           NOT NULL DEFAULT false,
  status                party_status      NOT NULL DEFAULT 'lead',
  notes                 text,
  created_at            timestamptz       NOT NULL DEFAULT now(),
  updated_at            timestamptz       NOT NULL DEFAULT now()
);

-- Enforce uniqueness on stripe_customer_id when not null, to prevent accidental double-mapping
CREATE UNIQUE INDEX IF NOT EXISTS clients_stripe_customer_id_unique
  ON public.clients(stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;

-- ----- brands -----
CREATE TABLE IF NOT EXISTS public.brands (
  id                  uuid              PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id           uuid              NOT NULL REFERENCES public.clients(id) ON DELETE RESTRICT,
  name                text              NOT NULL CHECK (length(trim(name)) > 0),
  industry            text,
  location_city       text,
  location_state      text,
  website_url         text,
  gbp_url             text,
  instagram_handle    text,
  instagram_url       text,
  facebook_url        text,
  apple_maps_url      text,
  yelp_url            text,
  color               text              CHECK (color IS NULL OR color ~ '^#[0-9A-Fa-f]{6}$'),
  logo_path           text,
  status              brand_status      NOT NULL DEFAULT 'active',
  notes               text,
  created_at          timestamptz       NOT NULL DEFAULT now(),
  updated_at          timestamptz       NOT NULL DEFAULT now()
);
