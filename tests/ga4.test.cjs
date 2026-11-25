'use strict';

// GA4 audit engine tests: loads the browser scripts into a vm context and feeds fixture API data.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const ctx = vm.createContext({ console, URL, URLSearchParams, setTimeout, clearTimeout });
['js/engine.js', 'js/engine-web.js', 'js/google.js', 'js/ga4.js', 'js/report.js'].forEach(f =>
  vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), ctx, { filename: f }));
const g = name => vm.runInContext(name, ctx);
const buildGa4Result = g('buildGa4Result');
const ga4GtmContext = g('ga4GtmContext');
const maskPiiUrl_ = g('maskPiiUrl_');
const ga4ClientReportModel = g('ga4ClientReportModel');

const stream = (over) => Object.assign({
  id: '111', name: 'properties/1/dataStreams/111', type: 'WEB_DATA_STREAM', displayName: 'Website',
  measurementId: 'G-AAA111', defaultUri: 'https://www.example.co.uk',
  enhanced: { streamEnabled: true, scrollsEnabled: true, outboundClicksEnabled: true, siteSearchEnabled: false,
              videoEngagementEnabled: false, fileDownloadsEnabled: true, formInteractionsEnabled: false },
  redaction: { emailRedactionEnabled: true, queryParameterRedactionEnabled: false },
  createRules: [], editRules: [], mpSecrets: 0
}, over || {});

/** A healthy property: nothing should be flagged. */
function cleanData() {
  return {
    property: 'properties/1', displayName: 'Example UK', account: 'Example', fetchedAt: '2026-11-18T10:00:00Z',
    admin: {
      property: { name: 'properties/1', displayName: 'Example UK', timeZone: 'Europe/London', currencyCode: 'GBP',
                  serviceLevel: 'GOOGLE_ANALYTICS_STANDARD', parent: 'accounts/9' },
      streams: [stream()],
      retention: { eventDataRetention: 'FOURTEEN_MONTHS', userDataRetention: 'FOURTEEN_MONTHS', resetUserDataOnNewActivity: true },
      customDimensions: [{ parameterName: 'form_name', displayName: 'Form name', scope: 'EVENT' }],
      customMetrics: [], keyEvents: [{ eventName: 'generate_lead', countingMethod: 'ONCE_PER_EVENT' },
                                     { eventName: 'purchase', countingMethod: 'ONCE_PER_EVENT' }],
      adsLinks: [{ customerId: '1234567890', adsPersonalizationEnabled: true }], firebaseLinks: [],
      signals: { state: 'GOOGLE_SIGNALS_ENABLED' }, attribution: { reportingAttributionModel: 'PAID_AND_ORGANIC_CHANNELS_DATA_DRIVEN' },
      dataSharing: { sharingWithGoogleProductsEnabled: true }, audiences: ['All users'], channelGroups: ['Default'],
      calculatedMetrics: [], bigQueryLinks: [], dv360Links: [], sa360Links: [], adSenseLinks: [], annotations: []
    },
    data: {
      thresholded: false, otherRow: false,
      events: [
        { name: 'page_view', count: 10000, users: 4000, keyEvents: 0 },
        { name: 'scroll', count: 3000, users: 2000, keyEvents: 0 },
        { name: 'generate_lead', count: 120, users: 110, keyEvents: 120 },
        { name: 'purchase', count: 50, users: 48, keyEvents: 50 }
      ],
      streams: [{ id: '111', name: 'Website', count: 13170 }],
      hosts: [{ host: 'www.example.co.uk', count: 13170 }],
      channels: [{ name: 'Organic Search', sessions: 3000 }, { name: 'Direct', sessions: 1000 }, { name: 'Unassigned', sessions: 20 }],
      sources: [{ source: 'google', sessions: 3000 }, { source: '(direct)', sessions: 1000 }],
      landingNotSet: 10,
      purchases: { events: 50, ids: 50, notSet: 0, duplicateIds: 0, revenue: 5000, ecommercePurchases: 50 },
      piiPages: [], dimFill: [{ param: 'form_name', scope: 'EVENT', total: 13170, notSet: 13050, withValue: 120,
                   sentWith: [{ name: 'generate_lead', withValue: 120, count: 120 }] }], realtime: 12
    },
    unavailable: []
  };
}

