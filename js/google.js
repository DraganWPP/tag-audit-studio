// ════════════════════════════════════════════════════════════════════
//  Tag Audit Studio — Google sign-in, GTM API and GA4 Admin API
//  Runs entirely in the browser with Google Identity Services.
//  Read-only scopes; the access token lives in memory only.
// ════════════════════════════════════════════════════════════════════

const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/tagmanager.readonly',
  'https://www.googleapis.com/auth/analytics.readonly'
].join(' ');
const GTM_API = 'https://tagmanager.googleapis.com/tagmanager/v2/';
const GA4_API = 'https://analyticsadmin.googleapis.com/';

const Google = {
  token: null,
  expires: 0,
  user: null,

  isSignedIn() { return !!this.token && Date.now() < this.expires; },

  /** Opens Google's consent popup and resolves with an access token. */
  signIn(clientId) {
    return new Promise((resolve, reject) => {
      if (!clientId) return reject(new Error('Add your Google OAuth client ID in Settings first.'));
      if (!window.google || !google.accounts || !google.accounts.oauth2) {
        return reject(new Error('Google sign-in did not load. Check your connection or ad blocker and reload the page.'));
      }
      let settled = false, waitTimer = null;
      const done = (fn, value) => { if (settled) return; settled = true; clearTimeout(waitTimer); fn(value); };
      const client = google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: GOOGLE_SCOPES,
        callback: resp => {
          if (resp.error) {
            return done(reject, new Error('Google sign-in failed: ' + resp.error +
              (resp.error_description ? ' — ' + resp.error_description : '')));
          }
          this.token = resp.access_token;
          this.expires = Date.now() + (Number(resp.expires_in || 3600) - 60) * 1000;
          // If the wait already timed out, still keep the token and tell the app.
          if (settled) window.dispatchEvent(new Event('google-signed-in'));
          done(resolve, this.token);
        },
        error_callback: err => {
          const type = err && err.type || 'unknown';
          console.warn('[Google sign-in] error_callback', type, err);
          if (type === 'popup_failed_to_open') {
            return done(reject, new Error('The Google sign-in window was blocked. Allow pop-ups for ' + location.origin + ' and try again.'));
          }
          if (type === 'popup_closed') {
            // Chrome can report "closed" too early because of Cross-Origin-Opener-Policy.
            // Keep waiting for Google's answer instead of failing straight away.
            waitTimer = setTimeout(() => done(reject, new Error(
              'Google sign-in did not finish. If the window showed "Error 400: origin_mismatch", add ' +
              location.origin + ' to the OAuth client\'s Authorised JavaScript origins in Google Cloud. ' +
              'If you approved access and nothing happened, use "Sign in by redirect" instead.')), 120000);
            return;
          }
          done(reject, new Error('Google sign-in failed (' + type + ').'));
        }
      });
      client.requestAccessToken({ prompt: this.token ? '' : 'consent' });
    });
  },

  /**
   * Full-page redirect sign-in (OAuth implicit flow). No popup and no iframe relay,
   * so it works where corporate Chrome policies or extensions break the popup hand-off.
   * The page URL (origin + path) must be listed under the OAuth client's
   * "Authorised redirect URIs" in Google Cloud.
   */
  signInRedirect(clientId, returnView) {
    if (!clientId) throw new Error('Add your Google OAuth client ID in Settings first.');
    const state = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
    sessionStorage.setItem('tas.oauth', JSON.stringify({ state, view: returnView || 'audit' }));
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: this.redirectUri(),
      response_type: 'token',
      scope: GOOGLE_SCOPES,
      include_granted_scopes: 'true',
      state
    });
    location.assign('https://accounts.google.com/o/oauth2/v2/auth?' + params);
  },

  redirectUri() { return location.origin + location.pathname; },

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
    return { view };
  },

  signOut() {
    if (this.token && window.google && google.accounts && google.accounts.oauth2) {
      google.accounts.oauth2.revoke(this.token, () => {});
    }
    this.token = null; this.expires = 0;
  },

  /** GET with retries on rate limits. */
  async get(url) {
    if (!this.isSignedIn()) throw new Error('Not signed in to Google (or the session expired). Sign in again.');
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, { headers: { Authorization: 'Bearer ' + this.token } });
      if (res.ok) return res.json();
      const body = await res.text();
      if ((res.status === 429 || res.status >= 500) && attempt < 4) {
        await new Promise(r => setTimeout(r, 1500 * Math.pow(2, attempt)));
        continue;
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
      out = out.concat(page[field] || []);
      token = page.nextPageToken;
    } while (token);
    return out;
  }
};

function googleErrorMessage_(status, body) {
  let msg = '';
  try { msg = JSON.parse(body).error.message; } catch (e) { msg = body.slice(0, 200); }
  if (status === 403 && /has not been used|is disabled/i.test(msg)) {
    return 'This API is not enabled in your Google Cloud project. Enable the Tag Manager API and the Google Analytics Admin API (see README). Details: ' + msg;
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
