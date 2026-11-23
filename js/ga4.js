// ════════════════════════════════════════════════════════════════════
//  Tag Audit Studio — GA4 audit engine
//  Turns the data read by fetchGa4Full() (google.js) into a GA4 report:
//  issues, area scores, an event cross-reference with GTM, configuration
//  inventory, data quality tables and coverage notes.
//  Browser-only and synchronous (no DOM). Not part of the Apps Script port.
//  Uses truncate_, joinParts_, GA4_STANDARD_PARAMS, GA4_AUTO_EVENTS and
//  SEVERITY_ORDER from engine.js.
// ════════════════════════════════════════════════════════════════════

const GA4A_AREAS = ['Collection & streams', 'Events & key events', 'Custom definitions', 'Data quality',
                    'Privacy & retention', 'Integrations', 'Attribution & reporting', 'GTM alignment'];
const GA4A_WEIGHTS = {
  'Collection & streams': 2, 'Events & key events': 2, 'Custom definitions': 1, 'Data quality': 2,
  'Privacy & retention': 2, 'Integrations': 1, 'Attribution & reporting': 0.5, 'GTM alignment': 1.5
};
const GA4A_PENALTY = { High: 30, Medium: 12, Low: 4 };

/** Enhanced measurement setting → the event names it sends. */
const GA4A_EM_EVENTS = {
  scrollsEnabled: ['scroll'], outboundClicksEnabled: ['click'], siteSearchEnabled: ['view_search_results'],
  videoEngagementEnabled: ['video_start', 'video_progress', 'video_complete'], fileDownloadsEnabled: ['file_download'],
  formInteractionsEnabled: ['form_start', 'form_submit']
};
/** Same, keyed by the labels parseGtagStreamSettings_() returns (fallback when the Admin API v1alpha is unavailable). */
const GA4A_EM_LABEL_EVENTS = {
  'scrolls': ['scroll'], 'outbound clicks': ['click'], 'site search': ['view_search_results'],
  'video engagement': ['video_start', 'video_progress', 'video_complete'], 'file downloads': ['file_download'],
  'form interactions': ['form_start', 'form_submit']
};

const GA4A_RESERVED_EVENTS = new Set(['ad_activeview', 'ad_click', 'ad_exposure', 'ad_query', 'ad_reward', 'adunit_exposure',
  'app_background', 'app_clear_data', 'app_exception', 'app_remove', 'app_store_refund', 'app_update', 'app_upgrade',
  'error', 'first_open', 'first_visit', 'in_app_purchase', 'notification_dismiss', 'notification_foreground',
  'notification_open', 'notification_receive', 'os_update', 'session_start', 'user_engagement']);

const GA4A_PAYMENT_SOURCES = /paypal|stripe|klarna|adyen|worldpay|sagepay|opayo|checkout\.com|braintree|clearpay|afterpay|mollie|paddle|3dsecure|acs\.|secure.*bank|cardinalcommerce/i;

const GA4A_MANUAL_CHECKS = [
  ['Internal traffic', 'Admin → Data streams → Configure tag settings → Define internal traffic, and Admin → Data filters. Not readable through the API.'],
  ['Unwanted referrals', 'Admin → Data streams → Configure tag settings → List unwanted referrals (payment providers, own domains).'],
  ['Cross-domain measurement', 'Admin → Data streams → Configure tag settings → Configure your domains.'],
  ['Session timeout', 'Admin → Data streams → Configure tag settings → Adjust session timeout.'],
  ['User access', 'Admin → Account / Property access management: remove leavers and personal accounts; keep Administrators to a minimum.'],
  ['Change history', 'Admin → Change history: recent unexpected changes (needs edit access to read through the API).'],
  ['Consent', 'Check that Google signals, ads personalisation and user-provided data collection match the consent banner and privacy policy.']
];

const GA4A_DIM_QUOTA = { standard: { EVENT: 50, USER: 25 }, premium: { EVENT: 125, USER: 100 } };

function ga4Host_(url) {
  if (!url) return '';
  try { return new URL(/^https?:/i.test(url) ? url : 'https://' + url).hostname.toLowerCase().replace(/^www\./, ''); }
  catch (e) { return String(url).toLowerCase().replace(/^www\./, ''); }
}

