// ════════════════════════════════════════════════════════════════════
//  Tag Audit Studio — Google sign-in, GTM API and GA4 Admin API
//  Runs entirely in the browser: OAuth redirect sign-in, read-only scopes.
//  The access token (valid for an hour) is kept in sessionStorage, so it
//  survives reloads in the same tab and is gone when the tab closes.
// ════════════════════════════════════════════════════════════════════

const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/tagmanager.readonly',
  'https://www.googleapis.com/auth/analytics.readonly',
  'https://www.googleapis.com/auth/userinfo.email'      // shows which account is signed in
].join(' ');
// Optional permissions, requested only when the user turns on a feature that needs them
const CM360_SCOPE = 'https://www.googleapis.com/auth/dfareporting';   // CM360 reports (no campaign/Floodlight edits)
const GOOGLE_OPTIONAL_SCOPES = [CM360_SCOPE];
const GOOGLE_SESSION_KEY = 'tas.googleSession';           // sessionStorage: { token, expires, user }
const GOOGLE_HINT_KEY = 'tas.googleHint';                 // localStorage: last account, suggested at sign-in
const GTM_API = 'https://tagmanager.googleapis.com/tagmanager/v2/';
const GA4_API = 'https://analyticsadmin.googleapis.com/';

const Google = {
  token: null,
  expires: 0,
  user: null,

  isSignedIn() { return !!this.token && Date.now() < this.expires; },

  /** Puts back a sign-in saved earlier in this tab (survives reloads and the sign-in redirect). */
  restore() {
    let s = null;
    try { s = JSON.parse(sessionStorage.getItem(GOOGLE_SESSION_KEY) || 'null'); } catch (e) { /* storage blocked */ }
    if (s && s.token && Date.now() < s.expires) {
      this.token = s.token; this.expires = s.expires; this.user = s.user || null; this.scopes = s.scopes || [];
    }
  },

  /** True when the current sign-in includes this permission (e.g. CM360 reporting). */
  hasScope(scope) { return this.isSignedIn() && (this.scopes || []).indexOf(scope) >= 0; },

  persist() {
    try {
      if (this.token) sessionStorage.setItem(GOOGLE_SESSION_KEY, JSON.stringify({ token: this.token, expires: this.expires, user: this.user, scopes: this.scopes || [] }));
      else sessionStorage.removeItem(GOOGLE_SESSION_KEY);
    } catch (e) { /* storage blocked: the sign-in lasts until the page reloads */ }
  },

  /** True when this tab was signed in before, but the hour-long token has run out. */
  hasExpired() { return !this.isSignedIn() && !!this.expires; },

  /**
   * Full-page redirect sign-in (OAuth implicit flow). No popup and no iframe relay,
   * so it works where corporate Chrome policies or extensions break popups.
   * The page URL (origin + path) must be listed under the OAuth client's
   * "Authorised redirect URIs" in Google Cloud. Once access is approved, Google
   * sends the user straight back; the last account used is suggested (login_hint).
   */
  signInRedirect(clientId, returnView, extraScopes) {
    if (!clientId) throw new Error('No Google OAuth client ID is set up. See Settings → Google sign-in.');
    const state = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
    sessionStorage.setItem('tas.oauth', JSON.stringify({ state, view: returnView || 'audit' }));
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: this.redirectUri(),
      response_type: 'token',
      // Extra permissions (CM360) are only requested when a feature asks for them; keep any granted earlier this tab
      scope: [GOOGLE_SCOPES].concat(extraScopes || [], (this.scopes || []).filter(s => GOOGLE_OPTIONAL_SCOPES.indexOf(s) >= 0)).join(' '),
      include_granted_scopes: 'true',
      state
    });
    let hint = '';
    try { hint = localStorage.getItem(GOOGLE_HINT_KEY) || ''; } catch (e) { /* ignore */ }
    if (hint) params.set('login_hint', hint);
    location.assign('https://accounts.google.com/o/oauth2/v2/auth?' + params);
  },

  /** Reads the signed-in account's email (for display and login_hint). Never fails the caller. */
  async loadUser() {
    try {
      const u = await this.get('https://www.googleapis.com/oauth2/v3/userinfo');
      this.user = u.email || null;
      this.persist();
      if (this.user) { try { localStorage.setItem(GOOGLE_HINT_KEY, this.user); } catch (e) { /* ignore */ } }
    } catch (e) { /* the email scope may not be granted yet */ }
    return this.user;
  },

  /** The page's folder address: …/index.html and … both return to …/, so one registered URI covers both. */
  redirectUri() { return location.origin + location.pathname.replace(/index\.html$/i, ''); },

  /**
   * Called once at start-up. Reads the token Google put in the URL fragment after a
   * redirect sign-in, then removes it from the address bar and history.
   * Returns null when this load is not a sign-in return, else { view } or { view, error }.
   */
  consumeRedirect() {
    const hash = location.hash.slice(1);
    if (!/(^|&)(access_token|error)=/.test(hash)) return null;
    const p = new URLSearchParams(hash);
    let saved = null;
    try { saved = JSON.parse(sessionStorage.getItem('tas.oauth') || 'null'); } catch (e) { /* ignore */ }
    sessionStorage.removeItem('tas.oauth');
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* ignore */ }
    const view = saved && saved.view || 'audit';
    if (!saved || p.get('state') !== saved.state) return { view, error: 'Google sign-in could not be verified (state mismatch). Try again.' };
    if (p.get('error')) return { view, error: 'Google sign-in failed: ' + p.get('error') };
    this.token = p.get('access_token');
    this.expires = Date.now() + (Number(p.get('expires_in') || 3600) - 60) * 1000;
    this.user = null;
    this.scopes = (p.get('scope') || '').split(/\s+/).filter(Boolean);
    this.persist();
    return { view };
  },

  /** Ends the sign-in in this tab and asks Google to revoke the token. */
  signOut() {
    if (this.token) {
      fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(this.token), { method: 'POST', mode: 'no-cors' }).catch(() => {});
    }
    this.token = null; this.expires = 0; this.user = null; this.scopes = [];
    this.persist();
    try { localStorage.removeItem(GOOGLE_HINT_KEY); } catch (e) { /* ignore */ }
  },

  /** GET with retries on rate limits. */
  get(url) { return this.request(url); },

  /** POST a JSON body (GA4 Data API reports), with the same retries. */
  post(url, body) {
    return this.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  },

  async request(url, init) {
    if (!this.isSignedIn()) throw new Error('Not signed in to Google (or the session expired). Sign in again.');
    init = init || {};
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, Object.assign({}, init,
        { headers: Object.assign({ Authorization: 'Bearer ' + this.token }, init.headers || {}) }));
      if (res.ok) {
        const text = await res.text();           // DELETE and some POSTs return no body
        return text ? JSON.parse(text) : {};
      }
      const body = await res.text();
      if ((res.status === 429 || res.status >= 500) && attempt < 4) {
        await new Promise(r => setTimeout(r, 1500 * Math.pow(2, attempt)));
        continue;
      }
      if (res.status === 401) {               // token revoked or expired early: show "sign in again"
        this.token = null;
        this.persist();
        window.dispatchEvent(new Event('google-session-changed'));
      }
      const err = new Error(googleErrorMessage_(res.status, body));
      err.status = res.status;
      throw err;
    }
  },

  async listAll(url, field) {
    let out = [], token = null;
    do {
      const sep = url.indexOf('?') >= 0 ? '&' : '?';
      const page = await this.get(url + (token ? sep + 'pageToken=' + encodeURIComponent(token) : ''));
      // Fall back to the first list in the page if Google names the field differently
      out = out.concat(page[field] || Object.keys(page).map(k => page[k]).filter(Array.isArray)[0] || []);
      token = page.nextPageToken;
    } while (token);
    return out;
  }
};

