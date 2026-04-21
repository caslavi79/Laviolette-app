/**
 * Contract template registry.
 * Each entry describes a template that the ContractEditor can render.
 */

import { generateRetainerHTML, buildServicesTable } from './retainer.js'
import { generateBuildoutHTML, buildDeliverablesTable } from './buildout.js'

function monthsBetween(start, end) {
  if (!start || !end) return ''
  const s = new Date(start + 'T00:00:00')
  const e = new Date(end + 'T00:00:00')
  // Inclusive: May 1 → July 31 = 3 months (May, June, July)
  let months = (e.getFullYear() - s.getFullYear()) * 12 + (e.getMonth() - s.getMonth())
  if (e.getDate() >= 28) months += 1
  return months > 0 ? String(months) : '1'
}

function numberWord(n) {
  const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve']
  const num = parseInt(n, 10) || 0
  return num >= 0 && num < words.length ? `${words[num]} (${num})` : String(num)
}

function fmtDateLong(d) {
  if (!d) return '_______________'
  const [y, m, day] = d.split('-').map(Number)
  return new Date(y, m - 1, day).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
}

function fmtMoney(n) {
  const v = parseFloat(n) || 0
  return v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

const PAYMENT_LABELS = {
  stripe_ach: 'Automatic ACH',
  zelle: 'Zelle',
  check: 'Check',
  cash: 'Cash',
  other: 'As agreed',
}

/**
 * Build the full variables object from project + brand + client + contact data.
 * This auto-fills every field the template needs.
 */
export function buildVariables(project, { brand, client, contact, services, deliverables } = {}) {
  const isRetainer = project?.type === 'retainer'
  const fee = parseFloat(project?.total_fee) || 0
  const delCount = deliverables?.length || 0

  return {
    // Party info
    provider_name: 'Case Laviolette',
    provider_email: 'case.laviolette@gmail.com',
    // Provider signs electronically at contract-generation time (countersigned-
    // in-advance pattern). Client sees a pre-signed contract with their side
    // blank; their sign completes execution. Per ESIGN/UETA, intent to be bound
    // is demonstrated by generation + send, date-stamped here.
    provider_signed_date: fmtDateLong(new Date().toISOString().slice(0, 10)),
    client_name: contact?.name || client?.legal_name || client?.name || '',
    client_title: `Owner of ${brand?.name || ''}`,
    client_email: client?.billing_email || contact?.email || '',

    // Brand
    brand_name: brand?.name || '',

    // Money
    monthly_rate: isRetainer ? fmtMoney(fee) : '',
    total_fee: !isRetainer ? fmtMoney(fee) : '',

    // Dates
    effective_date: fmtDateLong(project?.start_date),
    intro_term_months: numberWord(monthsBetween(project?.start_date, project?.intro_term_end || project?.end_date)),
    intro_term_end: fmtDateLong(project?.intro_term_end || project?.end_date),

    // Payment
    payment_method: PAYMENT_LABELS[client?.payment_method] || client?.payment_method || 'ACH or agreed method',

    // Service / deliverable counts
    service_count: numberWord(services?.filter((s) => s.active !== false).length || 0),
    deliverable_count: numberWord(delCount),

    // Auto-generated tables
    services_table_html: buildServicesTable(services),
    deliverables_table_html: buildDeliverablesTable(deliverables),

    // Buildout-specific
    timeline: project?.timeline || '2 weeks',
    per_deliverable_refund: delCount > 0 ? fmtMoney(fee / delCount) : fmtMoney(0),
    scope_summary: '',

    // Legal
    governing_state: 'Texas',
    governing_county: 'Brazos County',
  }
}

export const TEMPLATES = [
  {
    id: 'retainer',
    name: 'Partnership Services Agreement',
    subtitle: 'Recurring retainer with monthly billing',
    type: 'retainer',
    generate: generateRetainerHTML,
    defaultToggles: {
      remote_systems: true,
      reporting: true,
      late_fees: true,
      rate_adjustments: true,
      pre_effective_termination: true,
    },
    toggleLabels: {
      remote_systems: '§5.5 Remote Systems Management',
      reporting: '§9 Reporting (quarterly performance reports)',
      late_fees: '§6.5 Late Payment Remedies ($100 fee + 2.5% interest)',
      rate_adjustments: '§3 Rate Adjustment clause (30-day notice)',
      pre_effective_termination: '§4.1 Pre-Effective Date protection (first month owed regardless)',
    },
  },
  {
    id: 'buildout',
    name: 'Build-Out Services Agreement',
    subtitle: 'Fixed scope, fixed fee, defined deliverables',
    type: 'buildout',
    generate: generateBuildoutHTML,
    defaultToggles: {
      late_fees: true,
      revisions: true,
      post_engagement: true,
    },
    toggleLabels: {
      late_fees: '§6.9 Late Payment Remedies ($100 fee + 2.5% interest)',
      revisions: '§5.3–5.4 Revisions & Change Orders + Deliverable Acceptance',
      post_engagement: '§6.7 Post-Engagement Services (no ongoing obligation)',
    },
  },
]
