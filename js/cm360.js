// ════════════════════════════════════════════════════════════════════
//  Tag Audit Studio — Campaign Manager 360 cross-check (reports only)
//  Uses the dfareporting permission: reports and report lookups only.
//  It cannot change campaigns, ads or Floodlight. Each run creates two
//  temporary report definitions and deletes them again.
//
//  Google serves report files from a server browsers cannot download
//  from (no CORS), so finished reports are fetched by the user with one
//  click each (the file's browserUrl) and added back as CSV files.
//
//  Data part (async, Google API) first; the cross-check engine
//  (buildCm360Result) is pure and synchronous, like ga4.js.
// ════════════════════════════════════════════════════════════════════

const CM360_API = 'https://dfareporting.googleapis.com/dfareporting/v5/';   // v4 is retired (404)
const CM360_RANGE = { relativeDateRange: 'LAST_30_DAYS' };

/** CM360 user profiles the signed-in account has (one per CM360 account it can use). */
async function cm360Profiles() {
  const res = await Google.get(CM360_API + 'userprofiles');
  return (res.items || []).map(p => ({ profileId: p.profileId, accountId: p.accountId, accountName: p.accountName, userName: p.userName }));
}

function cm360Day_(daysAgo) { return new Date(Date.now() - daysAgo * 864e5).toISOString().slice(0, 10); }

/** Floodlight configurations visible to a profile (reporting lookup; no trafficking access needed). */
async function cm360FloodlightConfigs(profileId) {
  const res = await Google.post(CM360_API + 'userprofiles/' + profileId + '/dimensionvalues/query',
    { dimensionName: 'floodlightConfigId', startDate: cm360Day_(90), endDate: cm360Day_(0) });
  return (res.items || []).map(x => ({ id: String(x.value) }));
}

/** Floodlight activities of a configuration (names and IDs; reporting lookup). */
async function cm360Activities(profileId, configId) {
  const res = await Google.post(CM360_API + 'userprofiles/' + profileId + '/dimensionvalues/query', {
    dimensionName: 'activity', startDate: cm360Day_(90), endDate: cm360Day_(0),
    filters: [{ dimensionName: 'floodlightConfigId', value: String(configId) }]
  });
  return (res.items || []).map(x => ({ id: String(x.id || ''), name: x.value }));
}

const cm360Sleep = ms => new Promise(r => setTimeout(r, ms));

const CM360_TEMP_NAME = 'Tag Audit Studio (temporary, deleted automatically)';
const CM360_PENDING_KEY = 'tas.cm360Pending';   // sessionStorage: reports created but not yet deleted

function cm360Pending() {
  try { return JSON.parse(sessionStorage.getItem(CM360_PENDING_KEY) || '[]'); } catch (e) { return []; }
}
function cm360SetPending(list) {
  try { sessionStorage.setItem(CM360_PENDING_KEY, JSON.stringify(list)); } catch (e) { /* ignore */ }
}

async function cm360DeleteReport(profileId, reportId) {
  await Google.request(CM360_API + 'userprofiles/' + profileId + '/reports/' + reportId, { method: 'DELETE' });
  cm360SetPending(cm360Pending().filter(p => String(p.reportId) !== String(reportId)));
}

/**
 * Deletes temporary reports this app created earlier and did not get to delete
 * (for example when the tab was closed before the files were added back).
 */
async function cm360CleanupLeftovers(profileId, progress) {
  let removed = 0;
  const res = await Google.get(CM360_API + 'userprofiles/' + profileId + '/reports?scope=MINE&maxResults=100');
  for (const r of (res.items || []).filter(r => r.name === CM360_TEMP_NAME)) {
    try { await cm360DeleteReport(profileId, r.id); removed++; } catch (e) { /* try again next time */ }
  }
  if (removed && progress) progress('Removed ' + removed + ' temporary report(s) left over from an earlier run.');
  return removed;
}

const CM360_FL_DIMENSIONS = ['activityGroup', 'activityGroupId', 'activity', 'activityId'];

