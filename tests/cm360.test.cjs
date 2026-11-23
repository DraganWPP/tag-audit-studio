'use strict';

// CM360 cross-check tests: report parsing, Floodlight tag capture in the GTM engine, matching and issues.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const ctx = vm.createContext({ console, URL, URLSearchParams, setTimeout, clearTimeout });
['js/engine.js', 'js/engine-web.js', 'js/google.js', 'js/ga4.js', 'js/cm360.js'].forEach(f =>
  vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), ctx, { filename: f }));
const g = name => vm.runInContext(name, ctx);
const run = code => vm.runInContext(code, ctx);

const preamble = '"Tag Audit Studio (temporary, deleted automatically)"\n\nDate/Time Generated,11/23/26 11:33 AM\n' +
  'Report Time Zone,Europe/London\nAccount ID,5960\nDate Range,10/24/26 - 11/22/26\n' +
  'MRC Accredited Metrics,"Clicks(Desktop Display, Mobile Video)",Active View metrics are accredited only when Measurement Source = Measured\n\nReport Fields\n';
const FLOODLIGHT_CSV = preamble + 'Activity Group,Activity Group ID,Activity,Activity ID,Total Conversions,Click-through Conversions,View-through Conversions\n' +
  'Leads,111,Book Test Drive,9001,120,80,40\nLeads,111,Brochure Download,9002,0,0,0\nSales,222,"Finance Quote, Online",9003,35,20,15\n' +
  'Leads,111,Dealer Locator,9004,12,6,6\nGrand Total:,,,,167,106,61\n';
const DELIVERY_CSV = preamble + 'Campaign,Campaign ID,Site (CM360),Impressions,Clicks\n' +
  'Omoda 5 Launch,501,Site A,100000,900\nOmoda 5 Launch,501,Site B,50000,300\nJaecoo Awareness,502,Site A,80000,400\n' +
  'Winter Offers,503,Site C,30000,150\nDART Search,504,Search,10,5665\nGrand Total:,,,260010,7415\n';

/** A GTM export with Floodlight tags in three forms: template, gtag send_to and Custom HTML iframe. */
const EXPORT = JSON.stringify({ containerVersion: {
  container: { publicId: 'GTM-FLTEST' },
  trigger: [{ triggerId: '1', name: 'All Pages', type: 'pageview' }],
  tag: [
    { tagId: '1', name: 'FL - Book Test Drive', type: 'flc', firingTriggerId: ['1'], parameter: [
      { type: 'template', key: 'advertiserId', value: '1234567' }, { type: 'template', key: 'groupTag', value: 'leads0' },
      { type: 'template', key: 'activityTag', value: 'bookt0' }, { type: 'template', key: 'countingMethod', value: 'STANDARD' },
      { type: 'list', key: 'customVariable', list: [{ type: 'map', map: [
        { type: 'template', key: 'key', value: 'u1' }, { type: 'template', key: 'value', value: '{{Model}}' }] }] }] },
    { tagId: '2', name: 'FL - Brochure Download', type: 'flc', firingTriggerId: ['1'], parameter: [
      { type: 'template', key: 'advertiserId', value: '1234567' }, { type: 'template', key: 'groupTag', value: 'leads0' },
      { type: 'template', key: 'activityTag', value: 'broch0' }] },
    { tagId: '3', name: 'FL - Old agency newsletter', type: 'html', firingTriggerId: ['1'], parameter: [
      { type: 'template', key: 'html', value: '<iframe src="https://5555555.fls.doubleclick.net/activityi;src=5555555;type=news0;cat=signu0;u2=x;ord=1?"></iframe>' }] },
    { tagId: '4', name: 'Gtag configurator event', type: 'html', firingTriggerId: ['1'], parameter: [
      { type: 'template', key: 'html', value: "<script>gtag('event','conversion',{send_to:'DC-1234567/leads0/confi0+standard'});</script>" }] },
    { tagId: '5', name: 'FL - Paused', type: 'flc', paused: true, firingTriggerId: ['1'], parameter: [
      { type: 'template', key: 'advertiserId', value: '1234567' }, { type: 'template', key: 'groupTag', value: 'x' },
      { type: 'template', key: 'activityTag', value: 'y' }] }
  ] } });

function gtmResult() {
  run('resetAudit_(); WEB_SETTINGS = {}; TAG_OVERRIDES = {};');
  ctx.__export = EXPORT;
  run('analyseExportJson_(__export)');
  return JSON.parse(run('JSON.stringify({ audit: { floodlightTags: AUDIT.floodlightTags, tags: AUDIT.tags.map(t => ({ label: t.label, risk: t.risk })) } })'));
}

test('report CSVs: preamble, quoted commas and totals handled; kind detected', () => {
  const parse = g('cm360ParseReport');
  const fl = parse(FLOODLIGHT_CSV);
  assert.equal(fl.kind, 'floodlight');
  assert.equal(fl.activities.length, 4);
  assert.equal(fl.activities[2].name, 'Finance Quote, Online');
  assert.equal(fl.activities[0].conversions, 120);
  assert.equal(fl.activities[0].clickThrough, 80);
  const del = parse(DELIVERY_CSV);
  assert.equal(del.kind, 'delivery');
  assert.equal(del.rows.length, 5);
  assert.equal(del.rows[0].impressions, 100000);
  assert.throws(() => parse(preamble + 'Foo,Bar\n1,2\n'), /not one of the two CM360 reports/);
});

