// Monthly recap shared module. Owns:
//   1. Aggregation of work_log rows → summary_json
//   2. Email subject formatting
//   3. Client-facing HTML render (Laviolette-branded, system-font,
//      cream background, copper accents — matches laviolette.io,
//      intentionally distinct from the dark internal dashboard
//      aesthetic and from the black-on-white contract style).
//   4. HQ alert HTML for "N drafts ready for review"
//
// Kept isolated from _shared/client-emails.ts so no payment-email
// code paths are touched.

export type RecapHighlight = {
  title: string
  performed_at: string   // ISO or YYYY-MM-DD
  link_url: string | null
}

export type RecapServiceBucket = {
  service_id: string | null
  service_name: string
  total_count: number
  entry_count: number
  highlights: RecapHighlight[]
}

export type RecapSummary = {
  brand_name: string
  month_label: string   // "May 2026"
  month_iso: string     // "2026-05-01"
  total_entries: number
  total_count: number
  services: RecapServiceBucket[]
  general: {
    entry_count: number
    total_count: number
    highlights: RecapHighlight[]
  }
  zero_activity: boolean
}

export type WorkLogRow = {
  id: string
  title: string
  notes: string | null
  link_url: string | null
  performed_at: string
  service_id: string | null
  count: number
}

export type ServiceMeta = { id: string; name: string }

/**
 * Aggregate work_log rows for a single brand+month into the
 * `summary_json` shape. Sorts services by total_count DESC so the
 * loudest buckets render first. Trims each bucket to the top 5
 * highlights by count-then-recency.
 */