function googleErrorMessage_(status, body) {
  let msg = '';
  try { msg = JSON.parse(body).error.message; } catch (e) { msg = body.slice(0, 200); }
  if (status === 403 && /has not been used|is disabled/i.test(msg)) {
    return 'This API is not enabled in your Google Cloud project. Enable the Tag Manager API, the Google Analytics Admin API ' +
      'and the Google Analytics Data API (see README). Details: ' + msg;
  }
  if (status === 401) return 'Your Google session expired. Sign in again.';
  if (status === 403) return 'No access: ' + msg;
  if (status === 404) return 'Not found: ' + msg;
  return 'Google API error ' + status + ': ' + msg;
}

// ── GTM ─────────────────────────────────────────────────────────────

const GTM_PATH_CACHE_KEY = 'tas.gtmPaths';

function cachedPaths_() {
  try { return JSON.parse(localStorage.getItem(GTM_PATH_CACHE_KEY) || '{}'); } catch (e) { return {}; }
}
function rememberPath_(publicId, c) {
  try {
    const all = cachedPaths_();
    all[publicId] = { path: c.path, name: c.name, accountName: c.accountName || '' };
    localStorage.setItem(GTM_PATH_CACHE_KEY, JSON.stringify(all));
  } catch (e) { /* storage unavailable */ }
}