/** A fake serialised GTM result that sends to G-AAA111. */
function gtmResult(over) {
  return Object.assign({
    meta: { sources: ['GTM API GTM-TEST1 (live version)'] },
    audit: {
      fullDetail: true, tags: [{ type: 'awct', paused: false }],
      ids: { 'GA4|G-AAA111': { platform: 'GA4', id: 'G-AAA111', live: true } },
      ga4Events: [
        { name: 'generate_lead', params: ['form_name'], where: 'GTM-TEST1 · GA4 - Lead', mid: 'G-AAA111' },
        { name: 'purchase', params: ['transaction_id', 'value'], where: 'GTM-TEST1 · GA4 - Purchase', mid: '' }
      ],
      googleTags: [{ id: 'G-AAA111' }], pageGoogleConfigs: [], userProps: [], gtagSettings: {}
    }
  }, over || {});
}

const findings = r => r.issues.map(i => i.severity + ' | ' + i.area + ' | ' + i.finding);
const has = (r, sev, area, re) => r.issues.some(i => i.severity === sev && i.area === area && re.test(i.finding));

test('clean property: no issues, grade A, every area checked', () => {
  const r = buildGa4Result(cleanData(), ga4GtmContext(gtmResult()), { site: 'https://www.example.co.uk' });
  assert.equal(r.issues.length, 0, findings(r).join('\n'));   // arrays from the vm context are not deepEqual-comparable
  assert.equal(r.score.grade, 'A');
  assert.equal(r.score.score, 100);
  assert.ok(r.areas.every(a => a.score === 100), JSON.stringify(r.areas.map(a => [a.area, a.score])));
  assert.equal(r.gtmSource, 'GTM API GTM-TEST1 (live version)');
});