export function buildRecapSummary(args: {
  brandName: string
  monthIso: string                 // "2026-05-01"
  rows: WorkLogRow[]
  services: ServiceMeta[]
  maxHighlights?: number
}): RecapSummary {
  const maxHi = args.maxHighlights ?? 5
  const monthLabel = new Date(`${args.monthIso}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'long', year: 'numeric', timeZone: 'UTC',
  })

  const bySvc = new Map<string, RecapServiceBucket>()
  for (const s of args.services) {
    bySvc.set(s.id, {
      service_id: s.id,
      service_name: s.name,
      total_count: 0,
      entry_count: 0,
      highlights: [],
    })
  }

  let generalEntryCount = 0
  let generalTotalCount = 0
  const generalHighlights: RecapHighlight[] = []
  let totalEntries = 0
  let totalCount = 0

  for (const r of args.rows) {
    const c = Number(r.count) || 1
    totalEntries++
    totalCount += c
    const hi: RecapHighlight = {
      title: r.title,
      performed_at: String(r.performed_at).slice(0, 10),
      link_url: r.link_url,
    }
    if (r.service_id && bySvc.has(r.service_id)) {
      const bucket = bySvc.get(r.service_id)!
      bucket.entry_count++
      bucket.total_count += c
      bucket.highlights.push(hi)
    } else {
      generalEntryCount++
      generalTotalCount += c
      generalHighlights.push(hi)
    }
  }

  // Order service buckets by total_count DESC, drop empty ones.
  const services = [...bySvc.values()]
    .filter((b) => b.entry_count > 0)
    .sort((a, b) => b.total_count - a.total_count || b.entry_count - a.entry_count)

  // Trim each bucket's highlights. Prefer most recent (performed_at DESC).
  for (const b of services) {
    b.highlights.sort((x, y) => y.performed_at.localeCompare(x.performed_at))
    b.highlights = b.highlights.slice(0, maxHi)
  }
  generalHighlights.sort((x, y) => y.performed_at.localeCompare(x.performed_at))
  const generalTrimmed = generalHighlights.slice(0, maxHi)

  return {
    brand_name: args.brandName,
    month_label: monthLabel,
    month_iso: args.monthIso,
    total_entries: totalEntries,
    total_count: totalCount,
    services,
    general: {
      entry_count: generalEntryCount,
      total_count: generalTotalCount,
      highlights: generalTrimmed,
    },
    zero_activity: totalEntries === 0,
  }
}

export function buildRecapSubject(brandName: string, monthLabel: string): string {
  return `${brandName} — ${monthLabel} recap`
}

function esc(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

function fmtEntryDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

/**
 * Pluralize a service-bucket line. The bucket has both an entry count
 * (rows) and a total_count (sum of `count` across rows). When they
 * agree or total_count==1 we render a single human phrase; otherwise
 * we show both — "12 posts (8 entries)" — so the client sees the
 * quantitative output AND that multiple batches were logged.
 */
function bucketLeadLine(name: string, entryCount: number, totalCount: number): string {
  const noun = inferNoun(name)
  if (totalCount === entryCount || totalCount <= 1) {
    return `${totalCount} ${pluralize(noun, totalCount)}`
  }
  return `${totalCount} ${pluralize(noun, totalCount)} <span style="color:#7a7567;font-weight:400;">(${entryCount} ${pluralize('entry', entryCount)})</span>`
}

function inferNoun(serviceName: string): string {
  const n = serviceName.toLowerCase()
  if (/post|content|social/.test(n)) return 'post'
  if (/review/.test(n)) return 'review response'
  if (/gbp|google/.test(n)) return 'update'
  if (/seo|content\s*update/.test(n)) return 'update'
  if (/event|menu/.test(n)) return 'update'
  if (/strategy|planning/.test(n)) return 'session'
  if (/host|maint/.test(n)) return 'task'
  if (/remote|system/.test(n)) return 'task'
  return 'item'
}

function pluralize(noun: string, n: number): string {
  if (n === 1) return noun
  if (noun === 'entry') return 'entries'
  if (noun.endsWith('y')) return noun.slice(0, -1) + 'ies'
  if (noun.endsWith('s') || noun.endsWith('x') || noun.endsWith('ch') || noun.endsWith('sh')) return noun + 'es'
  return noun + 's'
}

function highlightLi(h: RecapHighlight): string {
  const dateStr = esc(fmtEntryDate(h.performed_at))
  const title = esc(h.title)
  if (h.link_url) {
    const url = esc(h.link_url)
    return `<li style="margin:6px 0;line-height:1.5;"><strong>${title}</strong> <span style="color:#7a7567;">— ${dateStr}</span> <a href="${url}" style="color:#b87333;text-decoration:none;">view ↗</a></li>`
  }
  return `<li style="margin:6px 0;line-height:1.5;"><strong>${title}</strong> <span style="color:#7a7567;">— ${dateStr}</span></li>`
}

function section(name: string, leadLine: string, highlights: RecapHighlight[]): string {
  const lis = highlights.map(highlightLi).join('')
  return `
    <div style="margin:28px 0;">
      <h3 style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:15px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;color:#3a3733;margin:0 0 6px;">${esc(name)}</h3>
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:22px;font-weight:600;color:#b87333;margin:0 0 10px;">${leadLine}</div>
      <ul style="list-style:disc;padding-left:20px;margin:0;color:#1a1816;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:14px;">${lis}</ul>
    </div>
  `
}

/**
 * Render the client-facing recap HTML. Cream bg + copper accents,
 * system font stack, 600px max-width, single column. Intentionally
 * typographic-only — no logos, no images.
 */
export function renderRecapHtml(summary: RecapSummary): string {
  const sections: string[] = []
  for (const s of summary.services) {
    sections.push(section(
      s.service_name,
      bucketLeadLine(s.service_name, s.entry_count, s.total_count),
      s.highlights,
    ))
  }
  if (summary.general.entry_count > 0) {
    sections.push(section(
      'General',
      `${summary.general.total_count} ${pluralize('item', summary.general.total_count)}${summary.general.total_count !== summary.general.entry_count ? ` <span style="color:#7a7567;font-weight:400;">(${summary.general.entry_count} ${pluralize('entry', summary.general.entry_count)})</span>` : ''}`,
      summary.general.highlights,
    ))
  }

  const body = summary.zero_activity
    ? `<p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:15px;line-height:1.6;color:#1a1816;">No activity was logged for ${esc(summary.brand_name)} in ${esc(summary.month_label)}. If you know of work that wasn't captured here, let me know and I'll update this.</p>`
    : `<p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:15px;line-height:1.6;color:#1a1816;margin:0 0 20px;">Here's everything that moved for <strong>${esc(summary.brand_name)}</strong> in <strong>${esc(summary.month_label)}</strong>.</p>${sections.join('')}`

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(summary.brand_name)} — ${esc(summary.month_label)} recap</title>
</head>
<body style="margin:0;padding:0;background:#fafaf7;">
  <div style="max-width:600px;margin:0 auto;padding:40px 24px;background:#fafaf7;">
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:11px;letter-spacing:0.24em;font-weight:600;color:#b87333;margin:0 0 8px;">LAVIOLETTE</div>
    <h1 style="font-family:'Playfair Display',Georgia,serif;font-size:32px;font-weight:500;color:#1a1816;margin:0 0 4px;line-height:1.15;">${esc(summary.brand_name)}</h1>
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:13px;letter-spacing:0.14em;text-transform:uppercase;color:#7a7567;margin:0 0 28px;">${esc(summary.month_label)} recap</div>
    <hr style="border:0;border-top:1px solid #e6e1d6;margin:0 0 24px;">
    ${body}
    <hr style="border:0;border-top:1px solid #e6e1d6;margin:36px 0 18px;">
    <p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:13px;color:#5a5650;line-height:1.6;margin:0;">
      Questions? Text or call me directly. — Case<br>
      <a href="tel:+15123509124" style="color:#b87333;text-decoration:none;">(512) 350-9124</a>
    </p>
  </div>
</body>
</html>`
}

/** HQ alert when N drafts are ready for review. Dark aesthetic to
 * match the rest of the internal notification stack — visually
 * distinct from the cream client-facing recap above. */
export function renderDraftsReadyHtml(args: {
  draftCount: number
  monthLabel: string
  drafts: Array<{ brand_name: string; month_iso: string; recap_id: string; project_id: string; zero_activity: boolean }>
  appUrl: string
}): string {
  const rows = args.drafts.map((d) => {
    const url = `${args.appUrl}/projects?selected=${d.project_id}&tab=recaps&highlight=${d.recap_id}`
    const flag = d.zero_activity
      ? '<span style="color:#d47561;font-size:11px;letter-spacing:0.12em;text-transform:uppercase;">⚠ zero activity</span>'
      : ''
    return `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #2a2622;color:#f4f0e8;font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:14px;">
          ${esc(d.brand_name)} ${flag}
        </td>
        <td style="padding:8px 12px;border-bottom:1px solid #2a2622;text-align:right;">
          <a href="${url}" style="color:#b87333;text-decoration:none;font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:13px;">Review →</a>
        </td>
      </tr>
    `
  }).join('')

  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#12100D;">
  <div style="max-width:600px;margin:0 auto;padding:32px 24px;font-family:-apple-system,BlinkMacSystemFont,sans-serif;">
    <div style="font-size:11px;letter-spacing:0.24em;font-weight:600;color:#b87333;margin:0 0 10px;">LAVIOLETTE HQ</div>
    <h1 style="font-size:22px;font-weight:500;color:#f4f0e8;margin:0 0 8px;">${args.draftCount} recap draft${args.draftCount === 1 ? '' : 's'} ready for review</h1>
    <p style="font-size:14px;color:#a9a599;margin:0 0 20px;">Covering ${esc(args.monthLabel)}. Review, edit, and send from the Recaps tab on each project.</p>
    <table style="width:100%;border-collapse:collapse;background:#1a1612;border:1px solid #2a2622;border-radius:4px;">
      ${rows}
    </table>
    <p style="font-size:12px;color:#7a7567;margin:24px 0 0;">Auto-generated by generate-monthly-recaps cron.</p>
  </div>
</body></html>`
}

