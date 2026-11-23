// Client exports share plain-language content; technical evidence stays in the detailed report.
const CLIENT_AREAS = {
  Consent: ['Visitor consent', 'Website / analytics, with privacy input',
    'Tracking may not follow the visitor\'s consent choice.',
    'Review consent controls against the agreed privacy policy and correct the affected tracking.',
    'Repeat checks before a choice, after Reject and after Accept.'],
  Security: ['Tracking security', 'Website / security',
    'A tracking implementation needs a security review.',
    'Ask the security and website teams to review the flagged implementation and address the risk.',
    'Recheck the published tracking after the security changes.'],
  'GA4 Setup': ['Analytics measurement', 'Analytics',
    'The analytics configuration may affect the quality of reporting.',
    'Review the affected measurement settings and test the intended reporting behaviour.',
    'Use a test visit to confirm the intended measurements are recorded once.'],
  'GA4 Property': ['Analytics account settings', 'Analytics',
    'Account settings need attention or could not be fully reviewed.',
    'Review the affected settings with someone who has access to the analytics account.',
    'Repeat the account-level review after the changes.'],
  'Ads Setup': ['Advertising measurement', 'Media / analytics',
    'The advertising setup may affect conversion measurement.',
    'Review the affected advertising integration and confirm the intended measurement with your media team.',
    'Test an authorised conversion journey and check the destination account.'],
  'Accounts & IDs': ['Data destinations', 'Media / analytics',
    'Multiple destinations are configured to receive measurement data. They may be intentional.',
    'Confirm the intended accounts with your teams and remove obsolete connections.',
    'Recheck that measurements are sent only to the intended accounts.'],
  Legacy: ['Outdated tracking', 'Analytics',
    'An obsolete integration remains in the reviewed setup.',
    'Check dependencies, remove the obsolete integration and retain the current replacement.',
    'Repeat the audit and verify that current measurement still works.'],
  Hygiene: ['Tracking maintenance', 'Analytics',
    'Unused or inconsistent tracking configuration makes maintenance harder.',
    'Review the affected items, tidy the setup and remove only items confirmed to be unnecessary.',
    'Test relevant journeys and repeat the configuration review.'],
  'Third Parties': ['External tracking tools', 'Website / privacy',
    'External tools should match your intended tracking and privacy policy.',
    'Review the affected providers and remove or update any unintended connections.',
    'Check the published setup and update the privacy information where required.']
};

