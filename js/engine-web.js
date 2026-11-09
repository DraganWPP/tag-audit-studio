// ════════════════════════════════════════════════════════════════════
//  Tag Audit Studio — browser layer for the audit engine
//  Replaces the Apps Script parts of the engine: state, settings,
//  container cache, GA4 property data, live test data and overrides.
//  Everything here is synchronous; network calls happen in google.js /
//  app.js BEFORE the engine runs, and their results are handed in.
// ════════════════════════════════════════════════════════════════════

const Logger = { log: m => console.debug('[engine]', m) };
const ENGINE_HOOKS = { progress: () => {} };
function toast_(message) { ENGINE_HOOKS.progress(message); }

// ── Per-audit state ─────────────────────────────────────────────────

function freshAudit_() {
  return {
    tags: [], issues: [], ga4Events: [], googleTags: [], pageGoogleConfigs: [], externalHosts: {},
    consentMode: { defaultOnPage: false, defaultViaGtm: false, v2: false, redaction: false, passthrough: false },
    ids: {}, userProps: new Set(), currencies: [], paymentDomains: [], extraRows: [],
    pageScanned: false, fullDetail: false, ga4PropertyChecked: false,
    ga4Data: null,      // { [measurementId]: property data | { error } } — filled by google.js
    liveData: null,     // stored live consent test — filled by app.js
    liveTest: null
  };
}

let AUDIT = freshAudit_();
let settingsCache_ = null;
let containerCache_ = {};          // id → { code, js, parsed }
let TAG_OVERRIDES = {};            // tag key → { vendor, purpose, what, consent, confidence, source }
let WEB_SETTINGS = {};             // raw client settings from the Settings view

function resetAudit_() {
  AUDIT = freshAudit_();
  settingsCache_ = null;
}

/** Containers are downloaded by app.js and stored here before analysis. */
function fetchContainer_(id) {
  return containerCache_[id] || { code: 0, js: null };
}

function tagOverride_(key) {
  return key && TAG_OVERRIDES[key] ? TAG_OVERRIDES[key] : null;
}

/** Group for a tag whose vendor was named by the AI / analyst. */
function overrideGroup_(ov) {
  const name = String(ov.vendor).trim();
  const header = ov.purpose === 'advertising' ? '#6a1b9a' : ov.purpose === 'analytics' ? '#00838f' : '#4527a0';
  return {
    key: 'ai:' + name.toLowerCase(), rank: 60, header: header,
    label: '🤖 ' + name + ' Tags (identified by AI)', plain: name + ' Tags (identified by AI)',
    logo: '', vendorEntry: null
  };
}

// ── Client settings ─────────────────────────────────────────────────

function readClientSettings_() {
  if (settingsCache_) return settingsCache_;
  const s = {};
  SETTINGS_DEFS.forEach(d => { s[d[0]] = WEB_SETTINGS[d[0]] != null && WEB_SETTINGS[d[0]] !== '' ? WEB_SETTINGS[d[0]] : d[2]; });
  const list = v => String(v || '').split(/[,;\n]/).map(x => x.trim()).filter(Boolean);
  settingsCache_ = {
    clientName: s.clientName,
    adsCats: list(s.adsCats), analyticsCats: list(s.analyticsCats), functionalCats: list(s.functionalCats),
    analyticsConsent: !/^n/i.test(s.analyticsConsent),
    namingPattern: safeRegex_(s.namingPattern),
    approvedVendors: list(s.approvedVendors).map(v => v.toLowerCase()),
    approvedIds: list(s.approvedIds).map(v => v.toUpperCase()),
    ga4Checks: /^y/i.test(s.ga4Checks) ? 'Yes' : /^n/i.test(s.ga4Checks) ? 'No' : 'Auto'
  };
  return settingsCache_;
}

// ── Container export ────────────────────────────────────────────────

function analyseExportJson_(text) {
  let obj;
  try { obj = JSON.parse(text); } catch (e) {
    throw new Error('That file is not valid JSON. In GTM use Admin → Export Container and upload the file unchanged.');
  }
  const version = obj.containerVersion || obj;
  if (!version.tag && !version.trigger && !version.variable) {
    throw new Error('No tags, triggers or variables found — is this a GTM container export?');
  }
  const id = (version.container && version.container.publicId) || 'GTM export';
  return {
    id: id,
    findings: analyseContainerVersion_(version, {
      publicId: id, source: 'Container export',
      note: 'Full detail from an exported container' + (obj.exportTime ? ' (exported ' + obj.exportTime + ')' : '')
    })
  };
}