test('problem property: each check fires at the right severity', () => {
  const d = cleanData();
  d.admin.streams.push(stream({ id: '222', name: 'properties/1/dataStreams/222', displayName: 'Old site', measurementId: 'G-BBB222',
    redaction: { emailRedactionEnabled: false }, mpSecrets: 2 }));
  d.admin.retention = { eventDataRetention: 'TWO_MONTHS', resetUserDataOnNewActivity: false };
  d.admin.keyEvents.push({ eventName: 'sign_up', countingMethod: 'ONCE_PER_EVENT' });
  d.admin.keyEvents[1].countingMethod = 'ONCE_PER_SESSION';
  d.data.events.push({ name: 'Form-Submit', count: 5, users: 5, keyEvents: 0 });
  d.data.hosts.push({ host: 'staging.example-dev.com', count: 900 }, { host: 'localhost', count: 50 });
  d.data.channels.push({ name: 'Unassigned', sessions: 700 });
  d.data.sources.push({ source: 'paypal.com', sessions: 80 }, { source: 'example.co.uk', sessions: 200 });
  d.data.landingNotSet = 600;
  d.data.purchases = { events: 60, ids: 48, notSet: 4, duplicateIds: 3, revenue: 0, ecommercePurchases: 60 };
  d.data.piiPages = [{ masked: '/thanks?email=[redacted]', views: 40 }];
  d.data.dimFill = [{ param: 'form_name', scope: 'EVENT', total: 120, notSet: 120 }];
  const gtm = gtmResult();
  gtm.audit.ga4Events.push({ name: 'scroll', params: [], where: 'GTM-TEST1 · GA4 - Scroll', mid: 'G-AAA111' },
                           { name: 'brochure_download', params: ['model_name'], where: 'GTM-TEST1 · GA4 - Brochure', mid: 'G-AAA111' });
  const r = buildGa4Result(d, ga4GtmContext(gtm), { site: 'https://www.example.co.uk' });
  const expect = [
    ['Medium', 'Collection & streams', /1 data stream\(s\) received no data/],
    ['Medium', 'Collection & streams', /2 web streams for example\.co\.uk/],
    ['Medium', 'Collection & streams', /2 unexpected hostname/],
    ['Medium', 'Events & key events', /1 key event\(s\) received no data/],
    ['Medium', 'Events & key events', /Purchase key event counted once per session/],
    ['Low', 'Events & key events', /not in snake_case/],
    ['Low', 'Custom definitions', /registered but receive no data/],
    ['Low', 'Custom definitions', /sent from GTM but not registered/],
    ['Medium', 'Data quality', /Unassigned channel/],
    ['Low', 'Data quality', /no landing page/],
    ['Low', 'Data quality', /Self-referrals/],
    ['Low', 'Data quality', /Payment providers/],
    ['Medium', 'Data quality', /without a transaction ID/],
    ['Medium', 'Data quality', /recorded more than once/],
    ['Medium', 'Data quality', /no revenue/],
    ['High', 'Privacy & retention', /personal data in page URLs/],
    ['Medium', 'Privacy & retention', /retention is only 2 months/],
    ['Low', 'Privacy & retention', /not kept while users stay active/],
    ['Low', 'Privacy & retention', /Email redaction is off/],
    ['Low', 'Privacy & retention', /Measurement Protocol secrets/],
    ['Medium', 'GTM alignment', /tagged in GTM but not received/],
    ['Medium', 'GTM alignment', /sent by both GTM and enhanced measurement/],
    ['Low', 'GTM alignment', /not sent from this GTM container/]
  ];
  expect.forEach(([sev, area, re]) => assert.ok(has(r, sev, area, re), 'missing: ' + sev + ' ' + area + ' ' + re + '\n' + findings(r).join('\n')));
  assert.equal(r.issues.length, expect.length, findings(r).join('\n'));
  assert.equal(r.issues[0].severity, 'High', 'High issues sort first');
  assert.ok(r.score.score < 75);
});

test('custom dimension fill rate is measured over the events that send the parameter', () => {
  const d = cleanData();
  d.data.dimFill = [
    // Sent only on generate_lead and always filled: mostly "(not set)" across all events, but not a problem
    { param: 'form_name', scope: 'EVENT', total: 13170, notSet: 13050, withValue: 120,
      sentWith: [{ name: 'generate_lead', withValue: 120, count: 120 }] },
    // Sent on page_view but filled on only 2,000 of 10,000
    { param: 'page_type', scope: 'EVENT', total: 13170, notSet: 11170, withValue: 2000,
      sentWith: [{ name: 'page_view', withValue: 2000, count: 10000 }] },
    { param: 'old_param', scope: 'EVENT', total: 13170, notSet: 13170, withValue: 0, sentWith: [] }
  ];
  const r = buildGa4Result(d, ga4GtmContext(gtmResult()), { site: 'https://www.example.co.uk' });
  const gap = r.issues.find(i => /empty on half or more of the events that send them/.test(i.finding));
  assert.ok(gap, findings(r).join(' | '));
  assert.equal(gap.items.length, 1);
  assert.match(gap.items[0], /^page_type \(80% empty on page_view\)/);
  assert.ok(has(r, 'Low', 'Custom definitions', /^1 custom dimension\(s\) registered but receive no data/));
  const table = r.quality.find(t => t.title === 'Custom dimension fill rate');
  assert.equal(table.columns[4], 'Empty where sent');
  assert.equal(JSON.stringify(table.rows[0]), JSON.stringify(['form_name', 'event', 'generate_lead', '120', '0%']));
  assert.equal(table.rows[1][4], '80%');
  assert.equal(table.rows[2][2], 'No events');
  // An audit saved before this change still shows the old, all-events view
  d.data.dimFill = [{ param: 'form_name', scope: 'EVENT', total: 120, notSet: 30 }];
  const old = buildGa4Result(d, ga4GtmContext(gtmResult()), {}).quality.find(t => t.title === 'Custom dimension fill rate');
  assert.equal(old.columns[3], 'Empty across all events');
  assert.equal(old.rows[0][3], '25%');
});

