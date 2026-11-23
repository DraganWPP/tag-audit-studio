// ════════════════════════════════════════════════════════════════════
//  Google Search Console (read-only, optional permission webmasters.readonly)
//
//  Search Console has no link to GTM, so the property is found from the website:
//  the Search Console properties the signed-in account can see are matched to the
//  site's hostname (Domain properties "sc-domain:" and URL-prefix properties).
// ════════════════════════════════════════════════════════════════════

const GSC_API = 'https://searchconsole.googleapis.com/webmasters/v3/';

/** Properties the signed-in account can see: [{ siteUrl, permissionLevel }]. */
async function gscSites() {
  const res = await Google.get(GSC_API + 'sites');
  return (res.siteEntry || []).map(s => ({ siteUrl: s.siteUrl, permissionLevel: s.permissionLevel }));
}

function gscHost_(url) {
  const s = String(url || '').trim().toLowerCase();
  if (!s) return '';
  try { return new URL(/^[a-z]+:\/\//.test(s) ? s : 'https://' + s).hostname.replace(/^www\./, ''); }
  catch (e) { return ''; }
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
      if (host === d || host.endsWith('.' + d) || d.endsWith('.' + host)) out.push(Object.assign({ kind: 'Domain', exact: host === d }, s));
    } else {
      const h = gscHost_(u);
      if (h && h === host) out.push(Object.assign({ kind: 'URL prefix', exact: true }, s));
    }
  });
  const rank = m => (m.kind === 'Domain' ? 0 : 2) + (m.exact ? 0 : 1) + (/https:/i.test(m.siteUrl) ? 0 : 0.5) +
    (/siteUnverifiedUser/.test(m.permissionLevel) ? 10 : 0);
  return out.sort((a, b) => rank(a) - rank(b));
}

function gscDate_(daysAgo) {
  const d = new Date(Date.now() - daysAgo * 86400000);
  return d.toISOString().slice(0, 10);
}

/**
 * Search performance for a property. Search Console data lags by about 2–3 days,
 * so the range ends 3 days ago. dimensions: [] gives one totals row.
 */
async function gscQuery(siteUrl, dimensions, days, rowLimit) {
  const end = gscDate_(3), start = gscDate_(3 + (days || 28) - 1);
  const res = await Google.post(GSC_API + 'sites/' + encodeURIComponent(siteUrl) + '/searchAnalytics/query', {
    startDate: start, endDate: end, dimensions: dimensions || [], rowLimit: rowLimit || 1000
  });
  return { start: start, end: end, rows: res.rows || [] };
}

/** Sitemaps submitted for a property: [{ path, errors, warnings, isPending, lastDownloaded, lastSubmitted }]. */
async function gscSitemaps(siteUrl) {
  const res = await Google.get(GSC_API + 'sites/' + encodeURIComponent(siteUrl) + '/sitemaps');
  return (res.sitemap || []).map(s => ({
    path: s.path, errors: Number(s.errors) || 0, warnings: Number(s.warnings) || 0, isPending: !!s.isPending,
    lastDownloaded: s.lastDownloaded || '', lastSubmitted: s.lastSubmitted || ''
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
