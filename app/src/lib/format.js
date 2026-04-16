/* Shared formatting utilities. Ported from the Sheepdog reference
 * project; same semantics for date + money parsing. */

export function fmtMoney(n) {
  if (n == null || n === '') return '—'
  return `$${parseFloat(n).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

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
  const raw = typeof d === 'string' && d.includes('T') ? d.split('T')[0] : d
  const [y, m, day] = String(raw).split('-').map(Number)
  const dt = new Date(y, m - 1, day)
  return dt.toLocaleDateString('en-US', opts)
}

export function fmtDateShort(d) {
  return fmtDate(d, { month: 'short', day: 'numeric' })
}

export function fmtDow(d) {
  if (!d) return ''
  const raw = typeof d === 'string' && d.includes('T') ? d.split('T')[0] : d
  const [y, m, day] = String(raw).split('-').map(Number)
  const dt = new Date(y, m - 1, day)
  return dt.toLocaleDateString('en-US', { weekday: 'long' })
}

export function daysUntil(d) {
  if (!d) return null
  const raw = typeof d === 'string' && d.includes('T') ? d.split('T')[0] : d
  const [y, m, day] = String(raw).split('-').map(Number)
  const exp = new Date(y, m - 1, day)
  const now = new Date(); now.setHours(0, 0, 0, 0)
  return Math.ceil((exp - now) / (1000 * 60 * 60 * 24))
}

export function daysSince(d) {
  if (!d) return null
  const raw = typeof d === 'string' && d.includes('T') ? d.split('T')[0] : d
  const [y, m, day] = String(raw).split('-').map(Number)
  const then = new Date(y, m - 1, day)
  const now = new Date(); now.setHours(0, 0, 0, 0)
  return Math.ceil((now - then) / (1000 * 60 * 60 * 24))
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
 * Return a hex string that plays well with badgeStyle. */
export function colorForInvoiceStatus(status) {
  switch (status) {
    case 'paid':            return COLORS.green
    case 'partially_paid':  return COLORS.amber
    case 'overdue':         return COLORS.red
    case 'pending':         return COLORS.amber
    case 'sent':            return COLORS.slate
    case 'void':            return COLORS.slate
    default:                return COLORS.steel
  }
}

export function colorForContractStatus(status) {
  switch (status) {
    case 'active':     return COLORS.green
    case 'signed':     return COLORS.green
    case 'sent':       return COLORS.amber
    case 'expired':    return COLORS.slate
    case 'terminated': return COLORS.red
    default:           return COLORS.steel
  }
}

export function colorForProjectStatus(status) {
  switch (status) {
    case 'active':    return COLORS.copper
    case 'complete':  return COLORS.green
    case 'paused':    return COLORS.amber
    case 'cancelled': return COLORS.red
    default:          return COLORS.steel
  }
}
