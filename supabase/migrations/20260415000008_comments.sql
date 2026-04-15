-- =============================================================
-- 20260415000008_comments.sql
-- COMMENT ON for every table and column — so Claude Code (and any
-- other tool) can understand the schema via \d+ and information_schema.
-- =============================================================

-- =============== contacts ===============
COMMENT ON TABLE public.contacts IS
  'People Case communicates with. One contact can own multiple client entities (LLCs/businesses). Status tracks the overall relationship: lead → active → past.';
COMMENT ON COLUMN public.contacts.id IS 'Primary key, random UUID.';
COMMENT ON COLUMN public.contacts.name IS 'Full name. Required, non-empty.';
COMMENT ON COLUMN public.contacts.email IS 'Primary email for communication. Nullable.';
COMMENT ON COLUMN public.contacts.phone IS 'Phone number (free format, e.g. "(512) 555-1234").';
COMMENT ON COLUMN public.contacts.preferred_contact IS 'How this person prefers to be reached: phone, email, or text.';
COMMENT ON COLUMN public.contacts.status IS 'Relationship status. Default ''lead''. Transitions to ''active'' on first engagement and ''past'' when work concludes.';
COMMENT ON COLUMN public.contacts.notes IS 'Freeform notes about the person.';
COMMENT ON COLUMN public.contacts.created_at IS 'Row creation timestamp.';
COMMENT ON COLUMN public.contacts.updated_at IS 'Row last-updated timestamp. Maintained by trigger update_updated_at.';

-- =============== clients ===============
COMMENT ON TABLE public.clients IS
  'Legal entities (LLCs, DBAs) that sign contracts and pay invoices. One contact can own many clients. One client can have many brands. Invoices and contracts are issued to clients.';
COMMENT ON COLUMN public.clients.id IS 'Primary key, random UUID.';
COMMENT ON COLUMN public.clients.contact_id IS 'FK to contacts. ON DELETE RESTRICT — cannot delete a contact that owns clients.';
COMMENT ON COLUMN public.clients.name IS 'Display/short name (e.g. "VBTX Group").';
COMMENT ON COLUMN public.clients.legal_name IS 'Full legal name for contracts (e.g. "VBTX Group LLC").';
COMMENT ON COLUMN public.clients.billing_email IS 'Where invoices go; may differ from contact email.';
COMMENT ON COLUMN public.clients.billing_address IS 'Mailing address for the business.';
COMMENT ON COLUMN public.clients.ein IS 'Employer Identification Number. Nullable. Useful if a 1099 is ever issued.';
COMMENT ON COLUMN public.clients.payment_method IS 'Primary payment method. Default stripe_ach.';
COMMENT ON COLUMN public.clients.stripe_customer_id IS 'Stripe Customer ID once set up. UNIQUE when present.';
COMMENT ON COLUMN public.clients.bank_info_on_file IS 'Whether ACH bank details have been collected in Stripe for this client. Toggled true after the "Send Bank Connection Link" flow completes.';
COMMENT ON COLUMN public.clients.status IS 'Relationship status: lead/active/past.';
COMMENT ON COLUMN public.clients.notes IS 'Freeform client notes.';
COMMENT ON COLUMN public.clients.created_at IS 'Row creation timestamp.';
COMMENT ON COLUMN public.clients.updated_at IS 'Row last-updated timestamp.';

-- =============== brands ===============
COMMENT ON TABLE public.brands IS
  'Specific businesses or brands that receive the work. Projects, retainers, and daily rounds attach to brands. One brand belongs to one client; the money flows up to the client.';
