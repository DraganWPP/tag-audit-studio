// ════════════════════════════════════════════════════════════════════
//  Tag Audit Studio — Campaign Manager 360 (reports only)
//  Uses the dfareporting permission: reports and report lookups only.
//  It cannot change campaigns, ads or Floodlight. Each run creates one
//  temporary report definition and deletes it again.
//
//  FEASIBILITY TEST: cm360ConnectionTest() checks every step the full
//  feature needs (profiles, Floodlight configurations, run a report,
//  download the file in the browser, delete the report) and logs only
//  counts, never report contents.
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

/**
 * Creates a temporary report, runs it, waits for the file, downloads it in the browser and
 * deletes the report definition. Returns { rows, text } or throws with the failing step.
 */
async function cm360RunTemporaryReport(profileId, criteria, type, progress) {
  const report = await Google.post(CM360_API + 'userprofiles/' + profileId + '/reports', {
    name: 'Tag Audit Studio (temporary, deleted automatically)', type: type || 'STANDARD', format: 'CSV',
    [type === 'FLOODLIGHT' ? 'floodlightCriteria' : 'criteria']: criteria
  });
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
    progress && progress('Report ready; downloading it in the browser…');
    const text = await cm360Download(report.id, file);
    return { text: text, rows: cm360CsvRows(text) };
  } finally {
    try { await Google.request(CM360_API + 'userprofiles/' + profileId + '/reports/' + report.id, { method: 'DELETE' }); }
    catch (e) { progress && progress('Could not delete the temporary report ' + report.id + ': ' + e.message, true); }
  }
}

/** Downloads a finished report file. Tries the API media URL first, then the file's own API URL. */
async function cm360Download(reportId, file) {
  const urls = [CM360_API + 'reports/' + reportId + '/files/' + file.id + '?alt=media'];
  if (file.urls && file.urls.apiUrl) urls.push(file.urls.apiUrl);
  let last = null;
  for (const url of urls) {
    try {
      const res = await fetch(url, { headers: { Authorization: 'Bearer ' + Google.token } });
      if (res.ok) return await res.text();
      last = new Error('HTTP ' + res.status + ' from ' + url.split('?')[0]);
    } catch (e) {
      last = new Error('The browser blocked the download (' + e.message + ') from ' + url.split('?')[0]);
    }
  }
  throw last;
}

/** CM360 CSV files have a preamble; the data table starts after the "Report Fields" line. */
function cm360CsvRows(text) {
  const lines = String(text || '').split(/\r?\n/);
  const start = lines.findIndex(l => /^Report Fields/i.test(l));
  const body = (start >= 0 ? lines.slice(start + 1) : lines).filter(l => l && !/^Grand Total/i.test(l));
  return body.map(l => l.split(','));
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
  try {
    const configs = await step('Look up Floodlight configurations (reporting lookup)', () => cm360FloodlightConfigs(pid));
    summary.floodlightConfigs = configs.length;
    log(configs.length + ' Floodlight configuration(s) visible: ' + configs.map(c => c.id).slice(0, 10).join(', '));
  } catch (e) { /* logged; carry on with the report test */ }
  const result = await step('Create, run, download and delete a small temporary report (campaigns, impressions, clicks, yesterday)',
    () => cm360RunTemporaryReport(pid, {
      dateRange: { relativeDateRange: 'YESTERDAY' },
      dimensions: [{ name: 'campaign' }],
      metricNames: ['impressions', 'clicks']
    }, 'STANDARD', log));
  summary.download = true;
  summary.reportRows = Math.max(0, result.rows.length - 1);
  log('Downloaded the report: ' + summary.reportRows + ' campaign row(s). The contents were not displayed or stored.');
  return summary;
}