async function findGtmContainer(publicId, progress) {
  const cached = cachedPaths_()[publicId];
  if (cached) return cached;
  try {
    const c = await Google.get(GTM_API + 'accounts/containers:lookup?tagId=' + encodeURIComponent(publicId));
    if (c && c.path) { rememberPath_(publicId, c); return c; }
  } catch (e) {
    if (e.status === 401) throw e;
    // fall through to a full walk (lookup is unavailable or returned nothing)
  }
  const accounts = await Google.listAll(GTM_API + 'accounts', 'account');
  for (const acc of accounts) {
    progress && progress('Searching GTM account "' + acc.name + '"…');
    const containers = await Google.listAll(GTM_API + acc.path + '/containers', 'container');
    const hit = containers.filter(c => c.publicId === publicId)[0];
    if (hit) {
      hit.accountName = acc.name;
      rememberPath_(publicId, hit);
      return hit;
    }
  }
  return null;
}

/** Workspace names for a container (for the "Version to audit" picker). */
async function listGtmWorkspaces(publicId, progress) {
  const container = await findGtmContainer(publicId, progress);
  if (!container) throw new Error('Your Google account has no access to ' + publicId + '.');
  return Google.listAll(GTM_API + container.path + '/workspaces', 'workspace');
}

/**
 * Reads a workspace's current (unpublished) contents in the same shape as a
 * container version, so the engine can analyse it. Read-only.
 */
async function fetchWorkspaceVersion(ws, container, publicId) {
  const list = (path, field) => Google.listAll(GTM_API + ws.path + '/' + path, field).catch(e => {
    if (path === 'templates' || path === 'built_in_variables' || path === 'folders') return [];
    throw e;
  });
  const [tags, triggers, variables, builtIns, folders, templates] = await Promise.all([
    list('tags', 'tag'), list('triggers', 'trigger'), list('variables', 'variable'),
    list('built_in_variables', 'builtInVariable'), list('folders', 'folder'), list('templates', 'template')
  ]);
  return {
    containerVersionId: 'workspace', name: 'Workspace: ' + ws.name,
    container: { publicId: publicId, name: container.name },
    tag: tags, trigger: triggers, variable: variables, builtInVariable: builtIns,
    folder: folders, customTemplate: templates
  };
}

/**
 * Live version (or a named workspace) + workspace status for one container.
 * target: 'live' or a workspace name.
 */
async function fetchGtmContainerDetail(publicId, progress, target) {
  target = target || 'live';
  const container = await findGtmContainer(publicId, progress);
  if (!container) return { publicId: publicId, noAccess: true };
  let version;
  if (target === 'live') {
    progress && progress('Reading the live version of ' + publicId + '…');
    try {
      version = await Google.get(GTM_API + container.path + '/versions:live');
    } catch (e) {
      return { publicId: publicId, container: container, error: 'Could not read the live version: ' + e.message };
    }
  } else {
    const all = await Google.listAll(GTM_API + container.path + '/workspaces', 'workspace');
    const ws = all.filter(w => w.name.trim().toLowerCase() === String(target).trim().toLowerCase())[0];
    if (!ws) {
      return { publicId: publicId, container: container,
               error: 'No workspace called "' + target + '" in ' + publicId + '. Workspaces: ' + all.map(w => w.name).join(', ') };
    }
    progress && progress('Reading workspace "' + ws.name + '" of ' + publicId + ' (unpublished changes included)…');
    try {
      version = await fetchWorkspaceVersion(ws, container, publicId);
    } catch (e) {
      return { publicId: publicId, container: container, error: 'Could not read workspace "' + ws.name + '": ' + e.message };
    }
  }
  let workspaces = [];
  try {
    const list = await Google.listAll(GTM_API + container.path + '/workspaces', 'workspace');
    for (const ws of list) {
      try {
        const st = await Google.get(GTM_API + ws.path + '/status');
        workspaces.push({ name: ws.name, changes: st.workspaceChange || [], mergeConflict: st.mergeConflict || [] });
      } catch (e) {
        workspaces.push({ name: ws.name, error: e.message });
      }
    }
  } catch (e) {
    workspaces = [{ name: 'Workspaces', error: e.message }];
  }
  return { publicId: publicId, container: container, version: version, workspaces: workspaces };
}

// ── GA4 Admin API ───────────────────────────────────────────────────