COMMENT ON COLUMN public.brands.id IS 'Primary key, random UUID.';
COMMENT ON COLUMN public.brands.client_id IS 'FK to clients. ON DELETE RESTRICT.';
COMMENT ON COLUMN public.brands.name IS 'Brand name as it appears publicly.';
COMMENT ON COLUMN public.brands.industry IS 'Free-text industry tag: bar, restaurant, security, retail, real_estate, ecommerce, apparel, plumbing, healthcare, other.';
COMMENT ON COLUMN public.brands.location_city IS 'City where the business operates.';
COMMENT ON COLUMN public.brands.location_state IS 'State code or name.';
COMMENT ON COLUMN public.brands.website_url IS 'Brand website.';
COMMENT ON COLUMN public.brands.gbp_url IS 'Google Business Profile direct link.';
COMMENT ON COLUMN public.brands.instagram_handle IS 'Handle with or without @ (e.g. "@citrusandsalt").';
COMMENT ON COLUMN public.brands.instagram_url IS 'Full URL to the Instagram profile.';
COMMENT ON COLUMN public.brands.facebook_url IS 'Full URL to the Facebook page.';
COMMENT ON COLUMN public.brands.apple_maps_url IS 'Apple Maps listing URL.';
COMMENT ON COLUMN public.brands.yelp_url IS 'Yelp listing URL.';
COMMENT ON COLUMN public.brands.color IS 'Hex color (#RRGGBB) used as brand accent in the UI.';
COMMENT ON COLUMN public.brands.logo_path IS 'Supabase Storage path to the logo image (logos bucket).';
COMMENT ON COLUMN public.brands.status IS 'Operational status: active, paused, or offboarded.';
COMMENT ON COLUMN public.brands.notes IS 'Freeform brand notes.';
COMMENT ON COLUMN public.brands.created_at IS 'Row creation timestamp.';
COMMENT ON COLUMN public.brands.updated_at IS 'Row last-updated timestamp.';

-- =============== projects ===============
COMMENT ON TABLE public.projects IS
  'Engagements tied to a brand. A brand can have a buildout project, a retainer project, or both. Status drives alerts and what appears on the Today screen.';
COMMENT ON COLUMN public.projects.id IS 'Primary key, random UUID.';
COMMENT ON COLUMN public.projects.brand_id IS 'FK to brands. ON DELETE RESTRICT.';
COMMENT ON COLUMN public.projects.name IS 'Project name (e.g. "Citrus and Salt Buildout").';
COMMENT ON COLUMN public.projects.type IS 'buildout (fixed scope, one-time fee) or retainer (recurring monthly).';
COMMENT ON COLUMN public.projects.status IS 'Lifecycle: draft → active → paused/complete/cancelled.';
COMMENT ON COLUMN public.projects.total_fee IS 'Buildout: fixed total. Retainer: monthly rate. USD.';
COMMENT ON COLUMN public.projects.payment_structure IS 'Free-text: e.g. "due_at_signing", "split_60_40", "monthly_recurring_ach".';
COMMENT ON COLUMN public.projects.start_date IS 'Effective date from the contract.';
COMMENT ON COLUMN public.projects.end_date IS 'Buildout target completion or retainer intro term end. Nullable.';
COMMENT ON COLUMN public.projects.timeline IS 'Human-readable timeline (e.g. "2 weeks", "3-month intro term").';
COMMENT ON COLUMN public.projects.intro_term_end IS 'Retainer intro-rate lock expiration date.';
COMMENT ON COLUMN public.projects.briefing_md IS 'Auto-generated living markdown document describing current project state. Regenerated by trigger on child-table changes.';
COMMENT ON COLUMN public.projects.notes IS 'Freeform project notes, decisions, context.';
COMMENT ON COLUMN public.projects.created_at IS 'Row creation timestamp.';
COMMENT ON COLUMN public.projects.updated_at IS 'Row last-updated timestamp.';

-- =============== deliverables ===============
COMMENT ON TABLE public.deliverables IS
  'Numbered deliverables for a buildout project. When all are marked complete, a trigger auto-flips the parent project to status=complete.';