/** Conversion metrics a Floodlight report offers with the activity dimensions selected. */
async function cm360ConversionMetrics(profileId, configId) {
  const res = await Google.post(CM360_API + 'userprofiles/' + profileId + '/reports/compatiblefields/query', {
    type: 'FLOODLIGHT',
    floodlightCriteria: {
      dateRange: CM360_RANGE,
      floodlightConfigId: { dimensionName: 'floodlightConfigId', value: String(configId) },
      dimensions: CM360_FL_DIMENSIONS.map(n => ({ name: n })), metricNames: []
    }
  });
  const all = ((res.floodlightReportCompatibleFields || {}).metrics || []).map(x => x.name);
  const preferred = ['totalConversions', 'clickThroughConversions', 'viewThroughConversions'].filter(m => all.indexOf(m) >= 0);
  const picked = preferred.length ? preferred : all.filter(m => /conversion/i.test(m)).slice(0, 3);
  return picked.length ? picked : all.slice(0, 3);
}

/**
 * Creates a temporary report and runs it until the file is ready. Returns the file's manual
 * download link (browserUrl). The report stays listed as pending until cm360DeleteReport() runs
 * (also swept by cm360CleanupLeftovers()).
 */
async function cm360PrepareReport(profileId, body, progress, label) {
  const report = await Google.post(CM360_API + 'userprofiles/' + profileId + '/reports',
    Object.assign({ name: CM360_TEMP_NAME, format: 'CSV' }, body));
  cm360SetPending(cm360Pending().concat({ profileId: profileId, reportId: report.id }));
  const say = msg => progress && progress((label ? label + ': ' : '') + msg);
  try {
    let file = await Google.post(CM360_API + 'userprofiles/' + profileId + '/reports/' + report.id + '/run?synchronous=false', {});
    // CM360 queues reports (QUEUED), then builds them (PROCESSING). Large network accounts can take a few minutes.
    const started = Date.now(), limit = 8 * 60 * 1000;
    let lastStatus = '';
    for (let i = 0; /^(QUEUED|PROCESSING)$/.test(file.status) && Date.now() - started < limit; i++) {
      if (file.status !== lastStatus || i % 6 === 5) {
        say('report ' + file.status.toLowerCase() + ' in CM360 (' + Math.round((Date.now() - started) / 1000) + 's)…');
        lastStatus = file.status;
      }
      await cm360Sleep(Math.min(2000 + i * 1000, 10000));
      file = await Google.get(CM360_API + 'reports/' + report.id + '/files/' + file.id);
    }
    if (file.status !== 'REPORT_AVAILABLE') {
      throw new Error(/^(QUEUED|PROCESSING)$/.test(file.status)
        ? 'CM360 had not finished the report after 8 minutes (still ' + file.status.toLowerCase() + '). Try again later.'
        : 'The report did not finish (status ' + file.status + ').');
    }
    if (!file.urls || !file.urls.browserUrl) throw new Error('CM360 did not provide a download link for the report.');
    say('report ready.');
    return { profileId: profileId, reportId: report.id, fileId: file.id, browserUrl: file.urls.browserUrl };
  } catch (e) {
    try { await cm360DeleteReport(profileId, report.id); } catch (e2) { /* swept later */ }
    throw e;
  }
}

/**
 * Runs the two cross-check reports for one Floodlight configuration (last 30 days):
 * Floodlight conversions per activity, and delivery (impressions, clicks) per campaign and site
 * for the advertiser that owns the configuration.
 */
async function cm360PrepareCrossCheck(profileId, configId, progress) {
  try { await cm360CleanupLeftovers(profileId, progress); } catch (e) { /* not essential */ }
  const metrics = await cm360ConversionMetrics(profileId, configId);
  const floodlightBody = {
    type: 'FLOODLIGHT',
    floodlightCriteria: {
      dateRange: CM360_RANGE,
      floodlightConfigId: { dimensionName: 'floodlightConfigId', value: String(configId) },
      dimensions: CM360_FL_DIMENSIONS.map(n => ({ name: n })), metricNames: metrics
    }
  };
  const deliveryBody = filterName => ({
    type: 'STANDARD',
    criteria: {
      dateRange: CM360_RANGE,
      dimensions: ['campaign', 'campaignId', 'site'].map(n => ({ name: n })),
      metricNames: ['impressions', 'clicks'],
      dimensionFilters: [{ dimensionName: filterName, id: String(configId) }]
    }
  });
  // The advertiser filter's name has changed between API versions; try the current one first.
  const delivery = async () => {
    try { return await cm360PrepareReport(profileId, deliveryBody('advertiser'), progress, 'Delivery'); }
    catch (e) {
      if (e.status !== 400) throw e;
      return cm360PrepareReport(profileId, deliveryBody('advertiserId'), progress, 'Delivery');
    }
  };
  const exact = Google.hasScope(CM360_TRAFFIC_SCOPE);
  const [floodlight, del, catalog, setup] = await Promise.all([
    cm360PrepareReport(profileId, floodlightBody, progress, 'Floodlight'),
    delivery(),
    cm360Activities(profileId, configId).catch(() => []),
    exact ? cm360FloodlightSetup(profileId, configId).catch(e => { progress && progress('Floodlight setup could not be read (' + e.message + '); matching by name instead.', true); return null; })
          : Promise.resolve(null)
  ]);
  if (setup) progress && progress('Floodlight setup read: ' + setup.length + ' activit(ies) with their tag strings, for exact matching.');
  return { profileId: profileId, configId: String(configId), metrics: metrics, floodlight: floodlight, delivery: del, catalog: catalog, setup: setup };
}

