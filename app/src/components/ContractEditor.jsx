/**
 * ContractEditor — multi-step wizard for generating contracts from templates.
 *
 * Steps:
 *  1. Pick template + project → auto-fills variables
 *  2. Review variables + section toggles → editable form
 *  3. Live preview → save to contracts table
 *
 * On save: generates filled_html, creates/updates contract record with
 * field_values (jsonb) so the contract can be re-generated later if
 * variables change. Then the existing send-for-signing flow takes over.
 */

import { useState, useEffect, useMemo, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { TEMPLATES, buildVariables } from '../templates/index'
import Modal from './Modal'
import { TextField, SelectField } from './Field'

export default function ContractEditor({ onClose, onSaved }) {
  const [step, setStep] = useState(1)
  const [templateId, setTemplateId] = useState(null)
  const [projects, setProjects] = useState([])
  const [selectedProjectId, setSelectedProjectId] = useState('')
  const [vars, setVars] = useState({})
  const [toggles, setToggles] = useState({})
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  const template = TEMPLATES.find((t) => t.id === templateId)

  // Load projects with related data
  useEffect(() => {
    supabase
      .from('projects')
      .select(`
        *,
        brands (id, name, color, client_id,
          clients (id, name, legal_name, billing_email, payment_method,
            contacts:contact_id (id, name, email, phone)
          )
        ),
        retainer_services (id, number, name, description, cadence, quantity_per_period, sla_hours, platforms, active),
        deliverables (id, number, name, description, category, status)
      `)
      .order('name')
      .then(({ data }) => setProjects(data || []))
  }, [])

  // When project or template changes, rebuild variables
  useEffect(() => {
    if (!template || !selectedProjectId) return
    const project = projects.find((p) => p.id === selectedProjectId)
    if (!project) return
    const brand = project.brands
    const client = brand?.clients
    const contact = client?.contacts
    const newVars = buildVariables(project, {
      brand,
      client,
      contact,
      services: project.retainer_services,
      deliverables: project.deliverables,
    })
    setVars(newVars)
    setToggles({ ...template.defaultToggles })
  }, [selectedProjectId, templateId, projects, template])

  const setVar = (key) => (val) => setVars((v) => ({ ...v, [key]: val }))
  const setToggle = (key) => (val) => setToggles((t) => ({ ...t, [key]: val }))

  // Generate preview HTML
  const previewHTML = useMemo(() => {
    if (!template || !vars.brand_name) return ''
    try {
      return template.generate(vars, toggles)
    } catch (e) {
      return `<p style="color:red;">Template error: ${e.message}</p>`
    }
  }, [template, vars, toggles])

  // Filter projects to match selected template type
  const filteredProjects = useMemo(() => {
    if (!template) return projects
    return projects.filter((p) => p.type === template.type)
  }, [projects, template])

  const handleSave = async () => {
    setErr('')
    if (!previewHTML || !template) return
    setSaving(true)

    const project = projects.find((p) => p.id === selectedProjectId)
    const brand = project?.brands
    const client = brand?.clients
    const contact = client?.contacts

    const payload = {
      client_id: client?.id || null,
      brand_id: brand?.id || null,
      project_id: project?.id || null,
      name: `${vars.brand_name} ${template.id === 'retainer' ? 'Partnership Services Agreement' : 'Build-Out Services Agreement'}`,
      type: template.type,
      status: 'draft',
      effective_date: project?.start_date || null,
      end_date: project?.intro_term_end || project?.end_date || null,
      monthly_rate: template.type === 'retainer' ? project?.total_fee : null,
      total_fee: template.type === 'buildout' ? project?.total_fee : null,
      termination_fee: project?.total_fee || null,
      payment_terms: vars.payment_method,
      auto_renew: false,
      renewal_notice_days: 30,
      filled_html: previewHTML,
      signer_name: vars.client_name,
      signer_email: vars.client_email,
      field_values: { templateId: template.id, vars, toggles },
      notes: `Generated from template: ${template.name}`,
    }

    try {
      const { data, error } = await supabase.from('contracts').insert(payload).select().single()
      if (error) throw error
      onSaved(data, 'created')
      onClose()
    } catch (e) {
      setErr(e.message || String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      onClose={onClose}
      title={step === 1 ? 'New contract from template' : step === 2 ? 'Configure contract' : 'Preview & save'}
      width="large"
    >
      {/* Step 1: Template + Project picker */}
      {step === 1 && (
        <div className="editor-step">
          <div className="editor-section-label">Choose a template</div>
          <div className="template-cards">
            {TEMPLATES.map((t) => (
              <button
                key={t.id}
                className={`template-card ${templateId === t.id ? 'selected' : ''}`}
                onClick={() => {
                  setTemplateId(t.id)
                  setSelectedProjectId('')
                }}
              >
                <div className="template-card-name">{t.name}</div>
                <div className="template-card-sub">{t.subtitle}</div>
              </button>
            ))}
          </div>

          {templateId && (
            <>
              <div className="editor-section-label" style={{ marginTop: 24 }}>
                Pick a {template.type} project
              </div>
              <div className="project-picker">
                {filteredProjects.length === 0 ? (
                  <p style={{ color: 'var(--text-md)', fontSize: 13 }}>
                    No {template.type} projects found. Create one on the Projects page first.
                  </p>
                ) : (
                  <select
                    value={selectedProjectId}
                    onChange={(e) => setSelectedProjectId(e.target.value)}
                    className="project-select"
                  >
                    <option value="">Select a project…</option>
                    {filteredProjects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} — {p.brands?.name || '—'} — ${parseFloat(p.total_fee || 0).toLocaleString()}
                        {p.type === 'retainer' ? '/mo' : ''}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            </>
          )}

          <div className="editor-actions">
            <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button
              className="btn btn-primary"
              disabled={!templateId || !selectedProjectId}
              onClick={() => setStep(2)}
            >
              Next →
            </button>
          </div>
        </div>
      )}

      {/* Step 2: Variables + Toggles */}
      {step === 2 && (
        <div className="editor-step">
          <div className="editor-section-label">Variable fields (auto-filled, editable)</div>
          <div className="form-grid">
            <TextField id="brand_name" label="Brand name" value={vars.brand_name} onChange={setVar('brand_name')} />
            <TextField id="client_name" label="Client name" value={vars.client_name} onChange={setVar('client_name')} />
            <TextField id="client_title" label="Client title" span="full" value={vars.client_title} onChange={setVar('client_title')} />
            <TextField id="client_email" label="Client email" value={vars.client_email} onChange={setVar('client_email')} />
            <TextField id="effective_date" label="Effective date" value={vars.effective_date} onChange={setVar('effective_date')} />
            {template?.type === 'retainer' ? (
              <>
                <TextField id="monthly_rate" label="Monthly rate" value={vars.monthly_rate} onChange={setVar('monthly_rate')} />
                <TextField id="intro_term_months" label="Intro term length" value={vars.intro_term_months} onChange={setVar('intro_term_months')} hint='Shows as "three (3) months" in the contract' />
                <TextField id="intro_term_end" label="Intro term end date" value={vars.intro_term_end} onChange={setVar('intro_term_end')} />
                <TextField id="service_count" label="Number of services" value={vars.service_count} onChange={setVar('service_count')} hint='Shows as "nine (9) services" in the contract' />
              </>
            ) : (
              <>
                <TextField id="total_fee" label="Total fee" value={vars.total_fee} onChange={setVar('total_fee')} />
                <TextField id="timeline" label="Timeline" value={vars.timeline} onChange={setVar('timeline')} />
                <TextField id="deliverable_count" label="Number of deliverables" value={vars.deliverable_count} onChange={setVar('deliverable_count')} hint='Shows as "five (5) deliverables" in the contract' />
                <TextField id="per_deliverable_refund" label="Per-deliverable refund" value={vars.per_deliverable_refund} onChange={setVar('per_deliverable_refund')} />
              </>
            )}
            <TextField id="payment_method" label="Payment method" value={vars.payment_method} onChange={setVar('payment_method')} />
            <TextField id="governing_state" label="Governing state" value={vars.governing_state} onChange={setVar('governing_state')} />
            <TextField id="governing_county" label="Governing county" value={vars.governing_county} onChange={setVar('governing_county')} />
          </div>

          {template && (
            <>
              <div className="editor-section-label" style={{ marginTop: 24 }}>Optional sections</div>
              <div className="toggle-list">
                {Object.entries(template.toggleLabels).map(([key, label]) => (
                  <label key={key} className="toggle-row">
                    <input
                      type="checkbox"
                      checked={!!toggles[key]}
                      onChange={(e) => setToggle(key)(e.target.checked)}
                    />
                    <span>{label}</span>
                  </label>
                ))}
              </div>
            </>
          )}

          <div className="editor-actions">
            <button className="btn btn-secondary" onClick={() => setStep(1)}>← Back</button>
            <button className="btn btn-primary" onClick={() => setStep(3)}>Preview →</button>
          </div>
        </div>
      )}

      {/* Step 3: Preview */}
      {step === 3 && (
        <div className="editor-step">
          <div className="editor-section-label">Contract preview</div>
          <div className="contract-editor-preview" dangerouslySetInnerHTML={{ __html: previewHTML }} />

          {err && <div className="form-error">{err}</div>}

          <div className="editor-actions">
            <button className="btn btn-secondary" onClick={() => setStep(2)}>← Edit</button>
            <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
              {saving ? 'Saving…' : 'Save as draft contract'}
            </button>
          </div>
        </div>
      )}
    </Modal>
  )
}