COMMENT ON COLUMN public.deliverables.id IS 'Primary key.';
COMMENT ON COLUMN public.deliverables.project_id IS 'FK to projects. ON DELETE CASCADE.';
COMMENT ON COLUMN public.deliverables.number IS 'Deliverable number from the contract (1, 2, 3...). UNIQUE per project.';
COMMENT ON COLUMN public.deliverables.category IS 'Category header from contract ("Brand Architecture", "Google Business", etc.).';
COMMENT ON COLUMN public.deliverables.name IS 'Deliverable name ("Color Palette", "Typography System").';
COMMENT ON COLUMN public.deliverables.description IS 'Full description from contract scope.';
COMMENT ON COLUMN public.deliverables.status IS 'not_started / in_progress / complete.';
COMMENT ON COLUMN public.deliverables.started_at IS 'When Case first started working on this. Nullable.';
COMMENT ON COLUMN public.deliverables.completed_at IS 'When marked complete. Nullable.';
COMMENT ON COLUMN public.deliverables.notes IS 'Work notes, client feedback, decisions, blockers.';
COMMENT ON COLUMN public.deliverables.sort_order IS 'Allows reordering if working out of numeric sequence.';
COMMENT ON COLUMN public.deliverables.created_at IS 'Row creation timestamp.';
COMMENT ON COLUMN public.deliverables.updated_at IS 'Row last-updated timestamp.';

-- =============== retainer_services ===============
COMMENT ON TABLE public.retainer_services IS
  'Individual recurring services within a retainer agreement. Each service has a cadence and optional quantity that drives task generation. Maps directly to the numbered service list in the retainer contract.';
COMMENT ON COLUMN public.retainer_services.id IS 'Primary key.';
COMMENT ON COLUMN public.retainer_services.project_id IS 'FK to projects (retainer). ON DELETE CASCADE.';
COMMENT ON COLUMN public.retainer_services.number IS 'Service number from the contract. UNIQUE per project.';
COMMENT ON COLUMN public.retainer_services.name IS 'Service name ("Instagram & Facebook Content", "Review Management").';
COMMENT ON COLUMN public.retainer_services.description IS 'Full description including SLA terms from contract.';
COMMENT ON COLUMN public.retainer_services.cadence IS 'daily / weekly / biweekly / monthly / quarterly / ongoing / as_needed.';
COMMENT ON COLUMN public.retainer_services.quantity_per_period IS 'e.g. 2 for "2 posts/week". Default 1.';
COMMENT ON COLUMN public.retainer_services.sla_hours IS 'For time-bound SLAs: "72 hours" = 72. Nullable.';
COMMENT ON COLUMN public.retainer_services.platforms IS 'Array of platforms this service touches: {instagram, facebook, gbp, yelp, apple_maps}.';
COMMENT ON COLUMN public.retainer_services.active IS 'False disables the service without removing it.';
COMMENT ON COLUMN public.retainer_services.notes IS 'Freeform service notes.';
COMMENT ON COLUMN public.retainer_services.created_at IS 'Row creation timestamp.';
COMMENT ON COLUMN public.retainer_services.updated_at IS 'Row last-updated timestamp.';

-- =============== retainer_tasks ===============
COMMENT ON TABLE public.retainer_tasks IS
  'Time-bounded tasks generated from retainer_services (weekly/monthly cadence). The Today screen reads from this table. ''behind'' / ''missed'' are derived at query time, not stored.';
COMMENT ON COLUMN public.retainer_tasks.id IS 'Primary key.';
COMMENT ON COLUMN public.retainer_tasks.retainer_service_id IS 'FK to retainer_services (parent service).';
COMMENT ON COLUMN public.retainer_tasks.brand_id IS 'Denormalized brand_id for fast queries on the Today screen.';
COMMENT ON COLUMN public.retainer_tasks.project_id IS 'Denormalized project_id.';
COMMENT ON COLUMN public.retainer_tasks.title IS 'Task label ("Post 1 of 2", "Monthly strategy session").';
COMMENT ON COLUMN public.retainer_tasks.description IS 'Optional longer description.';
COMMENT ON COLUMN public.retainer_tasks.period_type IS 'weekly or monthly.';
COMMENT ON COLUMN public.retainer_tasks.period_start IS 'Start of the week/month this task belongs to (date_trunc).';
COMMENT ON COLUMN public.retainer_tasks.period_end IS 'End of the period.';
COMMENT ON COLUMN public.retainer_tasks.assigned_date IS 'Which day inside the period it''s assigned to. Nullable.';
COMMENT ON COLUMN public.retainer_tasks.status IS 'pending / complete / skipped / deferred.';
COMMENT ON COLUMN public.retainer_tasks.completed_at IS 'When marked complete.';
COMMENT ON COLUMN public.retainer_tasks.notes IS 'Notes on execution.';
COMMENT ON COLUMN public.retainer_tasks.created_at IS 'Row creation timestamp.';

