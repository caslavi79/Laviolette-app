/* Shared formatting utilities. Ported from the Sheepdog reference
 * project; same semantics for date + money parsing. */

export function fmtMoneyShort(n) {
  if (n == null || n === '') return '—'
  const v = parseFloat(n)
  if (Math.abs(v) >= 1000 && Math.round(v) === v) {
    return `$${v.toLocaleString()}`
  }
  return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function fmtDate(d, opts = { month: 'short', day: 'numeric', year: 'numeric' }) {
  if (!d) return '—'
  // If opts include time fields AND the input has a T (timestamp), use the full timestamp
  const hasTimeOpts = opts.hour || opts.minute || opts.second
  if (hasTimeOpts && typeof d === 'string' && d.includes('T')) {
    return new Date(d).toLocaleString('en-US', opts)
  }
  const raw = typeof d === 'string' && d.includes('T') ? d.split('T')[0] : d
  const [y, m, day] = String(raw).split('-').map(Number)
  const dt = new Date(y, m - 1, day)
  return dt.toLocaleDateString('en-US', opts)
}

export function daysUntil(d) {
  if (!d) return null
  const raw = typeof d === 'string' && d.includes('T') ? d.split('T')[0] : d
  const [y, m, day] = String(raw).split('-').map(Number)
  const exp = new Date(y, m - 1, day)
  const now = new Date(); now.setHours(0, 0, 0, 0)
  return Math.ceil((exp - now) / (1000 * 60 * 60 * 24))
}

export function badgeStyle(c) {
  return {
    display: 'inline-block',
    fontFamily: 'var(--label)',
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: '1.5px',
    textTransform: 'uppercase',
    color: c,
    background: `${c}22`,
    padding: '3px 10px',
    borderRadius: 3,
  }
}

export const COLORS = {
  copper: '#B8845A',
  green:  '#6E8F5A',
  amber:  '#C9922E',
  red:    '#C25A4E',
  navy:   '#1D2E4A',
  slate:  '#7A8490',
  steel:  '#929BAA',
}

/* Status → color helpers shared across pages.
 * Return a hex string that plays well with badgeStyle.
 *
 * 'processing' is a UI-derived pseudo-status for invoices whose DB status is
 * 'pending' but already have a stripe_payment_intent_id attached (charge in
 * flight, awaiting webhook confirmation). Copper signals "work is happening,
 * no operator action required" — distinct from pending's amber (charge your
 * invoice). Callers opt in by passing the derived label, not the raw column. */
export function colorForInvoiceStatus(status) {
  switch (status) {
    case 'paid':            return COLORS.green
    case 'partially_paid':  return COLORS.amber
    case 'overdue':         return COLORS.red
    case 'processing':      return COLORS.copper
    case 'pending':         return COLORS.amber
    case 'sent':            return COLORS.slate
    case 'draft':           return COLORS.steel
    case 'void':            return COLORS.slate
    default:                return COLORS.steel
  }
}

export function colorForContractStatus(status) {
  switch (status) {
    case 'active':     return COLORS.green
    case 'signed':     return COLORS.green
    case 'sent':       return COLORS.amber
    case 'draft':      return COLORS.steel
    case 'expired':    return COLORS.slate
    case 'terminated': return COLORS.red
    default:           return COLORS.steel
  }
}

/* Humanized display label for contract status. The raw enum has 'signed'
 * (post-sign, pre-effective-date) AND 'active' (effective-date reached,
 * cron-flipped by advance-contract-status) as separate states. For
 * operator-facing UI both read as "signed" — the internal advancement
 * matters for billing triggers, not for human comprehension. */
export function contractDisplayLabel(status) {
  if (status === 'active' || status === 'signed') return 'signed'
  return status
}

export function colorForProjectStatus(status) {
  switch (status) {
    case 'active':    return COLORS.copper
    case 'complete':  return COLORS.green
    case 'paused':    return COLORS.amber
    case 'cancelled': return COLORS.red
    case 'draft':     return COLORS.steel
    default:          return COLORS.steel
  }
}
