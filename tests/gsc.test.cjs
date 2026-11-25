'use strict';

// Search Console check tests: property matching, page keys, verification tags and the check engine.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const ctx = vm.createContext({ console, URL, URLSearchParams, setTimeout, clearTimeout });
['js/engine.js', 'js/engine-web.js', 'js/google.js', 'js/gsc.js'].forEach(f =>
  vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), ctx, { filename: f }));
const g = name => vm.runInContext(name, ctx);
const plain = x => JSON.parse(JSON.stringify(x));

const SITES = [
  { siteUrl: 'https://www.example.co.uk/', permissionLevel: 'siteOwner' },
  { siteUrl: 'sc-domain:example.co.uk', permissionLevel: 'siteFullUser' },
  { siteUrl: 'http://example.co.uk/', permissionLevel: 'siteRestrictedUser' },
  { siteUrl: 'sc-domain:notexample.co.uk', permissionLevel: 'siteFullUser' },
  { siteUrl: 'https://shop.other.com/', permissionLevel: 'siteFullUser' }
];

test('property matching: Domain first, subdomains covered, other domains not', () => {
  const m = plain(g('gscMatchSites')('https://www.example.co.uk/models?x=1', SITES));
  assert.deepEqual(m.map(x => x.siteUrl), ['sc-domain:example.co.uk', 'https://www.example.co.uk/', 'http://example.co.uk/']);
  assert.equal(m[0].kind, 'Domain');
  const sub = plain(g('gscMatchSites')('blog.example.co.uk', SITES));
  assert.deepEqual(sub.map(x => x.siteUrl), ['sc-domain:example.co.uk'], 'Domain property covers subdomains; URL prefix does not');
  assert.equal(g('gscMatchSites')('nothing.org', SITES).length, 0);
  assert.equal(g('gscMatchSites')('', SITES).length, 0);
});

test('page keys match GA4 landing pages; personal data masked; verification tags counted', () => {
  const k = g('gscPathKey_');
  assert.equal(k('https://www.example.co.uk/Products/Gadget-5/?utm_source=x#top'), '/products/gadget-5');
  assert.equal(k('/products/gadget-5'), '/products/gadget-5');
  assert.equal(k('https://www.example.co.uk/'), '/');
  assert.equal(k('/thanks/someone@example.com'), '/thanks/[email]');
  const tags = g('gscVerificationTags')('<meta name="google-site-verification" content="aaa"><meta content="bbb" name=\'google-site-verification\'>' +
    '<meta name="google-site-verification" content="aaa"><meta name="description" content="x">');
  assert.equal(tags.length, 2);
});

function data(over) {
  return Object.assign({
    date: '2026-11-23T10:00:00Z', site: 'https://www.example.co.uk', host: 'example.co.uk', sitesCount: 5,
    matches: plain(g('gscMatchSites')('https://www.example.co.uk', SITES)), property: 'sc-domain:example.co.uk', permission: 'siteFullUser',
    start: '2026-10-24', end: '2026-11-20', totals: { clicks: 10000, impressions: 400000, position: 9.1 }, pagesComplete: true,
    pages: [
      { host: 'www.example.co.uk', protocol: 'https', path: '/', clicks: 6000, impressions: 100000 },
      { host: 'www.example.co.uk', protocol: 'https', path: '/products/gadget-5', clicks: 2500, impressions: 90000 },
      { host: 'www.example.co.uk', protocol: 'https', path: '/finance', clicks: 900, impressions: 30000 },
      { host: 'www.example.co.uk', protocol: 'https', path: '/tiny', clicks: 5, impressions: 300 },
      { host: 'example.co.uk', protocol: 'http', path: '/old-page', clicks: 400, impressions: 9000 },
      { host: 'staging.example.co.uk', protocol: 'https', path: '/', clicks: 30, impressions: 500 }
    ],
    sitemaps: [
      { path: 'https://www.example.co.uk/sitemap.xml', errors: 7, warnings: 41, isPending: false, lastDownloaded: '2026-11-20T00:00:00Z' },
      { path: 'https://www.example.co.uk/old-sitemap.xml', errors: 0, warnings: 0, isPending: false, lastDownloaded: '2026-06-01T00:00:00Z' }
    ],
    unavailable: []
  }, over || {});
}
const ga4 = { source: 'Example - GA4', organic: { total: 4000, complete: true, pages: [
  { host: 'www.example.co.uk', path: '/', sessions: 3000 },
  { host: 'www.example.co.uk', path: '/products/gadget-5', sessions: 1000 },
  { host: 'other-site.com', path: '/finance', sessions: 999 }   // another host: not counted for this site
] } };
const has = (r, sev, area, re) => r.issues.some(i => i.severity === sev && i.area === area && re.test(i.finding));