const CLIENT_FINDING_COPY = [
  [/credential|API secret/i, 'Review a potentially exposed credential',
    'A potential credential was identified in publicly readable tracking code.',
    'Ask security to confirm whether it is private. If so, rotate it and move it out of public website code.'],
  [/dynamic code|eval \/ new Function/i, 'Review dynamically executed tracking code',
    'Dynamically executed code is harder to inspect and maintain.',
    'Ask the website team to review the code and replace unnecessary dynamic execution.'],
  [/document\.write/i, 'Modernise an older script-loading method',
    'An older loading method may slow the page or fail in some browsers.',
    'Replace this loading method and retest the affected tracking.'],
  [/plain http/i, 'Use secure connections for tracking scripts',
    'A script is configured to load over an unencrypted connection.',
    'Update it to a secure HTTPS source and verify that it still loads correctly.'],
  [/No Consent Mode default/i, 'Set consent before tracking starts',
    'An initial consent instruction was not found in the reviewed page or tracking setup.',
    'Configure the consent platform to set the initial choice before measurement tools run.'],
  [/Consent Mode v1/i, 'Update Google consent settings',
    'The reviewed consent setup is missing newer Google advertising consent signals.',
    'Update to Consent Mode v2 and confirm that all relevant choices reach Google tools.'],
  [/Consent Initialization/i, 'Load consent controls early enough',
    'The consent platform may start after other tracking tools.',
    'Make consent controls available before other tracking is allowed to run.'],
  [/may fire without consent|incomplete consent gating/i, 'Review tracking consent controls',
    'Configuration suggests some tools may run without the appropriate consent. This is not proof of actual firing.',
    'Review the affected tools against your policy and test their behaviour for each consent choice.'],
  [/configured on the page AND|Google tags in GTM|base code loaded/i, 'Avoid duplicate measurement',
    'Overlapping tracking configuration could count the same activity more than once.',
    'Keep one intended measurement source, or ensure overlapping tools never count the same activity.'],
  [/No GA4 Google tag/i, 'Confirm how analytics is deployed',
    'A standard Google Analytics tag was not found in the supplied setup. Measurement may be implemented elsewhere.',
    'Confirm how analytics is deployed and verify that the intended website activity reaches reporting.'],
  [/event naming problem|not in snake_case/i, 'Make event names consistent',
    'Inconsistent event names can split reporting or cause measurements to be rejected.',
    'Agree a consistent naming approach and correct the flagged event names.'],
  [/dynamic GA4 event/i, 'Validate generated event names',
    'Some event names depend on values available only while the website is running.',
    'Test the relevant journeys and verify the actual event names received by analytics.'],
  [/Universal Analytics/i, 'Remove obsolete Universal Analytics tracking',
    'An older analytics integration remains even though Universal Analytics no longer processes data.',
    'Check dependencies and remove the obsolete tracking while retaining current analytics.'],
  [/Google Optimize/i, 'Remove discontinued Google Optimize tracking',
    'A discontinued testing integration remains in the setup.',
    'Remove the obsolete integration after checking that no current implementation depends on it.'],
  [/without a firing trigger/i, 'Review tracking with no activation rule',
    'Some tracking has no direct activation rule in the supplied configuration.',
    'Check whether it is invoked by sequencing or another route; repair or remove it as appropriate.'],
  [/unused trigger|unreferenced variable/i, 'Clean up unreferenced configuration',
    'Some rules or settings have no other static references in the supplied snapshot.',
    'Check dynamic dependencies and other uses before removing anything marked unused.'],
  [/paused tag/i, 'Review paused tracking',
    'Paused tracking adds maintenance overhead but may have been retained deliberately.',
    'Confirm what is still needed and remove only items that are no longer required.'],
  [/not in a folder|naming convention|Inconsistent tag naming/i, 'Make the tracking setup easier to maintain',
    'Inconsistent organisation makes changes and future reviews harder.',
    'Use a consistent naming convention and organise tracking into clear folders.'],
  [/without a Conversion Linker|Linker does not fire/i, 'Review advertising click measurement',
    'The reviewed click-linking setup may affect conversion attribution.',
    'Review click-linking coverage across relevant pages, with the appropriate consent controls.'],
  [/Enhanced Conversions/i, 'Evaluate enhanced conversion measurement',
    'An enhanced conversion setup was not detected in the reviewed configuration.',
    'Check the advertising account and assess whether enhanced measurement is appropriate under your privacy policy.'],
  [/ads_data_redaction/i, 'Review advertising data redaction',
    'The optional advertising data-redaction setting was not detected.',
    'Review whether advertising click information should be redacted when advertising consent is denied.'],
  [/url_passthrough/i, 'Review consent-aware click attribution',
    'An optional setting for preserving click information across pages was not detected.',
    'Assess whether this setting is appropriate for your attribution requirements and privacy policy.'],
  [/Meta pixel runs/i, 'Evaluate server-side advertising measurement',
    'Only browser-side Meta measurement was identified in the supplied configuration.',
    'Check for an existing server-side integration before considering a consent-aware implementation with duplicate-event protection.'],
  [/external domain|vendor.*approved list/i, 'Review external tracking providers',
    'The setup references external providers that should be reviewed.',
    'Confirm that the intended providers are appropriate and reflected in your privacy information.'],
  [/Payment providers/i, 'Keep payment journeys correctly attributed',
    'Payment-provider references were found; they may affect how visits are attributed.',
    'Review referral settings so returning customers are not incorrectly attributed to the payment provider.'],
  [/retention is only/i, 'Review how long detailed analytics data is retained',
    'Short retention limits how far back detailed analysis can look.',
    'Consider increasing retention from two to fourteen months where appropriate for your policy and reporting needs.'],
  [/not registered|custom dimensions/i, 'Make useful custom data available in reports',
    'Some supplied custom measurements are not registered for reporting.',
    'Register only the custom measurements needed for your reporting requirements.'],
  [/No key events/i, 'Define the business outcomes to measure',
    'No key events were found in the reviewed analytics account.',
    'Agree the business-critical actions and configure them as key events.'],
  [/key event.*not found/i, 'Verify that important business events still arrive',
    'Some configured key events were not found in the supplied tracking setup; they may come from elsewhere.',
    'Confirm their source and test whether these business events still reach analytics.'],
  [/not linked to Google Ads/i, 'Connect analytics and advertising reporting',
    'Advertising tags were found, but the reviewed analytics property has no Google Ads link.',
    'Review and create the intended account link if shared audiences or conversion reporting are required.'],
  [/currency differs/i, 'Check currency handling in revenue reports',
    'Website purchase currencies differ from the analytics property currency. This may be intentional.',
    'Confirm that the sent currencies and account conversion settings produce the intended revenue reporting.'],
  [/no access|checks failed/i, 'Complete the analytics account review',
    'Access or an API error prevented some account checks.',
    'Check sign-in and account permissions, then repeat the review.']
];

const CLIENT_PRIORITY_PALETTE = {
  High: { tint: 'FCE8E6', ink: '8C1D18', solid: 'C62828', onDark: 'FF7777' },
  Medium: { tint: 'FFF2CC', ink: '7A4B00', solid: 'D98C00', onDark: 'FFC857' },
  Low: { tint: 'E2F3E6', ink: '1D6332', solid: '2E7D32', onDark: '5EE28B' },
  Info: { tint: 'EDF0F3', ink: '5C6B7E', solid: '8793A2', onDark: 'C5D0E0' }
};

function clientScoreTraffic(score) {
  return score === null ? 'Info' : score >= 90 ? 'Low' : score >= 60 ? 'Medium' : 'High';
}