-- =============== project_files ===============
COMMENT ON TABLE public.project_files IS
  'File attachments on a project. Text-ish files (html/md/txt/json) expose a "Copy Contents" button in the UI. Files with is_briefing_file=true are appended to the Copy Briefing clipboard output.';
COMMENT ON COLUMN public.project_files.id IS 'Primary key.';
COMMENT ON COLUMN public.project_files.project_id IS 'FK to projects. ON DELETE CASCADE.';
COMMENT ON COLUMN public.project_files.name IS 'Display name.';
COMMENT ON COLUMN public.project_files.file_type IS 'File type hint: html, pdf, md, json, txt, png, jpg, etc.';
COMMENT ON COLUMN public.project_files.storage_path IS 'Path in the project-files Supabase Storage bucket.';
COMMENT ON COLUMN public.project_files.file_size_bytes IS 'Size in bytes (for display).';
COMMENT ON COLUMN public.project_files.description IS 'What this file is and when to use it.';
COMMENT ON COLUMN public.project_files.is_briefing_file IS 'If true, file contents are concatenated into the project briefing when Case taps "Copy Briefing to Clipboard".';
COMMENT ON COLUMN public.project_files.created_at IS 'Row creation timestamp.';

-- =============== schedule_template ===============
COMMENT ON TABLE public.schedule_template IS
  'Repeating weekly pattern: one row per day_of_week+time_block. brand_id NULL means flex. Overridden per-date by schedule_overrides.';
COMMENT ON COLUMN public.schedule_template.day_of_week IS '0=Sunday, 1=Monday, ..., 6=Saturday.';
COMMENT ON COLUMN public.schedule_template.time_block IS 'all_day, morning, or afternoon.';
COMMENT ON COLUMN public.schedule_template.brand_id IS 'FK to brands. NULL means flex/admin/off.';
COMMENT ON COLUMN public.schedule_template.label IS 'Override label like "Flex", "Admin", "Off".';
COMMENT ON COLUMN public.schedule_template.sort_order IS 'Ordering if multiple entries coexist for the same day.';

-- =============== schedule_overrides ===============
COMMENT ON TABLE public.schedule_overrides IS
  'Per-date override that replaces the template entry for that date+time_block. Used for "Sheepdog deadline — Tuesday override" or "taking the day off".';
COMMENT ON COLUMN public.schedule_overrides.date IS 'The specific date being overridden.';
COMMENT ON COLUMN public.schedule_overrides.time_block IS 'all_day, morning, or afternoon.';
COMMENT ON COLUMN public.schedule_overrides.brand_id IS 'FK to brands. NULL means flex.';
COMMENT ON COLUMN public.schedule_overrides.label IS 'Override label.';
COMMENT ON COLUMN public.schedule_overrides.reason IS 'Human-readable reason (e.g. "Sheepdog deadline").';

-- =============== daily_rounds ===============
COMMENT ON TABLE public.daily_rounds IS
  'One row per (date, brand, platform) for brands with active retainers. Case checks each platform for DMs / comments / reviews and responds. Generated fresh each day at midnight.';
COMMENT ON COLUMN public.daily_rounds.date IS 'Calendar date the round belongs to.';
COMMENT ON COLUMN public.daily_rounds.brand_id IS 'FK to brands. ON DELETE CASCADE.';
COMMENT ON COLUMN public.daily_rounds.platform IS 'instagram, facebook, gbp, yelp, apple_maps.';
COMMENT ON COLUMN public.daily_rounds.status IS 'pending / checked / skipped.';
COMMENT ON COLUMN public.daily_rounds.checked_at IS 'When Case marked the item checked.';
COMMENT ON COLUMN public.daily_rounds.response_count IS 'Number of reviews/DMs/comments responded to.';
COMMENT ON COLUMN public.daily_rounds.notes IS 'What happened: "Replied to 1-star review", "No new activity".';