// ── GTM API workspaces (data fetched by google.js) ──────────────────

function workspaceRowsFromData_(workspaces, id) {
  return (workspaces || []).map(ws => {
    if (ws.error) return row_('📝 GTM Workspace', ws.name || 'Not readable', id, ws.error, 'Workspace details need at least Read access');
    const changes = ws.changes || [];
    if (!changes.length) return row_('📝 GTM Workspace', ws.name, id, 'No unpublished changes', '');
    const names = changes.map(ch => {
      const kind = Object.keys(ch).filter(k => k !== 'changeStatus')[0] || 'item';
      const item = ch[kind] || {};
      return (ch.changeStatus || 'changed') + ' ' + kind + ' "' + (item.name || '?') + '"';
    });
    recordIssue_('Hygiene', 'Low', 'Workspace "' + ws.name + '" has ' + changes.length + ' unpublished change(s)',
                 'Publish or discard stale workspace changes', id, names, { row: false });
    return row_('📝 GTM Workspace', ws.name, id,
                changes.length + ' unpublished change(s): ' + truncate_(names.join(', '), 300),
                joinParts_(ws.mergeConflict && ws.mergeConflict.length && '⚠️ Has merge conflicts', 'Not live until published'));
  });
}

// ── GA4 property checks (data fetched by google.js) ─────────────────

function runGa4PropertyChecks_() {
  const S = readClientSettings_();
  if (S.ga4Checks === 'No' || !AUDIT.ga4Data) return;
  Object.keys(AUDIT.ga4Data).forEach(mid => {
    const d = AUDIT.ga4Data[mid];
    if (d.noAccess) {
      recordIssue_('GA4 Property', 'Low', mid + ': no access to its GA4 property',
                   'Sign in with an account that has Viewer access to run these checks', mid);
      return;
    }
    if (d.error) {
      recordIssue_('GA4 Property', 'Low', mid + ': property checks failed (' + truncate_(d.error, 120) + ')',
                   'Check your Google sign-in and access', mid);
      return;
    }
    AUDIT.ga4PropertyChecked = true;
    checkGa4PropertyData_(d, mid);
  });
}