test('check engine: sitemaps, hosts and search vs GA4 findings', () => {
  const r = plain(g('buildGscResult')(data(), ga4, '<meta name="google-site-verification" content="a"><meta name="google-site-verification" content="b">', {}));
  assert.ok(has(r, 'Medium', 'Sitemaps & indexing', /1 sitemap\(s\) with errors \(7/));
  assert.ok(has(r, 'Low', 'Sitemaps & indexing', /with warnings \(41/));
  assert.ok(has(r, 'Low', 'Sitemaps & indexing', /not read by Google for over 30 days/));
  assert.ok(has(r, 'Medium', 'Sitemaps & indexing', /over http:\/\//));
  assert.ok(has(r, 'Medium', 'Sitemaps & indexing', /staging/));
  assert.ok(has(r, 'Low', 'Sitemaps & indexing', /both example\.co\.uk and www\.example\.co\.uk/));
  assert.ok(has(r, 'Medium', 'Search vs analytics', /4,000 organic Google sessions for 10,000 Search Console clicks \(40%\)/));
  const missing = r.issues.find(i => /no GA4 organic sessions/.test(i.finding));
  assert.ok(missing, 'pages with clicks but no sessions');
  assert.deepEqual(missing.items.filter(x => /finance/.test(x)).length, 1, '/finance on another host in GA4 does not count');
  assert.ok(!missing.items.some(x => /tiny/.test(x)), 'pages under 20 clicks are not flagged');
  assert.ok(has(r, 'Low', 'Property & access', /2 Search Console verification tags/));
  assert.ok(!has(r, 'Low', 'Property & access', /Only URL-prefix/), 'Domain property exists');
  const gadget = r.pages.find(p => p.path === '/products/gadget-5');
  assert.equal(gadget.sessions, 1000);
  assert.equal(gadget.ratio, 40);
  assert.equal(r.summary.ga4Sessions, 4000);
  assert.ok(r.areas.every(a => a.score !== null));
});

test('no property: access finding only, other areas not checked; URL-prefix only gets a Low', () => {
  const none = plain(g('buildGscResult')(data({ property: null, permission: '', matches: [], totals: null, pages: null, sitemaps: null }), ga4, '', {}));
  assert.equal(none.issues.length, 1);
  assert.ok(has(none, 'Medium', 'Property & access', /No Search Console property you can access covers example\.co\.uk/));
  assert.equal(none.areas.find(a => a.area === 'Search vs analytics').status, 'Not checked');
  assert.equal(none.areas.find(a => a.area === 'Sitemaps & indexing').status, 'Not checked');
  const prefixOnly = plain(g('buildGscResult')(data({ matches: [{ siteUrl: 'https://www.example.co.uk/', permissionLevel: 'siteOwner', kind: 'URL prefix', exact: true }],
    property: 'https://www.example.co.uk/', permission: 'siteOwner' }), null, '', {}));
  assert.ok(has(prefixOnly, 'Low', 'Property & access', /Only URL-prefix/));
  assert.equal(prefixOnly.areas.find(a => a.area === 'Search vs analytics').status, 'Not checked');
});

test('clean property gives no findings and grade A', () => {
  const clean = plain(g('buildGscResult')(data({
    pages: [{ host: 'www.example.co.uk', protocol: 'https', path: '/', clicks: 1000, impressions: 9000 }],
    totals: { clicks: 1000, impressions: 9000, position: 5 },
    sitemaps: [{ path: 'https://www.example.co.uk/sitemap.xml', errors: 0, warnings: 0, isPending: false, lastDownloaded: '2026-11-20T00:00:00Z' }]
  }), { source: 'x', organic: { total: 900, complete: true, pages: [{ host: 'www.example.co.uk', path: '/', sessions: 900 }] } }, '', {}));
  assert.equal(clean.issues.length, 0, clean.issues.map(i => i.finding).join('\n'));
  assert.equal(clean.score.grade, 'A');
});