-- =============== contracts ===============
COMMENT ON TABLE public.contracts IS
  'Signed and draft contracts. Status transitions: draft → sent → signed → active → (expired | terminated). A daily Edge Function auto-advances signed→active on effective_date and active→expired on end_date (unless auto_renew).';
COMMENT ON COLUMN public.contracts.client_id IS 'FK to clients. Where the invoice goes.';
COMMENT ON COLUMN public.contracts.brand_id IS 'FK to brands. Nullable if contract covers multiple brands.';
COMMENT ON COLUMN public.contracts.project_id IS 'FK to projects. Nullable if contract predates the project record.';
COMMENT ON COLUMN public.contracts.name IS 'Contract name ("Citrus and Salt Build-Out Agreement").';
COMMENT ON COLUMN public.contracts.type IS 'buildout or retainer.';
COMMENT ON COLUMN public.contracts.status IS 'Lifecycle state.';
COMMENT ON COLUMN public.contracts.effective_date IS 'When services begin.';
COMMENT ON COLUMN public.contracts.signing_date IS 'When both parties signed.';
COMMENT ON COLUMN public.contracts.end_date IS 'Retainer intro term end or buildout target completion. Nullable.';
COMMENT ON COLUMN public.contracts.monthly_rate IS 'For retainers. Nullable for buildouts.';
COMMENT ON COLUMN public.contracts.total_fee IS 'For buildouts. Nullable for retainers.';
COMMENT ON COLUMN public.contracts.termination_fee IS 'Amount owed if client terminates early.';
COMMENT ON COLUMN public.contracts.payment_terms IS '"Due at signing", "ACH on 1st of month", etc.';
COMMENT ON COLUMN public.contracts.auto_renew IS 'True = retainer continues after intro term automatically.';
COMMENT ON COLUMN public.contracts.renewal_notice_days IS 'Days before end_date to fire renewal alert. Default 30.';
COMMENT ON COLUMN public.contracts.file_path IS 'Supabase Storage path to the signed PDF (contracts bucket).';
COMMENT ON COLUMN public.contracts.draft_file_path IS 'Path to the pre-signing draft.';

-- =============== invoices ===============
COMMENT ON TABLE public.invoices IS
  'All money owed to or received by Laviolette LLC. Status lifecycle: draft → sent → pending → paid (or overdue/void/partially_paid). Monthly retainer invoices are auto-generated by an Edge Function on the 1st.';
COMMENT ON COLUMN public.invoices.client_id IS 'Who owes the money.';
COMMENT ON COLUMN public.invoices.project_id IS 'Tying invoice to a specific project (retainer or buildout).';
COMMENT ON COLUMN public.invoices.brand_id IS 'For display when invoice covers one brand.';
COMMENT ON COLUMN public.invoices.invoice_number IS 'Human-readable "LV-YYYY-NNN". UNIQUE.';
COMMENT ON COLUMN public.invoices.description IS 'One-line description ("Citrus and Salt Retainer — May 2026").';
COMMENT ON COLUMN public.invoices.line_items IS 'jsonb array of {description, amount}.';
COMMENT ON COLUMN public.invoices.subtotal IS 'Sum of line items before tax.';
COMMENT ON COLUMN public.invoices.tax IS 'Tax amount. Case does not charge tax, but the field exists.';
COMMENT ON COLUMN public.invoices.total IS 'What is actually owed.';
COMMENT ON COLUMN public.invoices.status IS 'Lifecycle state.';
COMMENT ON COLUMN public.invoices.due_date IS 'Due date.';
COMMENT ON COLUMN public.invoices.sent_date IS 'When invoice was sent to client.';
COMMENT ON COLUMN public.invoices.paid_date IS 'When payment was received.';
COMMENT ON COLUMN public.invoices.paid_amount IS 'For partial payments.';
COMMENT ON COLUMN public.invoices.payment_method IS 'How payment was received.';
COMMENT ON COLUMN public.invoices.stripe_invoice_id IS 'Stripe invoice ID if tracked there.';
COMMENT ON COLUMN public.invoices.stripe_payment_intent_id IS 'Stripe PaymentIntent ID.';
COMMENT ON COLUMN public.invoices.late_fee_applied IS 'Flag per contract terms: $100 late fee after 5 business days overdue. Does not auto-add to total; just tells Case to address.';
COMMENT ON COLUMN public.invoices.notes IS 'Freeform notes.';