function clientReportModel(result) {
  if (!result || !result.audit || !Array.isArray(result.issues)) throw new Error('Run or open an audit before exporting a client report.');
  const audit = result.audit;
  const counts = { High: 0, Medium: 0, Low: 0 };
  const actions = result.issues.map((issue, index) => {
    if (!Object.prototype.hasOwnProperty.call(counts, issue.severity)) throw new Error('An audit finding has an unsupported priority. Re-run the audit before exporting.');
    counts[issue.severity]++;
    const area = CLIENT_AREAS[issue.area] || ['Other review', 'Website / analytics',
      'An additional configuration item needs review.', 'Review the flagged item with the implementation team.',
      'Repeat the relevant checks after any changes.'];
    const copy = CLIENT_FINDING_COPY.find(row => row[0].test(issue.finding));
    return {
      id: 'finding-' + (index + 1), area: issue.area, severity: issue.severity,
      title: copy ? copy[1] : 'Review ' + area[0].toLowerCase(),
      why: copy ? copy[2] : area[2], recommendation: copy ? copy[3] : area[3],
      verify: area[4], team: area[1], evidence: 'Configuration review',
      affected: Array.isArray(issue.items) ? issue.items.length : 0
    };
  });
  const stages = result.live && result.live.data && result.live.data.stages || {};
  const tested = Object.keys(LIVE_STAGES).filter(key => stages[key]);
  const observations = (result.live && result.live.verdicts || []).filter(v => ['High', 'Check'].includes(v.verdict)).map((v, index) => ({
    id: 'live-' + (index + 1), area: 'Consent', severity: v.verdict === 'High' ? 'High' : 'Medium',
    title: 'Review ' + v.vendor + ' consent behaviour',
    why: 'Activity was observed before a choice or after rejection. A request alone does not establish personal data collection.',
    recommendation: 'Review this tool against your privacy policy and adjust its consent controls where required.',
    verify: 'Repeat the before-choice, Reject and Accept checks on the relevant journey.',
    team: 'Website / analytics, with privacy input', evidence: 'Live observation', affected: 0
  }));
  actions.push(...observations);
  actions.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  const configurationAvailable = !!(audit.fullDetail || audit.pageScanned || (audit.tags || []).length || Object.keys(audit.ids || {}).length);
  const validScore = configurationAvailable && result.score && Number.isFinite(result.score.score) &&
    result.score.score >= 0 && result.score.score <= 100;
  const accountIncomplete = !audit.ga4PropertyChecked || result.issues.some(i =>
    i.area === 'GA4 Property' && /no access|checks failed/i.test(i.finding));
  const coverage = [
    audit.fullDetail ? 'Full tracking configuration reviewed (API / export).'
      : (audit.tags || []).length ? 'Published tracking configuration reviewed; original authoring detail is limited.'
        : 'Tracking container configuration not reviewed.',
    audit.pageScanned ? 'Supplied page source reviewed.' : 'Page source not reviewed.',
    accountIncomplete ? 'Analytics account review incomplete or unavailable.' : 'Analytics account settings reviewed.',
    tested.length ? 'Live consent states: ' + tested.map(key => ({ before: 'before choice', deny: 'Reject', accept: 'Accept' })[key]).join(', ') + '.'
      : 'Live consent behaviour not tested.'
  ];
  const areaGroups = [
    ['Visitor consent', ['Consent']],
    ['Analytics measurement', ['GA4 Setup', 'GA4 Property']],
    ['Advertising & destinations', ['Ads Setup', 'Accounts & IDs']],
    ['Tracking maintenance', ['Legacy', 'Hygiene']],
    ['Security & external tools', ['Security', 'Third Parties']]
  ].map(([label, names]) => {
    const relevant = actions.filter(a => names.includes(a.area));
    const partial = names.includes('GA4 Property') && accountIncomplete ||
      names.includes('Hygiene') && !audit.fullDetail || names.includes('Consent') && (!audit.pageScanned || tested.length < 3);
    const severity = relevant.length ? relevant[0].severity : null;
    return {
      label, severity,
      status: severity === 'High' ? 'High priority' : severity === 'Medium' ? 'Needs attention' : severity === 'Low' ? 'Maintenance'
        : !configurationAvailable ? 'Not checked' : partial ? 'Partly checked' : 'No issues identified',
      note: relevant.length ? relevant.length + ' recommendation' + (relevant.length === 1 ? '' : 's') + (partial ? '; review coverage is limited.' : '.')
        : !configurationAvailable ? 'Add audit sources to assess this area.' : partial ? 'Some checks need additional evidence.' : 'Within the available checks.'
    };
  });
  const score = validScore ? result.score.score : null;
  return {
    client: result.meta.client || hostOf_(result.meta.site) || 'Website audit',
    site: result.meta.site || 'Website not specified',
    date: new Date(result.meta.date).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }),
    score, grade: score === null ? null : result.score.grade,
    health: score === null ? 'Insufficient evidence' : score >= 90 ? 'Strong audit health'
      : score >= 75 ? 'Some improvements needed' : score >= 60 ? 'Improvements needed' : 'Priority action needed',
    counts, findingCount: result.issues.length, liveCount: observations.length,
    actions, areas: areaGroups, coverage,
    first: actions.length ? actions[0].title : configurationAvailable ? 'Complete any remaining checks.' : 'Add audit sources before drawing conclusions.',
    caveat: 'Score reflects configuration checks, not legal compliance or guaranteed data accuracy. Live observations are reported separately and do not change the score.',
    limits: 'This snapshot does not test every journey, browser or region. Configuration is not proof of execution. Repeat the review after changes.',
    noActions: configurationAvailable ? 'No recommendations from the available checks. Review the coverage limits before drawing conclusions.'
      : 'No audit evidence is available. Add tracking configuration or page source, then run the audit.'
  };
}