test('event cross-reference statuses', () => {
  const d = cleanData();
  d.data.events.push({ name: 'session_start', count: 4000, users: 4000, keyEvents: 0 }, { name: 'app_promo', count: 30, users: 20, keyEvents: 0 });
  const gtm = gtmResult();
  gtm.audit.ga4Events.push({ name: 'scroll', params: [], where: 'GTM-TEST1 · GA4 - Scroll', mid: 'G-AAA111' },
                           { name: 'brochure_download', params: [], where: 'GTM-TEST1 · GA4 - Brochure', mid: 'G-AAA111' },
                           { name: '{{Event Name}}', params: [], where: 'GTM-TEST1 · GA4 - Dynamic', mid: 'G-AAA111' });
  const r = buildGa4Result(d, ga4GtmContext(gtm), {});
  const status = n => (r.crossRef.find(x => x.name === n) || {}).status;
  assert.equal(status('generate_lead'), 'OK');
  assert.equal(status('scroll'), 'Possible duplicate (enhanced measurement)');
  assert.equal(status('brochure_download'), 'Tagged, not received');
  assert.equal(status('session_start'), 'Automatically collected');
  assert.equal(status('app_promo'), 'Received, not from this GTM container');
  assert.equal(status('{{Event Name}}'), 'Name set by a GTM variable (not checked)');
  assert.equal(r.crossRef[0].sev, 'Medium', 'problems sort first');
});

test('GTM audit for another property is not cross-referenced', () => {
  const gtm = gtmResult();
  gtm.audit.ids = { 'GA4|G-ZZZ999': { platform: 'GA4', id: 'G-ZZZ999', live: true } };
  const r = buildGa4Result(cleanData(), ga4GtmContext(gtm), {});
  assert.equal(r.gtmSource, null);
  assert.equal(r.areas.find(a => a.area === 'GTM alignment').status, 'Not checked');
  assert.ok(r.coverage.notes.some(n => /does not send data to this property/.test(n)));
});

test('no Data API access: data areas not checked, config checks still run', () => {
  const d = cleanData();
  d.data = { thresholded: false, otherRow: false };
  d.unavailable = ['Collected data: events, streams, hostnames, channels, sources (HTTP 403)'];
  d.admin.retention.eventDataRetention = 'TWO_MONTHS';
  const r = buildGa4Result(d, null, {});
  assert.equal(r.hasData, false);
  assert.equal(r.areas.find(a => a.area === 'Data quality').score, null);
  assert.ok(has(r, 'Medium', 'Privacy & retention', /2 months/));
  assert.equal(r.quality.length, 0);
});

test('PII in URLs is masked', () => {
  assert.equal(maskPiiUrl_('/thank-you?email=jane.doe%40mail.com&ref=1'), '/thank-you?email=[redacted]&ref=1');
  assert.equal(maskPiiUrl_('/u/jane@mail.co.uk/orders'), '/u/[email]/orders');
  assert.equal(maskPiiUrl_('/basket?phone=07700900123&name=Jane+Doe'), '/basket?phone=[redacted]&name=[redacted]');
  assert.equal(maskPiiUrl_('/order/12345678'), '/order/[number]');
});

test('GA4 client report model', () => {
  const d = cleanData();
  d.data.piiPages = [{ masked: '/x?email=[redacted]', views: 3 }];
  const r = buildGa4Result(d, null, { client: 'Example', site: 'https://www.example.co.uk' });
  const m = ga4ClientReportModel({ client: 'Example', site: 'https://www.example.co.uk' }, r);
  assert.equal(m.counts.High, 1);
  assert.equal(m.actions[0].title, 'Stop personal data reaching analytics');
  assert.equal(m.heading, 'Google Analytics 4 review');
  assert.equal(m.areas.find(a => a.label === 'Privacy & retention').severity, 'High');
});