-- =============== expenses ===============
COMMENT ON TABLE public.expenses IS
  'Business expenses, tagged by Schedule C category. Receipt images live in the receipts bucket. is_recurring=true flags monthly subscriptions for auto-generation on the 1st.';
COMMENT ON COLUMN public.expenses.category IS 'Maps to Schedule C line item via client-side lookup table.';
COMMENT ON COLUMN public.expenses.subcategory IS 'Optional finer tag.';
COMMENT ON COLUMN public.expenses.description IS 'What this expense is.';
COMMENT ON COLUMN public.expenses.vendor IS 'Who was paid (GoDaddy, Anthropic, ...).';
COMMENT ON COLUMN public.expenses.amount IS 'USD, two decimals.';
COMMENT ON COLUMN public.expenses.date IS 'Date of expense (not entry).';
COMMENT ON COLUMN public.expenses.receipt_path IS 'Supabase Storage path to receipt (receipts bucket).';
COMMENT ON COLUMN public.expenses.tax_deductible IS 'True = deduct on Schedule C.';
COMMENT ON COLUMN public.expenses.deduction_percentage IS 'Percent of amount deductible. Meals=50, home_office=33, most=100.';
COMMENT ON COLUMN public.expenses.client_id IS 'Expense attributed to a specific client (optional).';
COMMENT ON COLUMN public.expenses.brand_id IS 'Expense attributed to a specific brand (optional).';
COMMENT ON COLUMN public.expenses.is_recurring IS 'Monthly subscription template — copied to new month on the 1st.';
COMMENT ON COLUMN public.expenses.recurring_day IS 'Day of month to recur (1-31). Required when is_recurring=true.';

-- =============== lead_details ===============
COMMENT ON TABLE public.lead_details IS
  'Pipeline metadata for a contact who is still a lead. One row per contact (UNIQUE). Lost leads stay with their reason for history. Stale-lead thresholds are enforced by the check-stale-leads Edge Function.';
COMMENT ON COLUMN public.lead_details.contact_id IS 'FK to contacts. ON DELETE CASCADE. UNIQUE.';
COMMENT ON COLUMN public.lead_details.source IS 'Where the lead came from.';
COMMENT ON COLUMN public.lead_details.referred_by IS 'If source=referral: who referred them.';
COMMENT ON COLUMN public.lead_details.scope_summary IS 'Brief description of what they need.';
COMMENT ON COLUMN public.lead_details.deck_url IS 'Link to scope deck if one exists.';
COMMENT ON COLUMN public.lead_details.quoted_amount IS 'One-time fee quoted.';
COMMENT ON COLUMN public.lead_details.quoted_recurring IS 'Monthly retainer quoted.';
COMMENT ON COLUMN public.lead_details.temperature IS 'cold / warm / hot. Drives stale-alert thresholds.';
COMMENT ON COLUMN public.lead_details.stage IS 'initial_contact → discovery → quoted → negotiating → ready_to_sign → [CONVERT] or → lost.';
COMMENT ON COLUMN public.lead_details.next_step IS 'Human-readable next action.';
COMMENT ON COLUMN public.lead_details.next_follow_up IS 'Calendar date of next follow-up.';
COMMENT ON COLUMN public.lead_details.last_contact_date IS 'Last time Case reached out.';
COMMENT ON COLUMN public.lead_details.lost_reason IS 'If stage=lost: why (too expensive, went elsewhere, ghosted).';