// ── GA4 client report ───────────────────────────────────────────────

const GA4_CLIENT_AREAS = {
  'Collection & streams': ['Data collection', 'Analytics / website',
    'Analytics data may be missing, split or include traffic that is not from the website.',
    'Review where the analytics data comes from and remove or fix the sources that should not send data.',
    'Check the following week of data for the affected sites and streams.'],
  'Events & key events': ['Events & conversions', 'Analytics',
    'Some conversions or events may not be measured as intended.',
    'Review the affected events and conversions with the analytics team and fix or retire them.',
    'Complete a test journey and confirm each conversion appears once in reports.'],
  'Custom definitions': ['Reporting fields', 'Analytics',
    'Some reporting fields are unused or not set up, so details are missing from reports.',
    'Register the fields that reports need and archive the ones that are no longer used.',
    'Check the fields fill with data in reports after the change.'],
  'Data quality': ['Data quality', 'Analytics / media',
    'Some reports may attribute traffic or sales incorrectly.',
    'Fix the tagging or settings behind the affected reports.',
    'Compare the affected reports before and after the change.'],
  'Privacy & retention': ['Privacy & data retention', 'Analytics, with privacy input',
    'Some analytics settings may not match privacy requirements or reporting needs.',
    'Review the affected privacy and retention settings with the privacy owner.',
    'Recheck the settings and the affected reports after the change.'],
  'Integrations': ['Connected products', 'Media / analytics',
    'Analytics is not connected to all the advertising tools in use.',
    'Connect the products the media team relies on, so conversions and audiences can be shared.',
    'Confirm conversions and audiences appear in the connected product.'],
  'Attribution & reporting': ['Attribution & reporting', 'Analytics',
    'Reporting settings may affect how credit is given to marketing channels.',
    'Review the attribution and reporting settings with the media team.',
    'Agree the settings and document them.'],
  'GTM alignment': ['Tag manager alignment', 'Analytics',
    'The tag manager and analytics do not fully agree on what is measured.',
    'Align the tag manager setup with the events analytics should receive, and remove duplicates.',
    'Use a test visit to confirm each event arrives once.']
};

const GA4_CLIENT_FINDING_COPY = [
  [/personal data in page URLs/i, 'Stop personal data reaching analytics',
    'Page addresses recorded in analytics appear to contain personal details. Google does not allow this.',
    'Change the affected forms or pages so personal details are not added to page addresses, and turn on redaction.'],
  [/No data received/i, 'Restore analytics data collection',
    'The analytics property has not received data in the last 28 days.',
    'Confirm the analytics tag is installed and allowed to run on the site.'],
  [/key event\(s\) received no data/i, 'Fix conversions that are no longer recorded',
    'Some conversions are set up but have not been recorded in the last 28 days.',
    'Check those conversions still fire, or retire the ones that are no longer used.'],
  [/No key events/i, 'Set up conversions',
    'No conversions are set up, so analytics cannot report on business outcomes.',
    'Agree the key business actions and mark them as conversions.'],
  [/sent by both GTM and enhanced measurement/i, 'Remove double-counted events',
    'Some events are sent twice, which inflates the numbers in reports.',
    'Keep one source for each of the affected events.'],
  [/tagged in GTM but not received/i, 'Fix events that are set up but not arriving',
    'Some events are set up in the tag manager but analytics does not receive them.',
    'Check the triggers and the destination for each affected event, and remove unused ones.'],
  [/Unassigned channel/i, 'Improve campaign tagging',
    'A share of visits cannot be attributed to a marketing channel.',
    'Review the campaign tagging (UTM parameters) used by the media teams.'],
  [/transaction ID|recorded more than once|no revenue/i, 'Make purchase data reliable',
    'Some purchases are missing details or counted more than once, which affects revenue reports.',
    'Send a unique transaction ID, value and currency with every purchase, once.'],
  [/retention is only 2 months/i, 'Keep analytics data for longer',
    'Detailed analysis is limited to the last two months.',
    'Increase data retention to 14 months if the privacy policy allows.'],
  [/unexpected hostname/i, 'Remove data from other sites',
    'Analytics receives data from sites other than the client\'s, such as test or copied sites.',
    'Identify those sources and exclude them.']
];

