/**
 * Partnership Services Agreement — Retainer Template
 *
 * Generates a complete, detailed retainer contract as an HTML string.
 * All protective legal language is baked in. Variable fields are
 * interpolated from the `v` (variables) object. Optional sections
 * are controlled by the `t` (toggles) object.
 *
 * Structure mirrors Case's Opus-drafted contracts:
 *   1. Definitions & Parties
 *   2. Scope of Services
 *   3. Compensation
 *   4. Term and Termination (6 sub-sections)
 *   5. Operational Terms (6 sub-sections)
 *   6. Legal Terms (6 sub-sections)
 *   7. General Provisions (9 sub-sections)
 *   8. Service Schedule (auto-generated table)
 *   9. Reporting
 *  10. Acceptance and Signatures
 */

const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Great+Vibes&display=swap');
  .contract-doc { all: initial; display: block; font-family: 'Times New Roman', Georgia, serif; font-size: 14px; line-height: 1.6; color: #1a1a1a; background: #fff; max-width: 720px; margin: 0 auto; }
  .contract-doc * { color: #1a1a1a; }
  .contract-doc h1 { font-family: inherit; font-size: 20px; font-weight: 700; text-align: center; margin: 0 0 6px; letter-spacing: 0.5px; }
  .contract-doc .subtitle { text-align: center; font-size: 15px; font-weight: 400; margin-bottom: 2px; }
  .contract-doc .meta { text-align: center; font-size: 12px; color: #555; margin-bottom: 2px; font-weight: 400; }
  .contract-doc .meta * { color: #555; }
  .contract-doc h2 { font-family: inherit; font-size: 16px; font-weight: 700; margin: 28px 0 10px; }
  .contract-doc h3 { font-family: inherit; font-size: 13px; font-weight: 700; margin: 18px 0 6px; }
  .contract-doc p { margin: 8px 0; }
  .contract-doc strong { font-weight: 700; }
  .contract-doc table { width: 100%; border-collapse: collapse; margin: 14px 0; }
  .contract-doc th, .contract-doc td { border: 1px solid #999; padding: 7px 10px; text-align: left; font-size: 13px; vertical-align: top; }
  .contract-doc th { background: #efefef; font-weight: 700; }
  .contract-doc .sig-block { margin-top: 40px; }
  .contract-doc .sig-line { border: none; border-top: 1px solid #333; width: 300px; margin: 28px 0 4px; height: 0; }
  .contract-doc .sig-cursive { font-family: 'Great Vibes', 'Apple Chancery', cursive; font-size: 30px; color: #12100D; line-height: 1; margin: 22px 0 2px; }
  .contract-doc .sig-underline { border-bottom: 1px solid #333; width: 300px; margin-bottom: 4px; }
  .contract-doc .sig-name { font-weight: 700; }
  .contract-doc .sig-provider-note { font-size: 11px; color: #555; font-style: italic; }
  .contract-doc .footer { text-align: center; font-size: 10px; color: #888; margin-top: 36px; padding-top: 12px; border-top: 1px solid #ddd; }
  .contract-doc .footer * { color: #888; }
`

export function generateRetainerHTML(v, t = {}) {
  const toggles = {
    remote_systems: true,
    reporting: true,
    late_fees: true,
    rate_adjustments: true,
    ...t,
  }
  // §4.1 Pre-Effective Date Termination is a non-negotiable protective clause
  // per contract-playbook.md — hardcoded below, intentionally not toggleable.

  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

  return `<style>${CSS}</style>
<div class="contract-doc">

<h1>Partnership Services Agreement</h1>
<div class="subtitle">${esc(v.brand_name)}</div>
<div class="subtitle" style="font-size:13px;">Recurring Services Agreement</div>
<div class="meta">Prepared by ${esc(v.provider_name)}</div>
<div class="meta">Prepared for ${esc(v.client_name)}, ${esc(v.brand_name)}</div>
<div class="meta">${esc(v.service_count)} Services · $${esc(v.monthly_rate)}/month · ${esc(v.intro_term_months)}-Month Introductory Term</div>

<h2>1. Definitions and Parties</h2>

<p>This Partnership Services Agreement ("Agreement") is entered into by and between the parties named below.</p>

<p><strong>Parties:</strong></p>
<p>Service Provider: ${esc(v.provider_name)} ("Provider")</p>
<p>Client: ${esc(v.client_name)}, ${esc(v.client_title)} ("Client")</p>

<p><strong>Defined Terms:</strong></p>
<p>"Signing Date" means the date both parties execute this Agreement.</p>
<p>"Effective Date" means ${esc(v.effective_date)}.</p>

<p><strong>Binding and Irrevocable Commitment:</strong></p>
<p>By signing this Agreement, Client enters into a binding, irrevocable obligation to pay the compensation described in this Agreement. This Agreement cannot be withdrawn from or rescinded after execution. Signing this Agreement creates an immediate, unconditional, legally enforceable obligation to pay all amounts stated in this Agreement on their stated due dates. No cancellation, change of mind, or request to exit shall relieve Client of the minimum payment obligations described in the Termination provisions of this Agreement.</p>

<h2>2. Scope of Services</h2>

<p>Provider will deliver the following ${esc(v.service_count)} services on a recurring basis to support and grow ${esc(v.brand_name)}. The complete list of services and their descriptions is set forth exclusively in Section 8 of this Agreement.</p>

<h2>3. Compensation</h2>

<table>
  <tr><td style="width:200px;"><strong>Monthly Retainer</strong></td><td>$${esc(v.monthly_rate)} / month</td></tr>
  <tr><td><strong>First Payment Due</strong></td><td>${esc(v.effective_date)} (Effective Date)</td></tr>
  <tr><td><strong>Introductory Term</strong></td><td>${esc(v.intro_term_months)} months (${esc(v.effective_date)} – ${esc(v.intro_term_end)})</td></tr>
  <tr><td><strong>Rate Review</strong></td><td>At end of introductory term</td></tr>
  <tr><td><strong>Payment Method</strong></td><td>${esc(v.payment_method)}</td></tr>
</table>

<p>By signing this Agreement, Client agrees to pay Provider $${esc(v.monthly_rate)} per month. The first payment of $${esc(v.monthly_rate)} is due on ${esc(v.effective_date)} (the Effective Date). Subsequent payments of $${esc(v.monthly_rate)} are due on the first (1st) day of each calendar month thereafter. By signing this Agreement, Client unconditionally owes the first monthly payment of $${esc(v.monthly_rate)} on ${esc(v.effective_date)} regardless of whether Client continues with, cancels, or attempts to terminate this Agreement before that date. This first payment obligation is immediate, binding, and non-refundable upon execution of this Agreement.</p>

<p>This rate reflects a preferred introductory pricing structure for the initial term. All ${esc(v.service_count)} services listed in Section 8 are included in the monthly retainer. Payments will be collected via ${esc(v.payment_method).toLowerCase()}. Provider and Client will establish ACH billing within three (3) business days of signing.</p>

${toggles.rate_adjustments ? `
<p><strong>Rate Adjustments:</strong></p>
<p>Provider shall give Client at least thirty (30) days' written notice of any proposed rate change. Rate adjustments shall be proposed by Provider and are subject to mutual agreement. If the parties do not agree on a revised rate, the existing rate continues on a month-to-month basis until either party terminates in accordance with Section 4.</p>
` : ''}

<h2>4. Term and Termination</h2>

<p>This Agreement begins on the Effective Date (${esc(v.effective_date)}) and runs for an initial introductory term of ${esc(v.intro_term_months)} months, ending ${esc(v.intro_term_end)}. After the introductory term, the Agreement continues on a month-to-month basis.</p>

<h3>4.1 Pre-Effective Date Termination by Client</h3>
<p>If Client terminates or attempts to terminate this Agreement at any point after signing but before ${esc(v.effective_date)}, Client still owes the first monthly payment of $${esc(v.monthly_rate)} due ${esc(v.effective_date)}. This amount is non-refundable and non-negotiable. It represents a reasonable estimate of Provider's damages from early termination, including but not limited to lost opportunity cost from declining other engagements, resource allocation and scheduling commitments made in reliance on this Agreement, and the difficulty of precisely calculating such damages at the time of contracting.</p>

<h3>4.2 Termination During the Introductory Term by Client</h3>
<p>If Client terminates during the introductory term (${esc(v.effective_date)} – ${esc(v.intro_term_end)}), the current month's payment is immediately due in full plus one additional month's payment of $${esc(v.monthly_rate)} as a termination fee. This termination fee represents a reasonable estimate of Provider's damages from early termination, including but not limited to lost opportunity cost from declining other engagements, resource allocation and scheduling commitments made in reliance on this Agreement, and the difficulty of precisely calculating such damages at the time of contracting. This termination fee is not a penalty. All services cease upon the effective date of termination.</p>

<h3>4.3 Termination After the Introductory Term by Client</h3>
<p>After ${esc(v.intro_term_end)}, either party may terminate with thirty (30) days' written notice. Upon termination by Client after the introductory term, the current month's payment is immediately due in full plus one additional month's payment of $${esc(v.monthly_rate)} as a termination fee. This termination fee represents a reasonable estimate of Provider's damages, including but not limited to lost opportunity cost, resource reallocation, and scheduling disruption caused by early termination, and the difficulty of precisely calculating such damages at the time of contracting. This termination fee is not a penalty. All services cease at the end of the notice period.</p>

<h3>4.4 Termination by Provider</h3>
<p>If Provider terminates this Agreement, Provider will complete all work in progress and ensure a smooth transition through the end of the current billing cycle at no additional cost. If Provider terminates during the introductory term without cause, Provider shall refund any prepaid fees for undelivered services on a pro-rata basis.</p>

<h3>4.5 Termination for Cause by Client</h3>
<p>Client may terminate this Agreement immediately upon written notice if Provider materially breaches a specific obligation under this Agreement and fails to cure such breach within ten (10) business days of receiving written notice from Client that (a) identifies the specific provision of this Agreement that Provider has breached, and (b) describes in reasonable detail the nature of the breach. If Client properly terminates for cause under this section after Provider's failure to cure, Client shall owe only for services rendered through the termination date and no termination fee shall apply. For the avoidance of doubt, dissatisfaction with results, change in business priorities, or general desire to discontinue services does not constitute cause for termination under this section.</p>

<h3>4.6 Termination for Cause by Provider</h3>
<p>Provider may terminate this Agreement immediately upon written notice if Client materially breaches any obligation under this Agreement — including but not limited to failure to remit payment when due — and fails to cure such breach within ten (10) business days of receiving written notice specifying the breach. In such event, all outstanding and future payment obligations through the end of the introductory term (or the current month plus one additional month if after the introductory term) become immediately due and payable.</p>

<h2>5. Operational Terms</h2>

<h3>5.1 Ownership and Intellectual Property</h3>
<p>All content created by Provider for Client under this Agreement becomes Client's property, free and clear, once the corresponding monthly payment is received. Client owns everything delivered under this engagement.</p>
<p>Provider may feature the work in portfolio and case study materials. Client may opt out of this at any time by providing written notice, which will apply to future use only.</p>

<h3>5.2 Confidentiality</h3>
<p>Both parties commit to protecting each other's proprietary business information, strategies, credentials, and operational details shared during the engagement. This commitment remains in effect for a period of two (2) years following the end of the Agreement, except with respect to credentials and account access information, which shall remain confidential indefinitely.</p>
<p>Confidentiality obligations do not apply to information that: (a) is or becomes publicly available through no fault of the receiving party; (b) was independently developed by the receiving party; (c) was received from a third party without restriction; or (d) is required to be disclosed by law.</p>

<h3>5.3 Account Access and Credentials</h3>
<p>Client will provide Provider with necessary account access, credentials, and business information required to perform the services. Provider agrees to store all credentials using industry-standard encrypted password management tools and shall not share credentials with any third party without Client's written consent.</p>
<p>Upon conclusion of this Agreement, Provider will promptly return all account access and credentials to Client and remove Provider's own access within five (5) business days of the termination date.</p>

<h3>5.4 Client Responsibilities</h3>
<p>Client will provide the photographs, videos, and visual media used across the website, social media, and other digital platforms managed under this Agreement. Provider will handle all design, editing, and content creation from those materials.</p>
<p>Client agrees to provide access to accounts, content (photos, menus, event details), and approvals within five (5) business days of Provider's request. If there are delays in receiving needed materials, service delivery for that period may be adjusted accordingly. Provider will communicate proactively if timelines are at risk.</p>

${toggles.remote_systems ? `
<h3>5.5 Remote Systems</h3>
<p>The Remote Systems Management service (Service #9) covers ongoing maintenance, support, and management of any remote systems built by Provider for the establishment. Any new remote system builds or installations are handled through separate project agreements tailored to the specific system. This retainer covers the ongoing care of systems already in place.</p>
` : ''}

<h3>5.6 Third-Party Platforms</h3>
<p>Because these services rely on third-party platforms (Google, Meta, hosting providers), Provider cannot control and is not responsible for platform changes, outages, policy shifts, feature updates, API modifications, or account actions taken by those platforms, provided that Provider has followed applicable platform guidelines in the course of delivering services.</p>
<p>If a third-party change materially prevents delivery of a specific service, Provider will notify Client and offer a reasonable alternative within ten (10) business days. Client may accept or reject the alternative.</p>

<h2>6. Legal Terms</h2>

<h3>6.1 Professional Standards</h3>
<p>Provider warrants that all services will be performed in a professional and workmanlike manner consistent with generally accepted industry standards. This warranty does not guarantee specific business outcomes.</p>

<h3>6.2 Warranty Disclaimer</h3>
<p>While Provider brings professional expertise and proven strategies to every engagement, specific business outcomes such as revenue increases, search engine rankings, review volume, or customer acquisition cannot be guaranteed. Results depend on many factors, including market conditions, seasonal trends, and how the services are leveraged by Client.</p>

<h3>6.3 Limitation of Liability</h3>
<p>Neither party's total liability under this Agreement shall exceed the total fees paid by Client under this Agreement in the three (3) months preceding the event giving rise to the claim. Neither party shall be liable to the other for indirect, consequential, incidental, or punitive damages arising from this Agreement, including lost profits, lost data, business interruption, or third-party claims.</p>
<p>These limitations shall not apply to breaches of Section 5.2 (Confidentiality), indemnification obligations under Section 6.4, or damages arising from a party's gross negligence or willful misconduct.</p>

<h3>6.4 Indemnification</h3>
<p><strong>Client Indemnification:</strong> Client will indemnify and hold harmless Provider against any claims, damages, losses, or legal costs that arise from (a) content provided by Client for use in deliverables, or (b) Client's independent business operations unrelated to Provider's services.</p>
<p><strong>Provider Indemnification:</strong> Provider will indemnify and hold harmless Client against any claims, damages, losses, or legal costs that arise from (a) Provider's negligence or willful misconduct in performing the services, or (b) Provider's infringement of any third-party intellectual property rights in content created solely by Provider.</p>

${toggles.late_fees ? `
<h3>6.5 Late Payment Remedies</h3>
<p>If any payment remains outstanding more than five (5) business days past the due date, a late fee of one hundred dollars ($100.00) shall be assessed as liquidated damages to compensate Provider for the administrative burden and schedule disruption caused by nonpayment. In addition, any balance remaining unpaid beyond ten (10) business days of the due date shall accrue interest at a rate of two and one-half percent (2.5%) per month, compounding monthly, until paid in full. Late fees and accrued interest are due and payable together with the outstanding balance. If the payment delay is caused by a documented banking or processing error outside Client's control and Client cures within ten (10) business days, the late fee shall be waived.</p>
` : ''}

<h3>6.6 Data Security and Breach Notification</h3>
<p>Provider shall maintain reasonable data security measures consistent with industry standards for the protection of Client's credentials, business data, and customer-facing content. Provider shall notify Client within twenty-four (24) hours of discovering any suspected unauthorized access to Client's accounts or data.</p>

<h2>7. General Provisions</h2>

<h3>7.1 Force Majeure</h3>
<p>Neither party shall be liable for failure to perform obligations under this Agreement due to events beyond that party's reasonable control, including natural disasters, pandemics, government orders, utility failures, or acts of war. The affected party shall notify the other party within five (5) business days of the event. If the event continues for more than thirty (30) days, either party may terminate this Agreement without penalty.</p>

<h3>7.2 Dispute Resolution</h3>
<p>Prior to initiating any legal action, the parties shall first attempt to resolve the dispute through good-faith negotiation for a period of fifteen (15) days. If negotiation fails, the parties shall submit the dispute to mediation administered by a mutually agreed mediator. If mediation fails within thirty (30) days, either party may pursue legal remedies in accordance with Section 7.7.</p>

<h3>7.3 Transition and Offboarding</h3>
<p>Upon termination for any reason, Provider shall within five (5) business days transfer to Client all account credentials, login information, content files, analytics data, website backups, and any other Client property in Provider's possession. Provider shall continue website hosting for a minimum of fourteen (14) days following termination to allow Client to arrange alternative hosting. Provider shall cooperate with any successor service provider during the transition and provide reasonable documentation of recurring processes and systems.</p>

<h3>7.4 Assignment</h3>
<p>Neither party may assign or transfer this Agreement or any rights or obligations under it without the prior written consent of the other party. Any attempted assignment without consent is void.</p>

<h3>7.5 Severability</h3>
<p>If any provision of this Agreement is held invalid or unenforceable, the remaining provisions shall continue in full force and effect.</p>

<h3>7.6 Non-Waiver</h3>
<p>The failure of either party to enforce any provision of this Agreement shall not constitute a waiver of that party's right to enforce that provision or any other provision in the future.</p>

<h3>7.7 Governing Law</h3>
<p>This Agreement shall be governed by and construed in accordance with the laws of the State of ${esc(v.governing_state)}. Any disputes arising under this Agreement shall be resolved in the state or federal courts located in ${esc(v.governing_county)}, ${esc(v.governing_state)}.</p>

<h3>7.8 Notices</h3>
<p>All notices required or permitted under this Agreement shall be in writing and delivered by email or certified mail to the addresses provided by each party at the time of signing. Notice is deemed received upon confirmed delivery by email or three (3) business days after deposit with certified mail.</p>

<h3>7.9 Entire Agreement</h3>
<p>This Agreement constitutes the entire understanding between the parties and supersedes all prior discussions, proposals, and representations, whether written or oral. Any prior language inconsistent with the payment and termination provisions of this Agreement is superseded; in the event of any conflict, the payment and termination provisions of this Agreement (Sections 3 and 4) control. No modification of this Agreement shall be effective unless made in writing and signed by both parties.</p>

<h2>8. Service Schedule</h2>

<p>The following constitutes the complete list of recurring services included in this Agreement for ${esc(v.brand_name)}. All content shall be submitted to Client for approval before publication. Client has two (2) business days to approve or request revisions. Provider shall make up to one (1) round of revisions per deliverable at no additional cost.</p>

${v.services_table_html || '<p><em>No services defined yet. Add services to the project first.</em></p>'}

${toggles.reporting ? `
<h2>9. Reporting</h2>
<p>Provider shall deliver a quarterly performance report to Client at least ten (10) business days before the end of each three-month billing period. The report shall detail all services performed during the quarter, deliverables completed, and key metrics (engagement, traffic, review responses). This report is intended to provide a clear picture of results and value ahead of any rate review discussion. Client shall have the right to request reasonable additional documentation of services performed at any time.</p>
` : ''}

<h2>${toggles.reporting ? '10' : '9'}. Acceptance and Signatures</h2>

<p>By signing below, both parties confirm their agreement to the terms, scope, services, and compensation described in this Agreement and look forward to a successful partnership.</p>

<p>Effective Date: ${esc(v.effective_date)}</p>

<div class="sig-block">
  <p style="font-weight:600;text-transform:uppercase;font-size:12px;letter-spacing:1px;">SERVICE PROVIDER</p>
  <div class="sig-cursive">${esc(v.provider_name)}</div>
  <div class="sig-underline"></div>
  <p class="sig-name">${esc(v.provider_name)}</p>
  <p>Service Provider</p>
  <p>Signing Date: ${esc(v.provider_signed_date)}</p>
  <p class="sig-provider-note">Signed electronically by ${esc(v.provider_name)} under the U.S. ESIGN Act and UETA.</p>
  <p>Email for Notices: ${esc(v.provider_email)}</p>
</div>

<div class="sig-block">
  <p style="font-weight:600;text-transform:uppercase;font-size:12px;letter-spacing:1px;">CLIENT</p>
  <div class="sig-line"></div>
  <p class="sig-name">${esc(v.client_name)}</p>
  <p>On behalf of ${esc(v.brand_name)}</p>
  <p>Signing Date: _______________</p>
  <p>Email for Notices: ${esc(v.client_email)}</p>
</div>

<div class="footer">${esc(v.brand_name)} | Partnership Services Agreement</div>

</div>`
}

/** Generate the services table HTML from retainer_services rows. */
export function buildServicesTable(services) {
  if (!services || services.length === 0) return ''
  const rows = services
    .filter((s) => s.active !== false)
    .sort((a, b) => (a.number || 0) - (b.number || 0))
    .map((s) => `<tr><td style="width:40px;text-align:center;">${String(s.number).padStart(2, '0')}</td><td style="width:180px;">${esc(s.name)}</td><td>${esc(s.description || '')}</td></tr>`)
    .join('\n')
  return `<table><thead><tr><th>#</th><th>Service</th><th>Description</th></tr></thead><tbody>${rows}</tbody></table>`
}

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
