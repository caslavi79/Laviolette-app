-- =============================================================
-- 20260415000014_contracts_signing_columns.sql
-- Adds the 9 columns the contract signing flow needs that were
-- missing from the original contracts table definition.
-- These support: contract content storage, e-signature capture,
-- signing token for public URL, and template field storage.
-- =============================================================

-- Contract content (HTML rendered from template)
ALTER TABLE public.contracts ADD COLUMN IF NOT EXISTS filled_html text;

-- Signer identity
ALTER TABLE public.contracts ADD COLUMN IF NOT EXISTS signer_name text;
ALTER TABLE public.contracts ADD COLUMN IF NOT EXISTS signer_email text;

-- Signing token (public URL credential — UUID for unguessability)
ALTER TABLE public.contracts ADD COLUMN IF NOT EXISTS sign_token uuid DEFAULT gen_random_uuid() UNIQUE;

-- Signature capture
ALTER TABLE public.contracts ADD COLUMN IF NOT EXISTS signature_data text;
ALTER TABLE public.contracts ADD COLUMN IF NOT EXISTS signed_at timestamptz;
ALTER TABLE public.contracts ADD COLUMN IF NOT EXISTS signer_ip text;

-- Sent tracking
ALTER TABLE public.contracts ADD COLUMN IF NOT EXISTS sent_at timestamptz;

-- Template variables + toggles (for re-generation)
ALTER TABLE public.contracts ADD COLUMN IF NOT EXISTS field_values jsonb;

-- Comments
COMMENT ON COLUMN public.contracts.filled_html IS 'Full HTML contract content, rendered from template or pasted manually. This is what the client sees on the signing page.';
COMMENT ON COLUMN public.contracts.signer_name IS 'Name of the person signing (pre-filled from contact, confirmed at signing time).';
COMMENT ON COLUMN public.contracts.signer_email IS 'Email address for the signer (receives signing link + confirmation).';
COMMENT ON COLUMN public.contracts.sign_token IS 'UUID token used in the public signing URL. UNIQUE. Generated automatically.';
COMMENT ON COLUMN public.contracts.signature_data IS 'Base64 PNG of the captured signature image.';
COMMENT ON COLUMN public.contracts.signed_at IS 'Timestamp when the signature was submitted.';
COMMENT ON COLUMN public.contracts.signer_ip IS 'IP address of the signer at signing time (audit trail).';
COMMENT ON COLUMN public.contracts.sent_at IS 'Timestamp when the contract was emailed to the signer.';
COMMENT ON COLUMN public.contracts.field_values IS 'jsonb storing template variables + toggles used to generate this contract. Allows re-generation if terms change.';
