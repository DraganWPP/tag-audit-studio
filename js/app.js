// ════════════════════════════════════════════════════════════════════
//  Tag Audit Studio — app shell: inputs, audit pipeline, views, exports
// ════════════════════════════════════════════════════════════════════

const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ── Persistent app settings (AI + Google) ───────────────────────────

const SETTINGS_KEY = 'tas.settings';
function loadAppSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch (e) { return {}; }
}
function saveAppSettings(patch) {
  const s = Object.assign(loadAppSettings(), patch);
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (e) { toast('Settings could not be saved in this browser (storage blocked).', true); }
  return s;
}

const DRAFT_KEY = 'tas.draft';
function saveDraft() {
  const i = STATE.inputs;
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({
      client: i.client, site: i.site, publicIds: i.publicIds, apiIds: i.apiIds, apiTarget: i.apiTarget, ga4: i.ga4,
      ga4Full: i.ga4Full, cm360Auto: i.cm360Auto, gscAuto: i.gscAuto, rules: i.rules
    }));
  } catch (e) { /* ignore */ }
}
function loadDraft() {
  try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch (e) { return null; }
}

// ── State ───────────────────────────────────────────────────────────

const STATE = {
  view: 'audit',
  inputs: Object.assign({ client: '', site: '', publicIds: '', apiIds: '', apiTarget: 'live', ga4: true, ga4Full: true, cm360Auto: true, gscAuto: true, rules: {},
                          exports: [], pageSource: '', live: null }, loadDraft() || {}),
  result: null,
  ai: { writeup: '', fixplan: '', chat: [], busy: '' },
  overrides: {},
  caches: { containers: {}, api: {}, ga4: {}, gtag: {}, ga4full: {} },
  running: false,
  // Separate GA4 audit: picker state, result ({ date, client, site, properties: [...] }) and view state
  ga4: { props: null, loading: false, known: {}, selected: [], query: '', result: null, picking: false,
         index: 0, tab: 'overview', running: false, log: [] },
  // CM360 check: accounts, chosen configuration, pending reports, parsed data, analyst mapping, result
  cm360: { profiles: null, configs: {}, profileId: '', configId: '', loading: false, running: false, prep: null, files: {},
           data: null, mapping: {}, result: null, picking: false, tab: 'overview', log: [] },
  // Search Console check: fetched data and result
  gsc: { data: null, result: null, running: false, picking: false, tab: 'overview', log: [] },
  // Automatic run (GTM → GA4 → Search Console → CM360): { date, running, steps: [{ key, label, status, note }] }
  auto: null,
  consentFilter: 'All',
  tagSection: 'tags',
  workspaceOptions: [],
  log: []
};

// ── Small UI helpers ────────────────────────────────────────────────

let toastTimer = null;
function toast(msg, isError) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'show' + (isError ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, isError ? 6000 : 2800);
}