function ga4ClientReportModel(ga4, pr) {
  if (!ga4 || !pr || !Array.isArray(pr.issues)) throw new Error('Run a GA4 audit before exporting a GA4 report.');
  const counts = { High: 0, Medium: 0, Low: 0 };
  const actions = pr.issues.map((issue, index) => {
    counts[issue.severity]++;
    const area = GA4_CLIENT_AREAS[issue.area] || ['Analytics review', 'Analytics', 'An analytics setting needs review.',
      'Review the flagged item with the analytics team.', 'Recheck after any changes.'];
    const copy = GA4_CLIENT_FINDING_COPY.find(row => row[0].test(issue.finding));
    return {
      id: 'ga4-finding-' + (index + 1), area: issue.area, severity: issue.severity,
      title: copy ? copy[1] : 'Review ' + area[0].toLowerCase(),
      why: copy ? copy[2] : area[2], recommendation: copy ? copy[3] : area[3],
      verify: area[4], team: area[1], evidence: issue.area === 'GTM alignment' ? 'Tag manager and analytics comparison'
        : /Data quality|Collection|Events/.test(issue.area) && pr.hasData ? 'Analytics data, last 28 days' : 'Analytics settings',
      affected: Array.isArray(issue.items) ? issue.items.length : 0
    };
  });
  const partial = pr.coverage.unavailable.length > 0;
  const areaGroups = [
    ['Data collection', ['Collection & streams']],
    ['Events & conversions', ['Events & key events', 'GTM alignment']],
    ['Data quality & reporting', ['Data quality', 'Custom definitions', 'Attribution & reporting']],
    ['Privacy & retention', ['Privacy & retention']],
    ['Connected products', ['Integrations']]
  ].map(([label, names]) => {
    const relevant = actions.filter(a => names.includes(a.area));
    const notChecked = names.every(n => (pr.areas.find(a => a.area === n) || {}).score === null);
    const severity = relevant.length ? relevant[0].severity : null;
    return {
      label, severity,
      status: severity === 'High' ? 'High priority' : severity === 'Medium' ? 'Needs attention' : severity === 'Low' ? 'Maintenance'
        : notChecked ? 'Not checked' : partial ? 'Partly checked' : 'No issues identified',
      note: relevant.length ? relevant.length + ' recommendation' + (relevant.length === 1 ? '' : 's') + '.'
        : notChecked ? 'Needs more data to assess.' : 'Within the available checks.'
    };
  });
  const score = pr.score.score;
  return {
    client: ga4.client || hostOf_(ga4.site) || pr.displayName,
    site: joinParts_(ga4.site, 'GA4 property: ' + pr.displayName),
    date: new Date(pr.meta.date).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }),
    score, grade: pr.score.grade,
    health: score >= 90 ? 'Strong analytics health' : score >= 75 ? 'Some improvements needed'
      : score >= 60 ? 'Improvements needed' : 'Priority action needed',
    counts, findingCount: pr.issues.length, liveCount: 0, actions, areas: areaGroups,
    coverage: [
      'Analytics settings reviewed.',
      pr.hasData ? 'Collected analytics data from the last 28 days reviewed.' : 'Collected analytics data not available.',
      pr.gtmSource ? 'Compared with the tag manager setup.' : 'Not compared with the tag manager setup.',
      partial ? 'Some settings could not be read; see the technical report.' : ''
    ].filter(Boolean),
    first: actions.length ? actions[0].title : 'Keep the current setup under review.',
    caveat: 'Score reflects analytics configuration and data checks, not legal compliance or guaranteed data accuracy.',
    limits: 'Some settings (internal traffic, unwanted referrals, cross-domain, user access) are not readable with read-only access and need a manual check.',
    noActions: 'No recommendations from the available checks. Review the coverage notes before drawing conclusions.',
    heading: 'Google Analytics 4 review', title: 'Your analytics health.', footerLabel: 'GA4 client report',
    priorityNote: (pr.coverage.manual || []).length + ' settings to check manually are listed in the technical report.'
  };
}

function clientBadge(severity, label) {
  return `<span class="cr-badge cr-${severity || 'Info'}">${esc(label || severity + ' priority')}</span>`;
}

function clientActionRow(action, number) {
  return `<div class="cr-action"><span class="cr-number">${String(number).padStart(2, '0')}</span>
    <div><h3>${esc(action.title)}</h3><p>${esc(action.recommendation)}</p><small>${esc(action.evidence)}</small></div>
    <aside>${clientBadge(action.severity)}<p>Suggested team<br>${esc(action.team)}</p></aside></div>`;
}

