// ════════════════════════════════════════════════════════════════════
//  Tag Audit Studio — Campaign Manager 360 (reports only)
//  Uses the dfareporting permission: reports and report lookups only.
//  It cannot change campaigns, ads or Floodlight. Each run creates one
//  temporary report definition and deletes it again.
//
//  Google serves report files from a server browsers may not download
//  from (no CORS), so a finished report is fetched by the user with one
//  click (the file's browserUrl) and added back as a CSV.
//
//  FEASIBILITY TEST: cm360ConnectionTest() checks every step the full
//  feature needs (profiles, Floodlight configurations and report fields,
//  run a report, manual download, delete) and logs only counts and field
//  names, never report contents.
// ════════════════════════════════════════════════════════════════════

const CM360_API = 'https://dfareporting.googleapis.com/dfareporting/v5/';   // v4 is retired (404)

/** CM360 user profiles the signed-in account has (one per CM360 account it can use). */
async function cm360Profiles() {
  const res = await Google.get(CM360_API + 'userprofiles');
  return (res.items || []).map(p => ({ profileId: p.profileId, accountId: p.accountId, accountName: p.accountName, userName: p.userName }));
}

/** Floodlight configurations visible to a profile (reporting lookup; no trafficking access needed). */
async function cm360FloodlightConfigs(profileId) {
  const end = new Date(), start = new Date(Date.now() - 90 * 864e5);
  const day = d => d.toISOString().slice(0, 10);
  const res = await Google.post(CM360_API + 'userprofiles/' + profileId + '/dimensionvalues/query',
    { dimensionName: 'floodlightConfigId', startDate: day(start), endDate: day(end) });
  return (res.items || []).map(x => ({ id: x.value }));
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
 * (for example when the tab was closed before the file was added back).
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

/** Report fields CM360 offers for a Floodlight report on this configuration (metadata only). */
async function cm360FloodlightFields(profileId, floodlightConfigId) {
  const res = await Google.post(CM360_API + 'userprofiles/' + profileId + '/reports/compatiblefields/query', {
    type: 'FLOODLIGHT',
    floodlightCriteria: {
      dateRange: { relativeDateRange: 'LAST_30_DAYS' },
      floodlightConfigId: { dimensionName: 'floodlightConfigId', value: String(floodlightConfigId) },
      dimensions: [], metricNames: []
    }
  });
  const f = res.floodlightReportCompatibleFields || {};
  return { dimensions: (f.dimensions || []).map(x => x.name), metrics: (f.metrics || []).map(x => x.name) };
}

/**
 * Creates a temporary report and runs it until the file is ready. Google serves report files from a
 * server browsers cannot download from, so this returns the file's manual download link (browserUrl);
 * the user downloads it and adds it back with cm360ReadReportFile(). The report stays listed as
 * pending until cm360DeleteReport() runs (also swept by cm360CleanupLeftovers()).
 */
async function cm360PrepareReport(profileId, criteria, type, progress) {
  const report = await Google.post(CM360_API + 'userprofiles/' + profileId + '/reports', {
    name: CM360_TEMP_NAME, type: type || 'STANDARD', format: 'CSV',
    [type === 'FLOODLIGHT' ? 'floodlightCriteria' : 'criteria']: criteria
  });
  cm360SetPending(cm360Pending().concat({ profileId: profileId, reportId: report.id }));
  try {
    progress && progress('Report created; running it…');
    let file = await Google.post(CM360_API + 'userprofiles/' + profileId + '/reports/' + report.id + '/run?synchronous=false', {});
    // CM360 queues reports (QUEUED), then builds them (PROCESSING). Large network accounts can take a few minutes.
    const started = Date.now(), limit = 6 * 60 * 1000;
    let lastStatus = '';
    for (let i = 0; /^(QUEUED|PROCESSING)$/.test(file.status) && Date.now() - started < limit; i++) {
      if (file.status !== lastStatus || i % 6 === 5) {
        progress && progress('Report ' + file.status.toLowerCase() + ' in CM360 (' + Math.round((Date.now() - started) / 1000) + 's)…');
        lastStatus = file.status;
      }
      await cm360Sleep(Math.min(2000 + i * 1000, 10000));
      file = await Google.get(CM360_API + 'reports/' + report.id + '/files/' + file.id);
    }
    if (file.status !== 'REPORT_AVAILABLE') {
      throw new Error(/^(QUEUED|PROCESSING)$/.test(file.status)
        ? 'CM360 had not finished the report after 6 minutes (still ' + file.status.toLowerCase() + '). Try again later or with a smaller account.'
        : 'The report did not finish (status ' + file.status + ').');
    }
    if (!file.urls || !file.urls.browserUrl) throw new Error('CM360 did not provide a download link for the report.');
    return { profileId: profileId, reportId: report.id, fileId: file.id, browserUrl: file.urls.browserUrl };
  } catch (e) {
    try { await cm360DeleteReport(profileId, report.id); } catch (e2) { /* swept later */ }
    throw e;
  }
}

/** Reads a report CSV the user downloaded: { columns, rows } (data table only, no totals). */
function cm360ReadReportFile(text) {
  const rows = cm360CsvRows(text);
  if (!rows.length) throw new Error('That file has no report table. Choose the CSV downloaded from the "Download report" button.');
  return { columns: rows[0], rows: rows.slice(1) };
}

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

/** Feasibility test: logs each step; returns a summary object. Never logs report contents. */
async function cm360ConnectionTest(log, profileId) {
  const summary = { profiles: 0, profileList: [], floodlightConfigs: null, reportRows: null, download: false };
  const step = async (name, fn) => {
    log('… ' + name);
    try { const v = await fn(); log('✔ ' + name); return v; }
    catch (e) { log('✖ ' + name + ': ' + e.message, true); throw e; }
  };
  const profiles = await step('List your CM360 user profiles', cm360Profiles);
  summary.profiles = profiles.length;
  summary.profileList = profiles;
  cm360ConnectionTest.lastProfiles = profiles;   // lets the page offer an account picker even if a later step fails
  log(profiles.length + ' profile(s): ' + profiles.map(p => p.accountName + ' (account ' + p.accountId + ')').join(', '));
  if (!profiles.length) { log('This Google account has no CM360 profile, so nothing else can be tested.', true); return summary; }
  const chosen = profiles.find(p => String(p.profileId) === String(profileId)) || profiles[0];
  const pid = chosen.profileId;
  log('Testing with account ' + chosen.accountName + (profileId ? '.' : ' (the first one; choose another above to test it).'));
  try { await cm360CleanupLeftovers(pid, log); } catch (e) { /* not essential for the test */ }
  let configs = [];
  try {
    configs = await step('Look up Floodlight configurations (reporting lookup)', () => cm360FloodlightConfigs(pid));
    summary.floodlightConfigs = configs.length;
    log(configs.length + ' Floodlight configuration(s) visible: ' + configs.map(c => c.id).slice(0, 10).join(', '));
  } catch (e) { /* logged; carry on with the report test */ }
  if (configs.length) {
    try {
      const f = await step('List the fields a Floodlight report offers (configuration ' + configs[0].id + ')',
        () => cm360FloodlightFields(pid, configs[0].id));
      summary.floodlightFields = f;
      log('Floodlight report dimensions (' + f.dimensions.length + '): ' + f.dimensions.join(', '));
      log('Floodlight report metrics (' + f.metrics.length + '): ' + f.metrics.join(', '));
    } catch (e) { /* logged */ }
  }
  summary.pending = await step('Create and run a small temporary report (campaigns, impressions, clicks, yesterday)',
    () => cm360PrepareReport(pid, {
      dateRange: { relativeDateRange: 'YESTERDAY' },
      dimensions: [{ name: 'campaign' }],
      metricNames: ['impressions', 'clicks']
    }, 'STANDARD', log));
  log('Report ready. Click "Download report" below, then add the downloaded CSV file. The report is deleted from CM360 after that.');
  return summary;
}