function ga4Pct_(part, total) { return total ? Math.round(part / total * 1000) / 10 : 0; }
function ga4Num_(n) { return Number(n || 0).toLocaleString('en-GB'); }
function ga4Enum_(v) { return v ? String(v).toLowerCase().replace(/_/g, ' ') : '—'; }
function ga4YesNo_(v) { return v === true ? 'Yes' : v === false ? 'No' : '—'; }
function ga4List_(arr, empty) {
  if (arr === null || arr === undefined) return 'Not available';
  return arr.length ? arr.join(', ') : (empty || 'None');
}

/**
 * The GTM audit facts the GA4 report cross-references, from a serialised GTM result.
 * Returns null when there is no GTM audit.
 */
function ga4GtmContext(result) {
  if (!result || !result.audit) return null;
  const a = result.audit;
  const idList = Object.keys(a.ids || {}).map(k => a.ids[k]);
  return {
    source: (result.meta && result.meta.sources || []).filter(s => !/^GA4 /.test(s)).join(', ') || 'GTM audit',
    fullDetail: !!a.fullDetail,
    events: (a.ga4Events || []).map(e => ({ name: e.name, params: e.params || [], where: e.where, mid: e.mid || '' })),
    googleTagIds: Array.from(new Set((a.googleTags || []).map(g => g.id).concat((a.pageGoogleConfigs || []).map(c => c.id)))),
    liveGa4Ids: idList.filter(x => x.platform === 'GA4' && x.live).map(x => x.id),
    userProps: a.userProps || [],
    adsTagsLive: (a.tags || []).some(t => !t.paused && /^(awct|sp|gclidw)$/.test(t.type)),
    gtagSettings: a.gtagSettings || {}
  };
}