const GA4_STREAM_CACHE_KEY = 'tas.ga4Streams';   // measurement ID → property it belongs to
const GA4_MISS_KEY = 'tas.ga4Misses';             // measurement ID → time a full search did not find it
const GA4_MISS_TTL = 6 * 3600 * 1000;
const GA4_CONCURRENCY = 5;
const GA4_HINT_STOP = new Set(['www', 'com', 'net', 'org', 'http', 'https', 'the', 'and', 'ltd', 'inc', 'web', 'app',
                               'site', 'ga4', 'test', 'staging', 'prod', 'property', 'account']);

function readJsonStore_(key) {
  try { return JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch (e) { return {}; }
}
function writeJsonStore_(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* ignore */ }
}

/** Words from the client name and site domain, used to search likely properties first. */
function ga4HintWords_(hints) {
  const words = new Set();
  const add = s => String(s || '').toLowerCase().split(/[^a-z0-9]+/)
    .forEach(w => { if (w.length >= 3 && !GA4_HINT_STOP.has(w)) words.add(w); });
  add(hints.client);
  if (hints.site) {
    let host = String(hints.site);
    try { host = new URL(/^https?:/i.test(host) ? host : 'https://' + host).hostname; } catch (e) { /* use as typed */ }
    add(host.split('.').slice(0, -1).join(' '));   // drop the TLD
  }
  return words;
}

function ga4HintScore_(name, words) {
  const text = String(name || '').toLowerCase();
  const tokens = text.split(/[^a-z0-9]+/).filter(t => t.length >= 4);
  let score = 0;
  words.forEach(w => { if (text.indexOf(w) >= 0 || tokens.some(t => w.indexOf(t) >= 0)) score++; });
  return score;
}

/** Errors worth a second try: rate limits, Google 5xx and network failures. */
function isTransientGoogleError_(e) {
  return !e.status || e.status === 429 || e.status >= 500;
}

/**
 * Finds the GA4 property behind a measurement ID. The Admin API has no lookup by
 * measurement ID, so this lists the account's properties and reads their data streams:
 * likely properties (matching the client name / site) first, several at a time.
 * Returns { property, skipped } — skipped lists properties that could not be read.
 */
async function findGa4Property(mid, progress, hints, force) {
  const cache = readJsonStore_(GA4_STREAM_CACHE_KEY);
  if (cache[mid]) return { property: cache[mid], skipped: [] };
  const misses = readJsonStore_(GA4_MISS_KEY);
  if (!force && misses[mid] && Date.now() - misses[mid] < GA4_MISS_TTL) {
    progress && progress(mid + ' was not found in your GA4 properties in the last few hours. Re-run the audit to search again.');
    return { property: null, skipped: [] };
  }

  const summaries = await Google.listAll(GA4_API + 'v1beta/accountSummaries?pageSize=200', 'accountSummaries');
  const known = new Set(Object.keys(cache).map(k => cache[k].property));
  const words = ga4HintWords_(hints || {});
  const props = [];
  summaries.forEach(acc => (acc.propertySummaries || []).forEach(ps => {
    // Properties whose streams are already cached go last: the ID was not among them.
    const score = known.has(ps.property) ? -1 : ga4HintScore_(ps.displayName + ' ' + acc.displayName, words);
    props.push({ ps: ps, acc: acc, score: score });
  }));
  props.sort((a, b) => b.score - a.score);   // stable: keeps Google's order within a score

  let found = null, checked = 0;
  const failed = [];
  const scan = async item => {
    const streams = await Google.listAll(GA4_API + 'v1beta/' + item.ps.property + '/dataStreams?pageSize=200', 'dataStreams');
    streams.forEach(ds => {
      const id = ds.webStreamData && ds.webStreamData.measurementId;
      if (!id) return;
      cache[id] = { property: item.ps.property, displayName: item.ps.displayName, account: item.acc.displayName, streams: streams.length };
      if (id === mid) found = cache[id];
    });
  };

  progress && progress('Looking for ' + mid + ' in ' + props.length + ' GA4 properties' +
    (props[0] && props[0].score > 0 ? ', likely matches first' : '') + '…');
  const queue = props.slice();
  const worker = async () => {
    while (!found && queue.length) {
      const item = queue.shift();
      try { await scan(item); }
      catch (e) {
        if (e.status === 401) throw e;                     // signed out: stop everything
        if (isTransientGoogleError_(e)) failed.push(item); // 403/404: no access to this one, move on
      }
      checked++;
      if (!found && progress && checked % 10 === 0) progress('Checked ' + checked + ' of ' + props.length + ' GA4 properties…');
    }
  };
  await Promise.all(Array.from({ length: Math.min(GA4_CONCURRENCY, props.length) }, worker));

  // Second chance, one at a time, for properties Google failed to answer for
  const skipped = [];
  for (const item of failed) {
    if (found) break;
    try { await scan(item); }
    catch (e) {
      if (e.status === 401) throw e;
      skipped.push(item.ps.displayName || item.ps.property);
    }
  }

  writeJsonStore_(GA4_STREAM_CACHE_KEY, cache);
  if (found) {
    delete misses[mid];
    progress && progress('Found ' + mid + ' in "' + found.displayName + '"');
  } else if (!skipped.length) {
    misses[mid] = Date.now();
  }
  writeJsonStore_(GA4_MISS_KEY, misses);
  return { property: found, skipped: skipped };
}