test('GTM engine captures Floodlight tags from templates, gtag send_to and Custom HTML', () => {
  const r = gtmResult();
  const keys = r.audit.floodlightTags.map(f => f.src + '/' + f.type + '/' + f.cat + (f.paused ? ' (paused)' : ''));
  for (const k of ['1234567/leads0/bookt0', '1234567/leads0/broch0', '5555555/news0/signu0', '1234567/leads0/confi0', '1234567/x/y (paused)']) {
    assert.ok(keys.includes(k), 'missing ' + k + ' in ' + keys.join(', '));
  }
  const book = r.audit.floodlightTags.find(f => f.cat === 'bookt0');
  assert.equal(book.method, 'STANDARD');
  assert.equal(JSON.stringify(book.uVars), '["u1"]');
  assert.equal(JSON.stringify(r.audit.floodlightTags.find(f => f.cat === 'signu0').uVars), '["u2"]');
});

function cmData(over) {
  const parse = g('cm360ParseReport');
  return Object.assign({
    account: 'Agency CM360', accountId: '777', configId: '1234567', configsOwned: ['1234567', '7654321'],
    metrics: ['totalConversions'], catalog: [{ id: '9005', name: 'Configurator Complete' }],
    activities: parse(FLOODLIGHT_CSV).activities, delivery: parse(DELIVERY_CSV).rows
  }, over || {});
}
const ga4 = { source: 'Omoda UK - GA4', campaigns: [
  { campaign: 'Omoda 5 Launch', sourceMedium: 'cm360 / display', sessions: 1000 },
  { campaign: 'jaecoo_awareness', sourceMedium: 'cm360 / display', sessions: 90 } ] };
const has = (r, sev, area, re) => r.issues.some(i => i.severity === sev && i.area === area && re.test(i.finding));

test('cross-check: matching, Floodlight issues and delivery vs GA4', () => {
  const tags = g('cm360GtmTags')(gtmResult());
  assert.equal(tags.length, 4, 'paused tag left out');
  const r = g('buildCm360Result')(cmData(), tags, ga4, {}, {});
  const row = cat => r.mappingRows.find(m => m.cat === cat);
  assert.equal(row('bookt0').activityName, 'Book Test Drive');
  assert.equal(row('bookt0').status, 'Suggested');
  assert.equal(row('broch0').activityName, 'Brochure Download');
  assert.equal(row('confi0').activityName, 'Configurator Complete', 'catalogue activity without conversions can be matched');
  // Issues
  assert.ok(has(r, 'Medium', 'Floodlight setup', /1 configuration\(s\) none of your CM360 accounts/), 'foreign src 5555555');
  assert.ok(has(r, 'Medium', 'Floodlight vs GTM', /2 Floodlight tag\(s\) in GTM whose activity recorded no conversions/));
  assert.ok(has(r, 'Low', 'Floodlight vs GTM', /record conversions but no tag/), 'Finance Quote and Dealer Locator');
  assert.ok(has(r, 'Medium', 'Delivery vs analytics', /clicks but no GA4 sessions/), 'Winter Offers');
  assert.ok(has(r, 'Medium', 'Delivery vs analytics', /under half as many sessions/), 'Jaecoo 400 clicks vs 90 sessions');
  const omoda = r.delivery.find(d => d.campaign === 'Omoda 5 Launch');
  assert.equal(omoda.clicks, 1200);
  assert.equal(omoda.sessions, 1000);
  assert.ok(r.delivery.find(d => d.campaign === 'DART Search').search, 'search campaign not compared');
  assert.ok(!r.issues.some(i => /DART Search/.test((i.items || []).join(' '))));
  assert.equal(r.summary.conversions, 167);
});

test('analyst mapping overrides the suggestion and is reflected in issues', () => {
  const tags = g('cm360GtmTags')(gtmResult());
  const key = tags.find(t => t.cat === 'broch0').key;
  const r = g('buildCm360Result')(cmData(), tags, ga4, { [key]: '9004' }, {});
  const row = r.mappingRows.find(m => m.key === key);
  assert.equal(row.status, 'Confirmed');
  assert.equal(row.activityName, 'Dealer Locator');
  assert.ok(has(r, 'Medium', 'Floodlight vs GTM', /^1 Floodlight tag\(s\) in GTM whose activity recorded no conversions/), 'only Configurator now');
  const none = g('buildCm360Result')(cmData(), tags, ga4, { [key]: 'none' }, {});
  assert.equal(none.mappingRows.find(m => m.key === key).status, 'No CM360 activity');
});

test('without GTM or GA4: those areas are not checked; clean data gives no issues', () => {
  const r = g('buildCm360Result')(cmData(), [], null, {}, {});
  assert.equal(r.areas.find(a => a.area === 'Floodlight vs GTM').status, 'Not checked');
  assert.equal(r.areas.find(a => a.area === 'Delivery vs analytics').status, 'Not checked');
  assert.equal(r.issues.length, 0);
  const clean = g('buildCm360Result')(cmData({ activities: [{ id: '9001', name: 'Book Test Drive', group: 'Leads', conversions: 5 }],
    catalog: [], delivery: [{ campaign: 'Omoda 5 Launch', campaignId: '501', site: 'A', impressions: 1000, clicks: 120 }] }),
    g('cm360GtmTags')(gtmResult()).filter(t => t.cat === 'bookt0'), { source: 'x', campaigns: [{ campaign: 'Omoda 5 Launch', sessions: 100 }] }, {}, {});
  assert.equal(clean.issues.length, 0, clean.issues.map(i => i.finding).join('\n'));
  assert.equal(clean.score.grade, 'A');
});
