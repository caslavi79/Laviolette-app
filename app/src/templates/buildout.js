/**
 * Build-Out Services Agreement Template
 *
 * Fixed-scope, fixed-fee project contract. Generates HTML matching
 * the same protective structure as the retainer template but with
 * buildout-specific sections: deliverable schedule, timeline,
 * revisions/change-orders, deliverable acceptance, no-ongoing-
 * obligations, post-engagement services.
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

export function generateBuildoutHTML(v, t = {}) {
  const toggles = {
    late_fees: true,
    revisions: true,
    post_engagement: true,
    ...t,
  }

  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

  return `<style>${CSS}</style>
<div class="contract-doc">

<h1>Build-Out Services Agreement</h1>
<div class="subtitle">${esc(v.brand_name)}</div>
<div class="subtitle" style="font-size:13px;">Digital Infrastructure &amp; Business Visibility Services</div>
<div class="meta">Prepared by ${esc(v.provider_name)}</div>
<div class="meta">Prepared for ${esc(v.client_name)}, ${esc(v.brand_name)}</div>
<div class="meta">${esc(v.deliverable_count)} Deliverables · $${esc(v.total_fee)} Fixed Fee · ${esc(v.timeline)} Timeline</div>

<h2>1. Definitions and Parties</h2>

<p>This Build-Out Services Agreement ("Agreement") is entered into by and between the parties named below.</p>

<p><strong>Parties:</strong></p>
<p>Service Provider: ${esc(v.provider_name)} ("Provider")</p>
<p>Client: ${esc(v.client_name)}, ${esc(v.client_title)} ("Client")</p>

<p><strong>Defined Terms:</strong></p>
<p>"Signing Date" means the date both parties execute this Agreement.</p>
<p>"Effective Date" means ${esc(v.effective_date)}.</p>

<p><strong>Binding and Irrevocable Commitment:</strong></p>
<p>By signing this Agreement, Client enters into a binding, irrevocable obligation to pay the compensation described in this Agreement. This Agreement cannot be withdrawn from or rescinded after execution. Signing this Agreement creates an immediate, unconditional, legally enforceable obligation to pay all amounts stated in this Agreement on their stated due dates. No cancellation, change of mind, or request to exit shall relieve Client of the minimum payment obligations described in the Termination provisions of this Agreement.</p>

<h2>2. Scope of Work</h2>

<p>Provider agrees to deliver the following ${esc(v.deliverable_count)} services to establish ${esc(v.brand_name)}'s digital infrastructure and business visibility. The full deliverable schedule is set forth in Section 8 of this Agreement.</p>

${v.scope_summary ? `<p>${esc(v.scope_summary)}</p>` : ''}

<h2>3. Compensation</h2>

<table>
  <tr><td style="width:200px;"><strong>Total Fixed Fee</strong></td><td>$${esc(v.total_fee)}</td></tr>
  <tr><td><strong>Payment Due Date</strong></td><td>${esc(v.effective_date)} (Effective Date)</td></tr>
  <tr><td><strong>Payment Method</strong></td><td>${esc(v.payment_method)}</td></tr>
</table>

<p>Client owes Provider a fixed fee of $${esc(v.total_fee)}. This amount is due on ${esc(v.effective_date)}. By signing this Agreement, Client unconditionally agrees to pay $${esc(v.total_fee)} on ${esc(v.effective_date)}. This obligation is absolute and not contingent on the status, completion, or acceptance of any deliverables. Provider will begin work immediately upon execution of this Agreement.</p>

<p>The fixed fee covers all ${esc(v.deliverable_count)} deliverables listed in Section 8. No additional charges, hourly fees, or overage costs will be assessed for work within the defined scope.</p>

<h2>4. Timeline</h2>

<p>Provider will complete all ${esc(v.deliverable_count)} deliverables within ${esc(v.timeline)} of the Signing Date. Provider will begin work immediately upon execution. Commencement of work is not contingent upon receipt of payment. Delays caused by Client's failure to provide necessary materials may extend the timeline accordingly.</p>

<h2>5. Operational Terms</h2>

<h3>5.1 Ownership and Intellectual Property</h3>
<p>Upon full payment, all deliverables, assets, accounts, and systems created under this Agreement become the sole property of Client. Provider retains no ownership rights to any work product delivered under this Agreement.</p>
<p>Provider may feature the work in portfolio and case study materials. Client may opt out of this at any time by providing written notice, which will apply to future use only.</p>

<h3>5.2 Confidentiality</h3>
<p>Both parties commit to protecting each other's proprietary business information, strategies, credentials, and operational details shared during the engagement. This commitment remains in effect for a period of two (2) years following the end of the Agreement, except with respect to credentials and account access information, which shall remain confidential indefinitely.</p>
<p>Confidentiality obligations do not apply to information that: (a) is or becomes publicly available through no fault of the receiving party; (b) was independently developed by the receiving party; (c) was received from a third party without restriction; or (d) is required to be disclosed by law.</p>

${toggles.revisions ? `
<h3>5.3 Revisions and Change Orders</h3>
<p>One (1) round of revisions per deliverable is included within the scope of this Agreement. A "round" means a single consolidated set of feedback submitted in writing. Additional revision rounds or requests that materially expand the scope beyond the ${esc(v.deliverable_count)} deliverables defined herein will be treated as change orders and scoped separately by mutual written agreement with separate compensation.</p>

<h3>5.4 Deliverable Acceptance</h3>
<p>Upon delivery of each deliverable, Client has five (5) business days to review and submit revision requests in writing. If Client does not submit revision requests within this window, the deliverable is deemed accepted. Silence or continued use of a deliverable constitutes acceptance. Once a deliverable is accepted, it is considered complete and no further revisions to that deliverable are owed under this Agreement.</p>
` : ''}

<h3>5.5 Account Access and Credentials</h3>
<p>Client will provide Provider with necessary account access, credentials, and business information required to complete the deliverables. Provider agrees to store all credentials using industry-standard encrypted password management tools and shall not share credentials with any third party without Client's written consent.</p>
<p>Upon conclusion of this Agreement, Provider will promptly return all account access and credentials to Client and remove Provider's own access within five (5) business days.</p>

<h3>5.6 Client Responsibilities</h3>
<p>Client is responsible for providing all photographs, videos, branding assets, menu content, and business information necessary to complete the deliverables in a timely manner. Provider will design, build, and configure all deliverables but does not provide photography, videography, or original media production.</p>
<p>Delays caused by Client's failure to provide required materials may extend the project timeline accordingly.</p>

<h3>5.7 Third-Party Platforms</h3>
<p>Several deliverables rely on third-party platforms including but not limited to Google, Apple, and Meta (Instagram). Provider is not responsible for changes, outages, policy updates, feature deprecations, API modifications, or account suspensions imposed by any third-party platform, provided that Provider has followed applicable platform guidelines in the course of delivering services.</p>
<p>If a third-party change materially prevents delivery of a specific deliverable, Provider will notify Client and offer a reasonable alternative within ten (10) business days.</p>

<h2>6. Legal Terms</h2>

<h3>6.1 Professional Standards</h3>
<p>Provider warrants that all services will be performed in a professional and workmanlike manner consistent with generally accepted industry standards. This warranty does not guarantee specific business outcomes.</p>

<h3>6.2 Warranty Disclaimer</h3>
<p>Provider does not warrant or guarantee any specific business outcomes, revenue, search engine rankings, review volume, customer acquisition, or increases in foot traffic from the deliverables. All deliverables are provided as professional services based on Provider's expertise and judgment. Results may vary based on market conditions, Client's use of the deliverables, and factors outside Provider's control.</p>

<h3>6.3 Limitation of Liability</h3>
<p>Neither party's total liability under this Agreement shall exceed the total fee paid ($${esc(v.total_fee)}). Neither party shall be liable to the other for indirect, consequential, incidental, or punitive damages arising from this Agreement, including lost profits, lost data, business interruption, or third-party claims.</p>
<p>These limitations shall not apply to breaches of Section 5.2 (Confidentiality), indemnification obligations under Section 6.4, or damages arising from a party's gross negligence or willful misconduct.</p>

<h3>6.4 Indemnification</h3>
<p><strong>Client Indemnification:</strong> Client will indemnify and hold harmless Provider against any claims, damages, losses, or legal costs that arise from (a) content provided by Client for use in deliverables, or (b) Client's independent business operations unrelated to Provider's services.</p>
<p><strong>Provider Indemnification:</strong> Provider will indemnify and hold harmless Client against any claims, damages, losses, or legal costs that arise from (a) Provider's negligence or willful misconduct in performing the services, or (b) Provider's infringement of any third-party intellectual property rights in content created solely by Provider.</p>

<h3>6.5 Termination</h3>
<p>Either party may terminate this Agreement with written notice. Regardless of when or why Client terminates — including termination before the Effective Date — the full $${esc(v.total_fee)} fee remains due and payable on ${esc(v.effective_date)}. There is no partial refund, credit, or reduction of this fee under any circumstances. This fee is earned upon execution of this Agreement because Provider will commence work immediately upon signing.</p>
<p>This payment obligation represents a reasonable estimate of Provider's damages from early termination, including but not limited to lost opportunity cost from declining other engagements, resource allocation and scheduling commitments made in reliance on this Agreement, and the difficulty of precisely calculating such damages at the time of contracting.</p>
<p>In the event of early termination by Provider without cause, Provider will deliver all completed work to date and refund any portion of the fee attributable to undelivered items, calculated on a per-deliverable basis ($${esc(v.per_deliverable_refund)} per deliverable).</p>

<h3>6.6 No Ongoing Obligations</h3>
<p>This is a fixed-scope engagement. Upon delivery and acceptance of all ${esc(v.deliverable_count)} deliverables, Provider has no obligation to perform updates, maintenance, content changes, redesigns, hosting, domain registration, DNS management, SSL certificates, social media management, or any other ongoing work of any kind. All deliverables are provided "as-is" upon acceptance. Client assumes full responsibility for the ongoing operation, maintenance, and management of all accounts and assets delivered.</p>

${toggles.post_engagement ? `
<h3>6.7 Post-Engagement Services</h3>
<p>Any work requested after delivery and acceptance of all deliverables is outside the scope of this Agreement and will require a separate, independently negotiated agreement with its own terms and compensation. Nothing in this Agreement obligates Provider to accept or perform post-engagement work.</p>
` : ''}

<h3>6.8 Data Security and Breach Notification</h3>
<p>Provider shall maintain reasonable data security measures consistent with industry standards for the protection of Client's credentials, business data, and customer-facing content. Provider shall notify Client within twenty-four (24) hours of discovering any suspected unauthorized access to Client's accounts or data.</p>

${toggles.late_fees ? `
<h3>6.9 Late Payment Remedies</h3>
<p>If any payment remains outstanding more than five (5) business days past the due date, a late fee of one hundred dollars ($100.00) shall be assessed as liquidated damages. Any balance remaining unpaid beyond ten (10) business days shall accrue interest at two and one-half percent (2.5%) per month, compounding monthly, until paid in full. If the delay is caused by a documented banking error and Client cures within ten (10) business days, the late fee shall be waived.</p>
` : ''}

<h2>7. General Provisions</h2>

<h3>7.1 Force Majeure</h3>
<p>Neither party shall be liable for failure to perform obligations due to events beyond that party's reasonable control. The affected party shall notify the other within five (5) business days. If the event continues for more than thirty (30) days, either party may terminate without penalty.</p>

<h3>7.2 Dispute Resolution</h3>
<p>The parties shall first attempt good-faith negotiation for fifteen (15) days. If unresolved, they shall submit to mediation. If mediation fails within thirty (30) days, either party may pursue legal remedies per Section 7.6.</p>

<h3>7.3 Assignment</h3>
<p>Neither party may assign this Agreement without prior written consent. Any attempted assignment without consent is void.</p>

<h3>7.4 Severability</h3>
<p>If any provision is held invalid, the remaining provisions continue in full force.</p>

<h3>7.5 Non-Waiver</h3>
<p>Failure to enforce any provision does not waive future enforcement rights.</p>

<h3>7.6 Governing Law</h3>
<p>This Agreement is governed by the laws of the State of ${esc(v.governing_state)}. Disputes shall be resolved in the courts of ${esc(v.governing_county)}, ${esc(v.governing_state)}.</p>

<h3>7.7 Notices</h3>
<p>All notices shall be in writing via email or certified mail. Notice is deemed received upon confirmed email delivery or three (3) business days after certified mail deposit.</p>

<h3>7.8 Entire Agreement</h3>
<p>This Agreement constitutes the entire understanding and supersedes all prior discussions. No modification is effective unless in writing and signed by both parties.</p>

<h2>8. Deliverable Schedule</h2>

<p>The following constitutes the complete list of deliverables included in this Agreement for ${esc(v.brand_name)}.</p>

${v.deliverables_table_html || '<p><em>No deliverables defined yet. Add deliverables to the project first.</em></p>'}

<h2>9. Acceptance and Signatures</h2>

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

<!-- client-sig-block -->
<div class="sig-block">
  <p style="font-weight:600;text-transform:uppercase;font-size:12px;letter-spacing:1px;">CLIENT</p>
  <div class="sig-line"></div>
  <p class="sig-name">${esc(v.client_name)}</p>
  <p>On behalf of ${esc(v.brand_name)}</p>
  <p>Signing Date: _______________</p>
  <p>Email for Notices: ${esc(v.client_email)}</p>
</div>
<!-- /client-sig-block -->

<div class="footer">${esc(v.brand_name)} | Build-Out Services Agreement</div>

</div>`
}

/** Generate the deliverables table HTML from deliverables rows. */
export function buildDeliverablesTable(deliverables) {
  if (!deliverables || deliverables.length === 0) return ''
  const rows = deliverables
    .sort((a, b) => (a.number || 0) - (b.number || 0))
    .map((d) => `<tr><td style="width:40px;text-align:center;">${String(d.number).padStart(2, '0')}</td><td style="width:180px;">${esc(d.name)}</td><td>${esc(d.description || '')}</td></tr>`)
    .join('\n')
  return `<table><thead><tr><th>#</th><th>Deliverable</th><th>Description</th></tr></thead><tbody>${rows}</tbody></table>`
}

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
