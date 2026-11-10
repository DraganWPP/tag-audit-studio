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
          done(resolve, this.token);
        },
        error_callback: err => {
          const type = err && err.type || 'unknown';
          if (type === 'popup_failed_to_open') {
            return done(reject, new Error('The Google sign-in window was blocked. Allow pop-ups for ' + location.origin + ' and try again.'));
          }
          if (type === 'popup_closed') {
            // Chrome can report "closed" too early because of Cross-Origin-Opener-Policy.
            // Keep waiting for Google's answer instead of failing straight away.
            waitTimer = setTimeout(() => done(reject, new Error(
              'Google sign-in did not finish. If the window showed "Error 400: origin_mismatch", add ' +
              location.origin + ' to the OAuth client\'s Authorised JavaScript origins in Google Cloud.')), 120000);
            return;
          }
          done(reject, new Error('Google sign-in failed (' + type + ').'));
        }
      });
      client.requestAccessToken({ prompt: this.token ? '' : 'consent' });
    });
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

const GA4_STREAM_CACHE_KEY = 'tas.ga4Streams';

async function findGa4Property(mid, progress) {
  let cache = {};
  try { cache = JSON.parse(localStorage.getItem(GA4_STREAM_CACHE_KEY) || '{}'); } catch (e) { /* ignore */ }
  if (cache[mid]) return cache[mid];
  const summaries = await Google.listAll(GA4_API + 'v1beta/accountSummaries?pageSize=200', 'accountSummaries');
  let found = null;
  for (const acc of summaries) {
    for (const ps of (acc.propertySummaries || [])) {
      progress && progress('Looking for ' + mid + ' in "' + ps.displayName + '"…');
      let streams = [];
      try { streams = await Google.listAll(GA4_API + 'v1beta/' + ps.property + '/dataStreams?pageSize=200', 'dataStreams'); }
      catch (e) { continue; }
      streams.forEach(ds => {
        const id = ds.webStreamData && ds.webStreamData.measurementId;
        if (!id) return;
        cache[id] = { property: ps.property, displayName: ps.displayName, account: acc.displayName, streams: streams.length };
        if (id === mid) found = cache[id];
      });
      if (found) break;
    }
    if (found) break;
  }
  try { localStorage.setItem(GA4_STREAM_CACHE_KEY, JSON.stringify(cache)); } catch (e) { /* ignore */ }
  return found;
}

/** Everything the engine's GA4 checks need, for one measurement ID. */
async function fetchGa4PropertyData(mid, progress) {
  const prop = await findGa4Property(mid, progress);
  if (!prop) return { noAccess: true };
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