/**
 * Floodlight activities of a configuration with their exact tag strings (type = group tag string,
 * cat = activity tag string). Needs the dfatrafficking permission; only this read is ever sent.
 */
async function cm360FloodlightSetup(profileId, configId) {
  const out = [];
  let token = '';
  do {
    const res = await Google.get(CM360_API + 'userprofiles/' + profileId + '/floodlightActivities?floodlightConfigurationId=' +
      encodeURIComponent(configId) + '&maxResults=1000' + (token ? '&pageToken=' + encodeURIComponent(token) : ''));
    (res.floodlightActivities || []).forEach(a => out.push({
      id: String(a.id), name: a.name || '', group: a.floodlightActivityGroupName || '',
      type: String(a.floodlightActivityGroupTagString || '').toLowerCase(), cat: String(a.tagString || '').toLowerCase(),
      method: a.countingMethod || '', status: a.status || '', uVars: (a.userDefinedVariableTypes || []).map(v => String(v).toLowerCase())
    }));
    token = res.nextPageToken || '';
  } while (token && out.length < 20000);
  return out;
}

// ── Report files ─────────────────────────────────────────────────────

/** Splits one CSV line, honouring quoted fields ("a, b" stays one value). */
function cm360CsvLine(line) {
  const out = [];
  let cur = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

/** CM360 CSV files have a preamble; the data table starts after the "Report Fields" line. */
function cm360CsvRows(text) {
  const lines = String(text || '').replace(/^﻿/, '').split(/\r?\n/);
  const start = lines.findIndex(l => /^Report Fields/i.test(l));
  const body = (start >= 0 ? lines.slice(start + 1) : lines).filter(l => l && !/^Grand Total/i.test(l));
  return body.map(cm360CsvLine);
}

const cm360Num_ = v => Number(String(v == null ? '' : v).replace(/[,\s]/g, '')) || 0;

/**
 * Reads a downloaded report CSV and says which report it is.
 * Returns { kind: 'floodlight', activities } or { kind: 'delivery', rows }. Only these parsed fields are kept.
 */
function cm360ParseReport(text) {
  const rows = cm360CsvRows(text);
  if (rows.length < 1) throw new Error('That file has no report table. Choose a CSV downloaded with a "Download report" button.');
  const cols = rows[0].map(c => c.trim().toLowerCase());
  const col = re => cols.findIndex(c => re.test(c));
  const data = rows.slice(1);
  const activity = col(/^activity$/), activityId = col(/^activity id$/);
  if (activity >= 0 || activityId >= 0) {
    const group = col(/^activity group$/), groupId = col(/^activity group id$/);
    const total = col(/^total conversions$/), ct = col(/click-?through conversions/), vt = col(/view-?through conversions/);
    const anyConv = col(/conversion|transaction/);
    return {
      kind: 'floodlight',
      activities: data.map(r => {
        const tot = total >= 0 ? cm360Num_(r[total]) : ct >= 0 || vt >= 0 ? cm360Num_(r[ct]) + cm360Num_(r[vt]) : anyConv >= 0 ? cm360Num_(r[anyConv]) : 0;
        return { group: group >= 0 ? r[group] : '', groupId: groupId >= 0 ? r[groupId] : '', name: activity >= 0 ? r[activity] : '',
                 id: activityId >= 0 ? String(r[activityId]) : '', conversions: tot,
                 clickThrough: ct >= 0 ? cm360Num_(r[ct]) : null, viewThrough: vt >= 0 ? cm360Num_(r[vt]) : null };
      }).filter(a => a.name || a.id)
    };
  }
  const campaign = col(/^campaign$/), impressions = col(/^impressions$/), clicks = col(/^clicks$/);
  if (campaign >= 0 && (impressions >= 0 || clicks >= 0)) {
    const campaignId = col(/^campaign id$/), site = col(/^site/);
    return {
      kind: 'delivery',
      rows: data.map(r => ({ campaign: r[campaign], campaignId: campaignId >= 0 ? String(r[campaignId]) : '',
                             site: site >= 0 ? r[site] : '', impressions: cm360Num_(r[impressions]), clicks: cm360Num_(r[clicks]) }))
        .filter(r => r.campaign)
    };
  }
  throw new Error('This CSV is not one of the two CM360 reports (it has no Activity or Campaign/Clicks columns).');
}

// ── Cross-check engine (pure) ────────────────────────────────────────

const CM360_AREAS = ['Floodlight setup', 'Floodlight vs GTM', 'Delivery vs analytics'];
const CM360_WEIGHTS = { 'Floodlight setup': 1, 'Floodlight vs GTM': 2, 'Delivery vs analytics': 1.5 };
const CM360_PENALTY = { High: 30, Medium: 12, Low: 4 };
const CM360_STOP = new Set(['floodlight', 'fl', 'counter', 'sales', 'tag', 'tags', 'dc', 'cm', 'cm360', 'dcm', 'dv360', 'the', 'and',
  'gtm', 'conversion', 'conversions', 'activity', 'event', 'standard', 'unique', 'per', 'session', 'cat', 'type', 'src', 'u']);

function cm360Tokens_(s) {
  return String(s || '').toLowerCase().replace(/([a-z])([0-9])/g, '$1 $2').split(/[^a-z0-9]+/)
    .filter(t => t && t.length > 1 && !CM360_STOP.has(t) && !/^\d+$/.test(t));
}
function cm360Compact_(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

/** How well a GTM Floodlight tag matches a CM360 activity (0–1+). */
function cm360MatchScore_(tag, activity) {
  const a = new Set(cm360Tokens_(tag.labels.join(' ') + ' ' + tag.cat + ' ' + tag.type));
  const b = new Set(cm360Tokens_(activity.name + ' ' + (activity.group || '')));
  if (!a.size || !b.size) return 0;
  let hit = 0;
  a.forEach(t => { if (b.has(t)) hit++; });
  let score = hit / Math.min(a.size, b.size);
  // Floodlight cat strings are often the activity name shortened (e.g. "bookt0" for "Book Test Drive")
  const cat = cm360Compact_(tag.cat).replace(/\d+$/, '');
  if (cat.length >= 4 && cm360Compact_(activity.name).indexOf(cat) === 0) score += 0.5;
  return score;
}

/** Why a suggestion was made, in a few words ("tag string + 2 words"). */
function cm360MatchReason_(tag, activity) {
  const a = new Set(cm360Tokens_(tag.labels.join(' ') + ' ' + tag.cat + ' ' + tag.type));
  const b = new Set(cm360Tokens_(activity.name + ' ' + (activity.group || '')));
  let hit = 0;
  a.forEach(t => { if (b.has(t)) hit++; });
  const cat = cm360Compact_(tag.cat).replace(/\d+$/, '');
  const prefix = cat.length >= 4 && cm360Compact_(activity.name).indexOf(cat) === 0;
  return [prefix ? 'activity name starts like the tag string' : '', hit ? hit + ' word' + (hit === 1 ? '' : 's') + ' in common' : ''].filter(Boolean).join(' + ');
}

/** CM360 counting method in GTM's terms (STANDARD, UNIQUE, SESSION, TRANSACTIONS, ITEM_SOLD). */
function cm360Method_(m) {
  const s = String(m || '').toUpperCase().replace(/_COUNTING$/, '').replace(/^ITEMS_SOLD$/, 'ITEM_SOLD').replace(/^PER_SESSION$/, 'SESSION');
  return s === 'ITEMS' ? 'ITEM_SOLD' : s;
}

const CM360_VISIT_WORDS = /\b(visit|visits|page|pageview|view|views|landing|lp|homepage)\b/i;
const CM360_SALE_WORDS = /\b(purchase|purchases|sale|sales|order|orders|transaction|transactions|checkout|confirmation|thank|thanks|buy|bought)\b/i;

/** True when a GTM tag name and its CM360 activity describe different things (a page visit vs a purchase). */
function cm360NamesDisagree_(tagName, activityName) {
  const t = String(tagName || ''), a = String(activityName || '');
  const tv = CM360_VISIT_WORDS.test(t) && !CM360_SALE_WORDS.test(t), ts = CM360_SALE_WORDS.test(t) && !CM360_VISIT_WORDS.test(t);
  const av = CM360_VISIT_WORDS.test(a) && !CM360_SALE_WORDS.test(a), as = CM360_SALE_WORDS.test(a) && !CM360_VISIT_WORDS.test(a);
  return (tv && as) || (ts && av);
}

/** GTM Floodlight tags grouped by src/type/cat, from a serialised GTM result. */
function cm360GtmTags(result) {
  if (!result || !result.audit || !Array.isArray(result.audit.floodlightTags)) return [];
  const byKey = new Map();
  result.audit.floodlightTags.filter(f => !f.paused).forEach(f => {
    const key = f.src + '/' + f.type + '/' + f.cat;
    if (!byKey.has(key)) byKey.set(key, { key: key, src: f.src, type: f.type, cat: f.cat, method: f.method, uVars: [], labels: [], where: [], risks: [] });
    const g = byKey.get(key);
    if (g.labels.indexOf(f.label) < 0) g.labels.push(f.label);
    if (g.where.indexOf(f.where) < 0) g.where.push(f.where);
    (f.uVars || []).forEach(u => { if (g.uVars.indexOf(u) < 0) g.uVars.push(u); });
    const t = result.audit.tags && result.audit.tags[f.tagIndex];
    if (t && t.risk) g.risks.push(t.risk);
  });
  return Array.from(byKey.values());
}

function cm360NormCampaign_(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }

/**
 * Builds the CM360 report.
 *  data:    { account, accountId, configId, configsOwned[], metrics[], activities[], catalog[], delivery[] }
 *  gtmTags: cm360GtmTags(STATE.result) (may be empty)
 *  ga4:     { campaigns: [{ campaign, sessions }], source } or null
 *  mapping: { [gtmKey]: activityId | 'none' } confirmed by the analyst
 */
function buildCm360Result(data, gtmTags, ga4, mapping, meta) {
  mapping = mapping || {};
  meta = meta || {};
  const issues = [];
  const add = (area, severity, finding, action, items) =>
    issues.push({ area: area, severity: severity, finding: finding, action: action, where: 'CM360 · ' + (data.account || ''), items: items || [] });

  // Activities: report rows (with conversions) plus the catalogue (all known activities)
  const acts = new Map();
  (data.catalog || []).forEach(a => { if (a.id || a.name) acts.set(a.id || a.name, { id: a.id, name: a.name, group: '', conversions: 0, clickThrough: null, viewThrough: null }); });
  const setup = Array.isArray(data.setup) ? data.setup : null;   // exact tag strings (dfatrafficking), when read
  (setup || []).forEach(a => { if (!acts.has(a.id)) acts.set(a.id, { id: a.id, name: a.name, group: a.group, conversions: 0, clickThrough: null, viewThrough: null }); });
  (data.activities || []).forEach(a => {
    const k = a.id || a.name;
    acts.set(k, Object.assign(acts.get(k) || {}, a));
  });
  const activities = Array.from(acts.values()).sort((a, b) => b.conversions - a.conversions || a.name.localeCompare(b.name));
  const byId = new Map(activities.map(a => [a.id || a.name, a]));

  // ── Floodlight setup ──
  const owned = new Set((data.configsOwned || []).map(String));
  const srcs = Array.from(new Set(gtmTags.map(t => t.src)));
  const foreign = srcs.filter(s => owned.size && !owned.has(s));
  if (foreign.length) {
    add('Floodlight setup', 'Medium', 'GTM sends Floodlight hits to ' + foreign.length + ' configuration(s) none of your CM360 accounts can see',
        'Check whether they belong to another advertiser, a previous agency or a test setup, and remove them if not needed',
        foreign.map(s => 'DC-' + s + ' (' + gtmTags.filter(t => t.src === s).length + ' activity tag(s))'));
  }
  const unconsented = gtmTags.filter(t => t.risks.some(r => r === 'High' || r === 'Medium'));

  // ── Floodlight vs GTM (only tags for the chosen configuration) ──
  const local = gtmTags.filter(t => t.src === String(data.configId));
  const setupByTag = new Map((setup || []).map(a => [a.type + '/' + a.cat, a]));
  const rows = local.map(t => {
    const confirmed = mapping[t.key];
    const exact = setup ? setupByTag.get(String(t.type).toLowerCase() + '/' + String(t.cat).toLowerCase()) || null : null;
    const scored = setup ? [] : activities.map(a => ({ a: a, s: cm360MatchScore_(t, a) })).sort((x, y) => y.s - x.s);
    const best = scored[0] && scored[0].s >= 0.5 ? scored[0].a : null;
    const auto = setup ? (exact ? byId.get(exact.id) || null : null) : best;
    const chosen = confirmed === 'none' ? null : confirmed ? byId.get(confirmed) || null : auto;
    const status = confirmed ? (confirmed === 'none' ? 'No CM360 activity' : 'Confirmed')
      : setup ? (exact ? 'Exact' : 'Not in CM360') : best ? 'Suggested' : 'Not matched';
    const reason = status === 'Exact' ? 'Same tag string (' + exact.type + '/' + exact.cat + ')'
      : status === 'Not in CM360' ? 'No activity with tag string ' + t.type + '/' + t.cat + ' in this configuration'
      : status === 'Suggested' ? 'Suggested by name: ' + cm360MatchReason_(t, best) : status === 'Confirmed' ? 'Chosen by the analyst' : '';
    return { tag: t, activity: chosen, status: status, exact: exact, reason: reason,
             suggestions: scored.slice(0, 5).filter(x => x.s > 0).map(x => x.a) };
  });
  const usedIds = new Set(rows.filter(r => r.activity).map(r => r.activity.id || r.activity.name));
  const dead = rows.filter(r => r.activity && !r.activity.conversions);
  if (dead.length) {
    add('Floodlight vs GTM', 'Medium', dead.length + ' Floodlight tag(s) in GTM whose activity recorded no conversions in 30 days',
        'Check the trigger fires on the right page and the tag waits for consent correctly; remove tags that are no longer used',
        dead.map(r => r.tag.labels[0] + ' → ' + r.activity.name));
  }
  if (setup) {
    const missing = rows.filter(r => r.status === 'Not in CM360');
    if (missing.length) {
      add('Floodlight vs GTM', 'Medium', missing.length + ' Floodlight tag(s) in GTM send to a tag string with no activity in DC-' + data.configId,
          'CM360 does not record these hits: the activity was deleted or the tag has a typo in type/cat. Fix the tag or remove it',
          missing.map(r => r.tag.labels[0] + ' (' + r.tag.type + '/' + r.tag.cat + ')'));
    }
    const inactive = rows.filter(r => r.exact && r.exact.status && !/^ACTIVE$/i.test(r.exact.status));
    if (inactive.length) {
      add('Floodlight vs GTM', 'Medium', inactive.length + ' Floodlight tag(s) in GTM fire to an activity that is not active in CM360',
          'Remove the tag from GTM, or reactivate the activity if it is still needed', inactive.map(r => r.tag.labels[0] + ' → ' + r.exact.name + ' (' + r.exact.status.toLowerCase().replace(/_/g, ' ') + ')'));
    }
    const methods = rows.filter(r => r.exact && r.tag.method && r.exact.method && cm360Method_(r.tag.method) !== cm360Method_(r.exact.method));
    if (methods.length) {
      add('Floodlight vs GTM', 'Low', methods.length + ' Floodlight tag(s) use a different counting method from their CM360 activity',
          'Set the tag\'s counting method to the one the activity uses, so conversions are counted as planned',
          methods.map(r => r.tag.labels[0] + ': GTM ' + cm360Method_(r.tag.method).toLowerCase() + ', CM360 ' + cm360Method_(r.exact.method).toLowerCase()));
    }
    const vars = rows.filter(r => r.exact && r.exact.uVars && (r.tag.uVars || []).some(u => r.exact.uVars.indexOf(String(u).toLowerCase()) < 0));
    if (vars.length) {
      add('Floodlight vs GTM', 'Low', vars.length + ' Floodlight tag(s) send custom variables their CM360 activity does not collect',
          'Add the variables to the activity in CM360 (or remove them from the tag); until then their values are dropped',
          vars.map(r => r.tag.labels[0] + ': ' + r.tag.uVars.filter(u => r.exact.uVars.indexOf(String(u).toLowerCase()) < 0).join(', ')));
    }
  }
  const disagree = rows.filter(r => r.activity && r.status !== 'Confirmed' && cm360NamesDisagree_(r.tag.labels.join(' '), r.activity.name));
  if (disagree.length) {
    add('Floodlight vs GTM', setup ? 'Medium' : 'Low', disagree.length + ' Floodlight tag(s) whose GTM name and CM360 activity describe different things (page visit vs purchase)',
        'Check each tag\'s trigger: a page-visit tag recording into a purchase activity inflates conversions. If the trigger is right, rename the tag',
        disagree.map(r => r.tag.labels[0] + ' → ' + r.activity.name));
  }
  const unmatched = rows.filter(r => r.status === 'Not matched');
  if (unmatched.length) {
    add('Floodlight vs GTM', 'Low', unmatched.length + ' Floodlight tag(s) in GTM not matched to a CM360 activity',
        'Pick the activity for each tag in the Floodlight mapping tab', unmatched.map(r => r.tag.labels[0] + ' (' + r.tag.type + '/' + r.tag.cat + ')'));
  }
  const elsewhere = activities.filter(a => a.conversions > 0 && !usedIds.has(a.id || a.name));
  if (elsewhere.length && local.length) {
    add('Floodlight vs GTM', 'Low', elsewhere.length + ' activit(ies) record conversions but no tag in this GTM container matches them',
        'They may be tracked from page code, another container or an app; confirm where they come from',
        elsewhere.slice(0, 20).map(a => a.name + ' (' + a.conversions + ')'));
  }

  // ── Delivery vs analytics ──
  const campaigns = new Map();
  (data.delivery || []).forEach(r => {
    const k = r.campaignId || r.campaign;
    if (!campaigns.has(k)) campaigns.set(k, { campaign: r.campaign, campaignId: r.campaignId, impressions: 0, clicks: 0, sites: 0 });
    const c = campaigns.get(k);
    c.impressions += r.impressions; c.clicks += r.clicks; c.sites++;
  });
  const ga4Sessions = new Map();
  if (ga4) ga4.campaigns.forEach(c => {
    const k = cm360NormCampaign_(c.campaign);
    ga4Sessions.set(k, (ga4Sessions.get(k) || 0) + c.sessions);
  });
  const delivery = Array.from(campaigns.values()).map(c => {
    const search = /dart search|paid search|\bsearch\b/i.test(c.campaign);
    let sessions = null, matched = '';
    if (ga4 && !search) {
      const k = cm360NormCampaign_(c.campaign);
      if (ga4Sessions.has(k)) { sessions = ga4Sessions.get(k); matched = c.campaign; }
      else {
        const ct = new Set(cm360Tokens_(c.campaign));
        let best = null, bestScore = 0;
        ga4Sessions.forEach((s, name) => {
          const nt = cm360Tokens_(name);
          if (!nt.length || !ct.size) return;
          const score = nt.filter(t => ct.has(t)).length / Math.max(ct.size, nt.length);
          if (score > bestScore) { bestScore = score; best = name; }
        });
        if (best && bestScore >= 0.8) { sessions = ga4Sessions.get(best); matched = best; }
        else sessions = 0;
      }
    }
    return Object.assign(c, { search: search, sessions: sessions, ga4Campaign: matched,
                              ratio: sessions !== null && c.clicks ? Math.round(sessions / c.clicks * 100) : null });
  }).sort((a, b) => b.clicks - a.clicks);
  if (ga4) {
    const none = delivery.filter(c => !c.search && c.clicks >= 100 && c.sessions === 0);
    if (none.length) {
      add('Delivery vs analytics', 'Medium', none.length + ' campaign(s) with clicks but no GA4 sessions found',
          'Check the landing pages carry UTM parameters (or the CM360–GA4 link), that redirects keep them, and consent loss',
          none.map(c => c.campaign + ' (' + c.clicks + ' clicks)'));
    }
    const low = delivery.filter(c => !c.search && c.clicks >= 100 && c.sessions > 0 && c.sessions < c.clicks * 0.5);
    if (low.length) {
      add('Delivery vs analytics', 'Medium', low.length + ' campaign(s) where GA4 records under half as many sessions as CM360 clicks',
          'Check landing-page tracking, redirects, consent rates and accidental clicks; some gap is normal',
          low.map(c => c.campaign + ' (' + c.clicks + ' clicks, ' + c.sessions + ' sessions)'));
    }
  }

  // ── Areas and score ──
  const sorted = issues.slice().sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  const checked = area => area === 'Floodlight vs GTM' ? local.length > 0 && !!data.activities
    : area === 'Delivery vs analytics' ? !!ga4 && !!data.delivery
    : gtmTags.length > 0;
  const areas = CM360_AREAS.map(area => {
    const list = sorted.filter(i => i.area === area);
    const isChecked = checked(area);
    return {
      area: area,
      score: isChecked ? Math.max(0, 100 - list.reduce((s, i) => s + CM360_PENALTY[i.severity], 0)) : null,
      status: list.length ? (list[0].severity === 'High' ? 'Action needed' : list[0].severity === 'Medium' ? 'Review' : 'Minor') : isChecked ? 'No issues' : 'Not checked',
      findings: list.length ? list.map(i => i.finding) : isChecked ? [] : [
        area === 'Delivery vs analytics' ? 'Run the GA4 audit for this site to compare clicks with sessions'
          : 'Run a GTM audit for this site that includes Floodlight tags for this configuration'],
      action: list[0] ? list[0].action : '', top: list[0] ? list[0].severity : null
    };
  });
  let total = 0, weight = 0;
  areas.forEach(a => { if (a.score !== null) { total += a.score * CM360_WEIGHTS[a.area]; weight += CM360_WEIGHTS[a.area]; } });
  const score = weight ? Math.round(total / weight) : 100;

  return {
    meta: { client: meta.client || '', site: meta.site || '', date: meta.date || new Date().toISOString() },
    account: data.account, accountId: data.accountId, configId: data.configId, metrics: data.metrics || [],
    summary: {
      gtmTags: local.length, otherConfigs: srcs.filter(s => s !== String(data.configId)).length,
      activities: activities.length, conversions: activities.reduce((s, a) => s + (a.conversions || 0), 0),
      impressions: delivery.reduce((s, c) => s + c.impressions, 0), clicks: delivery.reduce((s, c) => s + c.clicks, 0),
      campaigns: delivery.length
    },
    issues: sorted, areas: areas, score: { score: score, grade: score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : score >= 40 ? 'D' : 'E' },
    mappingRows: rows.map(r => ({ key: r.tag.key, labels: r.tag.labels, where: r.tag.where, type: r.tag.type, cat: r.tag.cat,
      method: r.tag.method, uVars: r.tag.uVars, status: r.status, reason: r.reason, cmMethod: r.exact ? cm360Method_(r.exact.method) : '',
      disagree: !!(r.activity && r.status !== 'Confirmed' && cm360NamesDisagree_(r.tag.labels.join(' '), r.activity.name)),
      activityId: r.activity ? r.activity.id || r.activity.name : '',
      activityName: r.activity ? r.activity.name : '', conversions: r.activity ? r.activity.conversions : null,
      suggestions: r.suggestions.map(a => a.id || a.name) })),
    activities: activities.map(a => ({ id: a.id, name: a.name, group: a.group || '', conversions: a.conversions || 0,
      clickThrough: a.clickThrough, viewThrough: a.viewThrough, gtm: usedIds.has(a.id || a.name) })),
    delivery: delivery,
    unconsented: unconsented.map(t => ({ labels: t.labels, risk: t.risks.indexOf('High') >= 0 ? 'High' : 'Medium' })),
    ga4Source: ga4 ? ga4.source : null,
    coverage: [
      'Last 30 days. Conversions from the CM360 Floodlight report; impressions and clicks from a standard report for the advertiser that owns Floodlight configuration ' + data.configId + '.',
      setup ? 'GTM tags are matched exactly on their tag strings (type/cat), read from the Floodlight setup of configuration ' + data.configId + '.'
        : 'GTM tags are matched to CM360 activities by name, because the reports-only permission cannot read the activities\' tag strings (type/cat). Connect "CM360 Floodlight setup" for exact matching, or confirm the matches in the Floodlight mapping tab.',
      ga4 ? 'Clicks are compared with GA4 sessions per campaign (matched by campaign name, from ' + ga4.source + '). Search campaigns are left out.'
          : 'GA4 was not compared: run the GA4 audit for this site first.',
      'Report files were downloaded manually and read in this browser; only the counts above are kept. The temporary reports were deleted from CM360.'
    ]
  };
}