/**
 * Sanitize html_body before transmit. Regex-based allow-list — not a
 * full HTML parser, but covers every attack vector the audit
 * (2026-04-21 Agent 3 finding) raised for Case's threat model (sole
 * author, copy-paste mishaps, compromised external HTML snippets).
 *
 * THREAT MODEL:
 *   - Input source: operator-authored monthly recap HTML, editable
 *     via the Recaps tab (Projects → <project> → Recaps subtab).
 *   - Authorized authors: the single authenticated user (Case). RLS
 *     on monthly_recaps is authenticated_all; no anon write path.
 *   - Assumption: Case is trusted. Sanitizer is defense-in-depth
 *     against accidental copy-paste of unsafe HTML (e.g. from a
 *     third-party analytics tool, a competitor's recap deck), NOT
 *     against an adversarial insider.
 *   - Out of scope: CSS unicode escapes (e.g. `\2f2a` → `/*`), BOM /
 *     zero-width character tricks, deeply nested HTML5 polyglots,
 *     CSS expression() (dead, IE-only anyway).
 *   - Upgrade path: if recaps ever become externally-authored (a
 *     contractor interface, a public-form input, etc.) OR Case wants
 *     stronger guarantees, replace this with a real parser. Current
 *     implementation is acceptable given the single-trusted-author model.
 *
 * WHY NOT DOMPURIFY:
 *   DOMPurify requires a DOM and isomorphic-dompurify pulls jsdom.
 *   Neither runs cleanly in Deno edge runtime, and bundle budget is
 *   tight. The manual allow-list here is intentionally strict.
 *
 * WHAT THIS DOES:
 *   1. Strips dangerous block elements (tag + content): script, style,
 *      link, iframe, object, embed, svg, video, audio, form, input,
 *      button, textarea, meta refresh, applet, base.
 *   2. Strips every `on*` event-handler attribute (onclick, onload,
 *      onerror, etc.) on any remaining tag.
 *   3. Neutralizes javascript:, data:, vbscript: URL schemes in href
 *      by rewriting them to href="#".
 *   4. Strips `src=` attributes entirely — no <img> or <iframe src> is
 *      permitted in recap emails. If remote images are ever needed
 *      (analytics pixels aside), this needs reconsideration.
 *   5. Preserves: inline `style` attributes (load-bearing — renderRecapHtml
 *      uses them for all styling), href on <a> when scheme is safe,
 *      document structure tags (html/head/body/p/h1-h6/ul/ol/li/etc.).
 *
 * WHAT IT DOES NOT DO:
 *   - Parse HTML properly. Malformed or obfuscated payloads (nested
 *     comments, CDATA tricks, unicode bidi) may slip through. Modern
 *     email clients (Gmail, Outlook, Apple Mail) apply their own layer
 *     of sanitization; this is defense-in-depth, not sole defense.
 *   - Validate CSS inside style attributes. CSS expression() was IE-only
 *     and is dead; url() in backgrounds is a tracking vector but not
 *     code exec.
 */
