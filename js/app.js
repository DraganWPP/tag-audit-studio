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
      client: i.client, site: i.site, publicIds: i.publicIds, apiIds: i.apiIds, apiTarget: i.apiTarget, ga4: i.ga4, rules: i.rules
    }));
  } catch (e) { /* ignore */ }
}
function loadDraft() {
  try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch (e) { return null; }
}

// ── State ───────────────────────────────────────────────────────────

const STATE = {
  view: 'audit',
  inputs: Object.assign({ client: '', site: '', publicIds: '', apiIds: '', apiTarget: 'live', ga4: true, rules: {},
                          exports: [], pageSource: '', live: null }, loadDraft() || {}),
  result: null,
  ai: { writeup: '', fixplan: '', chat: [], busy: '' },
  overrides: {},
  confirmations: {},
  caches: { containers: {}, api: {}, ga4: {} },
  running: false,
  consentFilter: 'All',
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
  live: renderLive, findings: renderFindings, ai: renderAI, settings: renderSettings
};

function setView(view) {
  if (!VIEWS[view]) view = 'audit';
  if (!STATE.result && ['summary', 'consent', 'tags', 'ids', 'live', 'findings', 'ai'].indexOf(view) >= 0) view = 'audit';
  STATE.view = view;
  $$('#nav .nav-item').forEach(b => {
    if (b.dataset.view === view) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  VIEWS[view]();
  try { history.replaceState(null, '', '#' + view); } catch (e) { /* ignore */ }
  $('#main').focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

function updateNav() {
  const r = STATE.result;
  $$('#nav-results .nav-item').forEach(b => { b.disabled = !r; });
  if (!r) return;
  const high = r.issues.filter(i => i.severity === 'High').length;
  const consentHigh = r.audit.tags.filter(t => !t.paused && t.risk === 'High').length;
  const setCount = (view, n, alert) => {
    const b = $('#nav [data-view="' + view + '"]');
    const label = b.textContent.replace(/\d+$/, '').trim();
    b.innerHTML = esc(label) + (n ? ' <span class="count' + (alert ? ' alert' : '') + '">' + n + '</span>' : '');
  };
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

async function runAudit(opts) {
  opts = opts || {};
  if (STATE.running) return;
  const i = STATE.inputs;
  const pageIds = i.pageSource ? parseIds(i.pageSource) : [];
  const apiIds = parseIds(i.apiIds);
  const hasLive = i.live && Object.keys(i.live.stages || {}).length;
  if (!parseIds(i.publicIds).length && !pageIds.length && !apiIds.length && !i.exports.length && !hasLive) {
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

    // GA4 property checks need the IDs found above
    if (i.ga4 && (i.rules.ga4Checks || 'Auto') !== 'No') {
      const mids = Object.keys(AUDIT.ids).map(k => AUDIT.ids[k]).filter(r => r.platform === 'GA4' && r.live).map(r => r.id);
      if (mids.length && Google.isSignedIn()) {
        AUDIT.ga4Data = {};
        for (const mid of Array.from(new Set(mids))) {
          try {
            if (!STATE.caches.ga4[mid] || opts.refresh) STATE.caches.ga4[mid] = await fetchGa4PropertyData(mid, log);
            AUDIT.ga4Data[mid] = STATE.caches.ga4[mid];
          } catch (e) {
            AUDIT.ga4Data[mid] = { error: e.message };
            log(mid + ': ' + e.message, true);
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
    saveDraft();
    updateNav();
    if (!opts.stay) setView('summary'); else VIEWS[STATE.view]();
  } catch (e) {
    console.error(e);
    log('Audit failed: ' + e.message, true);
    toast('Audit failed: ' + e.message, true);
  } finally {
    STATE.running = false;
    const b = $('#run-btn');
    if (b) { b.disabled = false; b.textContent = 'Run audit'; }
  }
}

function buildResult(rows, sources) {
  const groups = groupFindings_(rows).map(g => ({
    name: g.name, plain: g.plain || null, logo: g.logo || '', header: g.header,
    isTag: !!(g.rows[0] && g.rows[0].group), rows: g.rows.map(r => r.slice(0, 5))
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
      tags: tags, ids: AUDIT.ids, consentMode: AUDIT.consentMode, fullDetail: AUDIT.fullDetail,
      pageScanned: AUDIT.pageScanned, ga4PropertyChecked: AUDIT.ga4PropertyChecked, liveTest: AUDIT.liveTest,
      issues: issues
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
            ${Google.isSignedIn()
              ? '<span class="signed">Signed in to Google</span> <button class="link" data-act="signout">Sign out</button>'
              : '<button class="btn secondary" data-act="signin">Sign in with Google</button>' +
                (s.googleClientId ? '' : ' <span class="hint">Add a Google OAuth client ID in <button class="link" data-act="goto" data-view="settings">Settings</button> first.</span>')}
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
        </div>
      </div>
    </section>

    <section class="form-block">
      <details class="rules">
        <summary>Client rules (consent categories, naming, approved vendors and IDs)</summary>
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
  bind('in-api', 'apiIds'); bind('in-ga4', 'ga4', 'checked'); bind('in-page', 'pageSource'); bind('in-target', 'apiTarget');
  $$('[data-rule]').forEach(el => el.addEventListener('input', () => { STATE.inputs.rules[el.dataset.rule] = el.value; saveDraft(); }));

  $('#in-export').addEventListener('change', async e => {
    for (const f of Array.from(e.target.files)) {
      const text = await f.text();
      STATE.inputs.exports.push({ name: f.name, text: text });
    }
    renderAudit();
  });
  $('#run-btn').addEventListener('click', () => runAudit());
}

// ══════════════════════════════════════════════════════════════════
//  VIEW: SUMMARY
// ══════════════════════════════════════════════════════════════════

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
        <td class="wrap">${a.findings.length ? a.findings.map(f => esc(f)).join('<br>') : '<span class="sub">—</span>'}</td>
        <td class="wrap">${esc(a.action)}</td></tr>`;
    }).join('')}</tbody></table></div>`;
}

function actionsTable(r) {
  if (!r.issues.length) return '<div class="empty"><h3>No issues found</h3>Nothing in the checked areas needs action.</div>';
  return `<div class="table-wrap"><table>
    <thead><tr><th>#</th><th>Severity</th><th>Area</th><th>Finding</th><th>Action</th><th>Where</th></tr></thead>
    <tbody>${r.issues.map((x, n) => `<tr>
      <td>${n + 1}</td><td><span class="sev ${esc(x.severity)}">${esc(x.severity)}</span></td><td>${esc(x.area)}</td>
      <td class="wrap">${x.severity === 'High' ? '<span class="hl-mark">' + esc(x.finding) + '</span>' : esc(x.finding)}</td>
      <td class="wrap">${esc(x.action)}</td>
      <td class="wrap">${esc(x.where)}${x.items && x.items.length ? '<span class="sub">' + esc(truncate_(x.items.join(', '), 260)) + '</span>' : ''}</td></tr>`).join('')}
    </tbody></table></div>`;
}

function renderSummary() {
  const r = STATE.result;
  $('#view').innerHTML = reportHeader(r) + `
    <div class="actions">
      <button class="btn" data-act="pdf">Export PDF report</button>
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
      <td class="wrap"><strong>${esc(t.label)}</strong><span class="sub">${esc(t.where)}</span></td>
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
  const rows = g.rows.filter(row => !query || row.join(' ').toLowerCase().indexOf(query) >= 0);
  if (!rows.length) return '';
  const name = g.logo && g.plain ? g.plain : g.name;
  return `<details class="group" ${open ? 'open' : ''} style="--g:${esc(g.header)}">
    <summary>${g.logo ? `<img src="${esc(g.logo)}" alt="" loading="lazy" onerror="this.remove()">` : ''}<span class="gname">${esc(name)}</span><span class="gcount">${rows.length} ${rows.length === 1 ? 'item' : 'items'}</span></summary>
    <div class="table-wrap" style="border:0;border-radius:0"><table>
      <thead><tr><th>Type</th><th>Item</th><th>Location</th><th>Details</th><th>Notes</th></tr></thead>
      <tbody>${rows.map(row => `<tr><td>${esc(g.isTag ? String(row[0]).replace(/^🏷️\s*/, '') : row[0])}</td><td class="wrap"><strong>${esc(row[1])}</strong></td><td>${esc(row[2])}</td>
        <td class="wrap">${esc(row[3])}</td><td class="wrap">${esc(row[4])}</td></tr>`).join('')}</tbody>
    </table></div></details>`;
}

function renderGroupsView(title, lede, groups, idPrefix) {
  $('#view').innerHTML = `
    <h1>${esc(title)}</h1><p class="lede">${esc(lede)}</p>
    <div class="toolbar">
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
  const groups = STATE.result.groups.filter(g => g.isTag);
  renderGroupsView('Tags by platform', 'Every GTM tag, grouped by the platform it sends data to. Tags the AI identified appear in their own groups.', groups, 'tags');
  if (!groups.length) {
    $('#tags-list').innerHTML = '<div class="empty"><h3>No tags in what was scanned</h3>If you read a container through the API, its live version may be empty or unpublished. ' +
      'On <button class="link" data-act="goto" data-view="audit">New audit</button>, click Load workspaces, choose a workspace under "Version to audit" and run the audit again.</div>';
  }
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
  const approved = String(r.meta.settings.approvedIds || '').split(/[,;\n]/).map(x => x.trim().toUpperCase()).filter(Boolean);
  return ids.map(x => ({
    rec: x, key: x.platform + '|' + x.id,
    approved: approved.length ? (approved.indexOf(x.id.toUpperCase()) >= 0 ? 'Yes' : 'No') : '—',
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
      <thead><tr><th>Platform</th><th>ID</th><th>Type</th><th>Status</th><th>Used by</th><th>Approved</th><th>Client confirms</th><th>Notes</th></tr></thead>
      <tbody>${rows.map(x => `<tr>
        <td>${esc(x.rec.platform)}</td><td><code>${esc(x.rec.id)}</code></td><td>${esc(x.rec.kind)}</td>
        <td>${x.rec.live ? 'Live' : '<span class="sub">Paused only</span>'}</td>
        <td class="wrap">${esc(truncate_(x.rec.tags.join(', '), 200))}<span class="sub">${esc(truncate_(x.rec.where.join(', '), 160))}</span></td>
        <td>${x.approved === 'No' ? '<span class="sev Medium">No</span>' : esc(x.approved)}</td>
        <td><input type="checkbox" data-confirm="${esc(x.key)}" ${STATE.confirmations[x.key] ? 'checked' : ''} aria-label="Client confirms ${esc(x.rec.id)}"></td>
        <td class="wrap">${x.note ? '<span class="hl-mark">' + esc(x.note) + '</span>' : ''}</td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">No account or pixel IDs were found.</div>'}`;
  $$('[data-confirm]').forEach(cb => cb.addEventListener('change', () => { STATE.confirmations[cb.dataset.confirm] = cb.checked; }));
}

// ══════════════════════════════════════════════════════════════════
//  VIEW: LIVE CONSENT TEST
// ══════════════════════════════════════════════════════════════════

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
    <div class="table-wrap"><table>
      <thead><tr><th>Vendor</th><th>Purpose</th>${Object.keys(LIVE_STAGES).map(k => `<th>${esc(LIVE_STAGES[k])}</th>`).join('')}<th>Verdict</th><th>Recommendation</th></tr></thead>
      <tbody>${live.verdicts.map(v => `<tr>
        <td><strong>${esc(v.vendor)}</strong></td><td>${esc(v.purpose)}</td>
        ${Object.keys(LIVE_STAGES).map(k => `<td class="wrap">${/⚠️/.test(v.cells[k]) && v.verdict === 'High' ? '<span class="hl-mark">' + esc(v.cells[k]) + '</span>' : esc(v.cells[k])}</td>`).join('')}
        <td><span class="sev ${esc(v.verdict)}">${esc(v.verdict)}</span></td><td class="wrap">${esc(v.recommendation)}</td></tr>`).join('')}
      </tbody></table></div>
    <h3>Unrecognised third parties</h3>
    <div class="table-wrap"><table><tbody>${Object.keys(LIVE_STAGES).map(k => `<tr><td style="width:200px">${esc(LIVE_STAGES[k])}</td>
      <td class="wrap">${esc(st[k] ? (st[k].other.join(', ') || 'None') : 'Not tested')}</td></tr>`).join('')}</tbody></table></div>
    <p class="hint">gcs = G1[ad_storage][analytics_storage]: 1 granted, 0 denied. Only cookie names are read, never values. One browser session from one location; server-side tracking is not visible.</p>`;
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
    </div>`;
}

function addLiveResults(text, stage) {
  const results = parseLiveResults_(text);
  if (!results.length) throw new Error('No snippet results found. Paste the text the snippet copied to your clipboard.');
  const merged = mergeLiveResults_(STATE.inputs.live, results, stage);
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
      ${renderMarkdown(STATE.ai[key])}</div>` : '';
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
      <div class="chat-log" id="chat-log">${STATE.ai.chat.length ? STATE.ai.chat.map(m => `<div class="msg ${m.role}">${m.role === 'assistant' ? renderMarkdown(m.content) : esc(m.content)}</div>`).join('')
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
      <h2 style="margin-top:0">Google sign-in</h2>
      <label for="set-client">OAuth client ID</label>
      <input type="text" id="set-client" value="${esc(s.googleClientId || '')}" placeholder="1234567890-abc.apps.googleusercontent.com">
      <p class="hint">Create a "Web application" OAuth client in Google Cloud with this site's address as an authorised JavaScript origin, and enable the Tag Manager API and Google Analytics Admin API. See the README.</p>
      <div class="actions"><button class="btn" data-act="save-google">Save</button>
        ${Google.isSignedIn() ? '<button class="btn secondary" data-act="signout">Sign out of Google</button>' : '<button class="btn secondary" data-act="signin">Sign in with Google</button>'}</div>
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

function applyTheme() {
  const t = loadAppSettings().theme || 'auto';
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
}

// ══════════════════════════════════════════════════════════════════
//  EXPORTS
// ══════════════════════════════════════════════════════════════════

function exportPdf() {
  const r = STATE.result;
  const notOk = consentRows(r, 'All', '').filter(t => t.risk !== 'OK');
  $('#print-report').innerHTML = `
    <div class="page">${reportHeader(r)}<h2>Areas</h2>${areasTable(r)}</div>
    <div class="page"><h2>Prioritised actions</h2>${actionsTable(r)}</div>
    ${STATE.ai.writeup ? `<div class="page doc">${renderMarkdown(STATE.ai.writeup)}</div>` : ''}
    <div class="page"><h2>Consent matrix (tags needing attention)</h2>${consentModeNotice(r)}${consentTable(notOk)}</div>
    ${r.live ? `<div class="page"><h2>Live consent test</h2>${liveSection(r.live)}</div>` : ''}
    <div class="page"><h2>ID inventory</h2><div class="table-wrap"><table>
      <thead><tr><th>Platform</th><th>ID</th><th>Type</th><th>Status</th><th>Used by</th><th>Confirmed</th><th>Notes</th></tr></thead>
      <tbody>${idRows(r).map(x => `<tr><td>${esc(x.rec.platform)}</td><td><code>${esc(x.rec.id)}</code></td><td>${esc(x.rec.kind)}</td>
        <td>${x.rec.live ? 'Live' : 'Paused only'}</td><td>${esc(truncate_(x.rec.tags.join(', '), 160))}</td>
        <td>${STATE.confirmations[x.key] ? '✓' : ''}</td><td>${esc(x.note)}</td></tr>`).join('')}</tbody></table></div></div>
    ${STATE.ai.fixplan ? `<div class="page doc">${renderMarkdown(STATE.ai.fixplan)}</div>` : ''}`;
  const title = document.title;
  document.title = 'Tag audit - ' + fileSlug();
  window.print();
  document.title = title;
}

function saveAudit() {
  const data = {
    app: 'tag-audit-studio', v: 1, savedAt: new Date().toISOString(),
    inputs: STATE.inputs, result: STATE.result, ai: { writeup: STATE.ai.writeup, fixplan: STATE.ai.fixplan, chat: STATE.ai.chat },
    overrides: STATE.overrides, confirmations: STATE.confirmations
  };
  download('tag-audit-' + fileSlug() + '.json', JSON.stringify(data), 'application/json');
}

function openAudit(text) {
  const d = JSON.parse(text);
  if (d.app !== 'tag-audit-studio' || !d.result) throw new Error('That file is not a saved Tag Audit Studio audit.');
  STATE.inputs = Object.assign(STATE.inputs, d.inputs || {});
  STATE.result = d.result;
  STATE.ai = Object.assign({ writeup: '', fixplan: '', chat: [], busy: '' }, d.ai || {}, { busy: '' });
  STATE.overrides = d.overrides || {};
  STATE.confirmations = d.confirmations || {};
  updateNav();
  setView('summary');
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
      case 'goto': setView(el.dataset.view); break;
      case 'signin': {
        const clientId = ($('#set-client') && $('#set-client').value.trim()) || loadAppSettings().googleClientId;
        if ($('#set-client') && clientId) saveAppSettings({ googleClientId: clientId });
        el.disabled = true; el.textContent = 'Waiting for Google…';
        try { await Google.signIn(clientId); }
        finally { el.disabled = false; el.textContent = 'Sign in with Google'; }
        toast('Signed in to Google'); VIEWS[STATE.view](); break;
      }
      case 'signout': Google.signOut(); toast('Signed out of Google'); VIEWS[STATE.view](); break;
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
      case 'save': saveAudit(); break;
      case 'csv-actions':
        download('actions-' + fileSlug() + '.csv', toCsv([['#', 'Severity', 'Area', 'Finding', 'Action', 'Where', 'Items']]
          .concat(r.issues.map((x, n) => [n + 1, x.severity, x.area, x.finding, x.action, x.where, (x.items || []).join('; ')]))), 'text/csv'); break;
      case 'csv-consent':
        download('consent-' + fileSlug() + '.csv', toCsv([['Risk', 'Tag', 'Location', 'Platform', 'Vendor', 'Purpose', 'Fires on', 'Blocked by', 'Consent handling', 'Recommendation', 'AI note']]
          .concat(consentRows(r, 'All', '').map(t => [t.risk === '—' ? 'Paused' : t.risk, t.label, t.where, t.platform, t.vendor || '', t.purpose,
            (t.firesOn || []).join(' OR '), (t.blockedBy || []).join(' OR '), t.handling, t.recommendation, t.ai && t.ai.what || '']))), 'text/csv'); break;
      case 'csv-ids':
        download('ids-' + fileSlug() + '.csv', toCsv([['Platform', 'ID', 'Type', 'Status', 'Used by', 'Found in', 'Approved', 'Client confirms', 'Notes']]
          .concat(idRows(r).map(x => [x.rec.platform, x.rec.id, x.rec.kind, x.rec.live ? 'Live' : 'Paused only', x.rec.tags.join('; '),
            x.rec.where.join('; '), x.approved, STATE.confirmations[x.key] ? 'Yes' : '', x.note]))), 'text/csv'); break;
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
      case 'save-google': saveAppSettings({ googleClientId: $('#set-client').value.trim() }); toast('Google settings saved'); break;
      case 'clear-data':
        ['tas.settings', 'tas.draft', 'tas.gtmPaths', 'tas.ga4Streams'].forEach(k => { try { localStorage.removeItem(k); } catch (x) { /* ignore */ } });
        STATE.caches = { containers: {}, api: {}, ga4: {} };
        toast('Saved settings and caches cleared'); renderSettings(); break;
    }
  } catch (err) {
    console.error(err);
    toast(err.message, true);
  }
});

$('#open-audit').addEventListener('click', () => $('#open-audit-file').click());
$('#open-audit-file').addEventListener('change', async e => {
  const f = e.target.files[0];
  if (!f) return;
  try { openAudit(await f.text()); } catch (err) { toast(err.message, true); }
  e.target.value = '';
});

// ── Start ───────────────────────────────────────────────────────────
applyTheme();
updateNav();
setView((location.hash || '#audit').slice(1));
