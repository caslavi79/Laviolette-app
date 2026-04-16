import { useState } from 'react'
import Modal from '../Modal'
import { TextField, TextareaField, SelectField } from '../Field'
import { supabase } from '../../lib/supabase'

const STATUS_OPTS = [
  { value: 'active', label: 'Active' },
  { value: 'paused', label: 'Paused' },
  { value: 'offboarded', label: 'Offboarded' },
]
const INDUSTRY_OPTS = [
  { value: '', label: '—' },
  { value: 'bar', label: 'Bar' },
  { value: 'restaurant', label: 'Restaurant' },
  { value: 'security', label: 'Security' },
  { value: 'retail', label: 'Retail' },
  { value: 'real_estate', label: 'Real Estate' },
  { value: 'ecommerce', label: 'E-Commerce' },
  { value: 'apparel', label: 'Apparel' },
  { value: 'plumbing', label: 'Plumbing' },
  { value: 'healthcare', label: 'Healthcare' },
  { value: 'other', label: 'Other' },
]

export default function EditBrandModal({ clientId, brand, onClose, onSaved }) {
  const isNew = !brand?.id
  const [form, setForm] = useState({
    name: brand?.name || '',
    industry: brand?.industry || '',
    location_city: brand?.location_city || '',
    location_state: brand?.location_state || '',
    website_url: brand?.website_url || '',
    gbp_url: brand?.gbp_url || '',
    instagram_handle: brand?.instagram_handle || '',
    instagram_url: brand?.instagram_url || '',
    facebook_url: brand?.facebook_url || '',
    apple_maps_url: brand?.apple_maps_url || '',
    yelp_url: brand?.yelp_url || '',
    color: brand?.color || '#B8845A',
    status: brand?.status || 'active',
    notes: brand?.notes || '',
  })
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const set = (key) => (value) => setForm((f) => ({ ...f, [key]: value }))

  const handleSubmit = async (e) => {
    e.preventDefault()
    setErr('')
    if (!form.name.trim()) { setErr('Name is required.'); return }
    if (form.color && !/^#[0-9A-Fa-f]{6}$/.test(form.color)) {
      setErr('Color must be a 6-char hex like #B8845A.')
      return
    }
    setBusy(true)
    const payload = {
      name: form.name.trim(),
      industry: form.industry || null,
      location_city: form.location_city.trim() || null,
      location_state: form.location_state.trim() || null,
      website_url: form.website_url.trim() || null,
      gbp_url: form.gbp_url.trim() || null,
      instagram_handle: form.instagram_handle.trim() || null,
      instagram_url: form.instagram_url.trim() || null,
      facebook_url: form.facebook_url.trim() || null,
      apple_maps_url: form.apple_maps_url.trim() || null,
      yelp_url: form.yelp_url.trim() || null,
      color: form.color.trim() || null,
      status: form.status,
      notes: form.notes.trim() || null,
    }
    try {
      if (isNew) {
        const { data, error } = await supabase
          .from('brands')
          .insert({ ...payload, client_id: clientId })
          .select()
          .single()
        if (error) throw error
        onSaved(data, 'created')
      } else {
        const { data, error } = await supabase
          .from('brands')
          .update(payload)
          .eq('id', brand.id)
          .select()
          .single()
        if (error) throw error
        onSaved(data, 'updated')
      }
      onClose()
    } catch (e) {
      setErr(e.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async () => {
    if (!window.confirm('Delete this brand? This cannot be undone. (Only works if no projects attached.)')) return
    setErr(''); setBusy(true)
    try {
      const { error } = await supabase.from('brands').delete().eq('id', brand.id)
      if (error) throw error
      onSaved({ id: brand.id }, 'deleted')
      onClose()
    } catch (e) {
      setErr(e.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      onClose={onClose}
      title={isNew ? 'Add brand' : `Edit ${brand.name}`}
      width="medium"
    >
      <form onSubmit={handleSubmit} className="form-grid">
        <TextField id="name" label="Brand name" span="full" required value={form.name} onChange={set('name')} placeholder="Citrus and Salt" autoFocus />
        <SelectField id="industry" label="Industry" value={form.industry} onChange={set('industry')} options={INDUSTRY_OPTS.slice(1)} placeholder="—" />
        <SelectField id="status" label="Status" value={form.status} onChange={set('status')} options={STATUS_OPTS} />
        <TextField id="location_city" label="City" value={form.location_city} onChange={set('location_city')} />
        <TextField id="location_state" label="State" value={form.location_state} onChange={set('location_state')} placeholder="TX" />
        <TextField id="website_url" type="url" label="Website URL" span="full" value={form.website_url} onChange={set('website_url')} placeholder="https://…" />
        <TextField id="instagram_handle" label="Instagram @handle" value={form.instagram_handle} onChange={set('instagram_handle')} placeholder="@citrusandsalt" />
        <TextField id="instagram_url" type="url" label="Instagram URL" value={form.instagram_url} onChange={set('instagram_url')} />
        <TextField id="facebook_url" type="url" label="Facebook URL" value={form.facebook_url} onChange={set('facebook_url')} />
        <TextField id="gbp_url" type="url" label="Google Business URL" value={form.gbp_url} onChange={set('gbp_url')} />
        <TextField id="apple_maps_url" type="url" label="Apple Maps URL" value={form.apple_maps_url} onChange={set('apple_maps_url')} />
        <TextField id="yelp_url" type="url" label="Yelp URL" value={form.yelp_url} onChange={set('yelp_url')} />
        <div className="field field--color">
          <label htmlFor="color">Color</label>
          <div className="color-row">
            <input id="color" type="color" value={form.color || '#B8845A'} onChange={(e) => set('color')(e.target.value)} />
            <input type="text" value={form.color || ''} onChange={(e) => set('color')(e.target.value)} placeholder="#B8845A" />
          </div>
        </div>
        <TextareaField id="notes" label="Notes" value={form.notes} onChange={set('notes')} />
        {err && <div className="form-error" style={{ gridColumn: '1 / -1' }}>{err}</div>}
        <div className="form-actions">
          {!isNew && <button type="button" className="btn btn-danger-link" onClick={handleDelete} disabled={busy}>Delete</button>}
          <div style={{ flex: 1 }} />
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : isNew ? 'Add brand' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  )
}