function clientReportHtml(model) {
  const detailPages = [];
  for (let i = 0; i < model.actions.length; i += 3) detailPages.push(model.actions.slice(i, i + 3));
  const total = 1 + detailPages.length;
  const header = heading => `<header class="cr-header"><b>Tag Audit Studio</b><span>${esc(heading)}</span></header>`;
  const footer = page => `<footer class="cr-footer"><span>${esc(model.client)} · ${esc(model.date)}</span><span>${esc(model.footerLabel || 'Client report')} · ${page} / ${total}</span></footer>`;
  const stats = [['Audit findings', model.findingCount, 'Info'], ['High priority', model.counts.High, 'High'],
    ['Medium priority', model.counts.Medium, 'Medium'], ['Low priority', model.counts.Low, 'Low']];
  const gauge = model.score === null ? '<div class="cr-gauge cr-no-score"><b>—</b><small>No score available</small></div>'
    : `<div class="cr-gauge cr-score-${clientScoreTraffic(model.score)}" role="img" aria-label="Audit score ${model.score} out of 100">
      <svg viewBox="0 0 180 180" aria-hidden="true"><circle cx="90" cy="90" r="73" class="cr-track"/>
      <circle cx="90" cy="90" r="73" pathLength="100" class="cr-progress" stroke-dasharray="${model.score} 100"/></svg>
      <div><b>${model.score}</b><small>out of 100</small></div></div><span class="cr-grade cr-${clientScoreTraffic(model.score)}">Health grade ${esc(model.grade)}</span>`;
  return `<article class="client-report-page cr-dashboard">${header(model.heading || 'Website measurement & consent review')}
    <div class="cr-heading"><div><h1>${esc(model.title || 'Your measurement health.')}</h1><p>${esc(model.client)}</p><small>${esc(model.site)}</small></div><span>${esc(model.date)}</span></div>
    <section class="cr-stats">${stats.map(([label, value, severity]) =>
      `<div class="${severity !== 'Info' && value ? 'cr-stat-' + severity : ''}"><b>${value}</b><span>${label}</span></div>`).join('')}</section>
    <div class="cr-overview">
      <section class="cr-panel cr-health"><h2>Overall audit score</h2>${gauge}<h3>${esc(model.health)}</h3><p>Based on the available<br>configuration checks.</p></section>
      <section class="cr-panel"><h2>Where things stand</h2>${model.areas.map(area =>
        `<div class="cr-area"><div><strong>${esc(area.label)}</strong>${clientBadge(area.severity, area.status)}</div><p>${esc(area.note)}</p></div>`).join('')}</section>
    </div>
    <section class="cr-panel cr-priorities"><div><h2>Action priorities</h2>${model.findingCount
      ? `<div class="cr-stack" role="img" aria-label="${model.counts.High} high, ${model.counts.Medium} medium, ${model.counts.Low} low priority findings">${['High', 'Medium', 'Low'].filter(s => model.counts[s]).map(s =>
        `<span class="cr-${s}" style="flex:${model.counts[s]}"></span>`).join('')}</div>
        <p>High ${model.counts.High} · Medium ${model.counts.Medium} · Low ${model.counts.Low}</p>`
      : '<p>No configuration findings recorded.</p>'}
      <small>${model.priorityNote !== undefined ? esc(model.priorityNote)
        : model.liveCount ? model.liveCount + ' additional live-consent recommendation(s).' : 'No additional live-consent recommendations.'}</small></div>
      <div><h2>Recommended first</h2><h3>${esc(model.first)}</h3><p>${model.actions.length ? 'See the action plan for recommendations and follow-up checks.' : esc(model.noActions)}</p></div></section>
    <h2 class="cr-section-title">Your next steps</h2><section class="cr-panel cr-actions">${model.actions.length
      ? model.actions.slice(0, 2).map((action, i) => clientActionRow(action, i + 1)).join('')
      : `<p>${esc(model.noActions)}</p>`}</section>
    ${model.actions.length > 2 ? `<p class="cr-more">${model.actions.length - 2} further recommendation(s) in the full action plan. All recommendations are included on the following pages.</p>` : ''}
    <aside class="cr-coverage"><h3>Review coverage</h3><p>${model.coverage.map(esc).join(' ')}</p><p>${esc(model.caveat)}</p></aside>${footer(1)}</article>
    ${detailPages.map((actions, page) => `<article class="client-report-page cr-plan">${header('Recommendations & next steps')}
      <div class="cr-heading"><div><h1>Your action plan.</h1><p>Practical steps, ordered by priority.</p></div><span>${page * 3 + 1}–${page * 3 + actions.length} of ${model.actions.length}</span></div>
      ${actions.map((action, index) => `<section class="cr-panel cr-action-detail" data-finding="${action.id}">
        <div class="cr-detail-heading"><span class="cr-number">${String(page * 3 + index + 1).padStart(2, '0')}</span><h2>${esc(action.title)}</h2>${clientBadge(action.severity)}</div>
        <dl><div><dt>Why it matters</dt><dd>${esc(action.why)}</dd></div><div><dt>Recommendation</dt><dd>${esc(action.recommendation)}</dd></div>
        <div><dt>How to confirm</dt><dd>${esc(action.verify)}</dd></div></dl>
        <p class="cr-detail-meta">Suggested team: ${esc(action.team)} · ${esc(action.evidence)}${action.affected ? ' · ' + action.affected + ' referenced item(s)' : ''}</p>
      </section>`).join('')}
      <aside class="cr-coverage"><h3>After the changes</h3><p>${esc(model.limits)}</p><p>Use the separate technical report for implementation evidence and affected item names.</p></aside>${footer(page + 2)}</article>`).join('')}`;
}

let clientPptxLibrary = null;
function loadClientPptxLibrary() {
  if (typeof window.PptxGenJS === 'function') return Promise.resolve(window.PptxGenJS);
  if (clientPptxLibrary) return clientPptxLibrary;
  clientPptxLibrary = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    let timer;
    const fail = () => {
      clearTimeout(timer);
      script.remove();
      reject(new Error('PowerPoint export library could not load. Check your connection or CDN access and try again.'));
    };
    script.src = 'https://cdn.jsdelivr.net/npm/pptxgenjs@4.0.1/dist/pptxgen.bundle.js';
    script.integrity = 'sha384-qb0Xhi7LLYpvW1HCK6oMrmDLSY9sy7vwm6ZlV6KjtrlL9yg30+YN4neTwnmX+Kp8';
    script.crossOrigin = 'anonymous';
    script.referrerPolicy = 'no-referrer';
    script.onload = () => {
      clearTimeout(timer);
      if (typeof window.PptxGenJS !== 'function') { fail(); return; }
      resolve(window.PptxGenJS);
    };
    script.onerror = fail;
    timer = setTimeout(fail, 30000);
    document.head.appendChild(script);
  }).catch(error => { clientPptxLibrary = null; throw error; });
  return clientPptxLibrary;
}