/** Everything the engine's GA4 checks need, for one measurement ID. */
async function fetchGa4PropertyData(mid, progress, hints, force) {
  const lookup = await findGa4Property(mid, progress, hints, force);
  const prop = lookup.property;
  if (!prop) return { noAccess: true, skipped: lookup.skipped };
  const p = prop.property;
  const soft = async (fn, fallback) => { try { return await fn(); } catch (e) { console.debug('GA4', e.message); return fallback; } };
  progress && progress('Checking GA4 property "' + prop.displayName + '"…');
  const [property, retention, dims, keyEvents, adsLinks, bq] = await Promise.all([
    soft(() => Google.get(GA4_API + 'v1beta/' + p), {}),
    soft(() => Google.get(GA4_API + 'v1beta/' + p + '/dataRetentionSettings'), {}),
    soft(() => Google.listAll(GA4_API + 'v1beta/' + p + '/customDimensions?pageSize=200', 'customDimensions'), []),
    soft(() => Google.listAll(GA4_API + 'v1beta/' + p + '/keyEvents?pageSize=200', 'keyEvents'), null),
    soft(() => Google.listAll(GA4_API + 'v1beta/' + p + '/googleAdsLinks?pageSize=200', 'googleAdsLinks'), null),
    soft(() => Google.listAll(GA4_API + 'v1alpha/' + p + '/bigQueryLinks?pageSize=200', 'bigqueryLinks'), null)
  ]);
  let keys = keyEvents;
  if (keys === null) {
    keys = await soft(() => Google.listAll(GA4_API + 'v1beta/' + p + '/conversionEvents?pageSize=200', 'conversionEvents'), []);
  }
  return {
    displayName: prop.displayName, account: prop.account, streams: prop.streams,
    property: { timeZone: property.timeZone, currencyCode: property.currencyCode },
    retention: retention.eventDataRetention || null,
    customDimensions: dims.map(x => ({ parameterName: x.parameterName, scope: x.scope })),
    keyEvents: (keys || []).map(k => k.eventName),
    adsLinks: adsLinks === null ? null : adsLinks.length,
    bigQuery: bq === null ? null : bq.length
  };
}

/**
 * The GTM report's GA4 property checks need a small subset of the full GA4 read.
 * Same shape as fetchGa4PropertyData(), so one read per property serves both reports.
 */
function ga4PropertyDataFromFull(full, prop) {
  const a = full.admin || {};
  const p = a.property || {};
  return {
    displayName: full.displayName || prop.displayName, account: full.account || prop.account, streams: (a.streams || []).length,
    property: { timeZone: p.timeZone, currencyCode: p.currencyCode },
    retention: a.retention && a.retention.eventDataRetention || null,
    customDimensions: (a.customDimensions || []).map(x => ({ parameterName: x.parameterName, scope: x.scope })),
    keyEvents: (a.keyEvents || []).map(k => k.eventName),
    adsLinks: a.adsLinks === null || a.adsLinks === undefined ? null : a.adsLinks.length,
    bigQuery: a.bigQueryLinks === null || a.bigQueryLinks === undefined ? null : a.bigQueryLinks.length
  };
}

// ── GA4 audit: full property read (Admin API + Data API) ────────────

const GA4_DATA_API = 'https://analyticsdata.googleapis.com/';
const GA4_DATE_RANGE = [{ startDate: '28daysAgo', endDate: 'yesterday' }];

/** Every GA4 property the signed-in account can see, for the GA4 audit picker. */
async function listGa4Properties() {
  const summaries = await Google.listAll(GA4_API + 'v1beta/accountSummaries?pageSize=200', 'accountSummaries');
  const out = [];
  summaries.forEach(acc => (acc.propertySummaries || []).forEach(ps => out.push({
    property: ps.property, displayName: ps.displayName || ps.property, account: acc.displayName || acc.account,
    propertyType: ps.propertyType || ''
  })));
  return out;
}