function download(name, text, type) {
  const blob = new Blob([text], { type: type || 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

function toCsv(rows) {
  return rows.map(r => r.map(c => {
    const s = String(c == null ? '' : c);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',')).join('\n');
}

async function copyText(text, label) {
  try { await navigator.clipboard.writeText(text); toast((label || 'Copied') + ' to clipboard'); }
  catch (e) { toast('Copy failed — select the text and copy it manually.', true); }
}

function fileSlug() {
  const r = STATE.result;
  const base = (r && (r.meta.client || hostOf_(r.meta.site) || 'audit')) || 'audit';
  return String(base).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + new Date().toISOString().slice(0, 10);
}

function sevClass(s) { return esc(s === '—' ? 'Paused' : s); }

// ── Navigation ──────────────────────────────────────────────────────

const VIEWS = {
  audit: renderAudit, summary: renderSummary, consent: renderConsent, tags: renderTags, ids: renderIds,
  live: renderLive, findings: renderFindings, ai: renderAI, settings: renderSettings, ga4: renderGa4, cm360: renderCm360, gsc: renderGsc,
  overview: renderOverview
};

function setView(view) {
  if (!VIEWS[view]) view = 'audit';
  if (!STATE.result && ['summary', 'consent', 'tags', 'ids', 'live', 'findings', 'ai'].indexOf(view) >= 0) view = 'audit';
  if (view === 'overview' && !hasOverview()) view = 'audit';
  STATE.view = view;
  $$('#nav .nav-item').forEach(b => {
    if (b.dataset.view === view) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  VIEWS[view]();
  updateGoogleStatus();
  try { history.replaceState(null, '', '#' + view); } catch (e) { /* ignore */ }
  $('#main').focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

// ── Google sign-in (one control, shown in the rail and in the forms that need it) ──

function googleClientId() {
  return (loadAppSettings().googleClientId || '').trim() || APP_CONFIG.googleClientId;
}

const RENEW_WARN_MINUTES = 5;

/** "ends in 4 min" when the sign-in is about to run out, else ''. */
function endsSoon(session) {
  const m = session.minutesLeft();
  return session.isSignedIn() && m < RENEW_WARN_MINUTES ? 'ends in ' + (m < 1 ? 'under a minute' : m + ' min') : '';
}

function googleStatusHtml() {
  if (Google.isSignedIn()) {
    const soon = endsSoon(Google);
    return `<span class="signed">Signed in${Google.user ? ' as <span class="account">' + esc(Google.user) + '</span>' : ' to Google'}</span>
      ${soon ? `<span class="hint" style="margin:0">Sign-in ${soon}.</span> <button class="link" data-act="renew">Renew now</button>` : ''}
      <button class="link" data-act="signout">Sign out</button>`;
  }
  return Google.hasExpired()
    ? `<span class="hint" style="margin:0">Your Google sign-in${Google.user ? ' (' + esc(Google.user) + ')' : ''} has ended (it lasts an hour).</span>
       <button class="btn secondary" data-act="signin">Renew sign-in</button>`
    : '<button class="btn secondary" data-act="signin">Sign in with Google</button>';
}

/** Short names of the extra permissions the main sign-in has. */
function connectedExtras() {
  return [[GSC_SCOPE, 'Search Console'], [CM360_SCOPE, 'CM360'], [CM360_TRAFFIC_SCOPE, 'Floodlight setup']].filter(x => (Google.scopes || []).indexOf(x[0]) >= 0).map(x => x[1]);
}

function updateGoogleStatus() {
  const el = $('#rail-google');
  if (!el) return;
  const line = (session, label, signinAct, signoutAct) => {
    if (session.isSignedIn()) {
      const soon = endsSoon(session);
      return `<span class="rail-signed" title="${esc(session.user || label)}">${esc(label)}: ${esc(session.user || 'signed in')}</span>
        ${soon ? `<span class="rail-warn">${esc(soon)} · <button class="link" data-act="${signinAct === 'signin' ? 'renew' : 'ads-renew'}">Renew</button></span>` : ''}
        <button class="link" data-act="${signoutAct}">Sign out${session === GoogleAds ? ' of Google Ads' : ''}</button>`;
    }
    if (session.hasExpired()) return `<button class="link" data-act="${signinAct}">${esc(label)} sign-in expired: renew</button>`;
    return session === Google ? '<button class="link" data-act="signin">Sign in with Google</button>' : '';
  };
  const extras = Google.isSignedIn() ? connectedExtras() : [];
  el.innerHTML = line(Google, 'Google', 'signin', 'signout') +
    (extras.length ? `<span class="rail-extra">Also: ${esc(extras.join(', '))}</span>` : '') +
    line(GoogleAds, 'Google Ads', 'ads-connect', 'ads-signout');
}

/** The Google Ads sign-in control (a separate Google account is allowed). */
function adsStatusHtml() {
  if (GoogleAds.hasScope(ADS_SCOPE)) {
    const soon = endsSoon(GoogleAds);
    return `<span class="signed">Google Ads: signed in${GoogleAds.user ? ' as <span class="account">' + esc(GoogleAds.user) + '</span>' : ''}</span>
      ${soon ? `<span class="hint" style="margin:0">Sign-in ${soon}.</span> <button class="link" data-act="ads-renew">Renew now</button>` : ''}
      <button class="link" data-act="ads-signout">Sign out</button>`;
  }
  return GoogleAds.hasExpired()
    ? `<span class="hint" style="margin:0">The Google Ads sign-in${GoogleAds.user ? ' (' + esc(GoogleAds.user) + ')' : ''} has ended (it lasts an hour).</span>
       <button class="btn secondary" data-act="ads-connect">Renew Google Ads sign-in</button>`
    : '<button class="btn secondary" data-act="ads-connect">Sign in for Google Ads</button>';
}

/** Settings → Connections: every Google account and permission in one place. */
function connectionsHtml() {
  const signed = Google.isSignedIn();
  const row = (name, what, status, action) => `<tr><th scope="row">${name}<span class="sub">${what}</span></th><td>${status}</td><td>${action}</td></tr>`;
  const ok = t => `<span class="sev OK">${t}</span>`;
  const extra = (scope, act) => !signed ? '<span class="sub">Sign in first</span>'
    : Google.hasScope(scope) ? ok('Connected') : `<button class="btn secondary" data-act="${act}">Connect</button>`;
  return `<div class="table-wrap"><table class="kv connections">
    <tbody>
      ${row('Google account', 'GTM and GA4, read only', signed ? ok('Signed in') + (Google.user ? '<span class="sub">' + esc(Google.user) + '</span>' : '') + (endsSoon(Google) ? '<span class="sub">' + esc(endsSoon(Google)) + '</span>' : '')
        : Google.hasExpired() ? '<span class="sev Medium">Ended</span>' : 'Not signed in',
        signed ? '<button class="link" data-act="renew">Renew</button> · <button class="link" data-act="signout">Sign out</button>'
          : `<button class="btn secondary" data-act="signin">${Google.hasExpired() ? 'Renew sign-in' : 'Sign in with Google'}</button>`)}
      ${row('Search Console', 'Same account, read only. Asked for when first used', extra(GSC_SCOPE, 'gsc-connect'), '')}
      ${row('CM360', 'Same account, reports only. Asked for when first used', extra(CM360_SCOPE, 'cm360-connect'), '')}
      ${row('CM360 Floodlight setup', 'Same account. Exact Floodlight tag matching. Edit-level permission; the app only reads Floodlight activities', extra(CM360_TRAFFIC_SCOPE, 'cm360-exact-connect'), '')}
      ${row('Google Ads', 'Its own Google account (can be different). Needs a developer token below', GoogleAds.hasScope(ADS_SCOPE)
          ? ok('Signed in') + (GoogleAds.user ? '<span class="sub">' + esc(GoogleAds.user) + '</span>' : '') : GoogleAds.hasExpired() ? '<span class="sev Medium">Ended</span>' : 'Not signed in',
        GoogleAds.hasScope(ADS_SCOPE) ? '<button class="link" data-act="ads-renew">Renew</button> · <button class="link" data-act="ads-signout">Sign out</button>'
          : `<button class="btn secondary" data-act="ads-connect">${GoogleAds.hasExpired() ? 'Renew sign-in' : 'Sign in for Google Ads'}</button>`)}
    </tbody></table></div>`;
}

/**
 * The sign-in leaves the page and comes back, so results in memory are kept for this tab
 * in sessionStorage first. Returns false if the user chooses to stay (results too large to keep).
 */
const SIGNIN_STASH_KEY = 'tas.signinStash';
function stashForSignIn() {
  saveDraft();
  if (!STATE.result && !STATE.ga4.result && !STATE.cm360.data && !STATE.gsc.data && !STATE.auto) return true;
  try {
    sessionStorage.setItem(SIGNIN_STASH_KEY, JSON.stringify({
      result: STATE.result, ga4: STATE.ga4.result, ai: { writeup: STATE.ai.writeup, fixplan: STATE.ai.fixplan, chat: STATE.ai.chat },
      cm360: STATE.cm360.data ? { data: STATE.cm360.data, mapping: STATE.cm360.mapping } : null,
      gsc: STATE.gsc.data || null,
      overrides: STATE.overrides, ga4Index: STATE.ga4.index, ga4Tab: STATE.ga4.tab,
      auto: STATE.auto ? Object.assign({}, STATE.auto, { running: false }) : null
    }));
    return true;
  } catch (e) {
    return confirm('Signing in reloads the page, and this audit is too large to keep for the trip.\n\n' +
                   'Choose Cancel and use "Save audit" first, or OK to sign in and lose the current results.');
  }
}

function restoreSignInStash() {
  let s = null;
  try { s = JSON.parse(sessionStorage.getItem(SIGNIN_STASH_KEY) || 'null'); sessionStorage.removeItem(SIGNIN_STASH_KEY); }
  catch (e) { return; }
  if (!s) return;
  STATE.result = s.result || null;
  STATE.ga4.result = s.ga4 || null;
  if (s.cm360) { STATE.cm360.data = s.cm360.data; STATE.cm360.mapping = s.cm360.mapping || {}; }
  STATE.ga4.index = s.ga4Index || 0;
  STATE.ga4.tab = s.ga4Tab || 'overview';
  STATE.ai = Object.assign(STATE.ai, s.ai || {});
  STATE.overrides = s.overrides || {};
  STATE.auto = s.auto || null;
  STATE.gsc.data = s.gsc || null;
}

function updateNav() {
  const r = STATE.result;
  $$('#nav-results .nav-item').forEach(b => { b.disabled = !r; });
  const setCount = (view, n, alert) => {
    const b = $('#nav [data-view="' + view + '"]');
    if (!b) return;
    const label = b.textContent.replace(/\d+$/, '').trim();
    b.innerHTML = esc(label) + (n ? ' <span class="count' + (alert ? ' alert' : '') + '">' + n + '</span>' : '');
  };
  const g4 = STATE.ga4.result;
  const g4High = g4 ? g4.properties.reduce((s, p) => s + p.issues.filter(i => i.severity === 'High').length, 0) : 0;
  setCount('ga4', g4High, g4High > 0);
  const ov = $('#nav [data-view="overview"]');
  if (ov) ov.disabled = !hasOverview();
  if (!r) return;
  const high = r.issues.filter(i => i.severity === 'High').length;
  const consentHigh = r.audit.tags.filter(t => !t.paused && t.risk === 'High').length;
  setCount('summary', high, high > 0);
  setCount('consent', consentHigh, consentHigh > 0);
  setCount('tags', r.audit.tags.length, false);
  setCount('ids', Object.keys(r.audit.ids).length, false);
  setCount('live', r.live ? r.live.verdicts.filter(v => v.verdict === 'High').length : 0, true);
}

// ══════════════════════════════════════════════════════════════════
//  AUDIT PIPELINE
// ══════════════════════════════════════════════════════════════════

function log(msg, isError) {
  STATE.log.push({ msg: msg, err: !!isError });
  const el = $('#run-log');
  if (el) {
    el.hidden = false;
    el.innerHTML = STATE.log.map(l => '<div' + (l.err ? ' class="err"' : '') + '>' + esc(l.msg) + '</div>').join('');
    el.scrollTop = el.scrollHeight;
  }
}

function parseIds(text) {
  return uniqueMatches_(String(text || '').toUpperCase(), ID_PATTERNS.GTM);
}

async function fetchPublicContainer(id) {
  if (STATE.caches.containers[id]) return STATE.caches.containers[id];
  try {
    const res = await fetch('https://www.googletagmanager.com/gtm.js?id=' + encodeURIComponent(id));
    const js = res.ok ? await res.text() : null;
    STATE.caches.containers[id] = { code: res.status, js: js };
  } catch (e) {
    STATE.caches.containers[id] = { code: 0, js: null, error: e.message };
  }
  return STATE.caches.containers[id];
}

/** The published Google tag for a GA4 measurement ID. It carries the data stream's settings. */
async function fetchPublicGtag(mid) {
  if (STATE.caches.gtag[mid]) return STATE.caches.gtag[mid];
  try {
    const res = await fetch('https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(mid));
    STATE.caches.gtag[mid] = { code: res.status, js: res.ok ? await res.text() : null };
  } catch (e) {
    STATE.caches.gtag[mid] = { code: 0, js: null, error: e.message };
  }
  return STATE.caches.gtag[mid];
}

function hasAuditSources() {
  const i = STATE.inputs;
  return !!(parseIds(i.publicIds).length || (i.pageSource && parseIds(i.pageSource).length) || parseIds(i.apiIds).length ||
            i.exports.length || (i.live && Object.keys(i.live.stages || {}).length));
}

async function runAudit(opts) {
  opts = opts || {};
  if (STATE.running) return;
  const i = STATE.inputs;
  const pageIds = i.pageSource ? parseIds(i.pageSource) : [];
  const apiIds = parseIds(i.apiIds);
  const hasLive = i.live && Object.keys(i.live.stages || {}).length;
  if (!hasAuditSources()) {
    toast('Add at least one source: a GTM ID, a container export, page source or live test results.', true);
    return;
  }
  STATE.running = true;
  STATE.log = [];
  const btn = $('#run-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Running audit…'; }
  ENGINE_HOOKS.progress = m => log(m);

  try {
    WEB_SETTINGS = Object.assign({}, i.rules, { clientName: i.client });
    TAG_OVERRIDES = STATE.overrides;
    const sources = [];

    // Containers analysed with full detail are not scanned publicly as well
    const fullIds = new Set();
    const exportsParsed = i.exports.map(ex => {
      try {
        const obj = JSON.parse(ex.text);
        const v = obj.containerVersion || obj;
        if (v.container && v.container.publicId) fullIds.add(v.container.publicId);
      } catch (e) { /* reported during analysis */ }
      return ex;
    });

    // GTM API (full detail)
    const apiDetails = [];
    if (apiIds.length) {
      if (!Google.isSignedIn()) {
        log('Skipped GTM API for ' + apiIds.join(', ') + ' — sign in with Google first.', true);
      } else {
        for (const id of apiIds) {
          log('Reading ' + id + ' from the GTM API…');
          try {
            const target = i.apiTarget || 'live';
            const cacheKey = id + '|' + target;
            if (!STATE.caches.api[cacheKey] || opts.refresh) STATE.caches.api[cacheKey] = await fetchGtmContainerDetail(id, log, target);
            const d = STATE.caches.api[cacheKey];
            d.target = target;
            apiDetails.push(d);
            if (d.version) fullIds.add(id);
          } catch (e) {
            log(id + ': ' + e.message, true);
            apiDetails.push({ publicId: id, error: e.message });
          }
        }
      }
    }

    // Published containers (public)
    const publicIds = Array.from(new Set(parseIds(i.publicIds).concat(pageIds))).filter(id => !fullIds.has(id));
    const toFetch = Array.from(new Set(publicIds.concat(pageIds)));
    for (const id of toFetch) {
      log('Downloading published container ' + id + '…');
      const c = await fetchPublicContainer(id);
      if (!c.js) log(id + ': ' + (c.code ? 'HTTP ' + c.code : 'network error ' + (c.error || '')), true);
    }

    // ── Analysis (synchronous engine) ──
    resetAudit_();
    containerCache_ = {};
    Object.keys(STATE.caches.containers).forEach(id => {
      const c = STATE.caches.containers[id];
      containerCache_[id] = { code: c.code, js: c.js };
    });
    let findings = [];

    if (i.pageSource) {
      log('Analysing page source…');
      findings = findings.concat(analyseHtml_(i.pageSource, true));
      sources.push('Page source');
    }
    if (publicIds.length) {
      findings = findings.concat(analyseContainers_(publicIds));
      sources.push('Published container ' + publicIds.join(', '));
    }
    exportsParsed.forEach(ex => {
      try {
        const r = analyseExportJson_(ex.text);
        findings = findings.concat(r.findings);
        sources.push('Container export ' + r.id);
        log('Analysed export ' + ex.name + ' (' + r.id + ')');
      } catch (e) {
        log(ex.name + ': ' + e.message, true);
      }
    });
    apiDetails.forEach(d => {
      if (d.noAccess) {
        findings.push(row_('🔒 GTM Container Restricted', d.publicId, 'GTM API',
                           'Your Google account has no access to this container', 'Ask for Read access, or use a container export'));
      } else if (d.error) {
        findings.push(row_('❌ GTM API Error', d.publicId, 'GTM API', d.error, 'Check access and that a version is published'));
      } else {
        const isLive = (d.target || 'live') === 'live';
        if (!(d.version.tag || []).length) {
          recordIssue_('Hygiene', 'Medium', (isLive ? 'The live version of ' : 'Workspace "' + d.target + '" in ') + d.publicId + ' has no tags',
            isLive ? 'Nothing is published. If the tags are still being built, choose the workspace under "Version to audit" and run again'
                   : 'Check you chose the right workspace', d.publicId);
          log((isLive ? 'The live version of ' + d.publicId + ' has no tags. To audit unpublished work, choose a workspace under "Version to audit".'
                      : 'Workspace "' + d.target + '" has no tags.'), true);
        }
        findings = findings.concat(analyseContainerVersion_(d.version, {
          publicId: d.publicId,
          source: isLive ? 'GTM API · live version ' + (d.version.containerVersionId || '?') : 'GTM API · workspace "' + d.target + '" (unpublished)',
          note: joinParts_(d.container.accountName && 'Account: ' + d.container.accountName, 'Full detail from the GTM API')
        }));
        findings = findings.concat(workspaceRowsFromData_(d.workspaces, d.publicId));
        sources.push('GTM API ' + d.publicId + ((d.target || 'live') === 'live' ? ' (live version)' : ' (workspace "' + d.target + '", unpublished)'));
      }
    });
    if (hasLive) { AUDIT.liveData = i.live; sources.push('Live consent test'); }

    // GA4 checks need the measurement IDs found above
    const liveMids = Array.from(new Set(Object.keys(AUDIT.ids).map(k => AUDIT.ids[k])
      .filter(r => r.platform === 'GA4' && r.live && /^G-[A-Z0-9]+$/.test(r.id)).map(r => r.id)));
    if ((i.rules.ga4Checks || 'Auto') !== 'No' && liveMids.length) {
      // Data stream settings from the public Google tag (no sign-in needed)
      AUDIT.gtagStreams = {};
      log('Reading the published Google tag for ' + liveMids.join(', ') + '…');
      const gtags = await Promise.all(liveMids.map(fetchPublicGtag));
      gtags.forEach((g, n) => {
        if (g.js) AUDIT.gtagStreams[liveMids[n]] = g.js;
        else log(liveMids[n] + ': Google tag could not be downloaded (' + (g.code ? 'HTTP ' + g.code : g.error || 'network error') + ')', true);
      });
    }
    const ga4FetchedNow = new Set();   // GA4 properties read in full during this run (not read twice)
    if (i.ga4 && (i.rules.ga4Checks || 'Auto') !== 'No') {
      const mids = liveMids;
      if (mids.length && Google.isSignedIn()) {
        AUDIT.ga4Data = {};
        const hints = { client: i.client, site: i.site };
        if (i.ga4Full) {
          // One full read per property serves both the GTM report's GA4 checks and the GA4 report
          const props = {};
          for (const mid of mids) {
            try {
              const lookup = await findGa4Property(mid, log, hints, !!opts.refresh);
              if (!lookup.property) { AUDIT.ga4Data[mid] = { noAccess: true, skipped: lookup.skipped }; continue; }
              const p = lookup.property;
              STATE.ga4.known[p.property] = { property: p.property, displayName: p.displayName, account: p.account };
              props[mid] = p;
            } catch (e) {
              AUDIT.ga4Data[mid] = { error: e.message };
              log(mid + ': ' + e.message, true);
            }
          }
          const names = Array.from(new Set(Object.keys(props).map(mid => props[mid].property)));
          const failed = {};
          await runPooled_(names.map(name => async () => {
            if (STATE.caches.ga4full[name] && !opts.refresh) return;
            try {
              STATE.caches.ga4full[name] = await fetchGa4Full(STATE.ga4.known[name], log);
              ga4FetchedNow.add(name);
            } catch (e) { failed[name] = e.message; log(STATE.ga4.known[name].displayName + ': ' + e.message, true); }
          }), 2);
          Object.keys(props).forEach(mid => {
            const name = props[mid].property;
            AUDIT.ga4Data[mid] = failed[name] ? { error: failed[name] } : ga4PropertyDataFromFull(STATE.caches.ga4full[name], props[mid]);
          });
        } else {
          for (const mid of mids) {
            try {
              if (!STATE.caches.ga4[mid] || opts.refresh) STATE.caches.ga4[mid] = await fetchGa4PropertyData(mid, log, hints, !!opts.refresh);
              AUDIT.ga4Data[mid] = STATE.caches.ga4[mid];
            } catch (e) {
              AUDIT.ga4Data[mid] = { error: e.message };
              log(mid + ': ' + e.message, true);
            }
          }
        }
        sources.push('GA4 Admin API');
      } else if (mids.length) {
        log('GA4 property checks skipped — sign in with Google to run them.');
      }
    }

    log('Running audit checks…');
    const rows = dedupe_(findings.concat(runAuditChecks_()));
    STATE.result = buildResult(rows, sources);
    log('Done: ' + STATE.result.issues.length + ' issues, health score ' + STATE.result.score.score + '/100.');

    // Separate GA4 audit for the GA4 properties behind the live measurement IDs
    if (i.ga4Full && Google.isSignedIn() && liveMids.length && (i.rules.ga4Checks || 'Auto') !== 'No') {
      const found = await ga4PropertiesForIds(liveMids, log);
      if (found.length) {
        found.forEach(p => { STATE.ga4.known[p.property] = p; });
        STATE.ga4.selected = Array.from(new Set(found.map(p => p.property)));
        await runGa4Audit({ stay: true, refresh: !!opts.refresh, fresh: ga4FetchedNow });
      }
    }
    saveDraft();
    updateNav();
    if (!opts.stay) setView('summary'); else VIEWS[STATE.view]();
    return true;
  } catch (e) {
    console.error(e);
    log('Audit failed: ' + e.message, true);
    toast('Audit failed: ' + e.message, true);
    return false;
  } finally {
    STATE.running = false;
    const b = $('#run-btn');
    if (b) { b.disabled = false; b.textContent = 'Run audit'; }
  }
}

function buildResult(rows, sources) {
  const groups = groupFindings_(rows).map(g => ({
    name: g.name, plain: g.plain || null, logo: g.logo || '', header: g.header,
    isTag: !!(g.rows[0] && g.rows[0].group), rows: g.rows.map(r => r.slice(0, 5)),
    tagIndices: g.rows.map(r => Number.isInteger(r.tagIndex) ? r.tagIndex : null),
    entityRefs: g.rows.map(r => r.entity || null)
  }));
  const issues = AUDIT.issues.slice().sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  const areas = AREAS.map(area => {
    const list = issues.filter(x => x.area === area);
    const checked = areaChecked_(area);
    let status, findings = list.map(x => x.finding), action = list[0] ? list[0].action : '';
    if (list.length) status = list[0].severity === 'High' ? 'Action needed' : list[0].severity === 'Medium' ? 'Review' : 'Minor';
    else if (area === 'GA4 Property' && !AUDIT.ga4PropertyChecked) {
      status = 'Not checked'; findings = ['Needs Google sign-in with access to the GA4 property'];
    } else if (area === 'Hygiene' && !AUDIT.fullDetail) {
      status = 'Partly checked'; findings = ['Unused triggers/variables, folders and naming need the GTM API or an export'];
    } else status = 'No issues';
    return { area: area, score: checked ? areaScore_(area) : null, status: status, findings: findings, action: action,
             top: list[0] ? list[0].severity : null };
  });
  const tags = AUDIT.tags.map(t => Object.assign({}, t, { text: String(t.text || '').slice(0, 6000) }));
  const live = AUDIT.liveData ? { data: AUDIT.liveData, verdicts: liveTestVerdicts_(AUDIT.liveData) } : null;
  return {
    meta: { client: STATE.inputs.client, site: STATE.inputs.site, date: new Date().toISOString(), sources: sources,
            settings: Object.assign({}, STATE.inputs.rules) },
    rows: rows.map(r => r.slice(0, 5)),
    groups: groups,
    issues: issues,
    areas: areas,
    score: overallScore_(),
    live: live,
    audit: {
      tags: tags, triggers: AUDIT.triggers, variables: AUDIT.variables,
      ids: AUDIT.ids, consentMode: AUDIT.consentMode, fullDetail: AUDIT.fullDetail,
      pageScanned: AUDIT.pageScanned, ga4PropertyChecked: AUDIT.ga4PropertyChecked, liveTest: AUDIT.liveTest,
      issues: issues,
      // For the GA4 report's GTM cross-reference
      ga4Events: AUDIT.ga4Events, googleTags: AUDIT.googleTags, pageGoogleConfigs: AUDIT.pageGoogleConfigs,
      userProps: Array.from(AUDIT.userProps), gtagSettings: AUDIT.gtagSettings,
      floodlightTags: AUDIT.floodlightTags   // for the CM360 cross-check
    }
  };
}

// ══════════════════════════════════════════════════════════════════
//  VIEW: NEW AUDIT
// ══════════════════════════════════════════════════════════════════

function renderAudit() {
  const i = STATE.inputs;
  const s = loadAppSettings();
  const stages = i.live ? Object.keys(i.live.stages || {}) : [];
  const ruleDefs = SETTINGS_DEFS.filter(d => d[0] !== 'clientName');
  $('#view').innerHTML = `
    <h1>New audit</h1>
    <p class="lede">Combine any of the sources below. More sources give a fuller picture; the published container alone is enough to start.</p>

    <section class="form-block" aria-labelledby="client-h">
      <h2 id="client-h" style="margin-top:0">Client</h2>
      <div class="grid2">
        <div><label for="in-client">Client name</label><input type="text" id="in-client" value="${esc(i.client)}" placeholder="e.g. Omoda UK"></div>
        <div><label for="in-site">Website</label><input type="url" id="in-site" value="${esc(i.site)}" placeholder="https://www.example.co.uk"></div>
      </div>
    </section>

    <section class="form-block" aria-labelledby="src-h">
      <h2 id="src-h" style="margin-top:0">Sources</h2>

      <div class="source">
        <div><h3>Published container</h3><p class="what">Reads the live GTM container straight from Google. Tag names are not included.</p><span class="tag">No access needed</span></div>
        <div><label for="in-public">GTM container IDs</label>
          <input type="text" id="in-public" value="${esc(i.publicIds)}" placeholder="GTM-XXXXXXX, GTM-YYYYYYY">
          <p class="hint">Containers found in the page source below are added automatically.</p></div>
      </div>

      <div class="source">
        <div><h3>GTM and GA4 via Google</h3><p class="what">Real tag names, triggers, folders, unpublished changes and GA4 property settings.</p><span class="tag">Needs read access</span></div>
        <div>
          <div class="row" style="margin-bottom:10px">
            ${googleStatusHtml()}
          </div>
          <label for="in-api">GTM container IDs to read through the API</label>
          <input type="text" id="in-api" value="${esc(i.apiIds)}" placeholder="GTM-XXXXXXX">
          <label for="in-target" style="margin-top:10px">Version to audit</label>
          <div class="row">
            <select id="in-target" style="width:auto;min-width:280px">
              <option value="live" ${(i.apiTarget || 'live') === 'live' ? 'selected' : ''}>Live (published) version</option>
              ${Array.from(new Set(STATE.workspaceOptions.concat(i.apiTarget && i.apiTarget !== 'live' ? [i.apiTarget] : [])))
                .map(n => `<option value="${esc(n)}" ${i.apiTarget === n ? 'selected' : ''}>Workspace: ${esc(n)} (unpublished)</option>`).join('')}
            </select>
            <button class="btn secondary" data-act="load-workspaces" ${Google.isSignedIn() ? '' : 'disabled'}>Load workspaces</button>
          </div>
          <p class="hint">A workspace includes changes that are not live yet. Use it to review work in progress before it's published.</p>
          <label style="margin-top:10px;font-weight:400"><input type="checkbox" id="in-ga4" ${i.ga4 ? 'checked' : ''}> Check the GA4 properties behind the measurement IDs found</label>
          <label style="margin-top:6px;font-weight:400"><input type="checkbox" id="in-ga4full" ${i.ga4Full ? 'checked' : ''}> Also run the full GA4 audit for them (separate GA4 report, includes the last 28 days of data)</label>
          <label style="margin-top:6px;font-weight:400"><input type="checkbox" id="in-gscauto" ${i.gscAuto ? 'checked' : ''}> Then run the Search Console check for the website (read only)</label>
          <label style="margin-top:6px;font-weight:400"><input type="checkbox" id="in-cm360auto" ${i.cm360Auto ? 'checked' : ''}> Then run the CM360 check if GTM has Floodlight tags</label>
          <p class="hint">${Google.hasScope(CM360_SCOPE) ? 'CM360 reports are connected.' : Google.isSignedIn()
            ? 'CM360 needs its own reports-only permission. <button class="link" data-act="cm360-connect">Connect CM360 now</button>, or the run asks for it when it gets there.'
            : 'Sign in with Google first; CM360 also needs its own reports-only permission.'}
            The run pauses once for you to download the two CM360 reports and drop them in.
            ${Google.hasScope(GSC_SCOPE) ? 'Search Console is connected.' : 'Search Console also needs its own read-only permission; the run asks for it together with CM360.'}</p>
        </div>
      </div>

      <div class="source">
        <div><h3>Container export</h3><p class="what">Same detail as the API, from a file: GTM → Admin → Export Container.</p><span class="tag">No sign-in</span></div>
        <div>
          <input type="file" id="in-export" accept=".json,application/json" multiple>
          <div class="chips">${i.exports.map((e, n) => `<span class="chip on">${esc(e.name)} <button class="link" data-act="rm-export" data-n="${n}" aria-label="Remove ${esc(e.name)}">×</button></span>`).join('')}</div>
        </div>
      </div>

      <div class="source">
        <div><h3>Page source</h3><p class="what">Inline gtag config, consent defaults, data layer and scripts. Browsers can't download other sites, so paste it here.</p></div>
        <div>
          <textarea id="in-page" placeholder="Paste the page source here">${esc(i.pageSource)}</textarea>
          <p class="hint">On the client's site press F12 → Console and run the snippet; the rendered page is copied to your clipboard.
            <button class="link" data-act="copy-page-snippet">Copy snippet</button>. Or use Ctrl+U and copy everything.</p>
        </div>
      </div>

      <div class="source">
        <div><h3>Live consent test</h3><p class="what">What really fires before a choice, after Deny and after Accept.</p></div>
        <div>
          <p class="hint" style="margin-top:0">In an Incognito window on the site, wait for the cookie banner, open F12 → Console and run the snippet (<button class="link" data-act="copy-live-snippet">Copy snippet</button>).
            Paste the result below. Repeat after clicking Deny, then in a new Incognito window after Accept all.</p>
          <textarea id="in-live" placeholder='{"tool":"tag-scanner-live-test", …}'></textarea>
          <div class="row" style="margin-top:8px">
            <label for="in-live-stage" style="margin:0;font-weight:400">State if not detected</label>
            <select id="in-live-stage" style="width:auto"><option value="">Auto</option>${Object.keys(LIVE_STAGES).map(k => `<option value="${k}">${esc(LIVE_STAGES[k])}</option>`).join('')}</select>
            <button class="btn secondary" data-act="add-live">Add results</button>
            ${stages.length ? '<button class="link" data-act="clear-live">Clear live results</button>' : ''}
          </div>
          <div class="chips">${Object.keys(LIVE_STAGES).map(k => `<span class="chip ${stages.indexOf(k) >= 0 ? 'on' : ''}">${esc(LIVE_STAGES[k])}</span>`).join('')}</div>
          ${runnerImportControl()}
        </div>
      </div>
    </section>

    <section class="form-block">
      <details class="rules">
        <summary>Client rules (consent categories, naming and approved vendors)</summary>
        ${ruleDefs.map(d => `
          <div class="rule"><div><label for="rule-${d[0]}">${esc(d[1])}</label><p class="hint">${esc(d[3])}</p></div>
          <div><input type="text" id="rule-${d[0]}" data-rule="${d[0]}" value="${esc(i.rules[d[0]] != null ? i.rules[d[0]] : d[2])}"></div></div>`).join('')}
      </details>
    </section>

    <div class="actions">
      <button class="btn big" id="run-btn">Run audit</button>
      ${STATE.result ? '<button class="btn secondary big" data-act="goto" data-view="summary">Back to results</button>' : ''}
    </div>
    <div class="log" id="run-log" ${STATE.log.length ? '' : 'hidden'}>${STATE.log.map(l => '<div' + (l.err ? ' class="err"' : '') + '>' + esc(l.msg) + '</div>').join('')}</div>`;

  const bind = (id, key, prop) => {
    const el = $('#' + id);
    el.addEventListener(prop === 'checked' ? 'change' : 'input', () => { STATE.inputs[key] = el[prop || 'value']; saveDraft(); });
  };
  bind('in-client', 'client'); bind('in-site', 'site'); bind('in-public', 'publicIds');
  bind('in-api', 'apiIds'); bind('in-ga4', 'ga4', 'checked'); bind('in-ga4full', 'ga4Full', 'checked'); bind('in-cm360auto', 'cm360Auto', 'checked'); bind('in-gscauto', 'gscAuto', 'checked'); bind('in-page', 'pageSource'); bind('in-target', 'apiTarget');
  $$('[data-rule]').forEach(el => el.addEventListener('input', () => { STATE.inputs.rules[el.dataset.rule] = el.value; saveDraft(); }));

  $('#in-export').addEventListener('change', async e => {
    for (const f of Array.from(e.target.files)) {
      const text = await f.text();
      STATE.inputs.exports.push({ name: f.name, text: text });
    }
    renderAudit();
  });
  $('#run-btn').addEventListener('click', () => runFullAudit());
}

// ══════════════════════════════════════════════════════════════════
//  VIEW: SUMMARY
// ══════════════════════════════════════════════════════════════════

let tagPanelId = 0;

function tagToggle(index, label) {
  const tag = STATE.result && STATE.result.audit.tags[index];
  if (!tag) return esc(label);
  return `<button type="button" class="tag-toggle" data-act="tag-details" data-tag-index="${index}" aria-expanded="false">${esc(label || tag.label)}</button>`;
}

function entityToggle(kind, index, label) {
  const entry = STATE.result && (STATE.result.audit[kind] || [])[index];
  if (!entry || !['triggers', 'variables'].includes(kind)) return esc(label);
  return `<button type="button" class="tag-toggle" data-act="entity-details" data-entity-kind="${kind}" data-entity-index="${index}" aria-expanded="false">${esc(label || entry.name)}</button>`;
}

function entityUsage(entry) {
  if (!entry.usageKnown) return { label: 'Not checked', style: 'Info' };
  return entry.usage.length ? { label: 'Referenced', style: 'OK' } : { label: 'Unused', style: 'Check' };
}

function inventoryReference(reference) {
  const label = reference.name + (reference.paused ? ' (paused)' : '');
  const control = reference.kind === 'tags' ? tagToggle(reference.index, label)
    : ['triggers', 'variables'].includes(reference.kind) ? entityToggle(reference.kind, reference.index, label) : esc(label);
  return `<li>${control}${reference.role ? `<span class="sub">${esc(reference.role)}</span>` : ''}</li>`;
}

function entityTechnicalContent(kind, entry) {
  const usage = entityUsage(entry);
  return `<div class="tag-detail-content"><h2>${esc(entry.name)}</h2>
    <p class="hint">${entry.format === 'api'
      ? 'Complete configuration from the GTM API / export. Static references include paused tags and other container items; they do not prove execution. Dynamic lookups cannot be inferred. Review before deleting an unused item.'
      : 'Published-container representation only: original definitions and names may be unavailable. Unused status cannot be established from compiled data.'}</p>
    <dl class="tag-facts">
      <div><dt>Source</dt><dd>${esc(entry.container)} · ${esc(entry.source)}</dd></div>
      <div><dt>Type</dt><dd>${esc(entry.typeLabel)} (${esc(entry.type)})</dd></div>
      <div><dt>Usage</dt><dd><span class="sev ${usage.style}">${usage.label}</span></dd></div>
      ${entry.folder ? `<div><dt>Folder</dt><dd>${esc(entry.folder)}</dd></div>` : ''}
      ${entry.builtIn ? '<div><dt>Definition</dt><dd>Built-in GTM item</dd></div>' : ''}
    </dl>
    <h3>Referenced by</h3>${entry.usage.length ? `<ul class="inventory-references">${entry.usage.map(inventoryReference).join('')}</ul>`
      : `<p>${entry.usageKnown ? 'No other tags, triggers or variables reference this item in the supplied snapshot.'
        : 'No references identified in the available compiled data; this does not establish that the item is unused.'}</p>`}
    ${entry.references.length ? `<h3>References</h3><ul class="inventory-references">${entry.references.map(inventoryReference).join('')}</ul>` : ''}
    ${tagConfigurationSection('Custom JavaScript / code (as configured)', entry.code)}
    ${tagConfigurationSection('Complete ' + (kind === 'triggers' ? 'trigger' : 'variable') + ' configuration available from this source', entry.configuration)}
    ${tagConfigurationSection('Custom template definitions', entry.templates)}
  </div>`;
}

function tagReferences(tags) {
  return tags.map(tag => tagToggle(STATE.result.audit.tags.indexOf(tag), tag.label)).join(' ');
}

function idTagReferences(record) {
  return record.tags.map(label => {
    const matches = STATE.result.audit.tags.filter(t => t.label === label && record.where.indexOf(t.where) >= 0);
    return matches.length ? tagReferences(matches) : esc(label);
  }).join(', ');
}

function liveVendorTags(vendor) {
  const tags = STATE.result ? STATE.result.audit.tags.filter(t => t.platform === vendor || t.vendor === vendor) : [];
  return tags.length ? `<div class="tag-references"><span class="sub">Related container tags (firing unverified)</span>${tagReferences(tags)}</div>` : '';
}

function tagIndexForRow(g, row, index) {
  if (g.tagIndices && Number.isInteger(g.tagIndices[index])) return g.tagIndices[index];
  if (!g.isTag) return -1;
  return STATE.result.audit.tags.findIndex(t => t.where === row[2] &&
    (t.label === row[1] || t.label === String(row[1]).replace(/^\S+\s/, '')));
}

function issueTagReferences(issue) {
  if (!STATE.result) return '';
  const tags = STATE.result.audit.tags.filter(t => (issue.items || []).some(item =>
    item === t.label || String(item).indexOf(t.label + ':') === 0) ||
    issue.where === t.where || String(issue.where).indexOf(t.where + ' · ') === 0);
  return tags.length ? `<div class="tag-references">${tagReferences(tags)}</div>` : '';
}

function tagConfigurationSection(title, value) {
  if (value == null || (Array.isArray(value) && !value.length)) return '';
  return `<section class="tag-config-section"><h3>${esc(title)}</h3>
    <pre tabindex="0"><code>${esc(typeof value === 'string' ? value : JSON.stringify(value, null, 2))}</code></pre></section>`;
}

function configurationLabel(key, owner) {
  const labels = {
    tagId: 'Tag ID', measurementId: 'Measurement ID', measurementIdOverride: 'Measurement ID override',
    eventName: 'Event name', html: 'HTML', javascript: 'JavaScript',
    dataLayerVersion: 'Data Layer Version', setDefaultValue: 'Set default value', defaultValue: 'Default value',
    configSettingsTable: 'Configuration settings', fieldsToSet: 'Fields to set',
    eventSettingsTable: 'Event parameters', eventParameters: 'Event parameters',
    eventSettingsVariable: 'Event Settings Variable', configSettingsVariable: 'Configuration Settings Variable',
    parameter: 'Parameter', parameterValue: 'Value', fieldName: 'Field name',
    conversionId: 'Conversion ID', conversionLabel: 'Conversion label', value: 'Value',
    sendEcommerceData: 'Send Ecommerce data', getEcommerceDataFrom: 'Data source',
    ecommerceMacroData: 'Ecommerce object',
    input: 'Input variable', map: 'Lookup table', fullUrl: 'Full URL', url: 'URL',
    enableSupportDocumentWrite: 'Support document.write', tagFiringOption: 'Tag firing options',
    firingTriggerId: 'Firing triggers', blockingTriggerId: 'Exceptions', triggerIds: 'Triggers'
  };
  if (key === 'measurementIdOverride' && owner && owner.type === 'gaawe') return 'Measurement ID';
  if (key === 'parameter' && owner && owner.type === 'gaawe') return 'Event Parameter';
  if (key === 'name' && owner && owner.type === 'v') return 'Data Layer Variable Name';
  if (owner && ['smm', 'remm'].includes(owner.type)) {
    if (key === 'key') return owner.type === 'remm' ? 'Pattern' : 'Input';
    if (key === 'value') return 'Output';
    if (key === 'map' && owner.type === 'remm') return 'RegEx table';
  }
  return labels[key] || String(key).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ')
    .replace(/^./, c => c.toUpperCase());
}

function configurationItems(kind, owner) {
  const source = owner.source || (owner.inspection && owner.inspection.source);
  return ((STATE.result && STATE.result.audit[kind]) || []).map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.source === source && (owner.container ? entry.container === owner.container
      : owner.where === entry.container || String(owner.where).startsWith(entry.container + ' ·')));
}

function configurationText(value, owner) {
  const variables = configurationItems('variables', owner);
  return String(value == null ? '' : value).split(/(\{\{[^{}]+\}\})/g).map(part => {
    const match = /^\{\{([^{}]+)\}\}$/.exec(part);
    const variable = match && variables.find(({ entry }) => entry.name === match[1]);
    return variable ? `<span class="configuration-reference">${entityToggle('variables', variable.index, part)}</span>` : esc(part);
  }).join('');
}

function configurationValue(parameter, owner) {
  if (parameter.type === 'list') {
    const list = parameter.list || [];
    if (!list.length) return '<span class="sub">No entries configured</span>';
    if (list.every(item => item.type === 'map')) {
      const keys = Array.from(new Set(list.flatMap(item => (item.map || []).map(field => field.key))));
      return `<div class="configuration-table"><table><thead><tr>${keys.map(key =>
        `<th>${esc(configurationLabel(key, owner))}</th>`).join('')}</tr></thead><tbody>${list.map(item =>
        `<tr>${keys.map(key => {
          const field = (item.map || []).find(field => field.key === key);
          return `<td>${field ? configurationValue(field, owner) : ''}</td>`;
        }).join('')}</tr>`).join('')}</tbody></table></div>`;
    }
    return `<ul class="configuration-list">${list.map(item => `<li>${configurationValue(item, owner)}</li>`).join('')}</ul>`;
  }
  if (parameter.type === 'map') return configurationParameters(parameter.map || [], owner);
  if (parameter.type === 'triggerReference') {
    const trigger = configurationItems('triggers', owner).find(({ entry }) => String(entry.id) === String(parameter.value));
    if (trigger) return entityToggle('triggers', trigger.index, trigger.entry.name);
  }
  return configurationText(parameter.value, owner);
}

function configurationParameters(parameters, owner) {
  return `<dl class="configuration-fields">${parameters.map(parameter =>
    parameter.key === 'sendEcommerceData' && ['true', 'false'].includes(String(parameter.value))
      ? `<div class="configuration-check"><dt>${esc(configurationLabel(parameter.key, owner))}</dt><dd><span aria-hidden="true">${String(parameter.value) === 'true'
        ? '<svg viewBox="0 0 16 16" width="16" height="16"><path d="m3 8 3 3 7-7" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>'
        : '&#8722;'}</span><span class="configuration-accessible">${String(parameter.value) === 'true' ? 'Enabled' : 'Disabled'}</span></dd></div>`
      : `<div><dt>${esc(configurationLabel(parameter.key || parameter.type, owner))}</dt><dd>${['html', 'javascript'].includes(parameter.key)
      ? tagConfigurationSection(parameter.key === 'html' ? 'HTML' : 'JavaScript', parameter.value)
      : parameter.key === 'dataLayerVersion' && owner.type === 'v' ? 'Version ' + esc(parameter.value)
      : parameter.key === 'getEcommerceDataFrom' && parameter.value === 'dataLayer' ? 'Data Layer'
      : configurationValue(parameter, owner)}</dd></div>`).join('')}</dl>`;
}

function configurationSection(title, content) {
  return `<section class="configuration-section"><h4>${esc(title)}</h4>${content}</section>`;
}

function tagConfigurationParameters(parameters, tag) {
  const sections = [
    ['Configuration settings', ['configSettingsVariable', 'configSettingsTable', 'fieldsToSet']],
    [tag.type === 'gaawe' ? 'Event Parameters' : 'Shared event settings', ['eventSettingsVariable', 'eventSettingsTable', 'eventParameters']],
    ['Ecommerce', ['sendEcommerceData', 'getEcommerceDataFrom', 'ecommerceMacroData']]
  ];
  const grouped = new Set(sections.flatMap(section => section[1]));
  return configurationParameters(parameters.filter(p => !grouped.has(p.key)), tag) +
    sections.map(([title, keys]) => {
      const fields = parameters.filter(p => keys.includes(p.key));
      return fields.length ? configurationSection(title, configurationParameters(fields, tag)) : '';
    }).join('');
}

function configurationCard(title, content) {
  return `<section class="configuration-card"><h3>${esc(title)}</h3>${content}</section>`;
}

function moreConfigurationDetails(content) {
  return `<details class="configuration-more"><summary class="btn secondary">More details</summary>${content}</details>`;
}

function configurationType(label, type, kind) {
  const analytics = kind === 'Tag' && ['gaawe', 'gaawc'].includes(type);
  const paths = analytics
    ? '<path d="M5 15v4M12 9v10M19 3v16" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>'
    : kind === 'Trigger' ? '<path d="m9 7-5 5 5 5m6-10 5 5-5 5" fill="none" stroke="currentColor" stroke-width="2"/>'
      : '<path d="m3 8 9-5 9 5-9 5-9-5Zm0 5 9 5 9-5M3 18l9 5 9-5" fill="none" stroke="currentColor" stroke-width="1.5"/>';
  const provider = kind === 'Tag' && ['gaawe', 'gaawc'].includes(type) ? 'Google Analytics'
    : kind === 'Tag' && type === 'googtag' ? 'Google' : '';
  return `<div class="configuration-type"><span class="configuration-type-label">${esc(kind)} Type</span>
    <div class="configuration-type-row"><span class="configuration-icon${analytics ? ' analytics' : kind === 'Trigger' ? ' trigger' : ''}" aria-hidden="true">
      <svg viewBox="0 0 24 26" width="24" height="26">${paths}</svg></span>
      <div><strong>${esc(type === 'gaawe' ? 'Google Analytics: GA4 Event' : label)}</strong>${provider ? `<span class="sub">${provider}</span>` : ''}</div>
    </div></div>`;
}

function tagDetailContent(tag) {
  const detail = tag.inspection;
  const configuration = detail && detail.format === 'api' && detail.configuration;
  if (!configuration) return `<div class="tag-detail-content"><h2>${esc(tag.label)}</h2>
    <p class="hint">A GTM-style configuration view requires an API source or container export. ${detail
      ? 'Published data does not contain the original authoring settings.' : 'Original configuration was not saved in this audit. Re-run the audit for complete details.'}</p>
    ${moreConfigurationDetails(tagTechnicalContent(tag))}</div>`;
  const template = (detail.templates || []).find(t => t.name);
  const typeName = (GTM_TAGS[tag.type] && GTM_TAGS[tag.type].name) || (template && template.name) || tag.type;
  const triggers = configurationItems('triggers', tag);
  const triggerList = (ids, names, empty) => (ids || []).length
    ? `<ul class="inventory-references">${ids.map((id, i) => {
      const match = triggers.find(({ entry }) => String(entry.id) === String(id));
      return `<li>${match ? entityToggle('triggers', match.index, match.entry.name)
        : esc((names || [])[i] || BUILT_IN_TRIGGERS[id] || 'Trigger ' + id)}</li>`;
    }).join('')}</ul>` : `<p>${esc(empty)}</p>`;
  const consent = configuration.consentSettings;
  const consentLabel = !consent || !consent.consentStatus || consent.consentStatus === 'notSet' ? 'Not set'
    : consent.consentStatus === 'notNeeded' ? 'No additional consent required'
      : consent.consentStatus === 'needed' ? 'Require additional consent for tag to fire' : consent.consentStatus;
  return `<div class="tag-detail-content configuration-view"><h2>${esc(tag.label)}</h2>
    <p class="hint">Read-only GTM configuration. Variable references are not evaluated; configuration is not proof of firing.</p>
    ${tag.paused ? '<p class="hint">This tag is paused.</p>' : ''}
    ${configurationCard('Tag Configuration', configurationType(typeName, tag.type, 'Tag') +
      tagConfigurationParameters(configuration.parameter || [], tag) +
      configurationSection('Consent Settings', `<dl class="configuration-fields"><div><dt>Additional Consent Checks</dt><dd>${esc(consentLabel)}</dd></div>
      ${consent && consent.consentType ? `<div><dt>Consent types</dt><dd>${configurationValue(consent.consentType, tag)}</dd></div>` : ''}</dl>
      <p class="hint">Built-in consent checks are not supplied as an authoritative list by this source. Verify them in GTM.</p>`))}
    ${configurationCard('Triggering', `<h4>Firing Triggers</h4>${triggerList(configuration.firingTriggerId, tag.firesOn,
      'No firing triggers configured. Tag sequencing may still invoke this tag.')}
      ${(configuration.blockingTriggerId || []).length ? `<h4>Exceptions</h4>${triggerList(configuration.blockingTriggerId, tag.blockedBy, '')}` : ''}`)}
    ${configurationCard('Advanced Settings', configurationParameters([
      ...(configuration.tagFiringOption ? [{ key: 'tagFiringOption', value: ({
        oncePerEvent: 'Once per event', oncePerLoad: 'Once per page', unlimited: 'Unlimited'
      })[configuration.tagFiringOption] || configuration.tagFiringOption }] : []),
      ...(configuration.setupTag ? [{ key: 'Setup tags', value: configuration.setupTag.map(t => t.tagName).join(', ') }] : []),
      ...(configuration.teardownTag ? [{ key: 'Cleanup tags', value: configuration.teardownTag.map(t => t.tagName).join(', ') }] : [])
    ], tag) + (tag.notes ? `<p>${esc(tag.notes)}</p>` : '') + '<p class="hint">Only supplied settings are shown. More details contains every original field.</p>')}
    ${moreConfigurationDetails(tagTechnicalContent(tag))}</div>`;
}

function entityDetailContent(kind, entry) {
  const title = kind === 'triggers' ? 'Trigger' : 'Variable';
  if (entry.format !== 'api') return `<div class="tag-detail-content"><h2>${esc(entry.name)}</h2>
    <p class="hint">Published-container representation only. Original GTM settings cannot be reconstructed. Unused status cannot be established from compiled data.</p>
    ${moreConfigurationDetails(entityTechnicalContent(kind, entry))}</div>`;
  const configuration = entry.configuration;
  const template = (entry.templates || []).find(t => t.name);
  let settings = configurationType(entry.builtIn ? entry.name : (template && template.name) || entry.typeLabel, entry.type, title) +
    configurationParameters(configuration.parameter || [], entry);
  if (kind === 'triggers') {
    const filters = [['customEventFilter', 'Event name conditions'], ['autoEventFilter', 'Enable this trigger when'],
      ['filter', 'This trigger fires on']];
    settings += filters.map(([key, label]) => {
      const conditions = configuration[key] || [];
      if (key === 'customEventFilter' && configuration.type === 'customEvent' && conditions.length === 1) {
        const condition = conditions[0];
        const arg = name => (condition.parameter || []).find(p => p.key === name) || {};
        if (['{{_event}}', '{{Event}}'].includes(arg('arg0').value) &&
            ['equals', 'matchRegex'].includes(condition.type) && !['true', true].includes(arg('negate').value)) {
          return configurationParameters([{ key: 'eventName', value: arg('arg1').value }], entry) +
            (condition.type === 'matchRegex' ? `<p class="configuration-option">Use regex matching${String(arg('ignore_case').value) === 'true' ? ' (ignore case)' : ''}</p>` : '');
        }
      }
      return conditions.length ? `<h4>${esc(label)}</h4><ul class="configuration-list">${conditions.map(condition => {
        const parameters = condition.parameter || [];
        const arg = name => parameters.find(p => p.key === name) || {};
        return `<li>${configurationValue(arg('arg0'), entry)} <strong>${String(arg('negate').value) === 'true' ? 'not ' : ''}${esc(API_OPS[condition.type] || condition.type)}</strong>
          ${configurationValue(arg('arg1'), entry)}${String(arg('ignore_case').value) === 'true' ? ' (ignore case)' : ''}</li>`;
      }).join('')}</ul>` : '';
    }).join('');
  }
  const metadata = new Set(['name', 'type', 'parameter', 'filter', 'autoEventFilter', 'customEventFilter',
    'accountId', 'containerId', 'triggerId', 'variableId', 'fingerprint', 'path', 'parentFolderId', 'tagManagerUrl']);
  const extra = Object.entries(configuration).filter(([key]) => !metadata.has(key));
  settings += configurationParameters(extra.map(([key, value]) => ({
    key, value: typeof value === 'object' && value !== null ? renderApiParam_(value) || JSON.stringify(value) : value
  })), entry);
  const usage = entityUsage(entry);
  return `<div class="tag-detail-content configuration-view"><h2>${esc(entry.name)}</h2>
    <p class="hint">Read-only GTM configuration. Variable references and code are not executed.</p>
    ${configurationCard(title + ' Configuration', settings + (entry.builtIn ? '<p class="hint">Built-in GTM item; no editable settings are supplied.</p>' : ''))}
    ${configurationCard('References', `<p><span class="sev ${usage.style}">${usage.label}</span></p>
      <p class="hint">Static references include paused tags, not proof of execution. Review before deleting an unused item.</p>
      ${entry.usage.length ? `<h4>Referenced by</h4><ul class="inventory-references">${entry.usage.map(inventoryReference).join('')}</ul>`
        : '<p>No other items reference this definition in the supplied snapshot.</p>'}`)}
    ${moreConfigurationDetails(entityTechnicalContent(kind, entry))}</div>`;
}

function tagTechnicalContent(tag) {
  const detail = tag.inspection;
  const info = [
    ['Location', tag.where], ['Tag type', tag.type], ['Platform / vendor', joinParts_(tag.platform, tag.vendor)],
    ['Status', tag.paused ? 'Paused' : 'Enabled (not proof of firing)'], ['Folder', tag.folder],
    ['Purpose', tag.purpose], ['Consent risk', tag.risk], ['Consent handling', tag.handling],
    ['Additional consent checks', (tag.additionalChecks || []).join(', ')],
    ['Consent explicitly not needed', tag.consentNotNeeded ? 'Yes' : 'No'],
    ['Firing triggers', (tag.firesOn || []).join(' OR ')], ['Exceptions', (tag.blockedBy || []).join(' OR ')],
    ['Tag sequencing', tag.sequence || (tag.sequenced ? 'Used by tag sequencing' : '')],
    ['Notes', tag.notes], ['Recommendation', tag.recommendation], ['AI explanation', tag.ai && tag.ai.what]
  ];
  const limit = !detail
    ? 'Original configuration was not saved in this audit. The analysis text below may be truncated. Re-run with a GTM API source or container export for complete details.'
    : detail.format === 'compiled'
      ? 'Published-container detail: original names and authoring settings are not included. Code below is the compiled HTML representation; variable references may be rendered as placeholders. Raw compiled configuration is preserved below.'
      : detail.format === 'limited'
        ? 'Partial published-container parsing: this is an extracted fragment, not guaranteed to be the complete tag or code. Use the GTM API or an export for full detail.'
        : 'Original GTM API / export configuration. Variable references are not executed or replaced. These are configuration details, not evidence that the tag fired.';
  return `<div class="tag-detail-content">
    <h2>${esc(tag.label)}</h2><p class="hint">${esc(limit)}</p>
    ${detail ? `<p class="hint">Source: ${esc(detail.source)}</p>` : ''}
    ${detail && /^cvt_/.test(tag.type) && !(detail.templates || []).length
      ? '<p class="hint">The custom template implementation is not included in this source. Only its available tag settings can be shown.</p>' : ''}
    <dl class="tag-facts">${info.filter(pair => pair[1] != null && pair[1] !== '').map(pair =>
      `<div><dt>${esc(pair[0])}</dt><dd>${esc(pair[1])}</dd></div>`).join('')}</dl>
    ${detail ? tagConfigurationSection(detail.format === 'api' ? 'Custom HTML / code (as configured)' : 'Compiled HTML / code', detail.code) +
      tagConfigurationSection('Complete tag configuration available from this source', detail.configuration) +
      tagConfigurationSection('Firing and exception trigger configurations', detail.triggers) +
      tagConfigurationSection('Compiled conditions', detail.predicates) +
      tagConfigurationSection('Referenced variables (including their configuration / code)', detail.variables) +
      tagConfigurationSection('Setup / cleanup tag configurations', detail.sequence) +
      tagConfigurationSection('Custom template definitions', detail.templates)
      : tagConfigurationSection('Saved analysis text (may be incomplete)', tag.text)}
  </div>`;
}

function toggleTagDetail(button) {
  const tag = STATE.result.audit.tags[Number(button.dataset.tagIndex)];
  if (!tag) { toast('Tag details are no longer available. Refresh this view.', true); return; }
  toggleDetailPanel(button, 'Tag details: ' + tag.label, () => tagDetailContent(tag));
}

function toggleEntityDetail(button) {
  const kind = button.dataset.entityKind;
  const entry = ['triggers', 'variables'].includes(kind) &&
    (STATE.result.audit[kind] || [])[Number(button.dataset.entityIndex)];
  if (!entry) { toast('Configuration details are no longer available. Re-run the audit.', true); return; }
  toggleDetailPanel(button, (kind === 'triggers' ? 'Trigger' : 'Variable') + ' details: ' + entry.name,
    () => entityDetailContent(kind, entry));
}

function toggleDetailPanel(button, label, content) {
  const control = button.getAttribute('aria-controls');
  if (control) {
    const region = document.getElementById(control);
    if (region) (region.parentElement.matches('.tag-detail-row > td') ? region.parentElement.parentElement : region).remove();
    button.removeAttribute('aria-controls');
    button.setAttribute('aria-expanded', 'false');
    return;
  }
  const id = 'tag-detail-' + (++tagPanelId);
  const row = button.closest('.tag-detail-panel') ? null : button.closest('tr');
  const tableWrap = row && row.closest('.table-wrap');
  if (tableWrap) tableWrap.classList.add('tag-detail-table');
  const panel = document.createElement(row ? 'tr' : 'div');
  if (row) {
    panel.className = 'tag-detail-row';
    const cell = document.createElement('td');
    cell.colSpan = row.children.length;
    panel.appendChild(cell);
  }
  const region = row ? document.createElement('div') : panel;
  region.id = id;
  region.className = 'tag-detail-panel';
  region.setAttribute('role', 'region');
  region.setAttribute('aria-label', label);
  region.innerHTML = content();
  if (row) panel.firstChild.appendChild(region);
  const anchor = row || button.closest('p, li, h1, h2, h3, h4, h5, .tag-references, .msg, .doc') || button;
  if (anchor.matches('li, .msg, .doc')) anchor.appendChild(panel);
  else anchor.insertAdjacentElement('afterend', panel);
  button.setAttribute('aria-controls', id);
  button.setAttribute('aria-expanded', 'true');
  if (tableWrap) tableWrap.scrollLeft = 0;
}

function tagMentions(html) {
  const root = document.createElement('div');
  root.innerHTML = html;
  const tags = STATE.result ? STATE.result.audit.tags : [];
  const labels = Array.from(new Set(tags.map(t => t.label).filter(label => label.length >= 4))).sort((a, b) => b.length - a.length);
  if (!labels.length) return root.innerHTML;
  const pattern = new RegExp(labels.map(escapeRegex_).join('|'), 'g');
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) {
    if (!walker.currentNode.parentElement.closest('pre, code, button')) nodes.push(walker.currentNode);
  }
  nodes.forEach(node => {
    pattern.lastIndex = 0;
    let match, start = 0;
    const parts = [];
    while ((match = pattern.exec(node.textContent))) {
      parts.push(esc(node.textContent.slice(start, match.index)));
      const matches = tags.filter(t => t.label === match[0]);
      parts.push(matches.map(t => tagToggle(tags.indexOf(t), matches.length > 1 ? t.label + ' (' + t.where + ')' : t.label)).join(' '));
      start = match.index + match[0].length;
    }
    if (!parts.length) return;
    parts.push(esc(node.textContent.slice(start)));
    const span = document.createElement('span');
    span.innerHTML = parts.join('');
    node.replaceWith(span);
  });
  return root.innerHTML;
}

function auditMarkdown(text) { return tagMentions(renderMarkdown(text)); }

function reportHeader(r) {
  const title = r.meta.client || hostOf_(r.meta.site) || 'Tag audit';
  const counts = s => r.issues.filter(x => x.severity === s).length;
  const liveTags = r.audit.tags.filter(t => !t.paused).length;
  return `
    <div class="report-head">
      <div>
        <h1>${esc(title)}</h1>
        ${r.meta.site ? `<p class="meta">${esc(r.meta.site)}</p>` : ''}
        <p class="meta">Audited ${esc(new Date(r.meta.date).toLocaleString())} from ${esc(r.meta.sources.join(', ') || 'no sources')}</p>
        <p class="meta">${r.audit.fullDetail ? 'Full detail: real tag names, triggers and folders.' : 'Public detail: the published container has no tag names. Add the GTM API or an export for full detail.'}</p>
        <div class="tally">
          <div><strong>${counts('High')}</strong>high priority</div>
          <div><strong>${counts('Medium')}</strong>medium</div>
          <div><strong>${counts('Low')}</strong>low</div>
          <div><strong>${liveTags}</strong>live tags</div>
          <div><strong>${Object.keys(r.audit.ids).length}</strong>account IDs</div>
        </div>
      </div>
      <div class="stamp ${esc(r.score.grade)}" role="img" aria-label="Health grade ${esc(r.score.grade)}, score ${r.score.score} out of 100">
        <div><b>${esc(r.score.grade)}</b><span>${r.score.score} / 100</span></div>
      </div>
    </div>`;
}

function areasTable(r) {
  return `<div class="table-wrap"><table>
    <thead><tr><th>Area</th><th>Score</th><th>Status</th><th>Key findings</th><th>Recommended action</th></tr></thead>
    <tbody>${r.areas.map(a => {
      const cls = a.score === null ? '' : a.score >= 75 ? '' : a.score >= 50 ? ' mid' : ' bad';
      return `<tr>
        <td><strong>${esc(a.area)}</strong></td>
        <td>${a.score === null ? '<span class="sub">n/a</span>' : a.score + '<div class="bar' + cls + '"><i style="width:' + a.score + '%"></i></div>'}</td>
        <td>${a.top ? `<span class="sev ${esc(a.top)}">${esc(a.status)}</span>` : esc(a.status)}</td>
        <td class="wrap">${a.findings.length ? a.findings.map(f => tagMentions(esc(f))).join('<br>') : '<span class="sub">—</span>'}</td>
        <td class="wrap">${esc(a.action)}</td></tr>`;
    }).join('')}</tbody></table></div>`;
}

function actionsTable(r) {
  if (!r.issues.length) return '<div class="empty"><h3>No issues found</h3>Nothing in the checked areas needs action.</div>';
  return `<div class="table-wrap"><table>
    <thead><tr><th>#</th><th>Severity</th><th>Area</th><th>Finding</th><th>Action</th><th>Where</th></tr></thead>
    <tbody>${r.issues.map((x, n) => `<tr>
      <td>${n + 1}</td><td><span class="sev ${esc(x.severity)}">${esc(x.severity)}</span></td><td>${esc(x.area)}</td>
      <td class="wrap">${x.severity === 'High' ? '<span class="hl-mark">' + tagMentions(esc(x.finding)) + '</span>' : tagMentions(esc(x.finding))}</td>
      <td class="wrap">${esc(x.action)}</td>
      <td class="wrap">${esc(x.where)}${x.items && x.items.length ? '<span class="sub">' + esc(truncate_(x.items.join(', '), 260)) + '</span>' : ''}${issueTagReferences(x)}</td></tr>`).join('')}
    </tbody></table></div>`;
}

function renderSummary() {
  const r = STATE.result;
  $('#view').innerHTML = reportHeader(r) + `
    <div class="actions">
      <button class="btn" data-act="pdf">Client PDF report</button>
      <button class="btn secondary" data-act="pptx">Client PowerPoint</button>
      <button class="btn secondary" data-act="pdf-technical">Technical PDF report</button>
      <button class="btn secondary" data-act="csv-actions">Download actions (CSV)</button>
      <button class="btn secondary" data-act="save">Save audit</button>
      <button class="btn secondary" data-act="rerun">Re-run audit</button>
    </div>
    <h2>Areas</h2>${areasTable(r)}
    <h2>Prioritised actions</h2>${actionsTable(r)}`;
}

// ══════════════════════════════════════════════════════════════════
//  VIEW: CONSENT MATRIX
// ══════════════════════════════════════════════════════════════════

function consentRows(r, filter, query) {
  const order = { High: 0, Medium: 1, Check: 2, OK: 3, '—': 4 };
  return r.audit.tags.slice()
    .filter(t => filter === 'All' || (filter === 'Paused' ? t.risk === '—' : t.risk === filter))
    .filter(t => !query || (t.label + ' ' + (t.vendor || '') + ' ' + t.platform + ' ' + t.where).toLowerCase().indexOf(query) >= 0)
    .sort((a, b) => (order[a.risk] - order[b.risk]) || a.label.localeCompare(b.label));
}

function consentTable(rows) {
  if (!rows.length) return '<div class="empty">No tags match this filter.</div>';
  return `<div class="table-wrap"><table>
    <thead><tr><th>Risk</th><th>Tag</th><th>Platform / vendor</th><th>Purpose</th><th>Fires on</th><th>Consent handling found</th><th>Recommendation</th></tr></thead>
    <tbody>${rows.map(t => `<tr>
      <td><span class="sev ${sevClass(t.risk)}">${esc(t.risk === '—' ? 'Paused' : t.risk)}</span></td>
      <td class="wrap"><strong>${tagToggle(STATE.result.audit.tags.indexOf(t), t.label)}</strong><span class="sub">${esc(t.where)}</span></td>
      <td>${esc(t.platform)}${t.vendor && t.platform.indexOf(t.vendor) < 0 ? '<span class="sub">' + esc(t.vendor) + '</span>' : ''}</td>
      <td>${esc(t.purpose)}</td>
      <td class="wrap">${esc(truncate_((t.firesOn || []).join(' OR ') || (t.noTrigger ? 'No trigger' : ''), 200))}${t.blockedBy && t.blockedBy.length ? '<span class="sub">Blocked by: ' + esc(truncate_(t.blockedBy.join(' OR '), 120)) + '</span>' : ''}</td>
      <td class="wrap">${esc(t.handling)}</td>
      <td class="wrap">${esc(t.recommendation)}${t.ai && t.ai.what ? '<span class="ai-note">' + esc(t.ai.what) + '</span>' : ''}</td></tr>`).join('')}
    </tbody></table></div>`;
}

function consentModeNotice(r) {
  const cm = r.audit.consentMode;
  const text = cm.defaultOnPage ? 'Consent Mode default found on the page' + (cm.v2 ? ' (v2).' : ' (v1 — upgrade to v2).')
    : cm.defaultViaGtm ? 'Consent Mode default is set from GTM.'
    : r.audit.pageScanned ? 'No Consent Mode default found on the page or in GTM.'
    : 'Page source not scanned, so Consent Mode defaults were not checked. Google tags are rated "Check".';
  return `<div class="notice${!cm.defaultOnPage && !cm.defaultViaGtm && r.audit.pageScanned ? ' warn' : ''}">${esc(text)}</div>`;
}

function renderConsent() {
  const r = STATE.result;
  const count = k => r.audit.tags.filter(t => (k === 'Paused' ? t.risk === '—' : t.risk === k)).length;
  const filters = ['All', 'High', 'Medium', 'Check', 'OK', 'Paused'];
  $('#view').innerHTML = `
    <h1>Consent matrix</h1>
    <p class="lede">How each tag waits for consent, compared with what its purpose requires.</p>
    ${consentModeNotice(r)}
    <div class="toolbar">
      <div class="seg" role="group" aria-label="Filter by risk">${filters.map(f =>
        `<button data-filter="${f}" aria-pressed="${STATE.consentFilter === f}">${f}${f === 'All' ? '' : ' ' + count(f)}</button>`).join('')}</div>
      <input type="search" id="consent-q" placeholder="Search tags or vendors" aria-label="Search tags">
      <button class="btn secondary" data-act="csv-consent">Download CSV</button>
    </div>
    <div id="consent-table">${consentTable(consentRows(r, STATE.consentFilter, ''))}</div>`;
  const redraw = () => { $('#consent-table').innerHTML = consentTable(consentRows(r, STATE.consentFilter, $('#consent-q').value.toLowerCase().trim())); };
  $$('[data-filter]').forEach(b => b.addEventListener('click', () => {
    STATE.consentFilter = b.dataset.filter;
    $$('[data-filter]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    redraw();
  }));
  $('#consent-q').addEventListener('input', redraw);
}

// ══════════════════════════════════════════════════════════════════
//  VIEW: TAGS BY PLATFORM / ALL FINDINGS
// ══════════════════════════════════════════════════════════════════

function groupBlock(g, query, open) {
  const rows = g.rows.map((row, index) => ({ row: row, tagIndex: tagIndexForRow(g, row, index),
    entity: g.entityRefs && g.entityRefs[index] }))
    .filter(item => !query || item.row.join(' ').toLowerCase().indexOf(query) >= 0);
  if (!rows.length) return '';
  const name = g.logo && g.plain ? g.plain : g.name;
  return `<details class="group" ${open ? 'open' : ''} style="--g:${esc(g.header)}">
    <summary>${g.logo ? `<img src="${esc(g.logo)}" alt="" loading="lazy" onerror="this.remove()">` : ''}<span class="gname">${esc(name)}</span><span class="gcount">${rows.length} ${rows.length === 1 ? 'item' : 'items'}</span></summary>
    <div class="table-wrap" style="border:0;border-radius:0"><table>
      <thead><tr><th>Type</th><th>Item</th><th>Location</th><th>Details</th><th>Notes</th></tr></thead>
      <tbody>${rows.map(item => {
        const row = item.row;
        const entity = item.entity && (STATE.result.audit[item.entity.kind] || [])[item.entity.index];
        const usage = entity && entityUsage(entity);
        const control = entity ? entityToggle(item.entity.kind, item.entity.index, row[1]) : tagToggle(item.tagIndex, row[1]);
        return `<tr><td>${esc(g.isTag ? String(row[0]).replace(/^🏷️\s*/, '') : row[0])}</td><td class="wrap"><strong>${control}</strong>${usage ? `<span class="sub"><span class="sev ${usage.style}">${usage.label}</span></span>` : ''}</td><td>${esc(row[2])}</td>
        <td class="wrap">${tagMentions(esc(row[3]))}</td><td class="wrap">${tagMentions(esc(row[4]))}</td></tr>`;
      }).join('')}</tbody>
    </table></div></details>`;
}

function renderGroupsView(title, lede, groups, idPrefix, sections) {
  $('#view').innerHTML = `
    <h1>${esc(title)}</h1><p class="lede">${esc(lede)}</p>
    <div class="toolbar">
      ${sections || ''}
      <input type="search" id="${idPrefix}-q" placeholder="Search" aria-label="Search">
      <button class="link" data-act="expand">Expand all</button><button class="link" data-act="collapse">Collapse all</button>
      <button class="btn secondary" data-act="csv-findings">Download all findings (CSV)</button>
    </div>
    <div id="${idPrefix}-list">${groups.map(g => groupBlock(g, '', true)).join('') || '<div class="empty">Nothing to show.</div>'}</div>`;
  $('#' + idPrefix + '-q').addEventListener('input', e => {
    const q = e.target.value.toLowerCase().trim();
    $('#' + idPrefix + '-list').innerHTML = groups.map(g => groupBlock(g, q, true)).join('') || '<div class="empty">No matches.</div>';
  });
}

function renderTags() {
  const section = STATE.tagSection;
  const isTags = section === 'tags';
  const groups = isTags ? STATE.result.groups.filter(g => g.isTag) : inventoryGroups(section);
  const title = isTags ? 'Tags by platform' : section === 'triggers' ? 'Triggers' : 'Variables';
  const lede = isTags ? 'Every GTM tag, grouped by the platform it sends data to. Tags the AI identified appear in their own groups.'
    : 'Click an item to inspect its complete available configuration and references. Unused means no other item references it in the supplied API/export snapshot, not proof it is safe to delete.';
  const sections = `<div class="seg container-sections" role="group" aria-label="Container items">${['tags', 'triggers', 'variables'].map(kind =>
    `<button data-act="container-section" data-section="${kind}" aria-pressed="${section === kind}">${kind === 'tags' ? 'Tags' : kind === 'triggers' ? 'Triggers' : 'Variables'}</button>`).join('')}</div>`;
  renderGroupsView(title, lede, groups, 'tags', sections);
  if (!isTags) {
    const entries = STATE.result.audit[section];
    if (!entries || !entries.length) {
      $('#tags-list').innerHTML = `<div class="empty"><h3>No ${esc(section)} definitions available</h3>${entries
        ? 'No definitions were available from the scanned sources. Add a GTM API source or container export for original definitions and unused checks.'
        : 'This saved audit predates the inventory. Re-run with a GTM API source or container export to capture every definition, including unused items.'}</div>`;
    } else if (entries.some(e => !e.usageKnown)) {
      $('#tags-list').insertAdjacentHTML('beforebegin', '<p class="notice">Published data contains compiled rules and variables, not the complete authoring inventory. Unused checks are not available for those items.</p>');
    }
    return;
  }
  if (!groups.length) {
    $('#tags-list').innerHTML = '<div class="empty"><h3>No tags in what was scanned</h3>If you read a container through the API, its live version may be empty or unpublished. ' +
      'On <button class="link" data-act="goto" data-view="audit">New audit</button>, click Load workspaces, choose a workspace under "Version to audit" and run the audit again.</div>';
  }
}

function inventoryGroups(kind) {
  const groups = new Map();
  (STATE.result.audit[kind] || []).forEach((entry, index) => {
    const key = JSON.stringify([entry.container, entry.source]);
    if (!groups.has(key)) groups.set(key, {
      name: entry.container + ' · ' + entry.source, header: '#60758C', isTag: false, rows: [], entityRefs: []
    });
    const group = groups.get(key);
    let description = 'Published compiled representation; original name unavailable';
    if (entry.format === 'api') {
      description = kind === 'triggers' ? describeApiTrigger_(entry.configuration, '', [])[3]
        : variableKeyInfo_(entry.type, apiAdapter_(entry.configuration.parameter, {})) || entry.typeLabel;
    }
    group.rows.push([entry.typeLabel, entry.name, joinParts_(entry.container, entry.folder),
      description, entry.usage.length ? entry.usage.length + ' reference(s)' :
        entry.usageKnown ? 'Unused: no other item references this definition. Review before deleting.' : 'Usage not checked']);
    group.entityRefs.push({ kind: kind, index: index });
  });
  return Array.from(groups.values());
}

function renderFindings() {
  renderGroupsView('All findings', 'Everything the scan found, grouped by category.', STATE.result.groups, 'all');
}

// ══════════════════════════════════════════════════════════════════
//  VIEW: ID INVENTORY
// ══════════════════════════════════════════════════════════════════

function idRows(r) {
  const ids = Object.keys(r.audit.ids).map(k => r.audit.ids[k]).sort((a, b) => a.platform.localeCompare(b.platform) || a.id.localeCompare(b.id));
  const counts = {};
  ids.filter(x => x.live).forEach(x => { counts[x.platform] = (counts[x.platform] || 0) + 1; });
  return ids.map(x => ({
    rec: x,
    note: joinParts_(x.live && SINGLE_ID_PLATFORMS.has(x.platform) && counts[x.platform] > 1 && counts[x.platform] + ' ' + x.platform + ' IDs live — confirm all are the client\'s',
                     !x.live && 'Only in paused tags')
  }));
}

function renderIds() {
  const r = STATE.result;
  const rows = idRows(r);
  $('#view').innerHTML = `
    <h1>ID inventory</h1>
    <p class="lede">Every account, pixel and measurement ID found. Ask the client to confirm they own each one; extra IDs are often left by a previous agency or a test setup.</p>
    <div class="toolbar"><button class="btn secondary" data-act="csv-ids">Download CSV</button></div>
    ${rows.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Platform</th><th>ID</th><th>Type</th><th>Status</th><th>Used by</th><th>Notes</th></tr></thead>
      <tbody>${rows.map(x => `<tr>
        <td>${esc(x.rec.platform)}</td><td><code>${esc(x.rec.id)}</code></td><td>${esc(x.rec.kind)}</td>
        <td>${x.rec.live ? 'Live' : '<span class="sub">Paused only</span>'}</td>
        <td class="wrap">${idTagReferences(x.rec)}<span class="sub">${esc(truncate_(x.rec.where.join(', '), 160))}</span></td>
        <td class="wrap">${esc(x.note)}</td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">No account or pixel IDs were found.</div>'}`;
}

// ══════════════════════════════════════════════════════════════════
//  VIEW: LIVE CONSENT TEST
// ══════════════════════════════════════════════════════════════════

function liveActivityCell(text, verdict) {
  const warning = /^⚠️/.test(text) && verdict === 'High';
  const parts = text.replace(/^(?:⚠️|✔|ℹ️|⚪)\s*/, '').split(' · ');
  const inactive = text === 'No activity' || text === 'Not tested';
  return `<div class="live-activity${warning ? ' live-activity-high' : ''}${inactive ? ' live-activity-muted' : ''}">
    <span class="live-activity-title">${warning ? '<span class="live-risk-label">Without consent</span>' : ''}${esc(parts[0])}</span>
    ${parts.slice(1).map(part => part.indexOf('cookies: ') === 0
      ? `<span class="live-cookie-label">Cookies observed</span><ul class="live-cookies">${part.slice(9).split(', ').map(name =>
        `<li><code>${esc(name)}</code></li>`).join('')}</ul>`
      : `<span class="live-signal">${esc(part)}</span>`).join('')}
  </div>`;
}

function liveSection(live) {
  const st = live.data.stages;
  const any = st.before || st.deny || st.accept;
  const def = (st.before || any || {}).consentDefault;
  const defText = def ? Object.keys(def).filter(k => /_storage|ad_/.test(k)).map(k => k + ' ' + def[k]).join(', ') : 'none seen';
  return `
    <p class="meta">${esc(any.url)} · CMP: ${esc(any.cmp ? any.cmp.name : 'not detected')} · Consent Mode default: ${esc(defText)}</p>
    <div class="table-wrap" style="margin:12px 0"><table>
      <thead><tr><th>Google consent signal</th>${Object.keys(LIVE_STAGES).map(k => `<th>${esc(LIVE_STAGES[k])}</th>`).join('')}</tr></thead>
      <tbody><tr><td>gcs</td>${Object.keys(LIVE_STAGES).map(k => `<td><code>${esc(st[k] ? (st[k].gcs.join(' / ') || '—') : 'not tested')}</code></td>`).join('')}</tr></tbody>
    </table></div>
    <div class="table-wrap live-results"><table class="live-table" aria-label="Live consent observations by vendor">
      <colgroup><col class="live-vendor-col"><col><col><col><col class="live-recommendation-col"></colgroup>
      <thead><tr><th scope="col">Vendor / purpose</th>${Object.keys(LIVE_STAGES).map(k => `<th scope="col">${esc(LIVE_STAGES[k])}</th>`).join('')}<th scope="col">Verdict / recommendation</th></tr></thead>
      <tbody>${live.verdicts.map(v => `<tr>
        <th scope="row" class="live-vendor"><strong>${esc(v.vendor)}</strong><span class="sub">${esc(v.purpose)}</span>${liveVendorTags(v.vendor)}</th>
        ${Object.keys(LIVE_STAGES).map(k => `<td data-stage="${esc(LIVE_STAGES[k])}">${liveActivityCell(v.cells[k], v.verdict)}</td>`).join('')}
        <td class="live-recommendation"><span class="sev ${esc(v.verdict)}">${esc(v.verdict)}</span><p>${esc(v.recommendation)}</p></td></tr>`).join('')}
      </tbody></table></div>
    <h3>Unrecognised third parties</h3>
    <div class="table-wrap"><table><tbody>${Object.keys(LIVE_STAGES).map(k => `<tr><td style="width:200px">${esc(LIVE_STAGES[k])}</td>
      <td class="wrap">${esc(st[k] ? (st[k].other.join(', ') || 'None') : 'Not tested')}</td></tr>`).join('')}</tbody></table></div>
    <p class="hint">gcs = G1[ad_storage][analytics_storage]: 1 granted, 0 denied. Only cookie names are read, never values. Browser observations from one location; server-side tracking is not visible.</p>
    ${runnerEvidence(st)}`;
}

function runnerImportControl() {
  return `<p class="hint">Or use the local GTM-guided runner (Node.js + Playwright).
    See <a href="runner/README.md" target="_blank" rel="noopener">setup instructions</a>.
    Importing replaces the current live results.</p>
    <label>Import local runner results<input type="file" data-runner-file accept=".runner.json,application/json"></label>`;
}

function runnerEvidence(stages) {
  const keys = Object.keys(LIVE_STAGES).filter(k => stages[k] && stages[k].runner);
  if (!keys.length) return '';
  const first = stages[keys[0]].runner;
  return `<h3>Local runner evidence</h3>
    <p class="hint">${esc(first.container.id)} ${esc(first.container.name)}.
      Actions are analyst-selected tests, not proof that individual GTM tags fired.
      Confirm exact firing in GTM Preview / Tag Assistant.</p>
    ${keys.map(k => {
      const s = stages[k].runner.session;
      const hosts = Array.from(new Set(s.requests.map(q => q.host)));
      return `<details><summary>${esc(LIVE_STAGES[k])}: ${s.actions.length} action(s), ${s.requests.length} network attempt(s)</summary>
        <p class="hint">${esc(s.consentConfirmation)}</p>
        <div class="table-wrap"><table><thead><tr><th>Trigger to exercise</th><th>Action</th><th>Execution</th></tr></thead>
        <tbody>${s.actions.map(a => `<tr><td>${esc(a.trigger)}</td><td>${esc(a.type)}</td><td>${esc(a.status)}</td></tr>`).join('')}</tbody></table></div>
        <p>Data-layer event names: ${esc(s.events.join(', ') || 'None observed')}</p>
        <p>Request hosts: ${esc(hosts.join(', ') || 'None observed')}</p>
        <p>Failed requests: ${s.requests.filter(q => q.outcome === 'failed').length};
          pending: ${s.requests.filter(q => q.outcome === 'pending').length}.</p>
        ${s.errors.length ? `<p class="notice warn">${esc(s.errors.join('; '))}</p>` : ''}
      </details>`;
    }).join('')}
    <details><summary>Tag coverage plan (firing unverified)</summary><div class="table-wrap"><table>
      <thead><tr><th>Tag</th><th>Planned coverage</th><th>Firing triggers</th><th>Exceptions</th></tr></thead>
      <tbody>${first.coverage.map(t => `<tr><td>${tagMentions(esc(t.tag))}</td><td>${esc(t.status)}</td>
        <td>${tagMentions(esc(t.triggers.join(', ')))}</td><td>${tagMentions(esc(t.blockers.join(', ')))}</td></tr>`).join('')}</tbody>
    </table></div></details>`;
}

function renderLive() {
  const r = STATE.result;
  $('#view').innerHTML = `
    <h1>Live consent test</h1>
    <p class="lede">What actually happened in the browser before a choice, after Deny and after Accept.</p>
    ${r.live ? liveSection(r.live) : `<div class="empty"><h3>No live test yet</h3>
      Run the snippet on the site in each consent state and paste the results below. The audit re-runs with them.</div>`}
    <h2>Add results</h2>
    <p class="hint">Snippet: <button class="link" data-act="copy-live-snippet">Copy snippet</button> · run it in F12 → Console on the site, then paste the result here.</p>
    <textarea id="live-add" placeholder='{"tool":"tag-scanner-live-test", …}'></textarea>
    <div class="row" style="margin-top:8px">
      <select id="live-add-stage" style="width:auto"><option value="">Auto-detect state</option>${Object.keys(LIVE_STAGES).map(k => `<option value="${k}">${esc(LIVE_STAGES[k])}</option>`).join('')}</select>
      <button class="btn" data-act="live-add">Add and re-run audit</button>
    </div>
    ${runnerImportControl()}`;
}

function addLiveResults(text, stage) {
  const runner = parseRunnerResults_(text);
  const results = runner || parseLiveResults_(text);
  if (!results.length) throw new Error('No snippet results found. Paste the text the snippet copied to your clipboard.');
  const merged = mergeLiveResults_(runner ? null : STATE.inputs.live, results, stage);
  STATE.inputs.live = merged.data;
  return merged.added;
}

// ══════════════════════════════════════════════════════════════════
//  VIEW: AI ASSISTANT
// ══════════════════════════════════════════════════════════════════

function renderAI() {
  const r = STATE.result;
  const configured = AI.isConfigured();
  const unknown = r.audit.tags.filter(t => !t.paused && t.purpose === 'unknown' && !t.aiVendor).length;
  const busy = STATE.ai.busy;
  const doc = (key, title) => STATE.ai[key] ? `
    <div class="doc" id="doc-${key}">
      <div class="doc-head"><h2 style="margin:0">${esc(title)}</h2>
        <div class="row"><button class="btn secondary" data-act="copy-doc" data-key="${key}">Copy</button>
        <button class="btn secondary" data-act="dl-doc" data-key="${key}">Download .md</button></div></div>
      ${auditMarkdown(STATE.ai[key])}</div>` : '';
  $('#view').innerHTML = `
    <h1>AI assistant</h1>
    <p class="lede">Turns the audit into a client report and a fix plan, identifies unknown tags from their code, and answers questions about this audit.</p>
    ${configured ? '' : `<div class="notice warn">Add an AI provider and API key in <button class="link" data-act="goto" data-view="settings">Settings</button> to use the assistant.</div>`}
    <p class="hint">Only this audit's findings are sent to ${esc(AI_PROVIDERS[AI.config().provider].label)}${unknown ? ', plus the code of unknown tags when you identify them' : ''}. Check that your client agreement allows it.</p>
    <div class="ai-tools">
      <div class="ai-tool"><h3>Client report</h3><p>Executive summary, top risks, what works and prioritised recommendations. Included in the PDF export.</p>
        <button class="btn" data-act="ai-writeup" ${!configured || busy ? 'disabled' : ''}>${busy === 'writeup' ? 'Writing…' : STATE.ai.writeup ? 'Rewrite report' : 'Write report'}</button></div>
      <div class="ai-tool"><h3>Identify unknown tags</h3><p>${unknown ? unknown + ' tag(s) have no recognised vendor. The AI reads their code and names the vendor and purpose, then the consent matrix updates.' : 'Every live tag has a known vendor.'}</p>
        <button class="btn" data-act="ai-explain" ${!configured || busy || !unknown ? 'disabled' : ''}>${busy === 'explain' ? 'Reading code…' : 'Identify ' + (unknown || '') + ' tag' + (unknown === 1 ? '' : 's')}</button></div>
      <div class="ai-tool"><h3>GTM fix plan</h3><p>A step-by-step checklist for the developer or ad-ops person making the changes, with a way to verify each fix.</p>
        <button class="btn" data-act="ai-fixplan" ${!configured || busy ? 'disabled' : ''}>${busy === 'fixplan' ? 'Planning…' : STATE.ai.fixplan ? 'Rebuild fix plan' : 'Build fix plan'}</button></div>
    </div>
    ${doc('writeup', 'Client report')}${doc('fixplan', 'GTM fix plan')}
    <h2>Ask about this audit</h2>
    <div class="chat">
      <div class="chat-log" id="chat-log">${STATE.ai.chat.length ? STATE.ai.chat.map(m => `<div class="msg ${m.role}">${m.role === 'assistant' ? auditMarkdown(m.content) : tagMentions(esc(m.content))}</div>`).join('')
        : '<p class="hint" style="margin:0">For example: "Why is the Meta pixel high risk?", "Which tags should fire on Consent Initialization?", "Draft an email to the client\'s developer about Clarity."</p>'}
        ${busy === 'chat' ? '<div class="msg assistant thinking">Thinking…</div>' : ''}</div>
      <form class="chat-input" id="chat-form"><label for="chat-q" class="skip">Question</label>
        <textarea id="chat-q" placeholder="Ask a question about this audit" ${!configured ? 'disabled' : ''}></textarea>
        <button class="btn" type="submit" ${!configured || busy ? 'disabled' : ''}>Ask</button></form>
    </div>`;
  const logEl = $('#chat-log'); logEl.scrollTop = logEl.scrollHeight;
  $('#chat-form').addEventListener('submit', e => { e.preventDefault(); askChat(); });
  $('#chat-q').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); askChat(); } });
}

async function aiTask(key) {
  const r = STATE.result;
  STATE.ai.busy = key; renderAI();
  try {
    const prompt = AI_TASKS[key].prompt + '\n\nAUDIT DATA (JSON):\n' + aiAuditContext(r);
    STATE.ai[key] = await AI.chat([{ role: 'user', content: prompt }], { maxTokens: 5000 });
    toast(AI_TASKS[key].title + ' ready');
  } catch (e) { toast(e.message, true); }
  STATE.ai.busy = '';
  if (STATE.view === 'ai') renderAI();
}

async function aiExplain() {
  STATE.ai.busy = 'explain'; renderAI();
  try {
    const found = await aiExplainUnknownTags(STATE.result, m => toast(m));
    const n = Object.keys(found).length;
    Object.assign(STATE.overrides, found);
    STATE.ai.busy = '';
    if (n) {
      toast('Identified ' + n + ' tag(s). Re-running the audit…');
      await runAudit({ stay: true });
    } else toast('The AI could not identify these tags.');
  } catch (e) { toast(e.message, true); }
  STATE.ai.busy = '';
  if (STATE.view === 'ai') renderAI();
}

async function askChat() {
  const q = $('#chat-q').value.trim();
  if (!q || STATE.ai.busy) return;
  STATE.ai.chat.push({ role: 'user', content: q });
  STATE.ai.busy = 'chat'; renderAI();
  try {
    const context = { role: 'user', content: 'Here is the audit data for our conversation (JSON):\n' + aiAuditContext(STATE.result, 70000) };
    const ack = { role: 'assistant', content: 'Understood. I will answer only from this audit data.' };
    const history = STATE.ai.chat.slice(-12);
    const answer = await AI.chat([context, ack].concat(history), { maxTokens: 2500 });
    STATE.ai.chat.push({ role: 'assistant', content: answer });
  } catch (e) {
    STATE.ai.chat.push({ role: 'assistant', content: '**Error:** ' + e.message });
  }
  STATE.ai.busy = '';
  if (STATE.view === 'ai') renderAI();
}

// ══════════════════════════════════════════════════════════════════
//  VIEW: SETTINGS
// ══════════════════════════════════════════════════════════════════

function renderSettings() {
  const s = loadAppSettings();
  const provider = s.aiProvider || 'anthropic';
  const p = AI_PROVIDERS[provider];
  $('#view').innerHTML = `
    <h1>Settings</h1>
    <p class="lede">Stored only in this browser. Nothing is sent anywhere except the AI provider and Google when you use them.</p>

    <section class="form-block">
      <h2 style="margin-top:0">Connections</h2>
      ${connectionsHtml()}
      <p class="hint">Each sign-in lasts an hour and is kept in this browser tab only; closing the tab signs you out. The left bar warns 5 minutes before the end:
        <strong>Renew</strong> goes to Google and straight back without asking again, as long as you're still signed in to Google in this browser. Permissions you connected are kept.</p>
      <details class="advanced">
        <summary>Advanced: use a different OAuth client</summary>
        <label for="set-client" style="margin-top:10px">OAuth client ID override</label>
        <input type="text" id="set-client" value="${esc(s.googleClientId || '')}" placeholder="${esc(APP_CONFIG.googleClientId)}">
        <p class="hint">Leave empty to use the built-in client. A different client needs this page's address (${esc(location.origin + location.pathname)}) as an authorised redirect URI in Google Cloud. See the README.</p>
        <div class="actions"><button class="btn secondary" data-act="save-google">Save override</button></div>
      </details>
    </section>

    <section class="form-block">
      <h2 style="margin-top:0">AI assistant</h2>
      <div class="grid2">
        <div><label for="set-provider">Provider</label>
          <select id="set-provider">${Object.keys(AI_PROVIDERS).map(k => `<option value="${k}" ${k === provider ? 'selected' : ''}>${esc(AI_PROVIDERS[k].label)}</option>`).join('')}</select></div>
        <div><label for="set-model">Model</label><input type="text" id="set-model" value="${esc(s.aiModel || '')}" placeholder="${esc(p.defaultModel)}">
          <p class="hint">Leave empty for ${esc(p.defaultModel)}.</p></div>
      </div>
      <div class="grid2" style="margin-top:12px">
        <div><label for="set-key">API key</label><input type="password" id="set-key" value="${esc(s.aiKey || '')}" autocomplete="off" placeholder="Paste your key"></div>
        <div ${p.needsBase ? '' : 'hidden'}><label for="set-base">Base URL</label><input type="url" id="set-base" value="${esc(s.aiBase || '')}" placeholder="${esc(p.defaultBase || '')}">
          <p class="hint">For Azure or an internal gateway, use its OpenAI-compatible URL.</p></div>
      </div>
      <p class="hint">The key is kept in this browser's local storage and sent only to the provider. Use a personal or restricted key, and don't use this on shared computers.</p>
      <div class="actions"><button class="btn" data-act="save-ai">Save</button><button class="btn secondary" data-act="test-ai">Test connection</button></div>
    </section>

    <section class="form-block">
      <h2 style="margin-top:0">Google Ads test</h2>
      <p class="hint">Checks whether the Google Ads API works with your access: finds the account behind a GTM <code>AW-</code> ID and reads its conversion actions,
        conversion settings and last 30 days of clicks. Only read requests are sent. Google Ads has no read-only permission, so what could be changed is limited by your own role in each account.
        The log shows counts only.</p>
      <div class="grid2" style="margin-top:12px">
        <div><label for="ads-token">Developer token</label><input type="password" id="ads-token" value="${esc(s.adsDevToken || '')}" autocomplete="off" placeholder="From the manager account: Admin → API Center">
          <p class="hint">Kept in this browser only. Needs Basic access for real (non-test) accounts.</p></div>
        <div><label for="ads-login">Manager account ID (optional)</label><input type="text" id="ads-login" value="${esc(s.adsLoginId || '')}" placeholder="123-456-7890">
          <p class="hint">The MCC you reach client accounts through. Leave empty to use every manager account you can access.</p></div>
      </div>
      <div class="row" style="margin-top:10px">${adsStatusHtml()}</div>
      <p class="hint">Google Ads has its own sign-in, so you can use a different Google account from the one for GTM and GA4.</p>
      <label for="ads-aw" style="margin-top:12px">Google Ads conversion ID to find</label>
      <div class="row"><input type="text" id="ads-aw" value="${esc(adsIdsFromGtm()[0] || '')}" placeholder="AW-123456789" style="max-width:260px">
        <button class="btn secondary" data-act="ads-test" ${GoogleAds.hasScope(ADS_SCOPE) ? '' : 'disabled'}>Run Google Ads test</button></div>
      ${adsIdsFromGtm().length ? '<p class="hint">From the GTM audit: ' + adsIdsFromGtm().map(esc).join(', ') + '</p>' : ''}
      <div class="log" id="ads-log" hidden></div>
    </section>

    <section class="form-block">
      <h2 style="margin-top:0">Appearance and data</h2>
      <div class="row">
        <label for="set-theme" style="margin:0">Theme</label>
        <select id="set-theme" style="width:auto">${['auto', 'light', 'dark'].map(t => `<option ${(s.theme || 'auto') === t ? 'selected' : ''}>${t}</option>`).join('')}</select>
        <button class="btn secondary" data-act="clear-data">Clear saved settings and caches</button>
      </div>
    </section>`;
  $('#set-provider').addEventListener('change', e => { saveAppSettings({ aiProvider: e.target.value, aiModel: '', aiBase: '' }); renderSettings(); });
  $('#set-theme').addEventListener('change', e => { saveAppSettings({ theme: e.target.value }); applyTheme(); });
}

/** Google Ads conversion IDs (AW-…) the GTM audit found. */
function adsIdsFromGtm() {
  const r = STATE.result;
  if (!r) return [];
  return Array.from(new Set(Object.keys(r.audit.ids).map(k => r.audit.ids[k])
    .filter(x => x.platform === 'Google Ads' && /^AW-\d+$/.test(x.id)).map(x => x.id)));
}

/** Google Ads feasibility test (Settings). Logs counts and settings only, no names or campaign data. */
async function adsTest(aw) {
  const box = $('#ads-log');
  box.hidden = false; box.innerHTML = '';
  const say = (msg, err) => {
    box.insertAdjacentHTML('beforeend', '<div' + (err ? ' class="err"' : '') + '>' + esc(msg) + '</div>');
    box.scrollTop = box.scrollHeight;
  };
  const s = loadAppSettings();
  const opt = { devToken: s.adsDevToken, loginId: '' };
  const fail = (step, e) => {
    let hint = '';
    if (/DEVELOPER_TOKEN_NOT_APPROVED/.test(e.message)) hint = ' The developer token only has test access: apply for Basic access in the manager account\'s API Center.';
    else if (/DEVELOPER_TOKEN_INVALID|DEVELOPER_TOKEN_PROHIBITED/.test(e.message)) hint = ' Check the developer token.';
    else if (/USER_PERMISSION_DENIED/.test(e.message)) hint = ' Your Google account has no access to that account, or the manager account ID is wrong.';
    else if (/has not been used|is disabled|SERVICE_DISABLED/.test(e.message)) hint = ' Enable the Google Ads API in the Google Cloud project.';
    say('✖ ' + step + ': ' + e.message + hint, true);
  };
  const t0 = Date.now();
  // 1. Accounts reachable directly
  let direct;
  try { direct = await adsAccessibleCustomers(opt); }
  catch (e) { fail('Listing your Google Ads accounts', e); return; }
  say('✔ Google Ads API works (' + adsVersion_ + '). Your Google account reaches ' + direct.length + ' account(s) directly.');

  // 2. Which of them are manager accounts
  const info = await runPooled_(direct.slice(0, 60).map(id => async () => {
    try { return Object.assign({ id: id }, await adsCustomer(id, opt, id)); } catch (e) { return { id: id, error: e }; }
  }), 5);
  const errs = info.filter(x => x.error);
  const managers = info.filter(x => !x.error && x.manager);
  say('  Of these: ' + managers.length + ' manager account(s), ' + info.filter(x => !x.error && !x.manager).length + ' client account(s)' +
      (errs.length ? ', ' + errs.length + ' not readable' : '') + (direct.length > 60 ? ' (first 60 checked)' : '') + '.');
  if (errs.length) fail('Example of an unreadable account', errs[0].error);

  // 3. Client accounts under the manager accounts
  const loginOverride = adsDigits_(s.adsLoginId);
  const mgrIds = loginOverride ? [loginOverride] : managers.map(m => m.id);
  const clients = [];
  for (const m of mgrIds) {
    try {
      const list = await adsClients(m, opt);
      list.filter(c => !c.manager && c.status === 'ENABLED').forEach(c => clients.push({ id: String(c.id), via: m, test: !!c.testAccount }));
      say('✔ Manager account ' + m.replace(/(\d{3})(\d{3})(\d+)/, '$1-$2-$3') + ': ' + list.length + ' account(s) underneath, ' +
          list.filter(c => !c.manager && c.status === 'ENABLED').length + ' enabled client account(s).');
    } catch (e) { fail('Reading accounts under manager ' + m, e); }
  }

  // 4. Find the account behind the AW- ID
  const want = adsConversionId_(aw);
  if (!want) { say('Enter a Google Ads conversion ID (AW-…) to find its account.'); return; }
  say('Looking for the account behind AW-' + want + '…');
  let found = info.find(x => !x.error && !x.manager && x.conversionTrackingSetting &&
    String(x.conversionTrackingSetting.conversionTrackingId) === want);
  let via = found ? found.id : '';
  const seen = new Set(info.map(x => x.id));
  const queue = clients.filter(c => !seen.has(c.id)).slice(0, 1500);
  let checked = 0;
  for (let i = 0; i < queue.length && !found; i += 10) {
    const batch = queue.slice(i, i + 10);
    const res = await runPooled_(batch.map(c => async () => {
      try { return Object.assign({ id: c.id, via: c.via }, await adsCustomer(c.id, opt, c.via)); } catch (e) { return null; }
    }), 5);
    checked += batch.length;
    found = res.find(x => x && x.conversionTrackingSetting && (String(x.conversionTrackingSetting.conversionTrackingId) === want ||
      String(x.conversionTrackingSetting.crossAccountConversionTrackingId) === want)) || null;
    if (found) via = found.via;
    if (!found && checked % 100 === 0) say('  …' + checked + ' of ' + queue.length + ' client accounts checked');
  }
  if (!found) {
    say('✖ No account you can reach uses AW-' + want + (queue.length ? ' (' + (checked + info.length) + ' accounts checked)' : '') +
        '. It may belong to another agency\'s or the client\'s own account.', true);
    return;
  }
  const cts = found.conversionTrackingSetting || {};
  const cross = String(cts.crossAccountConversionTrackingId || '') === want && String(cts.conversionTrackingId || '') !== want;
  say('✔ Found in ' + (Math.round((Date.now() - t0) / 100) / 10) + 's: account ' + String(found.id).replace(/(\d{3})(\d{3})(\d+)/, '$1-$2-$3') +
      (cross ? ' (AW-' + want + ' is its manager\'s cross-account conversion tracking ID)' : '') + (found.testAccount ? ', test account' : '') + '.');
  say('  Auto-tagging: ' + (found.autoTaggingEnabled ? 'on' : 'OFF') + ' · conversion tracking status: ' + (cts.conversionTrackingStatus || 'not returned') +
      ' · enhanced conversions for leads: ' + (cts.enhancedConversionsForLeadsEnabled ? 'on' : 'off') +
      ' · customer data terms accepted: ' + (cts.acceptedCustomerDataTerms ? 'yes' : 'no'));

  // 5. Conversion actions, their tags and 30-day conversions
  try {
    const acts = (await adsSearch(found.id, 'SELECT conversion_action.id, conversion_action.status, conversion_action.type, ' +
      'conversion_action.primary_for_goal, conversion_action.tag_snippets FROM conversion_action', opt, via)).map(r => r.conversionAction);
    const enabled = acts.filter(a => a.status === 'ENABLED');
    const labels = [].concat(...enabled.map(adsSnippetLabels_));
    const types = {};
    enabled.forEach(a => { types[a.type] = (types[a.type] || 0) + 1; });
    say('✔ Conversion actions: ' + acts.length + ' (' + enabled.length + ' enabled, ' + enabled.filter(a => a.primaryForGoal).length + ' primary). Types: ' +
        Object.keys(types).map(k => k + ' ' + types[k]).join(', '));
    say('  Website tags: ' + labels.length + ' AW-ID/label pair(s) in the tag snippets, ' + labels.filter(l => l.indexOf(want + '/') === 0).length + ' for AW-' + want + '.');
    const conv = await adsSearch(found.id, 'SELECT segments.conversion_action, metrics.all_conversions FROM customer WHERE segments.date DURING LAST_30_DAYS', opt, via);
    const withConv = new Set(conv.filter(r => Number(r.metrics.allConversions) > 0).map(r => r.segments.conversionAction));
    say('✔ Last 30 days: ' + withConv.size + ' conversion action(s) recorded conversions; ' +
        enabled.filter(a => !withConv.has('customers/' + found.id + '/conversionActions/' + a.id)).length + ' enabled action(s) recorded none.');
  } catch (e) { fail('Conversion actions', e); }

  // 6. Campaign delivery
  try {
    const camps = await adsSearch(found.id, 'SELECT campaign.id, campaign.advertising_channel_type, metrics.clicks, metrics.impressions ' +
      'FROM campaign WHERE segments.date DURING LAST_30_DAYS AND metrics.impressions > 0', opt, via);
    const sum = k => camps.reduce((t, r) => t + Number(r.metrics[k] || 0), 0);
    const ch = {};
    camps.forEach(r => { const c = r.campaign.advertisingChannelType; ch[c] = (ch[c] || 0) + 1; });
    say('✔ Campaigns with impressions in the last 30 days: ' + camps.length + ' (' + Object.keys(ch).map(k => k + ' ' + ch[k]).join(', ') + '); ' +
        sum('clicks') + ' clicks, ' + sum('impressions') + ' impressions.');
  } catch (e) { fail('Campaigns', e); }
  say('Test finished. Only read requests were sent; nothing was changed in Google Ads.');
}

function applyTheme() {
  const t = loadAppSettings().theme || 'auto';
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
}

// ══════════════════════════════════════════════════════════════════
//  VIEW: GA4 AUDIT (separate report, cross-referenced with GTM)
// ══════════════════════════════════════════════════════════════════

const GA4_TABS = [['overview', 'Overview'], ['events', 'Events & GTM'], ['config', 'Configuration'],
                  ['quality', 'Data quality'], ['coverage', 'Coverage']];

function ga4Log(msg, isError) {
  const g = STATE.ga4;
  g.log.push({ msg: msg, err: !!isError });
  const el = $('#ga4-log');
  if (el) {
    el.hidden = false;
    el.insertAdjacentHTML('beforeend', '<div' + (isError ? ' class="err"' : '') + '>' + esc(msg) + '</div>');
    el.scrollTop = el.scrollHeight;
  } else if (STATE.view === 'audit' || STATE.view === 'overview') {
    log(msg, isError);
  }
}

/** GA4 properties behind measurement IDs (uses the cached stream lookup when it can). */
async function ga4PropertiesForIds(mids, progress) {
  const out = [];
  for (const mid of mids) {
    try {
      const lookup = await findGa4Property(mid, progress, { client: STATE.inputs.client, site: STATE.inputs.site });
      if (lookup.property) {
        out.push({ property: lookup.property.property, displayName: lookup.property.displayName,
                   account: lookup.property.account, mid: mid });
      } else if (progress) progress(mid + ': no GA4 property found for the GA4 audit');
    } catch (e) {
      if (progress) progress(mid + ': ' + e.message, true);
    }
  }
  return out;
}

/** GA4 IDs live in the current GTM audit, with their property if the lookup cache already knows it. */
function ga4IdsFromGtm() {
  const r = STATE.result;
  if (!r) return [];
  const cache = readJsonStore_(GA4_STREAM_CACHE_KEY);
  return Object.keys(r.audit.ids).map(k => r.audit.ids[k]).filter(x => x.platform === 'GA4' && x.live && /^G-/.test(x.id))
    .map(x => ({ mid: x.id, prop: cache[x.id] || null }));
}

async function loadGa4Properties() {
  const g = STATE.ga4;
  if (g.loading) return;
  g.loading = true;
  try {
    // The list is kept for this tab, so the GA4 page opens instantly after a reload or sign-in
    let cached = null;
    try { cached = JSON.parse(sessionStorage.getItem('tas.ga4Props') || 'null'); } catch (e) { /* ignore */ }
    if (cached && cached.token === Google.token.slice(-12)) g.props = cached.list;
    else {
      g.props = await listGa4Properties();
      try { sessionStorage.setItem('tas.ga4Props', JSON.stringify({ token: Google.token.slice(-12), list: g.props })); } catch (e) { /* ignore */ }
    }
    // Tick the properties found by the GTM audit (cached lookups only; no extra API calls)
    if (!g.selected.length) {
      ga4IdsFromGtm().forEach(x => { if (x.prop && g.selected.indexOf(x.prop.property) < 0) g.selected.push(x.prop.property); });
    }
  } catch (e) {
    toast('Could not list GA4 properties: ' + e.message, true);
  } finally {
    g.loading = false;
    if (STATE.view === 'ga4') renderGa4();
  }
}

async function runGa4Audit(opts) {
  opts = opts || {};
  const g = STATE.ga4;
  if (g.running) return;
  if (!Google.isSignedIn()) { toast('Sign in with Google first.', true); return; }
  if (!g.selected.length) { toast('Choose at least one GA4 property.', true); return; }
  g.running = true;
  g.log = [];
  const btn = $('#ga4-run-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Running GA4 audit…'; }
  try {
    const gtm = ga4GtmContext(STATE.result);
    const meta = { client: STATE.inputs.client, site: STATE.inputs.site, date: new Date().toISOString() };
    // Read the properties two at a time; skip any already read in full during this run
    const fresh = opts.fresh || new Set();
    await runPooled_(g.selected.map(name => async () => {
      const info = (g.props || []).find(p => p.property === name) || g.known[name] || { property: name, displayName: name };
      if (!STATE.caches.ga4full[name] || (opts.refresh && !fresh.has(name))) STATE.caches.ga4full[name] = await fetchGa4Full(info, ga4Log);
    }), 2);
    const properties = [];
    for (const name of g.selected) {
      const res = buildGa4Result(STATE.caches.ga4full[name], gtm, meta);
      properties.push(res);
      ga4Log('GA4 audit of "' + res.displayName + '": grade ' + res.score.grade + ' (' + res.score.score + '/100), ' + res.issues.length + ' issue(s)' +
             (res.coverage.unavailable.length ? ', ' + res.coverage.unavailable.length + ' setting(s) not readable' : ''));
    }
    g.result = { date: meta.date, client: meta.client, site: meta.site, properties: properties };
    g.index = 0; g.tab = 'overview'; g.picking = false;
    updateNav();
    if (!opts.stay) setView('ga4');
    else if (STATE.view === 'ga4') renderGa4();
  } catch (e) {
    console.error(e);
    ga4Log('GA4 audit failed: ' + e.message, true);
    toast('GA4 audit failed: ' + e.message, true);
  } finally {
    g.running = false;
    const b = $('#ga4-run-btn');
    if (b) { b.disabled = false; b.textContent = 'Run GA4 audit'; }
  }
}

function ga4Current() {
  const r = STATE.ga4.result;
  return r ? r.properties[STATE.ga4.index] || r.properties[0] : null;
}

function renderGa4() {
  const g = STATE.ga4;
  if (!g.result || g.picking) return renderGa4Start();
  const pr = ga4Current();
  $('#view').innerHTML = ga4ReportHeader(pr) + `
    ${g.result.properties.length > 1 ? `<div class="toolbar"><div class="seg" role="group" aria-label="GA4 property">${g.result.properties.map((p, n) =>
      `<button data-act="ga4-prop" data-index="${n}" aria-pressed="${n === g.index}">${esc(p.displayName)}</button>`).join('')}</div></div>` : ''}
    <div class="actions">
      <button class="btn" data-act="ga4-pdf">Client PDF report</button>
      <button class="btn secondary" data-act="ga4-pdf-technical">Technical PDF report</button>
      <button class="btn secondary" data-act="ga4-csv-actions">Download actions (CSV)</button>
      <button class="btn secondary" data-act="ga4-csv-events">Download events (CSV)</button>
      <button class="btn secondary" data-act="save">Save audit</button>
      <button class="btn secondary" data-act="ga4-rerun">Re-run GA4 audit</button>
      <button class="btn secondary" data-act="ga4-new">Choose properties</button>
    </div>
    <div class="toolbar"><div class="seg" role="group" aria-label="GA4 report section">${GA4_TABS.map(t =>
      `<button data-act="ga4-tab" data-tab="${t[0]}" aria-pressed="${g.tab === t[0]}">${t[1]}</button>`).join('')}</div></div>
    <div id="ga4-tab">${ga4TabHtml(pr, g.tab)}</div>`;
}

function ga4ReportHeader(pr) {
  const g = STATE.ga4.result;
  const counts = s => pr.issues.filter(x => x.severity === s).length;
  const num = n => n === null || n === undefined ? '—' : ga4Num_(n);
  return `
    <div class="report-head">
      <div>
        <h1>${esc(pr.displayName)}</h1>
        <p class="meta">${esc(joinParts_(g.client, g.site, 'Property ' + String(pr.property).replace('properties/', ''), pr.account && 'Account: ' + pr.account))}</p>
        <p class="meta">GA4 audit ${esc(new Date(pr.meta.date).toLocaleString())} · settings from the GA4 Admin API${pr.hasData ? ', collected data from the last 28 days (Data API)' : '; collected data not available'}</p>
        <p class="meta">${pr.gtmSource ? 'Cross-checked against GTM: ' + esc(pr.gtmSource) : 'Not cross-checked against GTM. Run a GTM audit for this site first to compare tags with the data GA4 receives.'}</p>
        <div class="tally">
          <div><strong>${counts('High')}</strong>high priority</div>
          <div><strong>${counts('Medium')}</strong>medium</div>
          <div><strong>${counts('Low')}</strong>low</div>
          <div><strong>${num(pr.summary.events28d)}</strong>events, 28 days</div>
          <div><strong>${num(pr.summary.keyEvents)}</strong>key events</div>
          <div><strong>${pr.summary.streams}</strong>data streams</div>
        </div>
      </div>
      <div class="stamp ${esc(pr.score.grade)}" role="img" aria-label="GA4 health grade ${esc(pr.score.grade)}, score ${pr.score.score} out of 100">
        <div><b>${esc(pr.score.grade)}</b><span>${pr.score.score} / 100</span></div>
      </div>
    </div>`;
}

function ga4KvTable(section) {
  return `<h3>${esc(section.title)}</h3><div class="table-wrap"><table class="kv"><tbody>${section.rows.map(r =>
    `<tr><th scope="row">${esc(r[0])}</th><td class="wrap">${esc(r[1])}</td></tr>`).join('')}</tbody></table></div>`;
}

function ga4DataTable(section) {
  return `<h3>${esc(section.title)}</h3>${section.rows.length ? `<div class="table-wrap"><table>
    <thead><tr>${section.columns.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead>
    <tbody>${section.rows.map(r => `<tr>${r.map((c, n) => `<td${n === 0 ? ' class="wrap"' : ''}>${n === 0 && /URL/.test(section.title) ? '<code>' + esc(c) + '</code>' : esc(c)}</td>`).join('')}</tr>`).join('')}</tbody>
  </table></div>` : '<p class="hint">No data.</p>'}`;
}

function ga4EventsTable(pr) {
  if (!pr.crossRef.length) return '<div class="empty">No events found.</div>';
  return `<div class="table-wrap"><table>
    <thead><tr><th>Event</th><th>Sent from GTM</th><th>Events (28 days)</th><th>Users</th><th>Key event</th><th>Status</th></tr></thead>
    <tbody>${pr.crossRef.map(x => `<tr>
      <td><code>${esc(x.name)}</code></td>
      <td class="wrap">${x.inGtm.length ? esc(truncate_(x.inGtm.join(', '), 240)) : '<span class="sub">—</span>'}</td>
      <td>${pr.hasData ? ga4Num_(x.count) : '—'}</td><td>${pr.hasData ? ga4Num_(x.users) : '—'}</td>
      <td>${x.isKey ? 'Yes' : ''}</td>
      <td><span class="sev ${esc(x.sev)}">${esc(x.status)}</span></td></tr>`).join('')}</tbody></table></div>`;
}

function ga4CoverageHtml(pr) {
  const c = pr.coverage;
  return `${c.notes.map(n => `<div class="notice">${esc(n)}</div>`).join('')}
    <h3>Settings that could not be read</h3>
    ${c.unavailable.length ? `<p class="hint">These were skipped. Some need extra access, are not available for this property, or are still in Google's alpha API.</p>
      <ul>${c.unavailable.map(u => `<li>${esc(u)}</li>`).join('')}</ul>` : '<p>Everything the audit asked for was read.</p>'}
    <h3>Check manually</h3>
    <p class="hint">The GA4 APIs do not expose these settings with read-only access.</p>
    <div class="table-wrap"><table class="kv"><tbody>${c.manual.map(m =>
      `<tr><th scope="row">${esc(m[0])}</th><td class="wrap">${esc(m[1])}</td></tr>`).join('')}</tbody></table></div>`;
}

function ga4TabHtml(pr, tab) {
  if (tab === 'events') {
    return `<p class="lede">Every event GTM sends, GA4 received in the last 28 days, or is marked as a key event.</p>
      ${pr.gtmSource ? '' : '<div class="notice">Not cross-checked against GTM. Run a GTM audit for this site (New audit) and then re-run the GA4 audit to fill the GTM column.</div>'}
      ${ga4EventsTable(pr)}`;
  }
  if (tab === 'config') return pr.config.map(ga4KvTable).join('');
  if (tab === 'quality') {
    return pr.quality.length ? `<p class="lede">Collected data, last 28 days. Numbers can differ slightly from the GA4 interface because of thresholding and sampling.</p>
      ${pr.quality.map(ga4DataTable).join('')}` : '<div class="empty"><h3>No collected data</h3>The Data API could not be read for this property. See Coverage.</div>';
  }
  if (tab === 'coverage') return ga4CoverageHtml(pr);
  return `<h2>Areas</h2>${areasTable(pr)}<h2>Prioritised actions</h2>${actionsTable(pr)}`;
}

function renderGa4Start() {
  const g = STATE.ga4, s = loadAppSettings(), i = STATE.inputs;
  const signed = Google.isSignedIn();
  if (signed && !g.props && !g.loading) loadGa4Properties();
  const fromGtm = ga4IdsFromGtm();
  $('#view').innerHTML = `
    <h1>GA4 audit</h1>
    <p class="lede">A separate report on GA4 properties: every setting the GA4 Admin API can read, plus the last 28 days of collected data from the Data API, cross-checked against the GTM audit when there is one.</p>
    <section class="form-block">
      <h2 style="margin-top:0">Google sign-in</h2>
      <div class="row">${googleStatusHtml()}</div>
      <p class="hint">Needs read access to the GA4 properties you want to audit.</p>
    </section>
    <section class="form-block">
      <h2 style="margin-top:0">Client</h2>
      <div class="grid2">
        <div><label for="ga4-client">Client name</label><input type="text" id="ga4-client" value="${esc(i.client)}" placeholder="e.g. Omoda UK"></div>
        <div><label for="ga4-site">Website</label><input type="url" id="ga4-site" value="${esc(i.site)}" placeholder="https://www.example.co.uk"></div>
      </div>
      <p class="hint">Used to check hostnames, self-referrals and that the stream URL matches the site.</p>
    </section>
    <section class="form-block">
      <h2 style="margin-top:0">Properties</h2>
      ${fromGtm.length ? `<p class="hint">From the GTM audit: ${fromGtm.map(x => '<code>' + esc(x.mid) + '</code>' + (x.prop ? ' → ' + esc(x.prop.displayName) : '')).join(', ')}.
        ${fromGtm.some(x => !x.prop) && signed ? ' <button class="link" data-act="ga4-from-gtm">Find their properties</button>' : ''}</p>` : ''}
      ${!signed ? '<p class="hint">Sign in to list the GA4 properties you can access.</p>'
        : !g.props ? '<p class="hint">Loading your GA4 properties…</p>'
        : `<div class="toolbar"><input type="search" id="ga4-q" value="${esc(g.query)}" placeholder="Search properties or accounts" aria-label="Search GA4 properties">
             <span class="hint" id="ga4-count">${g.selected.length} selected</span></div>
           <div class="ga4-picker" id="ga4-list">${ga4PickerList()}</div>`}
    </section>
    <div class="actions">
      <button class="btn big" id="ga4-run-btn" data-act="ga4-run" ${signed ? '' : 'disabled'}>Run GA4 audit</button>
      ${g.result ? '<button class="btn secondary" data-act="ga4-back">Back to the report</button>' : ''}
    </div>
    <div class="log" id="ga4-log" ${g.log.length ? '' : 'hidden'}>${g.log.map(l => '<div' + (l.err ? ' class="err"' : '') + '>' + esc(l.msg) + '</div>').join('')}</div>`;
  ['client', 'site'].forEach(k => {
    const el = $('#ga4-' + k);
    el.addEventListener('input', () => { STATE.inputs[k] = el.value; saveDraft(); });
  });
  const q = $('#ga4-q');
  if (q) q.addEventListener('input', () => { g.query = q.value; $('#ga4-list').innerHTML = ga4PickerList(); });
}

function ga4PickerList() {
  const g = STATE.ga4;
  const q = g.query.toLowerCase().trim();
  const list = (g.props || []).filter(p => !q || (p.displayName + ' ' + p.account + ' ' + p.property).toLowerCase().indexOf(q) >= 0);
  const shown = list.slice().sort((a, b) => (g.selected.indexOf(b.property) >= 0) - (g.selected.indexOf(a.property) >= 0)).slice(0, 200);
  if (!list.length) return '<p class="hint">No properties match.</p>';
  return shown.map(p => `<label><input type="checkbox" data-ga4-prop="${esc(p.property)}" ${g.selected.indexOf(p.property) >= 0 ? 'checked' : ''}>
      <span>${esc(p.displayName)}<span class="sub">${esc(p.account)} · ${esc(p.property.replace('properties/', ''))}</span></span></label>`).join('') +
    (list.length > shown.length ? `<p class="hint">${list.length - shown.length} more; search to narrow the list.</p>` : '');
}

// ══════════════════════════════════════════════════════════════════
//  VIEW: CM360 CHECK (Floodlight and delivery vs GTM and GA4)
// ══════════════════════════════════════════════════════════════════

const CM360_TABS = [['overview', 'Overview'], ['mapping', 'Floodlight mapping'], ['activities', 'Activities'],
                    ['delivery', 'Delivery vs GA4'], ['coverage', 'Coverage']];

function cm360Log(msg, isError) {
  const c = STATE.cm360;
  c.log.push({ msg: msg, err: !!isError });
  if (STATE.view === 'overview') log(msg, isError);
  const el = $('#cm360-log');
  if (el) {
    el.hidden = false;
    el.insertAdjacentHTML('beforeend', '<div' + (isError ? ' class="err"' : '') + '>' + esc(msg) + '</div>');
    el.scrollTop = el.scrollHeight;
  }
}

/** Floodlight configuration IDs the GTM audit sends to, with how many activity tags each. */
function cm360SrcsFromGtm() {
  const counts = {};
  cm360GtmTags(STATE.result).forEach(t => { counts[t.src] = (counts[t.src] || 0) + 1; });
  return Object.keys(counts).map(src => ({ src: src, tags: counts[src] })).sort((a, b) => b.tags - a.tags);
}

/** GA4 sessions per campaign from the GA4 audit in this session (if any). */
function cm360Ga4Context() {
  const g = STATE.ga4.result;
  if (!g) return null;
  const props = g.properties.filter(p => Array.isArray(p.campaigns30d));
  if (!props.length) return null;
  return { campaigns: [].concat(...props.map(p => p.campaigns30d)), source: props.map(p => p.displayName).join(', ') };
}

function computeCm360Result() {
  const c = STATE.cm360;
  if (!c.data) { c.result = null; return; }
  c.result = buildCm360Result(c.data, cm360GtmTags(STATE.result), cm360Ga4Context(), c.mapping,
                              { client: STATE.inputs.client, site: STATE.inputs.site, date: c.data.date });
  updateNav();
}

async function loadCm360Accounts() {
  const c = STATE.cm360;
  if (c.loading) return;
  c.loading = true;
  try {
    c.profiles = await cm360Profiles();
    const lists = await runPooled_(c.profiles.map(p => async () => {
      try { return (await cm360FloodlightConfigs(p.profileId)).map(x => x.id); } catch (e) { return []; }
    }), 2);
    c.configs = {};
    c.profiles.forEach((p, n) => { c.configs[p.profileId] = lists[n]; });
    // Pick the account that owns the Floodlight configurations GTM sends to
    const srcs = cm360SrcsFromGtm().map(x => x.src);
    let best = c.profiles[0], bestHits = -1;
    c.profiles.forEach(p => {
      const hits = srcs.filter(s => c.configs[p.profileId].indexOf(s) >= 0).length;
      if (hits > bestHits) { best = p; bestHits = hits; }
    });
    if (best) {
      c.profileId = best.profileId;
      const ids = c.configs[best.profileId] || [];
      c.configId = srcs.find(s => ids.indexOf(s) >= 0) || ids[0] || '';
    }
  } catch (e) {
    toast('Could not read your CM360 accounts: ' + e.message, true);
  } finally {
    c.loading = false;
    refreshCm360Views();
  }
}

async function runCm360Reports() {
  const c = STATE.cm360;
  if (c.running || !c.profileId || !c.configId) return;
  c.running = true; c.log = []; c.prep = null; c.files = {};
  refreshCm360Views();
  const btn = $('#cm360-run-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Running reports in CM360…'; }
  try {
    cm360Log('Running two reports in CM360 for Floodlight configuration ' + c.configId + ' (last 30 days)…');
    c.prep = await cm360PrepareCrossCheck(c.profileId, c.configId, cm360Log);
    cm360Log('Both reports are ready. Download them with the two buttons, then drop both files in.');
  } catch (e) {
    cm360Log('CM360 reports failed: ' + e.message, true);
    toast('CM360 reports failed: ' + e.message, true);
  } finally {
    c.running = false;
    refreshCm360Views();
  }
}

async function addCm360Files(files) {
  const c = STATE.cm360;
  for (const f of files) {
    try {
      if (f.size > 20 * 1024 * 1024) throw new Error('larger than 20 MB');
      const rep = cm360ParseReport(await f.text());
      c.files[rep.kind] = rep;
      cm360Log('✔ ' + (rep.kind === 'floodlight' ? 'Floodlight report: ' + rep.activities.length + ' activit(ies)' : 'Delivery report: ' + rep.rows.length + ' row(s)') + ' read.');
    } catch (e) { cm360Log('✖ ' + f.name + ': ' + e.message, true); }
  }
  if (c.files.floodlight && c.files.delivery) await finishCm360();
  else refreshCm360Views();
}

/** Builds the CM360 data from the added files and deletes the temporary reports. */
async function finishCm360() {
  const c = STATE.cm360, p = c.prep;
  if (p) {
    for (const r of [p.floodlight, p.delivery]) {
      try { await cm360DeleteReport(r.profileId, r.reportId); }
      catch (e) { cm360Log('Could not delete a temporary report (' + e.message + '); it is removed on the next run.', true); }
    }
    cm360Log('✔ Temporary reports deleted from CM360.');
  }
  const prof = (c.profiles || []).find(x => String(x.profileId) === String(c.profileId)) || {};
  c.data = {
    date: new Date().toISOString(), account: prof.accountName || '', accountId: prof.accountId || '', configId: String(c.configId),
    configsOwned: [].concat(...Object.keys(c.configs || {}).map(k => c.configs[k])),
    metrics: p ? p.metrics : [], catalog: p ? p.catalog : [], setup: p ? p.setup || null : null, profileId: String(c.profileId || ''),
    activities: c.files.floodlight ? c.files.floodlight.activities : null,
    delivery: c.files.delivery ? c.files.delivery.rows : null
  };
  c.prep = null; c.files = {}; c.picking = false; c.tab = 'overview';
  computeCm360Result();
  autoCm360Finished();
  refreshCm360Views();
}

/** Re-renders the views that show CM360 progress (the CM360 check and the Overview). */
function refreshCm360Views() {
  if (STATE.view === 'cm360') renderCm360();
  else if (STATE.view === 'overview') renderOverview();
}

/** The drop zone for the two downloaded CM360 reports (also a file picker). */
function cm360DropZone() {
  const c = STATE.cm360;
  return `<label class="dropzone" for="cm360-files" data-dropzone="cm360">
      <input type="file" id="cm360-files" accept=".csv,text/csv" multiple>
      <strong>Drop both CM360 reports here</strong>
      <span>Drag the two CSV files from Chrome's download bubble or the downloads page (Ctrl+J), or click to choose them.</span>
      <span class="got">${['floodlight', 'delivery'].map(k => (c.files[k] ? '✓ ' : '○ ') + (k === 'floodlight' ? 'Floodlight report' : 'Delivery report')).join(' · ')}</span>
    </label>`;
}

/** Download links for the two prepared reports, plus the drop zone. */
function cm360ManualHtml() {
  const c = STATE.cm360;
  if (!c.prep) return '';
  return `<div class="actions">
        <a class="btn ${c.files.floodlight ? 'secondary' : ''}" href="${esc(c.prep.floodlight.browserUrl)}" target="_blank" rel="noopener">1. Download Floodlight report${c.files.floodlight ? ' ✓' : ''}</a>
        <a class="btn ${c.files.delivery ? 'secondary' : ''}" href="${esc(c.prep.delivery.browserUrl)}" target="_blank" rel="noopener">2. Download delivery report${c.files.delivery ? ' ✓' : ''}</a>
      </div>
      ${cm360DropZone()}
      <p class="hint">Both are read in this browser; only counts per activity and campaign are kept. The reports are then deleted from CM360.
        ${c.files.floodlight || c.files.delivery ? ' <button class="link" data-act="cm360-finish">Continue with the file I have</button>' : ''}</p>`;
}

function renderCm360() {
  const c = STATE.cm360;
  if (c.data) computeCm360Result();   // the GTM or GA4 results may have changed since
  if (!c.result || c.picking) return renderCm360Start();
  const r = c.result;
  const counts = s => r.issues.filter(x => x.severity === s).length;
  $('#view').innerHTML = `
    <div class="report-head">
      <div>
        <h1>CM360 check</h1>
        <p class="meta">${esc(joinParts_(STATE.inputs.client, r.account && 'CM360 account: ' + r.account, 'Floodlight configuration DC-' + r.configId))}</p>
        <p class="meta">Last 30 days · ${STATE.result ? 'GTM: ' + esc(r.summary.gtmTags + ' Floodlight activity tag(s) for this configuration') : 'No GTM audit in this session'} ·
          ${r.ga4Source ? 'GA4: ' + esc(r.ga4Source) : 'GA4 not compared'}</p>
        <div class="tally">
          <div><strong>${counts('High')}</strong>high priority</div>
          <div><strong>${counts('Medium')}</strong>medium</div>
          <div><strong>${counts('Low')}</strong>low</div>
          <div><strong>${ga4Num_(r.summary.conversions)}</strong>conversions</div>
          <div><strong>${ga4Num_(r.summary.clicks)}</strong>clicks</div>
          <div><strong>${ga4Num_(r.summary.impressions)}</strong>impressions</div>
        </div>
      </div>
      <div class="stamp ${esc(r.score.grade)}" role="img" aria-label="CM360 check grade ${esc(r.score.grade)}, score ${r.score.score} out of 100">
        <div><b>${esc(r.score.grade)}</b><span>${r.score.score} / 100</span></div>
      </div>
    </div>
    <div class="actions">
      <button class="btn" data-act="cm360-pdf">Technical PDF report</button>
      <button class="btn secondary" data-act="cm360-csv" data-kind="actions">Download actions (CSV)</button>
      <button class="btn secondary" data-act="cm360-csv" data-kind="mapping">Download mapping (CSV)</button>
      <button class="btn secondary" data-act="cm360-csv" data-kind="delivery">Download delivery (CSV)</button>
      <button class="btn secondary" data-act="save">Save audit</button>
      <button class="btn secondary" data-act="cm360-new">Run again</button>
    </div>
    <div class="toolbar"><div class="seg" role="group" aria-label="CM360 report section">${CM360_TABS.map(t =>
      `<button data-act="cm360-tab" data-tab="${t[0]}" aria-pressed="${c.tab === t[0]}">${t[1]}</button>`).join('')}</div></div>
    <div id="cm360-tab">${cm360TabHtml(r, c.tab)}</div>`;
}

function cm360MappingTable(r, forPrint) {
  if (!r.mappingRows.length) {
    return '<div class="empty">No Floodlight tags for this configuration in the GTM audit. ' +
      (STATE.result ? 'GTM sends to other configurations: see Overview.' : 'Run a GTM audit for this site first.') + '</div>';
  }
  const options = r.activities.map(a => [a.id || a.name, a.name + (a.group ? ' · ' + a.group : '') + ' (' + ga4Num_(a.conversions) + ')']);
  return `<div class="table-wrap"><table>
    <thead><tr><th>GTM tag</th><th>type / cat</th><th>CM360 activity</th><th>Conversions (30 days)</th><th>Match</th></tr></thead>
    <tbody>${r.mappingRows.map(m => `<tr>
      <td class="wrap"><strong>${esc(m.labels.join(', '))}</strong><span class="sub">${esc(m.where.join(', '))}${m.uVars.length ? ' · variables ' + esc(m.uVars.join(', ')) : ''}</span></td>
      <td><code>${esc(m.type)}/${esc(m.cat)}</code>${m.method ? '<span class="sub">' + esc(m.method) + '</span>' : ''}</td>
      <td class="wrap">${forPrint ? esc(m.activityName || '—') : `<label class="skip" for="map-${esc(m.key)}">CM360 activity for ${esc(m.labels[0])}</label>
        <select id="map-${esc(m.key)}" data-cm360-map="${esc(m.key)}" class="map-select">
          <option value="">${m.status === 'Exact' ? 'Exact match' : m.status === 'Suggested' || m.status === 'Confirmed' ? 'Automatic suggestion' : 'Choose…'}</option>
          ${options.map(o => `<option value="${esc(o[0])}" ${STATE.cm360.mapping[m.key] === o[0] ? 'selected' : ''}>${esc(o[1])}</option>`).join('')}
          <option value="none" ${STATE.cm360.mapping[m.key] === 'none' ? 'selected' : ''}>No CM360 activity (not used)</option>
        </select>${m.activityName && !STATE.cm360.mapping[m.key] ? '<span class="sub">' + (m.status === 'Exact' ? 'Activity: ' : 'Suggested: ') + esc(m.activityName) + '</span>' : ''}`}
        ${m.reason ? '<span class="sub">' + esc(m.reason) + '</span>' : ''}
        ${m.disagree ? '<span class="sub"><span class="sev Medium">Check</span> The tag name and the activity describe different things</span>' : ''}</td>
      <td>${m.conversions === null ? '—' : ga4Num_(m.conversions)}</td>
      <td><span class="sev ${m.status === 'Confirmed' || m.status === 'Exact' ? 'OK' : m.status === 'Not matched' || m.status === 'Not in CM360' ? 'Medium' : 'Info'}">${esc(m.status)}</span></td></tr>`).join('')}
    </tbody></table></div>`;
}

function cm360ActivitiesTable(r) {
  if (!r.activities.length) return '<div class="empty">No Floodlight activities found for this configuration.</div>';
  return `<div class="table-wrap"><table>
    <thead><tr><th>Activity</th><th>Group</th><th>Activity ID</th><th>Conversions</th><th>Click-through</th><th>View-through</th><th>Tag in GTM</th></tr></thead>
    <tbody>${r.activities.map(a => `<tr><td class="wrap">${esc(a.name)}</td><td class="wrap">${esc(a.group)}</td><td><code>${esc(a.id)}</code></td>
      <td>${ga4Num_(a.conversions)}</td><td>${a.clickThrough === null ? '—' : ga4Num_(a.clickThrough)}</td><td>${a.viewThrough === null ? '—' : ga4Num_(a.viewThrough)}</td>
      <td>${a.gtm ? 'Yes' : '<span class="sub">—</span>'}</td></tr>`).join('')}</tbody></table></div>`;
}

function cm360DeliveryTable(r) {
  if (!r.delivery.length) return '<div class="empty">No delivery in the last 30 days for this advertiser.</div>';
  return `${r.ga4Source ? '' : '<div class="notice">GA4 sessions are not shown: run the GA4 audit for this site (GA4 audit) and then open this tab again.</div>'}
    <div class="table-wrap"><table>
    <thead><tr><th>Campaign</th><th>Impressions</th><th>Clicks</th><th>GA4 sessions</th><th>Sessions per click</th></tr></thead>
    <tbody>${r.delivery.map(d => `<tr><td class="wrap">${esc(d.campaign)}${d.ga4Campaign && cm360NormCampaign_(d.ga4Campaign) !== cm360NormCampaign_(d.campaign) ? '<span class="sub">GA4: ' + esc(d.ga4Campaign) + '</span>' : ''}${d.search ? '<span class="sub">Search: not compared</span>' : ''}</td>
      <td>${ga4Num_(d.impressions)}</td><td>${ga4Num_(d.clicks)}</td>
      <td>${d.sessions === null ? '—' : ga4Num_(d.sessions)}</td>
      <td>${d.ratio === null ? '—' : `<span class="sev ${d.clicks >= 100 && d.ratio < 50 ? 'Medium' : 'OK'}">${d.ratio}%</span>`}</td></tr>`).join('')}</tbody></table></div>`;
}

function cm360TabHtml(r, tab) {
  if (tab === 'mapping') {
    const exact = STATE.cm360.data && Array.isArray(STATE.cm360.data.setup);
    return `<p class="lede">${exact ? 'Each Floodlight tag in GTM, matched exactly to its CM360 activity on the tag strings (type/cat).'
        : 'Each Floodlight tag in GTM, matched to a CM360 activity by name.'} Confirm or correct the matches; your choices are saved with the audit.</p>
      ${exact ? '' : `<div class="notice">Matching by name is a guess. For exact matching on the tag strings, ${Google.hasScope(CM360_TRAFFIC_SCOPE)
        ? '<button class="link" data-act="cm360-setup">read the Floodlight setup</button>.'
        : 'connect the CM360 Floodlight setup (edit-level permission; the app only reads Floodlight activities): <button class="link" data-act="cm360-exact-connect">Connect Floodlight setup</button>.'}</div>`}
      ${cm360MappingTable(r)}`;
  }
  if (tab === 'activities') return `<p class="lede">Floodlight activities of configuration DC-${esc(r.configId)} and their conversions in the last 30 days.</p>${cm360ActivitiesTable(r)}`;
  if (tab === 'delivery') return `<p class="lede">CM360 clicks per campaign compared with GA4 sessions for the same campaign, last 30 days.</p>${cm360DeliveryTable(r)}`;
  if (tab === 'coverage') {
    return `${r.coverage.map(t => `<p>${esc(t)}</p>`).join('')}
      ${r.unconsented.length ? `<h3>Floodlight tags that may not wait for consent</h3><p class="hint">From the GTM audit's Consent matrix.</p>
        <ul>${r.unconsented.map(u => `<li>${esc(u.labels.join(', '))} <span class="sev ${esc(u.risk)}">${esc(u.risk)}</span></li>`).join('')}</ul>` : ''}`;
  }
  return `<h2>Areas</h2>${areasTable(r)}<h2>Prioritised actions</h2>${actionsTable(r)}`;
}

function renderCm360Start() {
  const c = STATE.cm360;
  const signed = Google.isSignedIn(), connected = Google.hasScope(CM360_SCOPE);
  if (connected && !c.profiles && !c.loading) loadCm360Accounts();
  const srcs = cm360SrcsFromGtm();
  const prof = (c.profiles || []);
  const configs = c.profileId ? (c.configs[c.profileId] || []) : [];
  $('#view').innerHTML = `
    <h1>CM360 check</h1>
    <p class="lede">Compares Floodlight conversions and campaign delivery in Campaign Manager 360 with the Floodlight tags in GTM and the sessions in GA4. Last 30 days.</p>
    <section class="form-block">
      <h2 style="margin-top:0">CM360 access</h2>
      <div class="row">${!signed ? googleStatusHtml() : connected ? '<span class="signed">CM360 reports connected</span>'
        : '<button class="btn secondary" data-act="cm360-connect">Connect CM360</button>'}</div>
      <p class="hint">Reports only: the app can run and delete its own temporary reports, and cannot change campaigns, ads or Floodlight.
        Google does not let browsers download report files directly, so you download the two reports with one click each and add them back.</p>
    </section>
    <section class="form-block">
      <h2 style="margin-top:0">What to compare</h2>
      ${srcs.length ? `<p class="hint" style="margin-bottom:14px">From the GTM audit: ${srcs.map(s => '<code>DC-' + esc(s.src) + '</code> (' + s.tags + ' activity tag' + (s.tags === 1 ? '' : 's') + ')').join(', ')}.</p>`
        : `<p class="hint" style="margin-bottom:14px">${STATE.result ? 'The GTM audit has no Floodlight tags.' : 'Run a GTM audit for this site first to compare its Floodlight tags.'} The delivery comparison with GA4 still works.</p>`}
      ${!connected ? '<p class="hint">Connect CM360 to choose the account.</p>'
        : !c.profiles ? '<p class="hint">Reading your CM360 accounts…</p>'
        : !prof.length ? '<p class="hint">This Google account has no CM360 user profile. Ask for CM360 access with API use allowed.</p>'
        : `<div class="grid2">
            <div><label for="cm360-profile">CM360 account</label>
              <select id="cm360-profile">${prof.map(p => `<option value="${esc(p.profileId)}" ${String(p.profileId) === String(c.profileId) ? 'selected' : ''}>${esc(p.accountName)} (${esc(p.accountId)})</option>`).join('')}</select></div>
            <div><label for="cm360-config">Floodlight configuration</label>
              <select id="cm360-config">${configs.map(id => `<option value="${esc(id)}" ${id === c.configId ? 'selected' : ''}>DC-${esc(id)}${srcs.some(s => s.src === id) ? ' (used in GTM)' : ''}</option>`).join('') || '<option value="">None visible in this account</option>'}</select></div>
          </div>`}
    </section>
    <div class="actions">
      <button class="btn big" id="cm360-run-btn" data-act="cm360-run" ${connected && c.configId && !c.running ? '' : 'disabled'}>${c.running ? 'Running reports in CM360…' : 'Run CM360 reports'}</button>
      ${c.result ? '<button class="btn secondary" data-act="cm360-back">Back to the report</button>' : ''}
    </div>
    ${c.prep ? `<section class="form-block" id="cm360-manual">
      <h2 style="margin-top:0">Download the two reports</h2>
      ${cm360ManualHtml()}
    </section>` : ''}
    <div class="log" id="cm360-log" ${c.log.length ? '' : 'hidden'}>${c.log.map(l => '<div' + (l.err ? ' class="err"' : '') + '>' + esc(l.msg) + '</div>').join('')}</div>`;
  const ps = $('#cm360-profile');
  if (ps) ps.addEventListener('change', () => {
    c.profileId = ps.value;
    const ids = c.configs[c.profileId] || [];
    c.configId = srcs.map(s => s.src).find(s => ids.indexOf(s) >= 0) || ids[0] || '';
    renderCm360();
  });
  const cs = $('#cm360-config');
  if (cs) cs.addEventListener('change', () => { c.configId = cs.value; });
}

function exportCm360Csv(kind) {
  const r = STATE.cm360.result;
  const slug = 'cm360-' + fileSlug();
  if (kind === 'mapping') {
    download(slug + '-floodlight-mapping.csv', toCsv([['GTM tag', 'Where', 'type', 'cat', 'Counting method', 'Variables', 'CM360 activity', 'Conversions (30 days)', 'Match', 'Why']]
      .concat(r.mappingRows.map(m => [m.labels.join('; '), m.where.join('; '), m.type, m.cat, m.method, m.uVars.join(' '), m.activityName, m.conversions === null ? '' : m.conversions, m.status, m.reason || '']))), 'text/csv');
  } else if (kind === 'delivery') {
    download(slug + '-delivery.csv', toCsv([['Campaign', 'Campaign ID', 'Impressions', 'Clicks', 'GA4 campaign', 'GA4 sessions', 'Sessions per click (%)']]
      .concat(r.delivery.map(d => [d.campaign, d.campaignId, d.impressions, d.clicks, d.ga4Campaign, d.sessions === null ? '' : d.sessions, d.ratio === null ? '' : d.ratio]))), 'text/csv');
  } else {
    download(slug + '-actions.csv', toCsv([['Severity', 'Area', 'Finding', 'Action', 'Items']]
      .concat(r.issues.map(x => [x.severity, x.area, x.finding, x.action, (x.items || []).join('; ')]))), 'text/csv');
  }
}

function exportCm360Pdf() {
  const r = STATE.cm360.result;
  $('#print-report').className = '';
  $('#print-report').innerHTML = `
    <div class="page"><h1>CM360 check</h1><p class="meta">${esc(joinParts_(STATE.inputs.client, r.account, 'DC-' + r.configId, 'last 30 days'))}</p>
      <h2>Areas</h2>${areasTable(r)}</div>
    <div class="page"><h2>Prioritised actions</h2>${actionsTable(r)}</div>
    <div class="page"><h2>Floodlight mapping</h2>${cm360MappingTable(r, true)}</div>
    <div class="page"><h2>Activities</h2>${cm360ActivitiesTable(r)}</div>
    <div class="page"><h2>Delivery vs GA4</h2>${cm360DeliveryTable(r)}</div>
    <div class="page"><h2>Coverage</h2>${cm360TabHtml(r, 'coverage')}</div>`;
  const title = document.title;
  document.title = 'CM360 check - ' + fileSlug();
  window.print();
  document.title = title;
}

// ══════════════════════════════════════════════════════════════════
//  VIEW: SEARCH CONSOLE CHECK
// ══════════════════════════════════════════════════════════════════

const GSC_TABS = [['overview', 'Overview'], ['pages', 'Pages vs GA4'], ['sitemaps', 'Sitemaps'], ['coverage', 'Coverage']];

function gscLog(msg, isError) {
  const g = STATE.gsc;
  g.log.push({ msg: msg, err: !!isError });
  if (STATE.view === 'overview') log(msg, isError);
  const el = $('#gsc-log');
  if (el) {
    el.hidden = false;
    el.insertAdjacentHTML('beforeend', '<div' + (isError ? ' class="err"' : '') + '>' + esc(msg) + '</div>');
    el.scrollTop = el.scrollHeight;
  }
}

/** Organic Google sessions from the GA4 audit: the property with the most organic sessions on this host. */
function gscGa4Context(host) {
  const g = STATE.ga4.result;
  if (!g || !host) return null;
  const onSite = h => { h = String(h || '').replace(/^www\./, ''); return h === host || h.endsWith('.' + host); };
  let best = null, bestSessions = -1;
  g.properties.filter(p => p.organic28d).forEach(p => {
    const s = p.organic28d.pages.filter(x => onSite(x.host)).reduce((t, x) => t + x.sessions, 0);
    if (s > bestSessions) { best = p; bestSessions = s; }
  });
  return best && bestSessions > 0 ? { source: best.displayName, organic: best.organic28d } : null;
}

function computeGscResult() {
  const g = STATE.gsc;
  if (!g.data) { g.result = null; return; }
  g.result = buildGscResult(g.data, gscGa4Context(g.data.host), STATE.inputs.pageSource || '',
                            { client: STATE.inputs.client, site: g.data.site, date: g.data.date });
  updateNav();
}

async function runGscCheck(opts) {
  opts = opts || {};
  const g = STATE.gsc;
  if (g.running) return;
  if (!Google.hasScope(GSC_SCOPE)) { toast('Connect Search Console first.', true); return; }
  g.running = true; g.log = [];
  if (STATE.view === 'gsc') renderGsc();
  try {
    g.data = await fetchGscData(STATE.inputs.site, gscLog);
    g.picking = false; g.tab = 'overview';
    computeGscResult();
    const r = g.result;
    gscLog(r.property ? 'Search Console check: grade ' + r.score.grade + ' (' + r.score.score + '/100), ' + r.issues.length + ' issue(s).'
      : 'Search Console check: no readable property for ' + r.host + '.');
  } catch (e) {
    console.error(e);
    const off = /has not been used|is disabled|SERVICE_DISABLED|accessNotConfigured/i.test(e.message);
    gscLog('Search Console check failed: ' + (off ? 'the Search Console API is not enabled in the Google Cloud project.' : e.message), true);
    if (!opts.stay) toast('Search Console check failed: ' + e.message, true);
  } finally {
    g.running = false;
    if (STATE.view === 'gsc') renderGsc();
  }
}

function renderGsc() {
  const g = STATE.gsc;
  if (g.data) computeGscResult();   // the GA4 result or page source may have changed since
  if (!g.result || g.picking) return renderGscStart();
  const r = g.result;
  const counts = s => r.issues.filter(x => x.severity === s).length;
  const num = n => n === null || n === undefined ? '—' : ga4Num_(n);
  $('#view').innerHTML = `
    <div class="report-head">
      <div>
        <h1>Search Console</h1>
        <p class="meta">${esc(joinParts_(STATE.inputs.client, r.property ? 'Property ' + r.property : r.host, r.permission))}</p>
        <p class="meta">${r.property ? 'Web search, ' + esc(r.start) + ' to ' + esc(r.end) : 'No readable property'} ·
          ${r.ga4Source ? 'GA4: ' + esc(r.ga4Source) : 'GA4 not compared'}</p>
        <div class="tally">
          <div><strong>${counts('High')}</strong>high priority</div>
          <div><strong>${counts('Medium')}</strong>medium</div>
          <div><strong>${counts('Low')}</strong>low</div>
          <div><strong>${num(r.summary.clicks)}</strong>search clicks</div>
          <div><strong>${num(r.summary.ga4Sessions)}</strong>GA4 organic sessions</div>
          <div><strong>${num(r.summary.impressions)}</strong>impressions</div>
        </div>
      </div>
      <div class="stamp ${esc(r.score.grade)}" role="img" aria-label="Search Console grade ${esc(r.score.grade)}, score ${r.score.score} out of 100">
        <div><b>${esc(r.score.grade)}</b><span>${r.score.score} / 100</span></div>
      </div>
    </div>
    <div class="actions">
      <button class="btn" data-act="gsc-pdf">Technical PDF report</button>
      <button class="btn secondary" data-act="gsc-csv" data-kind="actions">Download actions (CSV)</button>
      <button class="btn secondary" data-act="gsc-csv" data-kind="pages">Download pages (CSV)</button>
      <button class="btn secondary" data-act="save">Save audit</button>
      <button class="btn secondary" data-act="gsc-new">Run again</button>
    </div>
    <div class="toolbar"><div class="seg" role="group" aria-label="Search Console report section">${GSC_TABS.map(t =>
      `<button data-act="gsc-tab" data-tab="${t[0]}" aria-pressed="${g.tab === t[0]}">${t[1]}</button>`).join('')}</div></div>
    <div id="gsc-tab">${gscTabHtml(r, g.tab)}</div>`;
}

function gscPagesTable(r) {
  if (!r.pages.length) return '<div class="empty">No page data.</div>';
  return `${r.ga4Source ? '' : '<div class="notice">GA4 sessions are not shown: run the GA4 audit for this site and open this tab again.</div>'}
    <div class="table-wrap"><table>
    <thead><tr><th>Landing page</th><th>Search clicks</th><th>Impressions</th><th>GA4 organic sessions</th><th>Sessions per click</th></tr></thead>
    <tbody>${r.pages.map(p => `<tr><td class="wrap"><code>${esc(p.path)}</code></td><td>${ga4Num_(p.clicks)}</td><td>${ga4Num_(p.impressions)}</td>
      <td>${p.sessions === null ? '—' : ga4Num_(p.sessions)}</td>
      <td>${p.ratio === null ? '—' : `<span class="sev ${p.clicks >= 20 && p.sessions === 0 ? 'Medium' : 'OK'}">${p.ratio}%</span>`}</td></tr>`).join('')}</tbody>
    </table></div>`;
}

function gscSitemapsTable(r) {
  if (!r.sitemaps.length) return '<div class="empty">No sitemaps submitted, or they could not be read.</div>';
  const day = s => s ? new Date(s).toLocaleDateString() : '—';
  return `<div class="table-wrap"><table>
    <thead><tr><th>Sitemap</th><th>Errors</th><th>Warnings</th><th>Last read by Google</th><th>Submitted</th></tr></thead>
    <tbody>${r.sitemaps.map(m => `<tr><td class="wrap"><code>${esc(m.path)}</code>${m.isIndex ? '<span class="sub">Sitemap index</span>' : ''}${m.isPending ? '<span class="sub">Pending</span>' : ''}</td>
      <td>${m.errors ? `<span class="sev Medium">${m.errors}</span>` : 0}</td><td>${m.warnings ? `<span class="sev Low">${m.warnings}</span>` : 0}</td>
      <td>${day(m.lastDownloaded)}</td><td>${day(m.lastSubmitted)}</td></tr>`).join('')}</tbody></table></div>`;
}

function gscTabHtml(r, tab) {
  if (tab === 'pages') return `<p class="lede">Top landing pages from Google search (by clicks) and the organic Google sessions GA4 recorded on the same page, same 28 days.</p>${gscPagesTable(r)}`;
  if (tab === 'sitemaps') return `<p class="lede">Sitemaps submitted in Search Console.</p>${gscSitemapsTable(r)}`;
  if (tab === 'coverage') {
    return `${r.coverage.map(t => `<p>${esc(t)}</p>`).join('')}
      ${r.matches.length > 1 ? `<h3>Properties covering ${esc(r.host)}</h3><ul>${r.matches.map(m => `<li><code>${esc(m.siteUrl)}</code> · ${esc(m.kind)} · ${esc(m.permissionLevel)}</li>`).join('')}</ul>` : ''}`;
  }
  return `<h2>Areas</h2>${areasTable(r)}<h2>Prioritised actions</h2>${actionsTable(r)}`;
}

function renderGscStart() {
  const g = STATE.gsc, i = STATE.inputs;
  const signed = Google.isSignedIn(), connected = Google.hasScope(GSC_SCOPE);
  $('#view').innerHTML = `
    <h1>Search Console</h1>
    <p class="lede">Finds the Search Console property for a website, checks access and sitemaps, and compares Google search clicks with the organic Google sessions in GA4, per site and per landing page. Last 28 days.</p>
    <section class="form-block">
      <h2 style="margin-top:0">Search Console access</h2>
      <div class="row">${!signed ? googleStatusHtml() : connected ? '<span class="signed">Search Console connected (read only)</span>'
        : '<button class="btn secondary" data-act="gsc-connect">Connect Search Console</button>'}</div>
      <p class="hint">Read only: the app can view Search Console data and change nothing. Search Console has no link to GTM, so the property is found from the website.</p>
    </section>
    <section class="form-block">
      <h2 style="margin-top:0">Website</h2>
      <label for="gsc-site">Website</label>
      <input type="url" id="gsc-site" value="${esc(i.site)}" placeholder="https://www.example.co.uk">
      <p class="hint">${STATE.ga4.result ? 'Search clicks are compared with the GA4 audit in this session.' : 'Run the GA4 audit for this site first to compare search clicks with organic sessions.'}</p>
    </section>
    <div class="actions">
      <button class="btn big" id="gsc-run-btn" data-act="gsc-run" ${connected && !g.running ? '' : 'disabled'}>${g.running ? 'Reading Search Console…' : 'Run Search Console check'}</button>
      ${g.result ? '<button class="btn secondary" data-act="gsc-back">Back to the report</button>' : ''}
    </div>
    <div class="log" id="gsc-log" ${g.log.length ? '' : 'hidden'}>${g.log.map(l => '<div' + (l.err ? ' class="err"' : '') + '>' + esc(l.msg) + '</div>').join('')}</div>`;
  const el = $('#gsc-site');
  el.addEventListener('input', () => { STATE.inputs.site = el.value; saveDraft(); });
}

function gscFileSlug() {
  const base = STATE.inputs.client || (STATE.gsc.result && STATE.gsc.result.host) || 'search-console';
  return 'search-console-' + String(base).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + new Date().toISOString().slice(0, 10);
}

function exportGscCsv(kind) {
  const r = STATE.gsc.result;
  if (kind === 'pages') {
    download(gscFileSlug() + '-pages.csv', toCsv([['Landing page', 'Search clicks', 'Impressions', 'GA4 organic sessions', 'Sessions per click (%)']]
      .concat(r.pages.map(p => [p.path, p.clicks, p.impressions, p.sessions === null ? '' : p.sessions, p.ratio === null ? '' : p.ratio]))), 'text/csv');
  } else {
    download(gscFileSlug() + '-actions.csv', toCsv([['Severity', 'Area', 'Finding', 'Action', 'Items']]
      .concat(r.issues.map(x => [x.severity, x.area, x.finding, x.action, (x.items || []).join('; ')]))), 'text/csv');
  }
}

function exportGscPdf() {
  const r = STATE.gsc.result;
  $('#print-report').className = '';
  $('#print-report').innerHTML = `
    <div class="page"><h1>Search Console</h1><p class="meta">${esc(joinParts_(STATE.inputs.client, r.property || r.host, r.start && r.start + ' to ' + r.end))}</p>
      <h2>Areas</h2>${areasTable(r)}</div>
    <div class="page"><h2>Prioritised actions</h2>${actionsTable(r)}</div>
    <div class="page"><h2>Pages vs GA4</h2>${gscPagesTable(r)}</div>
    <div class="page"><h2>Sitemaps</h2>${gscSitemapsTable(r)}</div>
    <div class="page"><h2>Coverage</h2>${gscTabHtml(r, 'coverage')}</div>`;
  const title = document.title;
  document.title = 'Search Console - ' + gscFileSlug();
  window.print();
  document.title = title;
}

// ══════════════════════════════════════════════════════════════════
//  AUTOMATIC RUN (GTM → GA4 → CM360) AND OVERVIEW
// ══════════════════════════════════════════════════════════════════

const AUTO_STATUS = {
  pending: 'Waiting', running: 'Running', done: 'Done', skipped: 'Skipped', failed: 'Failed',
  waiting: 'Your turn', connect: 'Your turn'
};

function hasOverview() {
  return !!STATE.auto || (STATE.result ? 1 : 0) + (STATE.ga4.result ? 1 : 0) + (STATE.gsc.result ? 1 : 0) + (STATE.cm360.result ? 1 : 0) > 1;
}

function autoStep(key) { return STATE.auto ? STATE.auto.steps.find(s => s.key === key) : null; }

function setAutoStep(key, status, note) {
  const st = autoStep(key);
  if (!st) return;
  st.status = status;
  if (note !== undefined) st.note = note;
  updateNav();
  if (STATE.view === 'overview') renderOverview();
}

/** Live GA4 measurement IDs found by the GTM audit. */
function liveGa4IdsFromResult(r) {
  if (!r) return [];
  return Array.from(new Set(Object.keys(r.audit.ids).map(k => r.audit.ids[k])
    .filter(x => x.platform === 'GA4' && x.live && /^G-[A-Z0-9]+$/.test(x.id)).map(x => x.id)));
}

/**
 * One click: the GTM audit (which also finds the GA4 properties and runs the GA4 audit),
 * then the CM360 check when GTM has Floodlight tags. Ends on the Overview, or on the
 * Summary when only the GTM audit applied.
 */
async function runFullAudit() {
  if (STATE.running || (STATE.auto && STATE.auto.running)) return;
  const i = STATE.inputs;
  if (!hasAuditSources()) {
    toast('Add at least one source: a GTM ID, a container export, page source or live test results.', true);
    return;
  }
  const prev = STATE.auto;
  STATE.auto = { date: new Date().toISOString(), running: true, steps: [
    { key: 'gtm', label: 'GTM and consent audit', status: 'running', note: '' },
    { key: 'ga4', label: 'GA4 audit', status: 'pending', note: 'Finds the GA4 properties behind the measurement IDs in GTM' },
    { key: 'gsc', label: 'Search Console check', status: 'pending', note: 'Finds the Search Console property for the website' },
    { key: 'cm360', label: 'CM360 check', status: 'pending', note: 'Runs when GTM has Floodlight tags' }
  ] };
  // Results of an earlier run belong to another site or another point in time
  const oldGa4 = STATE.ga4.result, oldCm = { data: STATE.cm360.data, result: STATE.cm360.result },
        oldGsc = { data: STATE.gsc.data, result: STATE.gsc.result };
  STATE.ga4.result = null;
  Object.assign(STATE.cm360, { data: null, result: null, prep: null, files: {}, log: [], picking: false });
  Object.assign(STATE.gsc, { data: null, result: null, log: [], picking: false });
  STATE.log = [];
  setView('overview');   // the run sheet and log show progress
  const ok = await runAudit({ stay: true });
  if (!ok) {
    // The audit failed: put the earlier results back and show the log on New audit
    STATE.auto = prev;
    if (!STATE.ga4.result) STATE.ga4.result = oldGa4;
    if (!STATE.cm360.data) Object.assign(STATE.cm360, oldCm);
    if (!STATE.gsc.data) Object.assign(STATE.gsc, oldGsc);
    updateNav();
    setView('audit');
    return;
  }
  const r = STATE.result;
  setAutoStep('gtm', 'done', 'Grade ' + r.score.grade + ' (' + r.score.score + '/100), ' + r.issues.length + ' issue(s)');

  const mids = liveGa4IdsFromResult(r);
  const g4 = STATE.ga4.result;
  if (g4) setAutoStep('ga4', 'done', g4.properties.map(p => p.displayName + ': grade ' + p.score.grade).join(' · '));
  else if (!i.ga4Full || (i.rules.ga4Checks || 'Auto') === 'No') setAutoStep('ga4', 'skipped', 'Turned off on New audit');
  else if (!mids.length) setAutoStep('ga4', 'skipped', 'GTM has no live GA4 measurement ID');
  else if (!Google.isSignedIn()) setAutoStep('ga4', 'skipped', 'Sign in with Google to run it');
  else setAutoStep('ga4', 'skipped', 'None of your GA4 properties has ' + mids.join(', '));

  STATE.auto.running = false;
  await autoContinue();
  const ranMore = STATE.ga4.result || ['gsc', 'cm360'].some(k => ['waiting', 'connect', 'done', 'failed'].indexOf(autoStep(k).status) >= 0);
  if (STATE.view === 'overview') setView(ranMore ? 'overview' : 'summary');
}

/** Why the Search Console step cannot run yet (null when it can). */
function autoGscBlocker() {
  const host = gscHost_(STATE.inputs.site);
  if (!STATE.inputs.gscAuto) return { status: 'skipped', note: 'Turned off on New audit' };
  if (!host) return { status: 'skipped', note: 'Enter the website on New audit to find its Search Console property' };
  if (!Google.isSignedIn()) return { status: 'skipped', note: 'Sign in with Google to run it' };
  if (!Google.hasScope(GSC_SCOPE)) return { status: 'connect', scope: GSC_SCOPE, note: 'Connect Search Console (read only) to look for ' + host };
  return null;
}

/** Why the CM360 step cannot run yet (null when it can). */
function autoCm360Blocker() {
  const srcs = cm360SrcsFromGtm();
  if (!STATE.inputs.cm360Auto) return { status: 'skipped', note: 'Turned off on New audit' };
  if (!srcs.length) return { status: 'skipped', note: 'GTM has no live Floodlight tags' };
  const ids = srcs.map(s => 'DC-' + s.src).join(', ');
  if (!Google.isSignedIn()) return { status: 'skipped', note: 'GTM sends to ' + ids + '. Sign in with Google to run it' };
  if (!Google.hasScope(CM360_SCOPE)) return { status: 'connect', scope: CM360_SCOPE, note: 'GTM sends to ' + ids + '. Connect CM360 (reports only) to continue' };
  return null;
}

const AUTO_LATER_STEPS = [['gsc', autoGscBlocker, autoGscRun], ['cm360', autoCm360Blocker, autoCm360Run]];

/**
 * Runs the steps after GTM and GA4. Steps that need an extra permission are asked for together
 * (one Google round trip); the run continues by itself after the redirect.
 */
async function autoContinue() {
  if (!STATE.auto) return;
  const open = AUTO_LATER_STEPS.filter(s => autoStep(s[0]) && ['pending', 'connect'].indexOf(autoStep(s[0]).status) >= 0)
    .map(s => ({ key: s[0], run: s[2], block: s[1]() }));
  open.filter(s => s.block && s.block.status === 'skipped').forEach(s => setAutoStep(s.key, 'skipped', s.block.note));
  const connect = open.filter(s => s.block && s.block.status === 'connect');
  if (connect.length) {
    connect.forEach(s => setAutoStep(s.key, 'connect', s.block.note));
    open.filter(s => !s.block).forEach(s => setAutoStep(s.key, 'pending', 'Runs after the connection'));
    return;
  }
  for (const s of open.filter(x => !x.block)) await s.run();
}

/** Permissions the paused steps are waiting for. */
function autoScopesNeeded() {
  return AUTO_LATER_STEPS.map(s => autoStep(s[0]) && autoStep(s[0]).status === 'connect' && s[1]())
    .filter(b => b && b.scope).map(b => b.scope);
}

async function autoGscRun() {
  STATE.auto.running = true;
  try {
    setAutoStep('gsc', 'running', 'Looking for the Search Console property for ' + gscHost_(STATE.inputs.site) + '…');
    await runGscCheck({ stay: true });
    const r = STATE.gsc.result;
    if (!r) setAutoStep('gsc', 'failed', 'Search Console could not be read. See the log, then try again from Search Console');
    else if (!r.property) setAutoStep('gsc', 'done', 'No Search Console property you can access covers ' + r.host);
    else setAutoStep('gsc', 'done', r.property + ': grade ' + r.score.grade + ' (' + r.score.score + '/100), ' + r.issues.length + ' issue(s)');
  } finally {
    STATE.auto.running = false;
  }
}

/** The CM360 part of the automatic run. Pauses ('waiting') for the report downloads. */
async function autoCm360Run() {
  const c = STATE.cm360;
  const srcs = cm360SrcsFromGtm();
  const ids = srcs.map(s => 'DC-' + s.src).join(', ');
  STATE.auto.running = true;
  try {
    setAutoStep('cm360', 'running', 'Finding the CM360 account that owns ' + ids + '…');
    c.profiles = null;
    await loadCm360Accounts();
    if (!c.profiles) return setAutoStep('cm360', 'failed', 'Could not read your CM360 accounts');
    if (!c.profiles.length) return setAutoStep('cm360', 'skipped', 'This Google account has no CM360 user profile');
    const owned = srcs.filter(s => Object.keys(c.configs).some(k => c.configs[k].indexOf(s.src) >= 0));
    if (!owned.length) {
      return setAutoStep('cm360', 'skipped', 'None of your CM360 accounts owns ' + ids +
        ' (another agency, another advertiser or a test setup). Check who owns it');
    }
    const prof = c.profiles.find(p => String(p.profileId) === String(c.profileId)) || {};
    setAutoStep('cm360', 'running', 'Running two reports in ' + (prof.accountName || 'CM360') + ' for DC-' + c.configId + ' (can take a few minutes)…');
    await runCm360Reports();
    if (!c.prep) return setAutoStep('cm360', 'failed', 'The CM360 reports did not finish. See the log, then try again from CM360 check');
    setAutoStep('cm360', 'waiting', 'Download both reports and drop them below' +
      (owned.length < srcs.length ? '. Only DC-' + c.configId + ' is checked; ' + (srcs.length - owned.length) + ' other configuration(s) are not in your accounts' : ''));
  } finally {
    STATE.auto.running = false;
  }
}

function autoCm360Finished() {
  const st = autoStep('cm360');
  const r = STATE.cm360.result;
  if (st && r && (st.status === 'waiting' || st.status === 'running')) {
    setAutoStep('cm360', 'done', 'Grade ' + r.score.grade + ' (' + r.score.score + '/100), ' + r.issues.length + ' issue(s)');
    toast('CM360 check finished');
  }
}

function autoConnectLabel() {
  const names = autoScopesNeeded().map(sc => sc === GSC_SCOPE ? 'Search Console' : 'CM360');
  return 'Connect ' + (names.join(' and ') || 'Google');
}

/** All reports in this session, for the Overview and the combined PDF. */
function overviewReports() {
  const list = [];
  const counts = issues => ['High', 'Medium', 'Low'].map(s => issues.filter(x => x.severity === s).length);
  if (STATE.result) {
    list.push({ key: 'gtm', label: 'GTM and consent', sub: (STATE.result.meta.sources || []).join(', '),
      score: STATE.result.score, issues: STATE.result.issues, counts: counts(STATE.result.issues), view: 'summary' });
  }
  if (STATE.ga4.result) {
    STATE.ga4.result.properties.forEach((p, n) => list.push({ key: 'ga4-' + n, label: 'GA4: ' + p.displayName,
      sub: String(p.property).replace('properties/', 'Property ') + (p.account ? ' · ' + p.account : ''),
      score: p.score, issues: p.issues, counts: counts(p.issues), view: 'ga4', index: n }));
  }
  if (STATE.gsc.result) {
    const r = STATE.gsc.result;
    list.push({ key: 'gsc', label: 'Search Console', sub: r.property || 'No readable property for ' + r.host, score: r.score, issues: r.issues,
      counts: counts(r.issues), view: 'gsc' });
  }
  if (STATE.cm360.result) {
    const r = STATE.cm360.result;
    list.push({ key: 'cm360', label: 'CM360', sub: joinParts_(r.account, 'DC-' + r.configId), score: r.score, issues: r.issues,
      counts: counts(r.issues), view: 'cm360' });
  }
  return list;
}

function renderOverview() {
  const a = STATE.auto, reports = overviewReports(), i = STATE.inputs;
  const top = [].concat(...reports.map(rep => rep.issues.map(x => Object.assign({ report: rep.label }, x))))
    .filter(x => x.severity !== 'Low').sort((p, q) => SEVERITY_ORDER[p.severity] - SEVERITY_ORDER[q.severity]);
  const busy = a && a.steps.some(s => s.status === 'running' || s.status === 'pending');
  $('#view').innerHTML = `
    <h1>Overview</h1>
    <p class="lede">${esc(joinParts_(i.client, i.site) || 'All reports in this session')}${a ? ' · run started ' + esc(new Date(a.date).toLocaleString()) : ''}</p>
    ${a ? `<section class="form-block" aria-labelledby="run-h">
      <h2 id="run-h" style="margin-top:0">Run</h2>
      <ol class="runsheet">${a.steps.map(s => `<li class="st-${esc(s.status)}">
        <span class="st-mark" aria-hidden="true"></span>
        <div><strong>${esc(s.label)}</strong> <span class="st-label">${esc(AUTO_STATUS[s.status] || s.status)}</span>
          ${s.note ? `<p class="hint">${esc(s.note)}</p>` : ''}
          ${s.status === 'connect' && s === a.steps.find(x => x.status === 'connect') ? `<div class="actions"><button class="btn" data-act="auto-connect">${esc(autoConnectLabel())}</button></div>` : ''}
          ${s.key === 'cm360' && s.status === 'waiting' ? cm360ManualHtml() : ''}
        </div></li>`).join('')}</ol>
    </section>` : ''}
    <h2>Reports</h2>
    ${reports.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Report</th><th>Grade</th><th>High</th><th>Medium</th><th>Low</th><th><span class="vh">Open</span></th></tr></thead>
      <tbody>${reports.map(rep => `<tr>
        <td class="wrap"><strong>${esc(rep.label)}</strong><span class="sub">${esc(rep.sub)}</span></td>
        <td><span class="grade-chip g-${esc(rep.score.grade)}">${esc(rep.score.grade)}</span> ${rep.score.score}/100</td>
        <td>${rep.counts[0] ? '<span class="hl-mark">' + rep.counts[0] + '</span>' : 0}</td><td>${rep.counts[1]}</td><td>${rep.counts[2]}</td>
        <td><button class="link" data-act="overview-open" data-view="${rep.view}" data-index="${rep.index || 0}">Open<span class="vh"> ${esc(rep.label)}</span></button></td></tr>`).join('')}</tbody>
    </table></div>` : '<div class="empty">No reports yet.</div>'}
    <div class="actions">
      <button class="btn" data-act="pdf-combined" ${reports.length ? '' : 'disabled'}>Combined client PDF</button>
      <button class="btn secondary" data-act="save" ${reports.length ? '' : 'disabled'}>Save audit</button>
      <button class="btn secondary" data-act="goto" data-view="audit">New audit</button>
    </div>
    <h2>Top actions across the reports</h2>
    ${top.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Priority</th><th>Report</th><th>Finding</th><th>Action</th></tr></thead>
      <tbody>${top.slice(0, 15).map(x => `<tr><td><span class="sev ${esc(x.severity)}">${esc(x.severity)}</span></td><td>${esc(x.report)}</td>
        <td class="wrap">${x.severity === 'High' ? '<span class="hl-mark">' + esc(x.finding) + '</span>' : esc(x.finding)}</td><td class="wrap">${esc(x.action)}</td></tr>`).join('')}</tbody>
    </table></div>${top.length > 15 ? `<p class="hint">${top.length - 15} more in the individual reports.</p>` : ''}`
      : `<div class="empty">${busy ? 'Actions appear here as each report finishes.' : 'No high or medium priority actions.'}</div>`}
    <div class="log" id="run-log" ${STATE.log.length ? '' : 'hidden'}>${STATE.log.map(l => '<div' + (l.err ? ' class="err"' : '') + '>' + esc(l.msg) + '</div>').join('')}</div>`;
}

/** One client PDF: an overview page, then the client report of each review that ran. */
function exportCombinedPdf() {
  const i = STATE.inputs;
  const reports = [];
  if (STATE.result) {
    const m = clientReportModel(STATE.result);
    reports.push({ label: 'Tag manager & consent', model: Object.assign(m, { footerLabel: 'Tag manager & consent' }) });
  }
  if (STATE.ga4.result) {
    STATE.ga4.result.properties.forEach(p =>
      reports.push({ label: 'Analytics: ' + p.displayName, model: ga4ClientReportModel(STATE.ga4.result, p) }));
  }
  if (STATE.gsc.result && STATE.gsc.result.property) {
    reports.push({ label: 'Google Search Console', model: gscClientReportModel(STATE.gsc.result, { client: i.client, site: i.site }) });
  }
  if (STATE.cm360.result) {
    reports.push({ label: 'Campaign Manager 360', model: cm360ClientReportModel(STATE.cm360.result,
      { client: i.client, site: i.site, date: STATE.cm360.data && STATE.cm360.data.date }) });
  }
  if (!reports.length) throw new Error('Run an audit before exporting a report.');
  const notChecked = [];
  if (!STATE.result) notChecked.push(['Tag manager & consent', 'Not part of this review.']);
  if (!STATE.ga4.result) notChecked.push(['Analytics (GA4)', 'Not part of this review.']);
  if (!STATE.gsc.result || !STATE.gsc.result.property) notChecked.push(['Google Search Console', STATE.gsc.result ? 'No access to the site\'s Search Console property.' : 'Not part of this review.']);
  if (!STATE.cm360.result) notChecked.push(['Campaign Manager 360', 'Not part of this review.']);
  const meta = { client: i.client || hostOf_(i.site) || reports[0].model.client, site: i.site || reports[0].model.site,
                 date: new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) };
  const target = $('#print-report');
  target.className = 'client-report';
  target.innerHTML = combinedCoverHtml(reports, meta, notChecked) + reports.map(x => clientReportHtml(x.model)).join('');
  const title = document.title;
  document.title = 'Measurement review - ' + fileSlug();
  try { window.print(); }
  finally { document.title = title; }
}

// ══════════════════════════════════════════════════════════════════
//  EXPORTS
// ══════════════════════════════════════════════════════════════════

function exportPdf() {
  const model = clientReportModel(STATE.result);
  const target = $('#print-report');
  target.className = 'client-report';
  target.innerHTML = clientReportHtml(model);
  const title = document.title;
  document.title = 'Client report - ' + fileSlug();
  try { window.print(); }
  finally { document.title = title; }
}

function exportTechnicalPdf() {
  const r = STATE.result;
  const notOk = consentRows(r, 'All', '').filter(t => t.risk !== 'OK');
  $('#print-report').className = '';
  $('#print-report').innerHTML = `
    <div class="page">${reportHeader(r)}<h2>Areas</h2>${areasTable(r)}</div>
    <div class="page"><h2>Prioritised actions</h2>${actionsTable(r)}</div>
    ${STATE.ai.writeup ? `<div class="page doc">${auditMarkdown(STATE.ai.writeup)}</div>` : ''}
    <div class="page"><h2>Consent matrix (tags needing attention)</h2>${consentModeNotice(r)}${consentTable(notOk)}</div>
    ${r.live ? `<div class="page"><h2>Live consent test</h2>${liveSection(r.live)}</div>` : ''}
    <div class="page"><h2>ID inventory</h2><div class="table-wrap"><table>
      <thead><tr><th>Platform</th><th>ID</th><th>Type</th><th>Status</th><th>Used by</th><th>Notes</th></tr></thead>
      <tbody>${idRows(r).map(x => `<tr><td>${esc(x.rec.platform)}</td><td><code>${esc(x.rec.id)}</code></td><td>${esc(x.rec.kind)}</td>
        <td>${x.rec.live ? 'Live' : 'Paused only'}</td><td>${idTagReferences(x.rec)}</td>
        <td>${esc(x.note)}</td></tr>`).join('')}</tbody></table></div></div>
    ${STATE.ai.fixplan ? `<div class="page doc">${auditMarkdown(STATE.ai.fixplan)}</div>` : ''}`;
  $$('details', $('#print-report')).forEach(d => { d.open = true; });
  const title = document.title;
  document.title = 'Tag audit - ' + fileSlug();
  window.print();
  document.title = title;
}

function ga4FileSlug(pr) {
  const base = STATE.ga4.result.client || hostOf_(STATE.ga4.result.site) || pr.displayName || 'ga4';
  return 'ga4-' + String(base).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + new Date().toISOString().slice(0, 10);
}

function exportGa4Pdf() {
  const pr = ga4Current();
  const target = $('#print-report');
  target.className = 'client-report';
  target.innerHTML = clientReportHtml(ga4ClientReportModel(STATE.ga4.result, pr));
  const title = document.title;
  document.title = 'GA4 client report - ' + ga4FileSlug(pr);
  try { window.print(); }
  finally { document.title = title; }
}

function exportGa4TechnicalPdf() {
  const pr = ga4Current();
  $('#print-report').className = '';
  $('#print-report').innerHTML = `
    <div class="page">${ga4ReportHeader(pr)}<h2>Areas</h2>${areasTable(pr)}</div>
    <div class="page"><h2>Prioritised actions</h2>${actionsTable(pr)}</div>
    <div class="page"><h2>Events and GTM</h2>${ga4EventsTable(pr)}</div>
    <div class="page"><h2>Configuration</h2>${pr.config.map(ga4KvTable).join('')}</div>
    ${pr.quality.length ? `<div class="page"><h2>Data quality (last 28 days)</h2>${pr.quality.map(ga4DataTable).join('')}</div>` : ''}
    <div class="page"><h2>Coverage</h2>${ga4CoverageHtml(pr)}</div>`;
  const title = document.title;
  document.title = 'GA4 audit - ' + ga4FileSlug(pr);
  window.print();
  document.title = title;
}

function exportGa4Csv(kind) {
  const pr = ga4Current();
  if (kind === 'events') {
    download(ga4FileSlug(pr) + '-events.csv', toCsv([['Event', 'Sent from GTM', 'Events (28 days)', 'Users', 'Key event', 'Status']]
      .concat(pr.crossRef.map(x => [x.name, x.inGtm.join('; '), pr.hasData ? x.count : '', pr.hasData ? x.users : '', x.isKey ? 'Yes' : '', x.status]))), 'text/csv');
  } else {
    download(ga4FileSlug(pr) + '-actions.csv', toCsv([['Severity', 'Area', 'Finding', 'Action', 'Property', 'Items']]
      .concat(pr.issues.map(x => [x.severity, x.area, x.finding, x.action, x.where, (x.items || []).join('; ')]))), 'text/csv');
  }
}

function saveAudit() {
  const data = {
    app: 'tag-audit-studio', v: 1, savedAt: new Date().toISOString(), ga4: STATE.ga4.result || undefined,
    cm360: STATE.cm360.data ? { data: STATE.cm360.data, mapping: STATE.cm360.mapping } : undefined,
    gsc: STATE.gsc.data || undefined,
    inputs: STATE.inputs, result: STATE.result, ai: { writeup: STATE.ai.writeup, fixplan: STATE.ai.fixplan, chat: STATE.ai.chat },
    overrides: STATE.overrides
  };
  const slug = STATE.result || !STATE.ga4.result ? fileSlug() : ga4FileSlug(ga4Current());
  download('tag-audit-' + slug + '.json', JSON.stringify(data), 'application/json');
}

function openAudit(text) {
  const d = JSON.parse(text);
  if (d.app !== 'tag-audit-studio' || !(d.result || d.ga4 || d.cm360 || d.gsc)) throw new Error('That file is not a saved Tag Audit Studio audit.');
  STATE.inputs = Object.assign(STATE.inputs, d.inputs || {});
  STATE.result = d.result || null;
  STATE.ai = Object.assign({ writeup: '', fixplan: '', chat: [], busy: '' }, d.ai || {}, { busy: '' });
  STATE.overrides = d.overrides || {};
  STATE.ga4.result = d.ga4 && Array.isArray(d.ga4.properties) ? d.ga4 : null;
  STATE.cm360.data = d.cm360 && d.cm360.data || null;
  STATE.cm360.mapping = d.cm360 && d.cm360.mapping || {};
  STATE.cm360.result = null; STATE.cm360.picking = false; STATE.cm360.tab = 'overview';
  if (STATE.cm360.data) computeCm360Result();
  STATE.gsc.data = d.gsc || null;
  STATE.gsc.result = null; STATE.gsc.picking = false; STATE.gsc.tab = 'overview';
  if (STATE.gsc.data) computeGscResult();
  STATE.ga4.index = 0; STATE.ga4.tab = 'overview'; STATE.ga4.picking = false;
  updateNav();
  setView(hasOverview() ? 'overview' : STATE.result ? 'summary' : STATE.ga4.result ? 'ga4' : STATE.gsc.result ? 'gsc' : 'cm360');
  toast('Audit opened');
}

// ══════════════════════════════════════════════════════════════════
//  EVENTS
// ══════════════════════════════════════════════════════════════════

document.addEventListener('click', async e => {
  const nav = e.target.closest('#nav .nav-item');
  if (nav && !nav.disabled) { setView(nav.dataset.view); return; }
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  const r = STATE.result;
  try {
    switch (act) {
      case 'tag-details': toggleTagDetail(el); break;
      case 'entity-details': toggleEntityDetail(el); break;
      case 'container-section':
        if (['tags', 'triggers', 'variables'].includes(el.dataset.section)) {
          STATE.tagSection = el.dataset.section;
          renderTags();
        }
        break;
      case 'goto': setView(el.dataset.view); break;
      case 'signin':
      case 'signin-redirect':
      case 'renew': {
        if (!stashForSignIn()) break;
        if (act === 'renew') Google.signInRedirect(googleClientId(), STATE.view, [], { silent: true });
        else Google.renewOrSignIn(googleClientId(), STATE.view);
        break;
      }
      case 'ads-renew':
        if (!stashForSignIn()) break;
        GoogleAds.signInRedirect(googleClientId(), STATE.view, [ADS_SCOPE], { silent: true });
        break;
      case 'cm360-connect':
        if (!stashForSignIn()) break;
        Google.signInRedirect(googleClientId(), STATE.view, [CM360_SCOPE]);
        break;
      case 'cm360-run': await runCm360Reports(); break;
      case 'cm360-exact-connect':
        if (!stashForSignIn()) break;
        Google.signInRedirect(googleClientId(), STATE.view, [CM360_TRAFFIC_SCOPE]);
        break;
      case 'cm360-setup': {
        const c = STATE.cm360;
        if (!c.data) break;
        el.disabled = true; el.textContent = 'Reading the Floodlight setup…';
        try {
          const pid = c.data.profileId || c.profileId;
          if (!pid) throw new Error('Run the CM360 check again to read the Floodlight setup.');
          c.data.setup = await cm360FloodlightSetup(pid, c.data.configId);
          computeCm360Result();
          toast('Matched exactly: ' + c.data.setup.length + ' Floodlight activities read');
        } finally { renderCm360(); }
        break;
      }
      case 'ads-connect':
        saveAppSettings({ adsDevToken: $('#ads-token').value.trim(), adsLoginId: $('#ads-login').value.trim() });
        if (!stashForSignIn()) break;
        GoogleAds.renewOrSignIn(googleClientId(), STATE.view, [ADS_SCOPE]);
        break;
      case 'ads-signout': GoogleAds.signOut(); toast('Signed out of Google Ads'); VIEWS[STATE.view](); updateGoogleStatus(); break;
      case 'ads-test':
        saveAppSettings({ adsDevToken: $('#ads-token').value.trim(), adsLoginId: $('#ads-login').value.trim() });
        el.disabled = true;
        try { await adsTest($('#ads-aw').value); } finally { el.disabled = false; }
        break;
      case 'gsc-connect':
        if (!stashForSignIn()) break;
        Google.signInRedirect(googleClientId(), STATE.view, [GSC_SCOPE]);
        break;
      case 'auto-connect':
        if (!stashForSignIn()) break;
        Google.signInRedirect(googleClientId(), STATE.view, autoScopesNeeded());
        break;
      case 'gsc-run': await runGscCheck(); break;
      case 'gsc-new': STATE.gsc.picking = true; renderGsc(); break;
      case 'gsc-back': STATE.gsc.picking = false; renderGsc(); break;
      case 'gsc-tab': STATE.gsc.tab = el.dataset.tab; renderGsc(); break;
      case 'gsc-csv': exportGscCsv(el.dataset.kind); break;
      case 'gsc-pdf': exportGscPdf(); break;

      case 'pdf-combined': exportCombinedPdf(); break;
      case 'overview-open':
        if (el.dataset.view === 'ga4') { STATE.ga4.index = Number(el.dataset.index) || 0; STATE.ga4.picking = false; }
        if (el.dataset.view === 'cm360') STATE.cm360.picking = false;
        if (el.dataset.view === 'gsc') STATE.gsc.picking = false;
        setView(el.dataset.view); break;
      case 'cm360-finish': await finishCm360(); break;
      case 'cm360-new': STATE.cm360.picking = true; renderCm360(); break;
      case 'cm360-back': STATE.cm360.picking = false; renderCm360(); break;
      case 'cm360-tab': STATE.cm360.tab = el.dataset.tab; renderCm360(); break;
      case 'cm360-csv': exportCm360Csv(el.dataset.kind); break;
      case 'cm360-pdf': exportCm360Pdf(); break;
      case 'ga4-run': await runGa4Audit(); break;
      case 'ga4-rerun':
        if (!STATE.ga4.result) break;
        STATE.ga4.selected = STATE.ga4.result.properties.map(p => p.property);
        STATE.ga4.result.properties.forEach(p => { STATE.ga4.known[p.property] = { property: p.property, displayName: p.displayName, account: p.account }; });
        await runGa4Audit({ refresh: true });
        break;
      case 'ga4-new': STATE.ga4.picking = true; renderGa4(); break;
      case 'ga4-back': STATE.ga4.picking = false; renderGa4(); break;
      case 'ga4-tab': STATE.ga4.tab = el.dataset.tab; renderGa4(); break;
      case 'ga4-prop': STATE.ga4.index = Number(el.dataset.index) || 0; renderGa4(); break;
      case 'ga4-pdf': exportGa4Pdf(); break;
      case 'ga4-pdf-technical': exportGa4TechnicalPdf(); break;
      case 'ga4-csv-actions': exportGa4Csv('actions'); break;
      case 'ga4-csv-events': exportGa4Csv('events'); break;
      case 'ga4-from-gtm': {
        el.disabled = true; el.textContent = 'Looking up…';
        const found = await ga4PropertiesForIds(ga4IdsFromGtm().filter(x => !x.prop).map(x => x.mid), ga4Log);
        found.forEach(p => {
          STATE.ga4.known[p.property] = p;
          if (STATE.ga4.selected.indexOf(p.property) < 0) STATE.ga4.selected.push(p.property);
        });
        renderGa4();
        break;
      }
      case 'signout': Google.signOut(); toast('Signed out of Google'); VIEWS[STATE.view](); updateGoogleStatus(); break;
      case 'load-workspaces': {
        const ids = parseIds(STATE.inputs.apiIds);
        if (!ids.length) throw new Error('Enter a GTM container ID first.');
        el.disabled = true; el.textContent = 'Loading…';
        try {
          const list = await listGtmWorkspaces(ids[0], m => toast(m));
          STATE.workspaceOptions = list.map(w => w.name);
          toast(list.length + ' workspace(s) found in ' + ids[0]);
        } finally { el.disabled = false; el.textContent = 'Load workspaces'; }
        renderAudit(); break;
      }
      case 'rm-export': STATE.inputs.exports.splice(Number(el.dataset.n), 1); renderAudit(); break;
      case 'copy-page-snippet': copyText(PAGE_SOURCE_SNIPPET, 'Page source snippet'); break;
      case 'copy-live-snippet': copyText('(' + liveTestSnippet_.toString() + ')()', 'Live test snippet'); break;
      case 'add-live': {
        const added = addLiveResults($('#in-live').value, $('#in-live-stage').value);
        toast('Added: ' + added.map(s => LIVE_STAGES[s]).join(', '));
        renderAudit(); break;
      }
      case 'clear-live': STATE.inputs.live = null; renderAudit(); break;
      case 'live-add': {
        const added = addLiveResults($('#live-add').value, $('#live-add-stage').value);
        toast('Added: ' + added.map(s => LIVE_STAGES[s]).join(', ') + '. Re-running…');
        await runAudit({ stay: true }); break;
      }
      case 'rerun': await runAudit({ refresh: true }); break;
      case 'pdf': exportPdf(); break;
      case 'pdf-technical': exportTechnicalPdf(); break;
      case 'pptx': await exportClientPowerPoint(el); break;
      case 'save': saveAudit(); break;
      case 'csv-actions':
        download('actions-' + fileSlug() + '.csv', toCsv([['#', 'Severity', 'Area', 'Finding', 'Action', 'Where', 'Items']]
          .concat(r.issues.map((x, n) => [n + 1, x.severity, x.area, x.finding, x.action, x.where, (x.items || []).join('; ')]))), 'text/csv'); break;
      case 'csv-consent':
        download('consent-' + fileSlug() + '.csv', toCsv([['Risk', 'Tag', 'Location', 'Platform', 'Vendor', 'Purpose', 'Fires on', 'Blocked by', 'Consent handling', 'Recommendation', 'AI note']]
          .concat(consentRows(r, 'All', '').map(t => [t.risk === '—' ? 'Paused' : t.risk, t.label, t.where, t.platform, t.vendor || '', t.purpose,
            (t.firesOn || []).join(' OR '), (t.blockedBy || []).join(' OR '), t.handling, t.recommendation, t.ai && t.ai.what || '']))), 'text/csv'); break;
      case 'csv-ids':
        download('ids-' + fileSlug() + '.csv', toCsv([['Platform', 'ID', 'Type', 'Status', 'Used by', 'Found in', 'Notes']]
          .concat(idRows(r).map(x => [x.rec.platform, x.rec.id, x.rec.kind, x.rec.live ? 'Live' : 'Paused only', x.rec.tags.join('; '),
            x.rec.where.join('; '), x.note]))), 'text/csv'); break;
      case 'csv-findings':
        download('findings-' + fileSlug() + '.csv', toCsv([['Group', 'Type', 'Item', 'Location', 'Details', 'Notes']]
          .concat([].concat.apply([], r.groups.map(g => g.rows.map(row => [g.plain || g.name].concat(row)))))), 'text/csv'); break;
      case 'expand': $$('details.group').forEach(d => { d.open = true; }); break;
      case 'collapse': $$('details.group').forEach(d => { d.open = false; }); break;
      case 'ai-writeup': aiTask('writeup'); break;
      case 'ai-fixplan': aiTask('fixplan'); break;
      case 'ai-explain': aiExplain(); break;
      case 'copy-doc': copyText(STATE.ai[el.dataset.key], 'Text'); break;
      case 'dl-doc': download(el.dataset.key + '-' + fileSlug() + '.md', STATE.ai[el.dataset.key], 'text/markdown'); break;
      case 'save-ai':
        saveAppSettings({ aiProvider: $('#set-provider').value, aiModel: $('#set-model').value.trim(),
                          aiKey: $('#set-key').value.trim(), aiBase: ($('#set-base') || {}).value ? $('#set-base').value.trim() : '' });
        toast('AI settings saved'); break;
      case 'test-ai': {
        saveAppSettings({ aiProvider: $('#set-provider').value, aiModel: $('#set-model').value.trim(),
                          aiKey: $('#set-key').value.trim(), aiBase: $('#set-base') ? $('#set-base').value.trim() : '' });
        el.disabled = true; el.textContent = 'Testing…';
        try { const reply = await AI.chat([{ role: 'user', content: 'Reply with exactly: OK' }], { maxTokens: 20 }); toast('Connected — the model replied "' + truncate_(reply.trim(), 40) + '"'); }
        finally { el.disabled = false; el.textContent = 'Test connection'; }
        break;
      }
      case 'save-google': {
        const override = $('#set-client').value.trim();
        saveAppSettings({ googleClientId: override });
        if (Google.isSignedIn()) Google.signOut();   // the old token belongs to the previous client
        toast(override ? 'OAuth client override saved. Sign in again.' : 'Using the built-in OAuth client');
        renderSettings(); updateGoogleStatus(); break;
      }
      case 'clear-data':
        ['tas.settings', 'tas.draft', 'tas.gtmPaths', 'tas.ga4Streams', 'tas.ga4Misses', 'tas.googleHint', 'tas.googleHint.ads'].forEach(k => { try { localStorage.removeItem(k); } catch (x) { /* ignore */ } });
        try { sessionStorage.removeItem('tas.ga4Props'); } catch (x) { /* ignore */ }
        STATE.caches = { containers: {}, api: {}, ga4: {}, gtag: {}, ga4full: {} };
        toast('Saved settings and caches cleared'); renderSettings(); break;
    }
  } catch (err) {
    console.error(err);
    toast(err.message, true);
  }
});

$('#open-audit').addEventListener('click', () => $('#open-audit-file').click());
// CM360: downloaded report files, and analyst confirmations in the Floodlight mapping
document.addEventListener('change', async e => {
  if (e.target.id === 'cm360-files') {
    await addCm360Files(Array.from(e.target.files || []));
    e.target.value = '';
  } else if (e.target.matches('[data-cm360-map]')) {
    const key = e.target.dataset.cm360Map;
    if (e.target.value) STATE.cm360.mapping[key] = e.target.value; else delete STATE.cm360.mapping[key];
    computeCm360Result();
    renderCm360();
  }
});

// Drop zone for the CM360 report files
document.addEventListener('dragover', e => {
  const z = e.target.closest && e.target.closest('[data-dropzone]');
  if (!z) return;
  e.preventDefault();
  z.classList.add('over');
});
document.addEventListener('dragleave', e => {
  const z = e.target.closest && e.target.closest('[data-dropzone]');
  if (z && !z.contains(e.relatedTarget)) z.classList.remove('over');
});
document.addEventListener('drop', async e => {
  const z = e.target.closest && e.target.closest('[data-dropzone]');
  if (!z) return;
  e.preventDefault();
  z.classList.remove('over');
  const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
  if (files.length) await addCm360Files(files);
});

document.addEventListener('change', e => {
  if (!e.target.matches('[data-ga4-prop]')) return;
  const g = STATE.ga4, name = e.target.dataset.ga4Prop;
  g.selected = g.selected.filter(x => x !== name);
  if (e.target.checked) g.selected.push(name);
  const count = $('#ga4-count');
  if (count) count.textContent = g.selected.length + ' selected';
});
document.addEventListener('change', async e => {
  if (!e.target.matches('[data-runner-file]')) return;
  const f = e.target.files[0];
  if (!f) return;
  try {
    if (STATE.running) throw new Error('Wait for the current audit to finish before importing runner results.');
    if (f.size > 10 * 1024 * 1024) throw new Error('Runner results must be 10 MB or smaller.');
    const text = await f.text();
    if (!parseRunnerResults_(text)) throw new Error('Choose a local runner .runner.json results file.');
    const added = addLiveResults(text);
    toast('Imported local runner results: ' + added.map(s => LIVE_STAGES[s]).join(', '));
    if (STATE.view === 'audit') renderAudit();
    else await runAudit({ stay: true });
  } catch (err) { toast(err.message, true); }
  e.target.value = '';
});
$('#open-audit-file').addEventListener('change', async e => {
  const f = e.target.files[0];
  if (!f) return;
  try { openAudit(await f.text()); } catch (err) { toast(err.message, true); }
  e.target.value = '';
});

// ── Start ───────────────────────────────────────────────────────────
applyTheme();
Google.restore();
GoogleAds.restore();
const oauthReturn = Google.consumeRedirect();
if (oauthReturn) restoreSignInStash();
updateNav();
window.addEventListener('google-session-changed', () => {
  updateGoogleStatus();
  if (['audit', 'ga4', 'gsc', 'settings', 'overview'].indexOf(STATE.view) >= 0 && !STATE.running && !STATE.ga4.running && !STATE.gsc.running) VIEWS[STATE.view]();
});
setView(oauthReturn ? oauthReturn.view : (location.hash || '#audit').slice(1));
if (oauthReturn && oauthReturn.retry) {
  // Google needs the user (signed out of Chrome, or a new permission): continue with the normal sign-in
  const session = oauthReturn.retry === 'ads' ? GoogleAds : Google;
  if (stashForSignIn()) session.signInRedirect(googleClientId(), oauthReturn.view, session === GoogleAds ? [ADS_SCOPE] : []);
}
// Warn before a sign-in ends, and say once when it has ended (renewing stays the user's choice)
const signinWarned = { main: false, ads: false };
setInterval(() => {
  updateGoogleStatus();
  [[Google, 'main', 'Google'], [GoogleAds, 'ads', 'Google Ads']].forEach(([s, k, label]) => {
    if (s.hasExpired() && !signinWarned[k]) {
      signinWarned[k] = true;
      toast('Your ' + label + ' sign-in has ended. Renew it in the left bar (no new approval needed).', true);
      if (['settings', 'audit', 'ga4', 'gsc', 'cm360'].indexOf(STATE.view) >= 0 && !STATE.running && !(STATE.auto && STATE.auto.running)) VIEWS[STATE.view]();
    }
    if (s.isSignedIn()) signinWarned[k] = false;
  });
}, 30000);
if (oauthReturn && !oauthReturn.retry) toast(oauthReturn.error || (oauthReturn.session === 'ads' ? 'Signed in for Google Ads' : 'Signed in to Google'), !!oauthReturn.error);
// Back from "Connect CM360" during an automatic run: carry on with the CM360 step
if (oauthReturn && !oauthReturn.error && STATE.auto && STATE.auto.steps.some(s => s.status === 'connect')) {
  autoContinue().then(() => { if (STATE.view === 'overview') renderOverview(); });
}
[Google, GoogleAds].forEach(s => {
  if (s.isSignedIn() && !s.user) s.loadUser().then(() => window.dispatchEvent(new Event('google-session-changed')));
});