function clientReportPresentation(model, Pptx) {
  const pptx = new Pptx();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.author = 'Tag Audit Studio';
  pptx.subject = 'Client-friendly website measurement review';
  pptx.title = model.client + ' - Measurement health';
  pptx.lang = 'en-GB';
  pptx.theme = { headFontFace: 'Aptos', bodyFontFace: 'Aptos', lang: 'en-GB' };
  const C = { ink: '16233A', muted: '607086', paper: 'F5F7FA', line: 'DCE2E9' };
  const actionSlides = Math.ceil(model.actions.length / 2);
  const total = 2 + actionSlides;
  let slideNumber = 0;
  const text = (slide, value, x, y, w, h, size, options) => slide.addText(String(value), Object.assign({
    x, y, w, h, fontFace: 'Aptos', fontSize: size, color: C.ink, margin: 0,
    breakLine: false, valign: 'mid', fit: 'shrink'
  }, options));
  const rect = (slide, x, y, w, h, color, line) => slide.addShape(pptx.ShapeType.rect, {
    x, y, w, h, fill: { color }, line: { color: line || color, width: 0.6 }
  });
  const badge = (slide, severity, label, x, y, w) => {
    const colors = CLIENT_PRIORITY_PALETTE[severity] || CLIENT_PRIORITY_PALETTE.Info;
    rect(slide, x, y, w, 0.28, colors.tint);
    text(slide, label, x + 0.06, y, w - 0.12, 0.28, 10, { bold: true, color: colors.ink });
  };
  const page = (heading, subtitle) => {
    const slide = pptx.addSlide();
    slide.background = { color: C.paper };
    text(slide, 'Tag Audit Studio', 0.45, 0.19, 3, 0.22, 11, { bold: true });
    text(slide, model.client + ' | ' + model.date, 6, 0.19, 6.85, 0.22, 10, { align: 'right', color: C.muted });
    rect(slide, 0.45, 0.52, 12.43, 0.01, C.line);
    text(slide, heading, 0.45, 0.69, 12.43, 0.48, 27, { bold: true });
    text(slide, subtitle, 0.45, 1.2, 12.43, 0.38, 12, { color: C.muted });
    text(slide, 'Client report | Configuration is not proof of execution', 0.45, 7.12, 10.5, 0.2, 9, { color: C.muted });
    text(slide, ++slideNumber + ' / ' + total, 11.6, 7.12, 1.28, 0.2, 9, { align: 'right', color: C.muted });
    return slide;
  };
  const dashboard = page('Your measurement health.', model.site);
  const stats = [[model.findingCount, 'Audit findings'], [model.counts.High, 'High priority'],
    [model.counts.Medium, 'Medium priority'], [model.counts.Low, 'Low priority']];
  stats.forEach(([value, label], index) => {
    const x = 0.45 + index * 3.15;
    const severity = ['Info', 'High', 'Medium', 'Low'][index];
    const fill = severity !== 'Info' && value ? CLIENT_PRIORITY_PALETTE[severity].tint : 'FFFFFF';
    rect(dashboard, x, 1.74, 2.98, 0.88, fill, C.line);
    text(dashboard, value, x + 0.16, 1.84, 0.72, 0.52, 30, { bold: true });
    text(dashboard, label, x + 0.94, 1.95, 1.86, 0.3, 12, { color: C.muted });
  });
  rect(dashboard, 0.45, 2.82, 3.36, 3.95, C.ink);
  text(dashboard, 'Overall audit score', 0.65, 3.0, 2.95, 0.24, 13, { color: 'FFFFFF', bold: true });
  if (model.score !== null) {
    dashboard.addChart(pptx.ChartType.doughnut, [{
      name: 'Audit health', labels: ['Score', 'Remaining'], values: [model.score, 100 - model.score]
    }], {
      x: 0.86, y: 3.35, w: 2.55, h: 2.08, holeSize: 85, firstSliceAng: 270,
      showLegend: false, showTitle: false, showValue: false, showPercent: false,
      chartColors: [CLIENT_PRIORITY_PALETTE[clientScoreTraffic(model.score)].onDark, '35465F'], chartArea: { fill: { color: C.ink } },
      plotArea: { fill: { color: C.ink } }, showBorder: false,
      layout: { x: 0, y: 0, w: 1, h: 1 }
    });
  }
  text(dashboard, model.score === null ? '—' : model.score, 1.1, 3.96, 2.06, 0.62, 42,
    { align: 'center', color: model.score === null ? 'FFFFFF' : CLIENT_PRIORITY_PALETTE[clientScoreTraffic(model.score)].onDark, bold: true });
  text(dashboard, model.score === null ? 'No score available' : 'out of 100 | Grade ' + model.grade,
    0.68, 4.68, 2.9, 0.26, 11, { align: 'center', color: 'C5D0E0' });
  text(dashboard, model.health, 0.65, 5.62, 2.95, 0.5, 18, { color: 'FFFFFF', bold: true, align: 'center' });
  text(dashboard, 'Based on available configuration checks.', 0.65, 6.19, 2.95, 0.36, 11,
    { color: 'C5D0E0', align: 'center' });
  rect(dashboard, 4.02, 2.82, 5.3, 3.95, 'FFFFFF', C.line);
  text(dashboard, 'Where things stand', 4.22, 3.01, 4.9, 0.3, 16, { bold: true });
  model.areas.forEach((area, index) => {
    const y = 3.51 + index * 0.6;
    text(dashboard, area.label, 4.22, y, 2.9, 0.25, 12, { bold: true });
    badge(dashboard, area.severity, area.status, 7.2, y, 1.91);
    text(dashboard, area.note, 4.22, y + 0.28, 4.8, 0.23, 10, { color: C.muted });
  });
  rect(dashboard, 9.53, 2.82, 3.35, 3.95, 'FFFFFF', C.line);
  text(dashboard, 'Recommended first', 9.73, 3.01, 2.95, 0.3, 16, { bold: true });
  if (model.actions.length) badge(dashboard, model.actions[0].severity, model.actions[0].severity + ' priority', 9.73, 3.55, 1.5);
  text(dashboard, model.first, 9.73, 4.02, 2.95, 0.9, 21, { bold: true });
  text(dashboard, model.actions.length ? 'Use the action plan to agree responsibilities and follow-up checks.' : model.noActions,
    9.73, 5.05, 2.95, 0.9, 13, { color: C.muted });
  text(dashboard, model.liveCount + ' additional live-consent recommendation(s). Live observations do not change the score.',
    9.73, 6.05, 2.95, 0.48, 10, { color: C.muted });

  for (let offset = 0; offset < model.actions.length; offset += 2) {
    const slide = page('Your action plan.', 'Recommendations ' + (offset + 1) + '–' +
      Math.min(offset + 2, model.actions.length) + ' of ' + model.actions.length + ' | Ordered by priority');
    model.actions.slice(offset, offset + 2).forEach((action, index) => {
      const x = 0.45 + index * 6.3;
      rect(slide, x, 1.83, 6.13, 4.96, 'FFFFFF', C.line);
      text(slide, String(offset + index + 1).padStart(2, '0'), x + 0.22, 2.04, 0.7, 0.5, 26, { color: C.muted });
      badge(slide, action.severity, action.severity + ' priority', x + 4.36, 2.13, 1.53);
      text(slide, action.title, x + 0.22, 2.76, 5.67, 0.64, 21, { bold: true });
      text(slide, 'Why it matters', x + 0.22, 3.63, 5.67, 0.23, 11, { bold: true, color: C.muted });
      text(slide, action.why, x + 0.22, 3.92, 5.67, 0.64, 14);
      text(slide, 'Recommendation', x + 0.22, 4.69, 5.67, 0.23, 11, { bold: true, color: C.muted });
      text(slide, action.recommendation, x + 0.22, 4.98, 5.67, 0.73, 14);
      text(slide, 'How to confirm: ' + action.verify, x + 0.22, 5.86, 5.67, 0.45, 11, { color: C.muted });
      text(slide, 'Suggested team: ' + action.team + '\n' + action.evidence +
        (action.affected ? ' | ' + action.affected + ' referenced item(s)' : ''), x + 0.22, 6.4, 5.67, 0.3, 10, { color: C.muted });
    });
  }
  const scope = page('What was reviewed.', 'Coverage, limitations and the next checkpoint');
  rect(scope, 0.45, 1.83, 7.6, 4.96, 'FFFFFF', C.line);
  text(scope, 'Review coverage', 0.72, 2.1, 7.06, 0.36, 20, { bold: true });
  model.coverage.forEach((line, index) => {
    text(scope, line, 0.72, 2.8 + index * 0.7, 7.06, 0.48, 15);
  });
  text(scope, model.caveat, 0.72, 5.95, 7.06, 0.58, 12, { color: C.muted });
  rect(scope, 8.27, 1.83, 4.61, 4.96, C.ink);
  text(scope, 'After the changes', 8.54, 2.1, 4.07, 0.5, 23, { bold: true, color: 'FFFFFF' });
  text(scope, model.limits, 8.54, 3.03, 4.07, 1.14, 17, { color: 'FFFFFF' });
  text(scope, 'Use the separate technical report for implementation evidence and affected item names.',
    8.54, 4.59, 4.07, 1.0, 15, { color: 'C5D0E0' });
  text(scope, 'This report is not legal advice.', 8.54, 6.0, 4.07, 0.4, 12, { color: 'C5D0E0' });
  return pptx;
}

async function exportClientPowerPoint(button) {
  if (button && button.disabled) return;
  const result = STATE.result;
  const name = 'client-report-' + fileSlug() + '.pptx';
  const label = button && button.textContent;
  if (button) { button.disabled = true; button.textContent = 'Preparing PowerPoint…'; }
  try {
    const model = clientReportModel(result);
    const Pptx = await loadClientPptxLibrary();
    const deck = clientReportPresentation(model, Pptx);
    await deck.writeFile({ fileName: name });
    toast('PowerPoint created. Text, shapes and the score chart are editable.');
  } finally {
    if (button) { button.disabled = false; button.textContent = label; }
  }
}