/** Builds the GA4 report for one property. `gtm` comes from ga4GtmContext() or is null. */
function buildGa4Result(d, gtm, meta) {
  meta = meta || {};
  const A = d.admin || {}, D = d.data || {};
  const prop = A.property || {};
  const where = d.displayName;
  const issues = [];
  const add = (area, severity, finding, action, items) =>
    issues.push({ area: area, severity: severity, finding: finding, action: action, where: where, items: items || [] });

  const hasData = Array.isArray(D.events);
  const streams = A.streams || [];
  const webStreams = streams.filter(s => s.type === 'WEB_DATA_STREAM');
  const streamMids = new Set(webStreams.map(s => s.measurementId).filter(Boolean));
  const received = new Map((D.events || []).map(e => [e.name, e]));
  const totalEvents = (D.events || []).reduce((s, e) => s + e.count, 0);
  const totalSessions = (D.channels || []).reduce((s, c) => s + c.sessions, 0);
  const keyEvents = A.keyEvents;   // null = not readable
  const keyNames = new Set((keyEvents || []).map(k => k.eventName));

  // Only cross-reference GTM when it actually sends data to this property
  const gtmRelevant = !!(gtm && gtm.liveGa4Ids.some(id => streamMids.has(id)));
  const notes = [];
  if (gtm && !gtmRelevant) {
    notes.push('The GTM audit in this session does not send data to this property (' + (Array.from(streamMids).join(', ') || 'no web streams') +
               '), so GTM alignment was not checked.');
  }
  let gtmEvents = [];
  if (gtmRelevant) {
    const matched = gtm.events.filter(e => e.mid && streamMids.has(e.mid));
    const unknown = gtm.events.filter(e => !e.mid);
    gtmEvents = matched.concat(unknown);
    if (unknown.length) {
      notes.push(unknown.length + ' GA4 event tag(s) in GTM do not name their measurement ID directly (they use a variable or the Google tag), ' +
                 'so they were assumed to send to this property.');
    }
  }
  const gtmByName = new Map();
  gtmEvents.forEach(e => {
    const n = String(e.name).replace(/\s\(\{\{[^}]*\}\}\)$/, '');
    if (!gtmByName.has(n)) gtmByName.set(n, []);
    gtmByName.get(n).push(e);
  });

  // Enhanced measurement events per web stream (Admin API, else the public Google tag)
  const emEvents = new Set();
  webStreams.forEach(s => {
    if (s.enhanced && s.enhanced.streamEnabled) {
      Object.keys(GA4A_EM_EVENTS).forEach(k => { if (s.enhanced[k]) GA4A_EM_EVENTS[k].forEach(e => emEvents.add(e)); });
    } else if (!s.enhanced && gtm && gtm.gtagSettings[s.measurementId]) {
      (gtm.gtagSettings[s.measurementId].enhanced || []).forEach(l => (GA4A_EM_LABEL_EVENTS[l] || []).forEach(e => emEvents.add(e)));
    }
  });
  const ruleEvents = new Set();
  webStreams.forEach(s => (s.createRules || []).forEach(r => r.destinationEvent && ruleEvents.add(r.destinationEvent)));

  // ── Collection & streams ──
  if (!streams.length) {
    add('Collection & streams', 'High', 'The property has no data streams', 'Create a web data stream and install its Google tag');
  }
  if (hasData && totalEvents === 0) {
    add('Collection & streams', 'High', 'No data received in the last 28 days',
        'Check the Google tag is installed and fires on the site, and that consent settings allow (cookieless) collection');
  } else if (hasData && Array.isArray(D.streams)) {
    const withData = new Set(D.streams.filter(s => s.count > 0).map(s => String(s.id)));
    const silent = streams.filter(s => !withData.has(String(s.id)));
    if (silent.length) {
      add('Collection & streams', 'Medium', silent.length + ' data stream(s) received no data in the last 28 days',
          'Remove unused streams, or check the tag for each one is installed', silent.map(s => s.displayName + (s.measurementId ? ' (' + s.measurementId + ')' : '')));
    }
  }
  const byHost = new Map();
  webStreams.forEach(s => {
    const h = ga4Host_(s.defaultUri);
    if (h) byHost.set(h, (byHost.get(h) || []).concat(s));
  });
  byHost.forEach((list, host) => {
    if (list.length > 1) {
      add('Collection & streams', 'Medium', list.length + ' web streams for ' + host,
          'Use one web stream per site; extra streams split the data', list.map(s => s.displayName + ' (' + s.measurementId + ')'));
    }
  });
  const siteHost = ga4Host_(meta.site);
  if (siteHost && webStreams.length && !webStreams.some(s => {
    const h = ga4Host_(s.defaultUri);
    return h && (h === siteHost || h.endsWith('.' + siteHost) || siteHost.endsWith('.' + h));
  })) {
    add('Collection & streams', 'Low', 'No web stream URL matches ' + siteHost,
        'Check this is the right property for the site, or update the stream URL', webStreams.map(s => s.defaultUri || s.displayName));
  }
  const expectedHosts = Array.from(new Set(webStreams.map(s => ga4Host_(s.defaultUri)).concat(siteHost ? [siteHost] : []).filter(Boolean)));
  if (hasData && expectedHosts.length && Array.isArray(D.hosts)) {
    const hostTotal = D.hosts.reduce((s, h) => s + h.count, 0);
    const odd = D.hosts.filter(h => {
      const host = ga4Host_(h.host);
      return host && host !== '(not set)' && !expectedHosts.some(e => host === e || host.endsWith('.' + e) || e.endsWith('.' + host));
    });
    if (odd.length) {
      const share = ga4Pct_(odd.reduce((s, h) => s + h.count, 0), hostTotal);
      add('Collection & streams', share > 1 ? 'Medium' : 'Low',
          'Data received from ' + odd.length + ' unexpected hostname(s) (' + share + '% of events)',
          'Check for staging, test, translation or spam traffic; exclude it with a data filter or fix the tag',
          odd.slice(0, 15).map(h => h.host + ' (' + ga4Num_(h.count) + ')'));
    }
  }

  // ── Events & key events ──
  if (keyEvents !== null && keyEvents !== undefined) {
    if (!keyEvents.length) {
      add('Events & key events', 'Medium', 'No key events (conversions) set up', 'Mark the business-critical events as key events');
    } else if (hasData) {
      const dead = keyEvents.filter(k => !(received.get(k.eventName) || {}).count);
      if (dead.length) {
        add('Events & key events', 'Medium', dead.length + ' key event(s) received no data in the last 28 days',
            'Check the events still fire, or remove key events that are no longer used', dead.map(k => k.eventName));
      }
    }
    const perSession = (keyEvents || []).filter(k => /purchase/.test(k.eventName) && k.countingMethod === 'ONCE_PER_SESSION');
    if (perSession.length) {
      add('Events & key events', 'Medium', 'Purchase key event counted once per session',
          'Count purchases once per event, or repeat purchases in a session are lost', perSession.map(k => k.eventName));
    }
  }
  const allNames = Array.from(new Set(Array.from(received.keys()).concat(Array.from(gtmByName.keys()))))
    .filter(n => n && n !== '(other)' && !/\{\{/.test(n));
  const badNames = allNames.filter(n => !/^[a-z][a-z0-9_]*$/.test(n) || n.length > 40 || /^(firebase_|google_|ga_)/.test(n));
  if (badNames.length) {
    add('Events & key events', 'Low', badNames.length + ' event name(s) not in snake_case, too long or using a reserved prefix',
        'Use lowercase_with_underscores, at most 40 characters, without google_/ga_/firebase_ prefixes', badNames.slice(0, 20));
  }
  const reservedFromGtm = Array.from(gtmByName.keys()).filter(n => GA4A_RESERVED_EVENTS.has(n));
  if (reservedFromGtm.length) {
    add('Events & key events', 'Medium', 'GTM sends reserved GA4 event name(s)',
        'Rename these events; GA4 reserves them and may drop them', reservedFromGtm);
  }
  if (hasData && (received.has('(other)') || received.size >= 500)) {
    add('Events & key events', 'Low', 'Too many distinct event names (' + received.size + (received.has('(other)') ? ', with an "(other)" row' : '') + ')',
        'Use fewer event names and put the detail in parameters');
  }

  // ── Custom definitions ──
  const dims = A.customDimensions;
  if (dims) {
    const tier = prop.serviceLevel === 'GOOGLE_ANALYTICS_360' ? 'premium' : 'standard';
    ['EVENT', 'USER'].forEach(scope => {
      const used = dims.filter(x => x.scope === scope).length;
      const quota = GA4A_DIM_QUOTA[tier][scope];
      if (used >= quota * 0.9) {
        add('Custom definitions', 'Low', used + ' of ' + quota + ' ' + scope.toLowerCase() + '-scoped custom dimensions used',
            'Archive dimensions that are no longer needed before the limit is reached');
      }
    });
    if (Array.isArray(D.dimFill)) {
      const empty = D.dimFill.filter(x => !x.total || x.notSet / x.total >= 0.99);
      if (empty.length) {
        add('Custom definitions', 'Low', empty.length + ' custom dimension(s) registered but receive no data',
            'Check the parameter is still sent with that exact name, or archive the dimension', empty.map(x => x.param));
      }
    }
    if (gtmRelevant) {
      const eventDims = new Set(dims.filter(x => x.scope === 'EVENT').map(x => x.parameterName));
      const userDims = new Set(dims.filter(x => x.scope === 'USER').map(x => x.parameterName));
      const sent = new Set();
      gtmEvents.forEach(e => e.params.forEach(p => { if (!/\{\{/.test(p)) sent.add(p); }));
      const missing = Array.from(sent).filter(x => !eventDims.has(x) && !GA4_STANDARD_PARAMS.has(x));
      if (missing.length) {
        add('Custom definitions', 'Low', missing.length + ' event parameter(s) sent from GTM but not registered as custom dimensions',
            'Register the ones you need in reports (Admin → Custom definitions)', missing);
      }
      const missingUser = (gtm.userProps || []).filter(x => !userDims.has(x));
      if (missingUser.length) {
        add('Custom definitions', 'Low', missingUser.length + ' user propert(ies) sent from GTM but not registered',
            'Register them as user-scoped custom dimensions', missingUser);
      }
    }
  }

  // ── Data quality ──
  if (hasData && totalSessions) {
    const unassigned = (D.channels || []).filter(c => c.name === 'Unassigned').reduce((s, c) => s + c.sessions, 0);
    const share = ga4Pct_(unassigned, totalSessions);
    if (share > 3) {
      add('Data quality', share > 10 ? 'Medium' : 'Low', share + '% of sessions are in the Unassigned channel',
          'Check UTM tagging and the default channel group; often caused by missing or non-standard utm_medium values');
    }
    const lp = ga4Pct_(D.landingNotSet || 0, totalSessions);
    if (lp > 5) {
      add('Data quality', 'Low', lp + '% of sessions have no landing page ("(not set)")',
          'Usually sessions without a page_view (consent, events before the Google tag, or Measurement Protocol); check the tag order');
    }
    const own = expectedHosts.length ? (D.sources || []).filter(s => expectedHosts.some(h => ga4Host_(s.source) === h || ga4Host_(s.source).endsWith('.' + h))) : [];
    const ownShare = ga4Pct_(own.reduce((s, x) => s + x.sessions, 0), totalSessions);
    if (ownShare > 1) {
      add('Data quality', 'Low', 'Self-referrals: ' + ownShare + '% of sessions come from the site\'s own domain',
          'Set up cross-domain measurement or list the domains as unwanted referrals', own.map(s => s.source));
    }
    const pay = (D.sources || []).filter(s => GA4A_PAYMENT_SOURCES.test(s.source));
    if (pay.length) {
      add('Data quality', 'Low', 'Payment providers appear as traffic sources',
          'List them under unwanted referrals so purchases keep their original source', pay.map(s => s.source + ' (' + ga4Num_(s.sessions) + ')'));
    }
  }
  const pu = D.purchases;
  if (pu && pu.events > 0) {
    if (pu.notSet > 0) {
      add('Data quality', 'Medium', ga4Num_(pu.notSet) + ' purchase event(s) without a transaction ID',
          'Send transaction_id with every purchase so GA4 can remove duplicates');
    }
    if (pu.duplicateIds > 0) {
      add('Data quality', 'Medium', pu.duplicateIds + ' transaction ID(s) recorded more than once',
          'Stop the purchase event firing again on reload or revisit of the confirmation page');
    }
    if (!pu.revenue) {
      add('Data quality', 'Medium', 'Purchases are recorded with no revenue', 'Send value and currency with the purchase event');
    }
  }

  // ── Privacy & retention ──
  if (Array.isArray(D.piiPages) && D.piiPages.length) {
    add('Privacy & retention', 'High', 'Possible personal data in page URLs (' + D.piiPages.length + ' URL pattern(s), ' +
        ga4Num_(D.piiPages.reduce((s, p) => s + p.views, 0)) + ' views)',
        'Stop personal data reaching GA4 (fix the forms that put it in URLs, turn on redaction); Google\'s terms forbid it',
        D.piiPages.slice(0, 5).map(p => p.masked));
  }
  const ret = A.retention;
  if (ret) {
    if (ret.eventDataRetention === 'TWO_MONTHS') {
      add('Privacy & retention', 'Medium', 'Event data retention is only 2 months',
          'Set it to 14 months (Admin → Data collection and modification → Data retention); Explorations cannot look further back');
    }
    if (ret.resetUserDataOnNewActivity === false) {
      add('Privacy & retention', 'Low', 'User data is not kept while users stay active',
          'Turn on "Reset user data on new activity" so retention counts from the last visit');
    }
  }
  const noRedaction = webStreams.filter(s => s.redaction && s.redaction.emailRedactionEnabled === false);
  if (noRedaction.length) {
    add('Privacy & retention', 'Low', 'Email redaction is off on ' + noRedaction.length + ' web stream(s)',
        'Turn on email redaction (Admin → Data streams → the stream → Redact data)', noRedaction.map(s => s.displayName));
  }
  const mp = streams.filter(s => s.mpSecrets > 0);
  if (mp.length) {
    add('Privacy & retention', 'Low', 'Measurement Protocol secrets exist on ' + mp.length + ' stream(s)',
        'Confirm each is still used and kept server-side; delete unused ones', mp.map(s => s.displayName + ' (' + s.mpSecrets + ')'));
  }

  // ── Integrations ──
  if (A.adsLinks && gtmRelevant && gtm.adsTagsLive && !A.adsLinks.length) {
    add('Integrations', 'Medium', 'GA4 is not linked to Google Ads, but Google Ads tags are live in GTM',
        'Link the Ads account (Admin → Product links) to share key events and audiences');
  }

  // ── GTM alignment ──
  if (gtmRelevant) {
    if (hasData) {
      const notReceived = Array.from(gtmByName.keys()).filter(n => !/\{\{/.test(n) && !(received.get(n) || {}).count);
      if (notReceived.length) {
        add('GTM alignment', 'Medium', notReceived.length + ' event(s) tagged in GTM but not received in GA4 (28 days)',
            'Check the triggers fire and the tags send to this property; remove tags that are no longer needed', notReceived);
      }
    }
    const dupes = Array.from(gtmByName.keys()).filter(n => emEvents.has(n));
    if (dupes.length) {
      add('GTM alignment', 'Medium', dupes.length + ' event(s) sent by both GTM and enhanced measurement',
          'Turn off that enhanced measurement option, or remove the GTM tag, to avoid double counting', dupes);
    }
    if (keyEvents && keyEvents.length) {
      const orphan = keyEvents.map(k => k.eventName).filter(n => !gtmByName.has(n) && !GA4_AUTO_EVENTS.has(n) &&
        !emEvents.has(n) && !ruleEvents.has(n));
      if (orphan.length) {
        add('GTM alignment', 'Low', orphan.length + ' key event(s) not sent from this GTM container',
            'Check where they come from (page code, another container, Measurement Protocol)', orphan);
      }
    }
    if (hasData && Array.isArray(D.streams)) {
      const tagged = new Set(gtm.googleTagIds);
      const untagged = webStreams.filter(s => s.measurementId && !tagged.has(s.measurementId) &&
        D.streams.some(x => String(x.id) === String(s.id) && x.count > 0));
      if (untagged.length) {
        add('GTM alignment', 'Low', untagged.length + ' stream(s) receive data but have no Google tag in this GTM container',
            'Find what sends this data (hard-coded gtag, another container, an app) and document it', untagged.map(s => s.measurementId));
      }
    }
  }

  // ── Event cross-reference ──
  const xNames = Array.from(new Set(Array.from(received.keys()).concat(Array.from(gtmByName.keys()), Array.from(keyNames))))
    .filter(n => n && n !== '(other)');
  const crossRef = xNames.map(n => {
    const ev = received.get(n);
    const count = ev ? ev.count : 0;
    const inGtm = gtmByName.get(n) || [];
    const isKey = keyNames.has(n);
    let status, sev;
    if (/\{\{/.test(n)) { status = 'Name set by a GTM variable (not checked)'; sev = 'Info'; }
    else if (inGtm.length && emEvents.has(n)) { status = 'Possible duplicate (enhanced measurement)'; sev = 'Medium'; }
    else if (inGtm.length && hasData && !count && !/\{\{/.test(n)) { status = 'Tagged, not received'; sev = 'Medium'; }
    else if (isKey && hasData && !count) { status = 'Key event never received'; sev = 'Medium'; }
    else if (!inGtm.length && count) {
      status = GA4_AUTO_EVENTS.has(n) || emEvents.has(n) ? 'Automatically collected'
        : ruleEvents.has(n) ? 'Created by an event rule'
        : gtmRelevant ? 'Received, not from this GTM container' : 'Received';
      sev = 'Info';
    } else if (!hasData) { status = 'Collected data not available'; sev = 'Info'; }
    else { status = 'OK'; sev = 'OK'; }
    return { name: n, inGtm: inGtm.map(e => e.where), count: count, users: ev ? ev.users : 0, isKey: isKey, status: status, sev: sev };
  }).sort((a, b) => ({ Medium: 0, Info: 2, OK: 1 }[a.sev] - { Medium: 0, Info: 2, OK: 1 }[b.sev]) || b.count - a.count || a.name.localeCompare(b.name));

  // ── Areas and score ──
  const sorted = issues.slice().sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  const checked = area => area === 'GTM alignment' ? gtmRelevant : area === 'Data quality' ? hasData : true;
  const areaScore = area => Math.max(0, 100 - sorted.filter(i => i.area === area).reduce((s, i) => s + GA4A_PENALTY[i.severity], 0));
  const areas = GA4A_AREAS.map(area => {
    const list = sorted.filter(i => i.area === area);
    const isChecked = checked(area);
    const status = list.length ? (list[0].severity === 'High' ? 'Action needed' : list[0].severity === 'Medium' ? 'Review' : 'Minor')
      : !isChecked ? 'Not checked' : 'No issues';
    const findings = list.length ? list.map(i => i.finding)
      : !isChecked ? [area === 'GTM alignment' ? 'Run a GTM audit for this site in the same session' : 'Collected data (Data API) was not available'] : [];
    return { area: area, score: isChecked ? areaScore(area) : null, status: status, findings: findings,
             action: list[0] ? list[0].action : '', top: list[0] ? list[0].severity : null };
  });
  let total = 0, weight = 0;
  areas.forEach(a => { if (a.score !== null) { total += a.score * GA4A_WEIGHTS[a.area]; weight += GA4A_WEIGHTS[a.area]; } });
  const score = weight ? Math.round(total / weight) : 100;
  const grade = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : score >= 40 ? 'D' : 'E';

  if (D.thresholded) notes.push('Some Data API results were subject to thresholding (usually because Google signals is on); small numbers may be hidden.');
  if (D.otherRow) notes.push('Some Data API results grouped rare values into "(other)", so counts for rare values are incomplete.');

  return {
    property: d.property, displayName: d.displayName, account: d.account, fetchedAt: d.fetchedAt,
    meta: { client: meta.client || '', site: meta.site || '', date: meta.date || new Date().toISOString() },
    summary: {
      streams: streams.length, webStreams: webStreams.length, measurementIds: Array.from(streamMids),
      events28d: hasData ? totalEvents : null, sessions28d: hasData ? totalSessions : null,
      eventNames: hasData ? received.size : null, keyEvents: keyEvents ? keyEvents.length : null,
      realtime: D.realtime === undefined ? null : D.realtime
    },
    hasData: hasData,
    campaigns30d: D.campaigns30d || null,   // for the CM360 cross-check (sessions per campaign, last 30 days)
    organic28d: D.organic || null,          // for the Search Console cross-check (organic Google sessions per landing page)
    gtmSource: gtmRelevant ? gtm.source : null,
    issues: sorted, areas: areas, score: { score: score, grade: grade },
    crossRef: crossRef,
    config: ga4ConfigSections_(A),
    quality: ga4QualitySections_(D, totalEvents, totalSessions),
    coverage: {
      unavailable: d.unavailable || [],
      notes: notes,
      manual: GA4A_MANUAL_CHECKS
    }
  };
}

/** Configuration inventory as titled key/value sections. */
function ga4ConfigSections_(A) {
  const p = A.property || {};
  const sections = [];
  sections.push({ title: 'Property', rows: [
    ['Name', p.displayName || '—'], ['Property', (p.name || '').replace('properties/', '') || '—'],
    ['Time zone', p.timeZone || '—'], ['Currency', p.currencyCode || '—'],
    ['Industry', ga4Enum_(p.industryCategory)], ['Service level', ga4Enum_(p.serviceLevel)],
    ['Created', p.createTime ? new Date(p.createTime).toLocaleDateString('en-GB') : '—']
  ] });
  (A.streams || []).forEach(s => {
    const em = s.enhanced;
    const emOn = em ? (em.streamEnabled ? Object.keys(GA4A_EM_EVENTS).filter(k => em[k]).map(k => k.replace(/Enabled$/, '').replace(/([A-Z])/g, ' $1').toLowerCase()) : []) : null;
    sections.push({ title: 'Data stream: ' + (s.displayName || s.id), rows: [
      ['Type', ga4Enum_(s.type)], ['Measurement ID', s.measurementId || '—'], ['URL', s.defaultUri || '—'],
      ['Enhanced measurement', emOn === null ? 'Not available' : em.streamEnabled ? (emOn.join(', ') || 'on, no options') : 'Off'],
      ['Email redaction', s.redaction ? ga4YesNo_(s.redaction.emailRedactionEnabled) : 'Not available'],
      ['Query parameter redaction', s.redaction ? (s.redaction.queryParameterRedactionEnabled ? (s.redaction.queryParameterKeys || []).join(', ') || 'On' : 'Off') : 'Not available'],
      ['Event create rules', s.createRules ? ga4List_(s.createRules.map(r => r.destinationEvent)) : 'Not available'],
      ['Event edit rules', s.editRules ? ga4List_(s.editRules.map(r => r.displayName)) : 'Not available'],
      ['Measurement Protocol secrets', s.mpSecrets === null ? 'Not available' : String(s.mpSecrets)]
    ] });
  });
  const r = A.retention;
  const sig = A.signals, at = A.attribution, ds = A.dataSharing;
  sections.push({ title: 'Privacy and data settings', rows: [
    ['Event data retention', r ? ga4Enum_(r.eventDataRetention) : 'Not available'],
    ['User data retention', r ? ga4Enum_(r.userDataRetention) : 'Not available'],
    ['Reset user data on new activity', r ? ga4YesNo_(r.resetUserDataOnNewActivity) : 'Not available'],
    ['Google signals', sig ? ga4Enum_(sig.state).replace('google signals ', '') : 'Not available'],
    ['Data sharing with Google', ds ? joinParts_(ds.sharingWithGoogleProductsEnabled && 'products',
      ds.sharingWithGoogleSupportEnabled && 'support', ds.sharingWithGoogleAssignedSalesEnabled && 'assigned sales',
      ds.sharingWithGoogleAnySalesEnabled && 'any sales', ds.sharingWithOthersEnabled && 'modelling contributions') || 'None' : 'Not available']
  ] });
  sections.push({ title: 'Attribution', rows: at ? [
    ['Reporting attribution model', ga4Enum_(at.reportingAttributionModel)],
    ['Acquisition key event lookback', ga4Enum_(at.acquisitionConversionEventLookbackWindow)],
    ['Other key event lookback', ga4Enum_(at.otherConversionEventLookbackWindow)],
    ['Channels that can receive credit (Ads export)', ga4Enum_(at.adsWebConversionDataExportScope)]
  ] : [['Attribution settings', 'Not available']] });
  const ke = A.keyEvents, cd = A.customDimensions, cm = A.customMetrics;
  sections.push({ title: 'Key events and custom definitions', rows: [
    ['Key events', ke ? ga4List_(ke.map(k => k.eventName + (k.countingMethod === 'ONCE_PER_SESSION' ? ' (once per session)' : ''))) : 'Not available'],
    ['Event-scoped dimensions', cd ? ga4List_(cd.filter(x => x.scope === 'EVENT').map(x => x.parameterName)) : 'Not available'],
    ['User-scoped dimensions', cd ? ga4List_(cd.filter(x => x.scope === 'USER').map(x => x.parameterName)) : 'Not available'],
    ['Item-scoped dimensions', cd ? ga4List_(cd.filter(x => x.scope === 'ITEM').map(x => x.parameterName)) : 'Not available'],
    ['Custom metrics', cm ? ga4List_(cm.map(x => x.parameterName)) : 'Not available'],
    ['Calculated metrics', ga4List_(A.calculatedMetrics)]
  ] });
  sections.push({ title: 'Product links', rows: [
    ['Google Ads', A.adsLinks ? ga4List_(A.adsLinks.map(l => l.customerId + (l.adsPersonalizationEnabled ? ' (personalised ads on)' : ''))) : 'Not available'],
    ['BigQuery', ga4List_(A.bigQueryLinks)], ['Firebase', ga4List_(A.firebaseLinks)],
    ['Display & Video 360', ga4List_(A.dv360Links)], ['Search Ads 360', ga4List_(A.sa360Links)], ['AdSense', ga4List_(A.adSenseLinks)]
  ] });
  sections.push({ title: 'Reporting', rows: [
    ['Audiences', A.audiences ? A.audiences.length + (A.audiences.length ? ': ' + truncate_(A.audiences.join(', '), 300) : '') : 'Not available'],
    ['Channel groups', ga4List_(A.channelGroups)],
    ['Annotations', A.annotations ? String(A.annotations.length) : 'Not available']
  ] });
  return sections;
}

/** Collected-data tables for the Data quality tab. */
function ga4QualitySections_(D, totalEvents, totalSessions) {
  if (!Array.isArray(D.events)) return [];
  const out = [];
  out.push({ title: 'Hostnames', columns: ['Hostname', 'Events', 'Share'],
    rows: (D.hosts || []).slice(0, 25).map(h => [h.host, ga4Num_(h.count), ga4Pct_(h.count, totalEvents) + '%']) });
  out.push({ title: 'Default channel groups', columns: ['Channel', 'Sessions', 'Share'],
    rows: (D.channels || []).slice().sort((a, b) => b.sessions - a.sessions).map(c => [c.name, ga4Num_(c.sessions), ga4Pct_(c.sessions, totalSessions) + '%']) });
  out.push({ title: 'Top session sources', columns: ['Source', 'Sessions', 'Share'],
    rows: (D.sources || []).slice(0, 20).map(s => [s.source, ga4Num_(s.sessions), ga4Pct_(s.sessions, totalSessions) + '%']) });
  out.push({ title: 'Data streams', columns: ['Stream', 'Stream ID', 'Events'],
    rows: (D.streams || []).map(s => [s.name, s.id, ga4Num_(s.count)]) });
  if (D.purchases && D.purchases.events) {
    const p = D.purchases;
    out.push({ title: 'Purchases', columns: ['Check', 'Value'], rows: [
      ['Purchase events', ga4Num_(p.events)], ['Distinct transaction IDs', ga4Num_(p.ids)],
      ['Without transaction ID', ga4Num_(p.notSet)], ['IDs recorded more than once', ga4Num_(p.duplicateIds)],
      ['Purchase revenue', ga4Num_(Math.round(p.revenue))]
    ] });
  }
  if (Array.isArray(D.dimFill) && D.dimFill.length) {
    out.push({ title: 'Custom dimension fill rate', columns: ['Parameter', 'Scope', 'Events', 'Empty ("(not set)")'],
      rows: D.dimFill.map(x => [x.param, ga4Enum_(x.scope), ga4Num_(x.total), x.total ? ga4Pct_(x.notSet, x.total) + '%' : '—']) });
  }
  if (Array.isArray(D.piiPages) && D.piiPages.length) {
    out.push({ title: 'Page URLs that may contain personal data (masked)', columns: ['URL (masked)', 'Views'],
      rows: D.piiPages.map(p => [p.masked, ga4Num_(p.views)]) });
  }
  return out;
}
