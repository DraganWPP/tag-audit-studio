// ════════════════════════════════════════════════════════════════════
//  Google Search Console check (read-only, optional permission webmasters.readonly)
//
//  Search Console has no link to GTM, so the property is found from the website:
//  the Search Console properties the signed-in account can see are matched to the
//  site's hostname (Domain properties "sc-domain:" and URL-prefix properties).
//  Cross-checks search clicks with GA4 organic Google sessions, per site and per landing page.
// ════════════════════════════════════════════════════════════════════

const GSC_API = 'https://searchconsole.googleapis.com/webmasters/v3/';

/** Properties the signed-in account can see: [{ siteUrl, permissionLevel }]. */
async function gscSites() {
  const res = await Google.get(GSC_API + 'sites');
  return (res.siteEntry || []).map(s => ({ siteUrl: s.siteUrl, permissionLevel: s.permissionLevel }));
}

/** Hostname without "www.", lower case ('' if not a URL or hostname). */
function gscHost_(url) {
  const s = String(url || '').trim().toLowerCase();
  if (!s) return '';
  try { return new URL(/^[a-z]+:\/\//.test(s) ? s : 'https://' + s).hostname.replace(/^www\./, ''); }
  catch (e) { return ''; }
}

/**
 * The key a landing page is compared on, the same for Search Console URLs and GA4 landing pages:
 * the path only (no host, query or fragment), lower case, without a trailing slash, and masked
 * like every other stored URL (personal data, long numbers).
 */
function gscPathKey_(pathOrUrl) {
  let p = String(pathOrUrl || '');
  if (/^[a-z]+:\/\//i.test(p)) { try { p = new URL(p).pathname; } catch (e) { /* keep as is */ } }
  p = p.split(/[?#]/)[0].toLowerCase();
  if (p.length > 1) p = p.replace(/\/+$/, '');
  return maskPiiUrl_(p || '/');
}

/**
 * Search Console properties that cover a website. A Domain property covers the domain and all
 * its subdomains; a URL-prefix property covers one host and protocol.
 * Returns [{ siteUrl, permissionLevel, kind: 'Domain'|'URL prefix', exact }] (best first).
 */
function gscMatchSites(site, sites) {
  const host = gscHost_(site);
  if (!host) return [];
  const out = [];
  (sites || []).forEach(s => {
    const u = String(s.siteUrl || '');
    if (/^sc-domain:/i.test(u)) {
      const d = u.slice(10).toLowerCase().replace(/^www\./, '');
      if (host === d || host.endsWith('.' + d)) out.push(Object.assign({ kind: 'Domain', exact: host === d }, s));
    } else {
      const h = gscHost_(u);
      if (h && h === host) out.push(Object.assign({ kind: 'URL prefix', exact: true }, s));
    }
  });
  const rank = m => (/siteUnverifiedUser/.test(m.permissionLevel) ? 10 : 0) + (m.kind === 'Domain' ? 0 : 2) + (m.exact ? 0 : 1) +
    (/^https:/i.test(m.siteUrl) || m.kind === 'Domain' ? 0 : 0.5);
  return out.sort((a, b) => rank(a) - rank(b));
}

function gscDate_(daysAgo) {
  return new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10);
}

/** Search performance. Data lags about 3 days, so the 28 days end 3 days ago. dimensions [] gives one totals row. */
async function gscQuery(siteUrl, dimensions, days, rowLimit) {
  const end = gscDate_(3), start = gscDate_(3 + (days || 28) - 1);
  const res = await Google.post(GSC_API + 'sites/' + encodeURIComponent(siteUrl) + '/searchAnalytics/query', {
    startDate: start, endDate: end, dimensions: dimensions || [], rowLimit: rowLimit || 1000
  });
  return { start: start, end: end, rows: res.rows || [] };
}

/** Sitemaps submitted for a property. */
async function gscSitemaps(siteUrl) {
  const res = await Google.get(GSC_API + 'sites/' + encodeURIComponent(siteUrl) + '/sitemaps');
  return (res.sitemap || []).map(s => ({
    path: maskPiiUrl_(s.path), errors: Number(s.errors) || 0, warnings: Number(s.warnings) || 0, isPending: !!s.isPending,
    isIndex: !!s.isSitemapsIndex, lastDownloaded: s.lastDownloaded || '', lastSubmitted: s.lastSubmitted || ''
  }));
}

/** Search Console verification meta tags in pasted page source (each one is a verified owner). */
function gscVerificationTags(html) {
  const tags = [];
  const re = /<meta\b[^>]*name\s*=\s*["']google-site-verification["'][^>]*>/gi;
  let m;
  while ((m = re.exec(String(html || '')))) {
    const c = /content\s*=\s*["']([^"']+)["']/i.exec(m[0]);
    if (c && tags.indexOf(c[1]) < 0) tags.push(c[1]);
  }
  return tags;
}

const GSC_PAGE_LIMIT = 1000;

/**
 * Reads what the check needs for a website. Only counts, masked page paths and sitemap
 * addresses are kept; no search queries.
 */
async function fetchGscData(site, progress) {
  const say = m => progress && progress(m);
  const host = gscHost_(site);
  if (!host) throw new Error('Enter the website (for example https://www.example.co.uk) to find its Search Console property.');
  say('Looking for the Search Console property for ' + host + '…');
  const sites = await gscSites();
  const matches = gscMatchSites(site, sites);
  const data = { date: new Date().toISOString(), site: site, host: host, sitesCount: sites.length, matches: matches,
                 property: null, permission: '', start: '', end: '', totals: null, pages: null, pagesComplete: false,
                 sitemaps: null, unavailable: [] };
  const usable = matches.find(m => m.permissionLevel !== 'siteUnverifiedUser');
  if (!usable) {
    say(matches.length ? 'Search Console: ' + host + ' is listed for this account, but unverified (no data access).'
                       : 'Search Console: no property this account can see covers ' + host + '.');
    return data;
  }
  data.property = usable.siteUrl;
  data.permission = usable.permissionLevel;
  say('Reading Search Console property ' + usable.siteUrl + ' (last 28 days)…');
  const soft = (label, fn) => fn().catch(e => {
    if (e.status === 401) throw e;
    data.unavailable.push(label + (e.status ? ' (HTTP ' + e.status + ')' : ''));
    return null;
  });
  const [totals, pages, maps] = await Promise.all([
    soft('Search performance', () => gscQuery(usable.siteUrl, [], 28)),
    soft('Search performance per page', () => gscQuery(usable.siteUrl, ['page'], 28, GSC_PAGE_LIMIT)),
    soft('Sitemaps', () => gscSitemaps(usable.siteUrl))
  ]);
  if (totals) {
    const r = totals.rows[0] || {};
    data.start = totals.start; data.end = totals.end;
    data.totals = { clicks: Math.round(r.clicks || 0), impressions: Math.round(r.impressions || 0),
                    ctr: r.ctr || 0, position: r.position || null };
  }
  if (pages) {
    data.pagesComplete = pages.rows.length < GSC_PAGE_LIMIT;
    data.pages = pages.rows.map(r => {
      const url = String(r.keys[0] || '');
      let protocol = '', h = '';
      try { const u = new URL(url); protocol = u.protocol.replace(':', ''); h = u.hostname.toLowerCase(); } catch (e) { /* ignore */ }
      return { host: h, protocol: protocol, path: gscPathKey_(url), clicks: Math.round(r.clicks || 0), impressions: Math.round(r.impressions || 0) };
    });
  }
  data.sitemaps = maps;
  say('Search Console: ' + (data.totals ? data.totals.clicks + ' clicks, ' : '') + (data.pages ? data.pages.length + ' pages, ' : '') +
      (maps ? maps.length + ' sitemap(s)' : 'sitemaps not readable') + '.');
  return data;
}

// ── Check engine (pure) ──────────────────────────────────────────────

const GSC_AREAS = ['Property & access', 'Sitemaps & indexing', 'Search vs analytics'];
const GSC_WEIGHTS = { 'Property & access': 1, 'Sitemaps & indexing': 1.5, 'Search vs analytics': 2 };
const GSC_PENALTY = { High: 30, Medium: 12, Low: 4 };
const GSC_STAGING = /(^|[.-])(dev|stag(e|ing)?|test|uat|qa|preview|sandbox)([.-]|\d|$)/i;

/**
 * Builds the Search Console report.
 *  data:  fetchGscData() result
 *  ga4:   { source, organic: { total, complete, pages: [{ host, path, sessions }] } } or null
 *  pageSource: pasted page source ('' if none)
 */
function buildGscResult(data, ga4, pageSource, meta) {
  meta = meta || {};
  const issues = [];
  const add = (area, severity, finding, action, items) =>
    issues.push({ area: area, severity: severity, finding: finding, action: action, where: 'Search Console · ' + (data.property || data.host), items: items || [] });
  const fmt = n => Number(n || 0).toLocaleString('en-GB');
  const host = data.host;
  const hasProp = !!data.property;

  // Property & access
  const tags = gscVerificationTags(pageSource);
  if (!hasProp) {
    add('Property & access', 'Medium', data.matches.length
      ? 'Search Console lists ' + host + ' for your account, but unverified: no data can be read'
      : 'No Search Console property you can access covers ' + host,
    'Ask the client for Full user access to a Domain property (sc-domain:' + host + '), or create and verify one, then run the check again');
  } else {
    if (!data.matches.some(m => m.kind === 'Domain' && m.permissionLevel !== 'siteUnverifiedUser')) {
      add('Property & access', 'Low', 'Only URL-prefix properties cover ' + host + ' (no Domain property)',
        'Add a Domain property (sc-domain:' + host + ') so every subdomain and both http and https are covered in one place');
    }
    if (data.permission === 'siteRestrictedUser') {
      add('Property & access', 'Low', 'Your access to ' + data.property + ' is restricted',
        'Ask for Full user access; some data and the sitemap list can be limited with restricted access');
    }
  }
  if (tags.length > 1) {
    add('Property & access', 'Low', tags.length + ' Search Console verification tags in the page source (one per verified owner)',
      'Review the owners in Search Console → Settings → Users and permissions, and remove the tags and owners that are no longer needed, such as former agencies');
  }

  // Sitemaps & indexing
  const maps = data.sitemaps;
  if (hasProp && maps) {
    if (!maps.length) add('Sitemaps & indexing', 'Medium', 'No sitemap submitted', 'Submit the XML sitemap in Search Console → Sitemaps and reference it in robots.txt');
    const withErr = maps.filter(m => m.errors > 0);
    if (withErr.length) {
      add('Sitemaps & indexing', 'Medium', withErr.length + ' sitemap(s) with errors (' + fmt(withErr.reduce((s, m) => s + m.errors, 0)) + ' in total)',
        'Open each sitemap in Search Console, fix the errors (unreachable or invalid URLs, wrong format) and resubmit', withErr.map(m => m.path + ' (' + m.errors + ')'));
    }
    const withWarn = maps.filter(m => m.warnings > 0);
    if (withWarn.length) {
      add('Sitemaps & indexing', 'Low', withWarn.length + ' sitemap(s) with warnings (' + fmt(withWarn.reduce((s, m) => s + m.warnings, 0)) + ' in total)',
        'Review the warnings, often blocked or redirected URLs listed in the sitemap', withWarn.map(m => m.path + ' (' + m.warnings + ')'));
    }
    const now = Date.parse(meta.date || data.date) || Date.now();
    const stale = maps.filter(m => !m.isPending && m.lastDownloaded && now - Date.parse(m.lastDownloaded) > 30 * 86400000);
    if (stale.length) {
      add('Sitemaps & indexing', 'Low', stale.length + ' sitemap(s) not read by Google for over 30 days',
        'Check the sitemaps are still current and reachable; remove old ones and resubmit the current one', stale.map(m => m.path));
    }
  }
  const pages = data.pages || [];
  if (hasProp && pages.length) {
    const http = pages.filter(p => p.protocol === 'http' && p.clicks > 0);
    if (http.length) {
      add('Sitemaps & indexing', 'Medium', http.length + ' page(s) reached from Google search over http:// (' + fmt(http.reduce((s, p) => s + p.clicks, 0)) + ' clicks)',
        'Redirect http to https permanently (301) and make sure canonical tags and sitemaps use https', http.slice(0, 20).map(p => 'http://' + p.host + p.path));
    }
    const staging = pages.filter(p => GSC_STAGING.test(p.host.replace(/^www\./, '').replace(host, '')) && p.clicks > 0);
    if (staging.length) {
      add('Sitemaps & indexing', 'Medium', 'Test or staging hosts appear in Google search (' + Array.from(new Set(staging.map(p => p.host))).join(', ') + ')',
        'Block those hosts from indexing (password protection or noindex) and remove them from Google with the Removals tool');
    }
    const www = pages.filter(p => p.host === 'www.' + host).reduce((s, p) => s + p.clicks, 0);
    const bare = pages.filter(p => p.host === host).reduce((s, p) => s + p.clicks, 0);
    const minor = Math.min(www, bare), all = www + bare;
    if (minor > 0 && all && minor / all >= 0.02) {
      add('Sitemaps & indexing', 'Low', 'Search traffic lands on both ' + host + ' and www.' + host,
        'Redirect one version to the other (301) and use the same version in canonical tags, sitemaps and internal links');
    }
  }

  // Search vs analytics (GA4 organic Google sessions)
  const org = ga4 && ga4.organic;
  let ga4Total = null, pageRows = [];
  if (hasProp && org && data.totals) {
    const onSite = h => { h = String(h || '').replace(/^www\./, ''); return h === host || h.endsWith('.' + host); };
    const ga4Pages = new Map();
    org.pages.filter(p => !p.host || onSite(p.host)).forEach(p => ga4Pages.set(p.path, (ga4Pages.get(p.path) || 0) + p.sessions));
    ga4Total = org.total;
    const clicks = data.totals.clicks;
    const ratio = clicks ? Math.round(ga4Total / clicks * 100) : null;
    if (clicks >= 100 && ratio !== null && ratio < 50) {
      add('Search vs analytics', 'Medium', 'GA4 records ' + fmt(ga4Total) + ' organic Google sessions for ' + fmt(clicks) + ' Search Console clicks (' + ratio + '%)',
        'Check the consent banner\'s rejection rate and Consent Mode, that the GA4 tag loads on every landing page, and that redirects or internal UTM links do not overwrite google / organic');
    }
    // Pages with search clicks but no GA4 organic sessions (only where GA4's list is complete enough to tell)
    const minListed = org.pages.length ? Math.min(...org.pages.map(p => p.sessions)) : 0;
    const byPath = new Map();
    pages.filter(p => onSite(p.host)).forEach(p => {
      const r = byPath.get(p.path) || { path: p.path, clicks: 0, impressions: 0 };
      r.clicks += p.clicks; r.impressions += p.impressions;
      byPath.set(p.path, r);
    });
    pageRows = Array.from(byPath.values()).sort((a, b) => b.clicks - a.clicks).map(r => {
      const s = ga4Pages.has(r.path) ? ga4Pages.get(r.path) : 0;
      return Object.assign(r, { sessions: s, ratio: r.clicks ? Math.round(s / r.clicks * 100) : null });
    });
    const missing = pageRows.filter(r => r.clicks >= 20 && r.sessions === 0 && (org.complete || r.clicks > minListed));
    if (missing.length) {
      add('Search vs analytics', 'Medium', missing.length + ' page(s) get Google search clicks but no GA4 organic sessions',
        'Check the GTM container (and so the GA4 tag) loads on these pages: they may use another template, a separate app, or redirect before the tag fires',
        missing.slice(0, 25).map(r => r.path + ' (' + fmt(r.clicks) + ' clicks)'));
    }
  }

  const sorted = issues.sort((a, b) => ({ High: 0, Medium: 1, Low: 2 })[a.severity] - ({ High: 0, Medium: 1, Low: 2 })[b.severity]);
  const checked = area => area === 'Property & access' || (hasProp && (area === 'Sitemaps & indexing' ? !!maps : !!(org && data.totals)));
  const areas = GSC_AREAS.map(area => {
    const list = sorted.filter(i => i.area === area);
    const isChecked = checked(area);
    return {
      area: area,
      score: isChecked ? Math.max(0, 100 - list.reduce((s, i) => s + GSC_PENALTY[i.severity], 0)) : null,
      status: list.length ? (list[0].severity === 'High' ? 'Action needed' : list[0].severity === 'Medium' ? 'Review' : 'Minor') : isChecked ? 'No issues' : 'Not checked',
      findings: list.length ? list.map(i => i.finding) : isChecked ? [] : [
        !hasProp ? 'Needs access to the site\'s Search Console property'
          : area === 'Search vs analytics' ? 'Run the GA4 audit for this site to compare search clicks with organic sessions'
          : 'Sitemaps could not be read'],
      action: list[0] ? list[0].action : '', top: list[0] ? list[0].severity : null
    };
  });
  let total = 0, weight = 0;
  areas.forEach(a => { if (a.score !== null) { total += a.score * GSC_WEIGHTS[a.area]; weight += GSC_WEIGHTS[a.area]; } });
  const score = weight ? Math.round(total / weight) : 100;

  return {
    meta: { client: meta.client || '', site: data.site || meta.site || '', date: meta.date || data.date },
    host: host, property: data.property, permission: data.permission, matches: data.matches, sitesCount: data.sitesCount,
    start: data.start, end: data.end,
    summary: {
      clicks: data.totals ? data.totals.clicks : null, impressions: data.totals ? data.totals.impressions : null,
      position: data.totals ? data.totals.position : null, ga4Sessions: ga4Total,
      sitemaps: maps ? maps.length : null, verificationTags: pageSource ? tags.length : null
    },
    issues: sorted, areas: areas, score: { score: score, grade: score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : score >= 40 ? 'D' : 'E' },
    pages: pageRows.length ? pageRows.slice(0, 200) : pages.slice(0, 200).map(p => ({ path: p.path, clicks: p.clicks, impressions: p.impressions, sessions: null, ratio: null })),
    sitemaps: maps || [],
    ga4Source: ga4 && org ? ga4.source : null,
    coverage: [
      hasProp ? 'Search Console property ' + data.property + ' (' + data.permission + '), web search, ' + data.start + ' to ' + data.end + '. Search Console data runs about 3 days behind.'
        : 'No readable Search Console property for ' + host + ' among the ' + data.sitesCount + ' properties this account can see.',
      org ? 'Compared with organic Google sessions in GA4 (' + ga4.source + ') for the same 28 days, per site and per landing page path.'
        : 'Not compared with GA4: run the GA4 audit for this site first.',
      'Pages are compared on their path only (no query string). Search Console lists the top ' + GSC_PAGE_LIMIT + ' pages by clicks. Page addresses that look like they contain personal data are masked.',
      pageSource ? 'Verification tags were counted in the page source pasted on New audit.' : 'Paste the page source on New audit to count Search Console verification tags.',
      'Not readable with read-only access: the list of owners and users, indexing coverage per page and the link between Search Console and GA4. Check those in Search Console.'
    ].concat(data.unavailable.length ? ['Could not be read: ' + data.unavailable.join(', ') + '.'] : [])
  };
}