function checkGa4PropertyData_(d, mid) {
  const where = mid + ' · ' + d.displayName;
  const property = d.property || {};
  const info = [joinParts_(d.account && 'Account: ' + d.account, property.timeZone, property.currencyCode,
                           d.streams + ' data stream(s)')];

  if (d.retention) {
    info.push('Retention: ' + d.retention.toLowerCase().replace(/_/g, ' '));
    if (d.retention === 'TWO_MONTHS') {
      recordIssue_('GA4 Property', 'Medium', 'Event data retention is only 2 months',
                   'Set it to 14 months (Admin → Data collection and modification → Data retention) — Explorations cannot look further back',
                   where);
    }
  }

  const eventDims = new Set(), userDims = new Set();
  (d.customDimensions || []).forEach(x => (x.scope === 'USER' ? userDims : eventDims).add(x.parameterName));
  info.push(eventDims.size + ' event / ' + userDims.size + ' user custom dimensions');
  const sentParams = new Set();
  AUDIT.ga4Events.forEach(e => e.params.forEach(x => { if (!/\{\{/.test(x)) sentParams.add(x); }));
  const missing = Array.from(sentParams).filter(x => !eventDims.has(x) && !GA4_STANDARD_PARAMS.has(x));
  if (missing.length) {
    recordIssue_('GA4 Property', 'Low', missing.length + ' event parameter(s) sent but not registered as custom dimensions',
                 'Register the ones you need in reports (Admin → Custom definitions)', where, missing);
  }
  const missingUser = Array.from(AUDIT.userProps).filter(x => !userDims.has(x));
  if (missingUser.length) {
    recordIssue_('GA4 Property', 'Low', missingUser.length + ' user propert(ies) not registered',
                 'Register them as user-scoped custom dimensions', where, missingUser);
  }

  const keyEvents = d.keyEvents || [];
  info.push('Key events: ' + (keyEvents.length ? keyEvents.join(', ') : 'none'));
  const hasDynamic = AUDIT.ga4Events.some(e => /\{\{/.test(e.name));
  const sentEvents = new Set(AUDIT.ga4Events.map(e => String(e.name).replace(/\s\(\{\{[^}]*\}\}\)$/, '')));
  if (!keyEvents.length) {
    recordIssue_('GA4 Property', 'Medium', 'No key events (conversions) set up', 'Mark the business-critical events as key events', where);
  } else if (!hasDynamic) {
    const notSent = keyEvents.filter(k => !sentEvents.has(k) && !GA4_AUTO_EVENTS.has(k) && k !== 'purchase');
    if (notSent.length) {
      recordIssue_('GA4 Property', 'Low', notSent.length + ' key event(s) not found in GTM',
                   'Check these events still fire (they may come from another source)', where, notSent);
    }
  }

  if (d.adsLinks !== null && d.adsLinks !== undefined) {
    info.push(d.adsLinks + ' Google Ads link(s)');
    const adsLive = AUDIT.tags.some(t => !t.paused && /^(awct|sp|gclidw)$/.test(t.type));
    if (adsLive && !d.adsLinks) {
      recordIssue_('GA4 Property', 'Medium', 'GA4 is not linked to Google Ads, but Google Ads tags are live',
                   'Link the Ads account (Admin → Product links) to import key events and audiences', where);
    }
  }
  if (d.bigQuery !== null && d.bigQuery !== undefined) info.push(d.bigQuery ? 'BigQuery export linked' : 'No BigQuery link');

  if (property.currencyCode && AUDIT.currencies.length) {
    const other = AUDIT.currencies.filter(c => c !== property.currencyCode);
    if (other.length) {
      recordIssue_('GA4 Property', 'Low', 'Ecommerce currency differs from the property currency (' + property.currencyCode + ')',
                   'Fine if GA4 converts them; otherwise check the currency sent with ecommerce events', where, other);
    }
  }
  AUDIT.extraRows.push(row_('📈 GA4 Property', d.displayName, mid, info.filter(Boolean).join(' | '),
                            'Checked via the Google Analytics Admin API'));
}

// ── Live consent test (data stored by app.js) ───────────────────────

/** Merges snippet results into stored live-test data (same shape the Apps Script used). */
function mergeLiveResults_(data, results, stageOverride) {
  data = data && data.stages ? data : { stages: {} };
  const added = [];
  results.forEach(r => {
    const stage = LIVE_STAGES[r.stage] ? r.stage : stageOverride;
    if (!LIVE_STAGES[stage]) {
      throw new Error('Could not tell the consent state of one result (' + (r.stage || 'unknown') +
                      '). Choose the state in the dropdown and add that result on its own.');
    }
    const vendors = {};
    Object.keys(r.vendors || {}).forEach(v => {
      vendors[v] = [r.vendors[v].requests || 0, r.vendors[v].cookies || [], r.vendors[v].purpose || 'unknown'];
    });
    data.stages[stage] = {
      url: r.url, time: r.time, cmp: r.cmp, consentDefault: r.consentDefault,
      gcs: r.gcs || [], vendors: vendors, other: (r.otherHosts || []).slice(0, 40), cookieCount: r.cookieCount
    };
    added.push(stage);
  });
  return { data: data, added: added };
}

function liveTestIssues_() {
  const data = AUDIT.liveData;
  if (!data || !Object.keys(data.stages || {}).length) return;
  const any = data.stages.before || data.stages.deny || data.stages.accept;
  AUDIT.liveTest = { url: any.url, stages: Object.keys(data.stages) };
  const where = 'Live Consent Test · ' + hostOf_(any.url);
  liveTestVerdicts_(data).filter(v => v.verdict === 'High').forEach(v => {
    recordIssue_('Consent', 'High', 'Live test: ' + v.vendor + ' fires without consent',
                 v.recommendation, where, [v.cells.before, v.cells.deny].filter(c => /⚠️/.test(c)));
  });
  if (data.stages.before && !data.stages.before.consentDefault &&
      Object.keys(data.stages.before.vendors).some(v => /^(GA4|Google Ads|Floodlight)/.test(v))) {
    recordIssue_('Consent', 'High', 'Live test: Google tags load with no Consent Mode default',
                 'Set gtag("consent","default",{…denied}) before Google tags load', where);
  }
  const missing = Object.keys(LIVE_STAGES).filter(s => !data.stages[s]);
  if (missing.length) {
    recordIssue_('Consent', 'Low', 'Live test incomplete (missing: ' + missing.map(s => LIVE_STAGES[s]).join(', ') + ')',
                 'Run the snippet in the missing states', where, null, { row: false });
  }
}

/** One-liner testers run in the console to copy the rendered page source. */
const PAGE_SOURCE_SNIPPET = 'copy(document.documentElement.outerHTML); console.log("✅ Page source copied — paste it into Tag Audit Studio")';