/** Runs async tasks with at most `limit` in flight. Resolves with results in task order. */
async function runPooled_(tasks, limit) {
  const results = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

/** Data API report rows as { d: [dimension values], m: [numbers] }. */
function ga4ReportRows_(report) {
  return ((report && report.rows) || []).map(r => ({
    d: (r.dimensionValues || []).map(v => v.value),
    m: (r.metricValues || []).map(v => Number(v.value) || 0)
  }));
}

function ga4ReportTotal_(report) {
  const t = report && report.totals && report.totals[0];
  return t ? Number(t.metricValues[0].value) || 0 : null;
}

const GA4_PII_KEYS = 'e-?mail|mail|phone|tel|mobile|firstname|first_name|lastname|last_name|surname|fullname|name|address|postcode|zip';
const GA4_PII_URL_REGEX = '(@|%40|[?&;](' + GA4_PII_KEYS + ')=)';

/** Masks anything in a URL that may identify a person. Only the masked form is ever stored. */
function maskPiiUrl_(url) {
  return String(url || '')
    .replace(/[A-Z0-9._%+-]+(@|%40)[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(new RegExp('([?&;](?:' + GA4_PII_KEYS + ')=)[^&;#]*', 'gi'), '$1[redacted]')
    .replace(/\d{6,}/g, '[number]')
    .slice(0, 160);
}

/**
 * Reads everything the GA4 audit needs for one property. Every call is optional:
 * a failure is listed in `unavailable` and never stops the audit (except an expired sign-in).
 * Page URLs that look like they contain personal data are masked here, before anything is stored.
 */
async function fetchGa4Full(prop, progress) {
  const p = prop.property;
  const name = prop.displayName || p;
  const unavailable = [];
  const soft = (label, fn, fallback) => fn().catch(e => {
    if (e.status === 401) throw e;
    unavailable.push(label + (e.status ? ' (HTTP ' + e.status + ')' : ''));
    return fallback;
  });
  const B = GA4_API + 'v1beta/' + p, A = GA4_API + 'v1alpha/' + p;
  const list = (base, path) => Google.listAll(base + '/' + path + '?pageSize=200', path);

  progress && progress('Reading GA4 settings for "' + name + '"…');
  const admin = {};
  const adminTasks = [
    ['property', 'Property details', () => Google.get(B), {}],
    ['streams', 'Data streams', () => list(B, 'dataStreams'), []],
    ['retention', 'Data retention', () => Google.get(B + '/dataRetentionSettings'), null],
    ['customDimensions', 'Custom dimensions', () => list(B, 'customDimensions'), null],
    ['customMetrics', 'Custom metrics', () => list(B, 'customMetrics'), null],
    ['keyEvents', 'Key events', () => list(B, 'keyEvents'), null],
    ['adsLinks', 'Google Ads links', () => list(B, 'googleAdsLinks'), null],
    ['firebaseLinks', 'Firebase links', () => list(B, 'firebaseLinks'), null],
    ['signals', 'Google signals settings', () => Google.get(A + '/googleSignalsSettings'), null],
    ['attribution', 'Attribution settings', () => Google.get(A + '/attributionSettings'), null],
    ['audiences', 'Audiences', () => list(A, 'audiences'), null],
    ['channelGroups', 'Channel groups', () => list(A, 'channelGroups'), null],
    ['calculatedMetrics', 'Calculated metrics', () => list(A, 'calculatedMetrics'), null],
    ['bigQueryLinks', 'BigQuery links', () => list(A, 'bigQueryLinks'), null],
    ['dv360Links', 'Display & Video 360 links', () => list(A, 'displayVideo360AdvertiserLinks'), null],
    ['sa360Links', 'Search Ads 360 links', () => list(A, 'searchAds360Links'), null],
    ['adSenseLinks', 'AdSense links', () => list(A, 'adSenseLinks'), null],
    ['annotations', 'Annotations', () => list(A, 'reportingDataAnnotations'), null]
  ];
  await runPooled_(adminTasks.map(t => async () => { admin[t[0]] = await soft(t[1], t[2], t[3]); }), 5);

  // Account-level data sharing settings
  const parent = admin.property && admin.property.parent;
  admin.dataSharing = parent ? await soft('Account data sharing settings',
    () => Google.get(GA4_API + 'v1beta/' + parent + '/dataSharingSettings'), null) : null;

  // Per-stream settings
  progress && progress('Reading data stream settings for "' + name + '"…');
  const streamTasks = [];
  (admin.streams || []).forEach(s => {
    const label = ' (' + (s.displayName || s.name) + ')';
    s.extra = {};
    const add = (key, text, fn, fallback) => streamTasks.push(async () => { s.extra[key] = await soft(text + label, fn, fallback); });
    add('mpSecrets', 'Measurement Protocol secrets',
      () => Google.listAll(GA4_API + 'v1beta/' + s.name + '/measurementProtocolSecrets?pageSize=200', 'measurementProtocolSecrets'), null);
    if (s.type === 'WEB_DATA_STREAM') {
      add('enhanced', 'Enhanced measurement', () => Google.get(GA4_API + 'v1alpha/' + s.name + '/enhancedMeasurementSettings'), null);
      add('redaction', 'Data redaction', () => Google.get(GA4_API + 'v1alpha/' + s.name + '/dataRedactionSettings'), null);
      add('createRules', 'Event create rules',
        () => Google.listAll(GA4_API + 'v1alpha/' + s.name + '/eventCreateRules?pageSize=200', 'eventCreateRules'), null);
      add('editRules', 'Event edit rules',
        () => Google.listAll(GA4_API + 'v1alpha/' + s.name + '/eventEditRules?pageSize=200', 'eventEditRules'), null);
    }
  });
  await runPooled_(streamTasks, 5);

  // Collected data (Data API), last 28 days
  progress && progress('Reading collected data (last 28 days) for "' + name + '"…');
  const R = (dims, metrics, extra) => Object.assign({
    dateRanges: GA4_DATE_RANGE,
    dimensions: dims.map(n => ({ name: n })),
    metrics: metrics.map(n => ({ name: n })),
    limit: 1000
  }, extra || {});
  const exact = (field, value) => ({ filter: { fieldName: field, stringFilter: { matchType: 'EXACT', value: value } } });
  const desc = metric => [{ metric: { metricName: metric }, desc: true }];
  const batch = requests => Google.post(GA4_DATA_API + 'v1beta/' + p + ':batchRunReports', { requests: requests })
    .then(res => res.reports || []);

  const data = { thresholded: false, otherRow: false };
  const note = report => {
    const md = report && report.metadata || {};
    if (md.subjectToThresholding) data.thresholded = true;
    if (md.dataLossFromOtherRow) data.otherRow = true;
  };
  const b1 = await soft('Collected data: events, streams, hostnames, channels, sources', () => batch([
    R(['eventName'], ['eventCount', 'totalUsers', 'keyEvents'], { orderBys: desc('eventCount') }),
    R(['streamId', 'streamName'], ['eventCount']),
    R(['hostName'], ['eventCount'], { orderBys: desc('eventCount'), limit: 200 }),
    R(['sessionDefaultChannelGroup'], ['sessions']),
    R(['sessionSource'], ['sessions'], { orderBys: desc('sessions'), limit: 200 })
  ]), null);
  if (b1) {
    b1.forEach(note);
    data.events = ga4ReportRows_(b1[0]).map(r => ({ name: r.d[0], count: r.m[0], users: r.m[1], keyEvents: r.m[2] }));
    data.streams = ga4ReportRows_(b1[1]).map(r => ({ id: r.d[0], name: r.d[1], count: r.m[0] }));
    data.hosts = ga4ReportRows_(b1[2]).map(r => ({ host: r.d[0], count: r.m[0] }));
    data.channels = ga4ReportRows_(b1[3]).map(r => ({ name: r.d[0], sessions: r.m[0] }));
    data.sources = ga4ReportRows_(b1[4]).map(r => ({ source: r.d[0], sessions: r.m[0] }));
  }

  const b2 = await soft('Collected data: landing pages, purchases, page URLs', () => batch([
    R(['landingPage'], ['sessions'], { dimensionFilter: exact('landingPage', '(not set)'), limit: 1 }),
    R(['transactionId'], ['eventCount'], { dimensionFilter: exact('eventName', 'purchase'), orderBys: desc('eventCount'), limit: 10000 }),
    R([], ['purchaseRevenue', 'ecommercePurchases']),
    R(['pagePathPlusQueryString'], ['screenPageViews'], {
      dimensionFilter: { filter: { fieldName: 'pagePathPlusQueryString',
        stringFilter: { matchType: 'PARTIAL_REGEXP', value: GA4_PII_URL_REGEX, caseSensitive: false } } },
      orderBys: desc('screenPageViews'), limit: 50
    })
  ]), null);
  if (b2) {
    b2.forEach(note);
    const landing = ga4ReportRows_(b2[0])[0];
    data.landingNotSet = landing ? landing.m[0] : 0;
    const tx = ga4ReportRows_(b2[1]);
    const totals = ga4ReportRows_(b2[2])[0] || { m: [0, 0] };
    data.purchases = {
      events: tx.reduce((s, r) => s + r.m[0], 0),
      ids: tx.filter(r => r.d[0] !== '(not set)').length,
      notSet: (tx.find(r => r.d[0] === '(not set)') || { m: [0] }).m[0],
      duplicateIds: tx.filter(r => r.d[0] !== '(not set)' && r.m[0] > 1).length,
      revenue: totals.m[0], ecommercePurchases: totals.m[1]
    };
    data.piiPages = ga4ReportRows_(b2[3]).map(r => ({ masked: maskPiiUrl_(r.d[0]), views: r.m[0] }));
  }

  // How often each custom dimension is empty
  const dims = (admin.customDimensions || []).filter(x => x.scope === 'EVENT' || x.scope === 'USER').slice(0, 25);
  if (dims.length && b1) {
    const reqs = dims.map(x => R([(x.scope === 'USER' ? 'customUser:' : 'customEvent:') + x.parameterName], ['eventCount'],
      { metricAggregations: ['TOTAL'], orderBys: desc('eventCount') }));
    const chunks = [];
    for (let i = 0; i < reqs.length; i += 5) chunks.push(reqs.slice(i, i + 5));
    const reports = await soft('Collected data: custom dimension fill rates',
      async () => [].concat(...(await runPooled_(chunks.map(c => () => batch(c)), 2))), null);
    if (reports) {
      reports.forEach(note);
      data.dimFill = dims.map((x, i) => {
        const rows = ga4ReportRows_(reports[i]);
        const total = ga4ReportTotal_(reports[i]);
        const notSet = (rows.find(r => r.d[0] === '(not set)') || { m: [0] }).m[0];
        return { param: x.parameterName, scope: x.scope,
                 total: total === null ? rows.reduce((s, r) => s + r.m[0], 0) : total, notSet: notSet };
      });
    }
  }

  data.realtime = await soft('Realtime data', () => Google.post(GA4_DATA_API + 'v1beta/' + p + ':runRealtimeReport',
    { metrics: [{ name: 'eventCount' }] }).then(res => {
      const row = ga4ReportRows_(res)[0];
      return row ? row.m[0] : 0;
    }), null);

  // Keep only what the report needs (audiences, groups and metrics as names)
  const names = (arr, f) => arr === null || arr === undefined ? null : arr.map(f || (x => x.displayName || x.name));
  return {
    property: p, displayName: name, account: prop.account || '', fetchedAt: new Date().toISOString(),
    admin: {
      property: admin.property || {},
      streams: (admin.streams || []).map(s => ({
        id: String(s.name || '').split('/').pop(), name: s.name, type: s.type, displayName: s.displayName,
        measurementId: s.webStreamData && s.webStreamData.measurementId || '',
        defaultUri: s.webStreamData && s.webStreamData.defaultUri || '',
        enhanced: s.extra.enhanced || null, redaction: s.extra.redaction || null,
        createRules: s.extra.createRules ? s.extra.createRules.map(r => ({ destinationEvent: r.destinationEvent })) : null,
        editRules: s.extra.editRules ? s.extra.editRules.map(r => ({ displayName: r.displayName })) : null,
        mpSecrets: s.extra.mpSecrets ? s.extra.mpSecrets.length : null
      })),
      retention: admin.retention,
      customDimensions: names(admin.customDimensions, x => ({ parameterName: x.parameterName, displayName: x.displayName, scope: x.scope })),
      customMetrics: names(admin.customMetrics, x => ({ parameterName: x.parameterName, displayName: x.displayName })),
      keyEvents: names(admin.keyEvents, x => ({ eventName: x.eventName, countingMethod: x.countingMethod, custom: x.custom })),
      adsLinks: names(admin.adsLinks, x => ({ customerId: x.customerId, adsPersonalizationEnabled: x.adsPersonalizationEnabled })),
      firebaseLinks: names(admin.firebaseLinks, x => x.project || x.name),
      signals: admin.signals, attribution: admin.attribution, dataSharing: admin.dataSharing,
      audiences: names(admin.audiences), channelGroups: names(admin.channelGroups), calculatedMetrics: names(admin.calculatedMetrics),
      bigQueryLinks: names(admin.bigQueryLinks, x => x.project || x.name),
      dv360Links: names(admin.dv360Links, x => x.advertiserDisplayName || x.advertiserId || x.name),
      sa360Links: names(admin.sa360Links, x => x.advertiserDisplayName || x.advertiserId || x.name),
      adSenseLinks: names(admin.adSenseLinks, x => x.adClientCode || x.name),
      annotations: names(admin.annotations, x => x.title || x.name)
    },
    data: data,
    unavailable: unavailable
  };
}