export function sanitizeHtmlForSend(html: string): string {
  let out = String(html || '')

  // 1. Block elements — strip tag + content together. Iterate until stable
  //    so nested / malformed cases (e.g. <script><script>alert(1)</script>)
  //    can't survive by shielding an inner copy.
  const blockTags = [
    'script', 'style', 'link', 'iframe', 'object', 'embed',
    'svg', 'video', 'audio', 'form', 'input', 'button', 'textarea',
    'meta', 'applet', 'base',
  ]
  for (let pass = 0; pass < 3; pass++) {
    let changed = false
    for (const tag of blockTags) {
      const pair = new RegExp(`<${tag}\\b[^<]*(?:(?!<\\/${tag}>)<[^<]*)*<\\/${tag}>`, 'gi')
      const self = new RegExp(`<${tag}\\b[^>]*\\/?>`, 'gi')
      const before = out
      out = out.replace(pair, '').replace(self, '')
      if (out !== before) changed = true
    }
    if (!changed) break
  }

  // 2. Event-handler attributes — catch quoted + unquoted forms.
  out = out.replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '')
  out = out.replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '')
  out = out.replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '')

  // 3. Dangerous URL schemes in href — neutralize to #. Matches both
  //    'javascript:' etc. with optional whitespace after the colon.
  out = out.replace(/href\s*=\s*"\s*(?:javascript|data|vbscript):[^"]*"/gi, 'href="#"')
  out = out.replace(/href\s*=\s*'\s*(?:javascript|data|vbscript):[^']*'/gi, "href='#'")

  // 4. Strip src attributes. Recaps are text-only; no remote asset loads.
  out = out.replace(/\ssrc\s*=\s*"[^"]*"/gi, '')
  out = out.replace(/\ssrc\s*=\s*'[^']*'/gi, '')
  out = out.replace(/\ssrc\s*=\s*[^\s>]+/gi, '')

  return out
}
