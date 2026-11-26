'use strict';

const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { chromium } = require('playwright');
const { readContainer, runSession } = require('../runner/core.cjs');
const { metaTags, metaEvent, metaCheck } = require('../runner/meta.cjs');

const root = path.join(__dirname, '..');
const PIXEL = '111111111111111', OTHER = '222222222222222';
const exportFixture = {
  containerVersion: {
    container: { publicId: 'GTM-META01', name: 'Synthetic Meta container' },
    variable: [{ name: 'Meta Pixel ID', type: 'c', parameter: [{ key: 'value', type: 'template', value: PIXEL }] }],
    customTemplate: [{ templateId: '9', name: 'Facebook Pixel', templateData: '___SANDBOXED_JS_FOR_WEB_TEMPLATE___' }],
    trigger: [
      { triggerId: '5', name: 'Form submit', type: 'formSubmission' },
      { triggerId: '6', name: 'Brochure click', type: 'click' }
    ],
    tag: [
      { tagId: '1', name: 'Meta - base', type: 'html', firingTriggerId: ['2147479553'],
        parameter: [{ key: 'html', type: 'template', value: "<script>fbq('init', '{{Meta Pixel ID}}'); fbq('track', 'PageView');</script>" }] },
      { tagId: '2', name: 'Meta - Lead', type: 'cvt_123_9', firingTriggerId: ['5'],
        parameter: [{ key: 'pixelId', type: 'template', value: '{{Meta Pixel ID}}' },
          { key: 'eventName', type: 'template', value: 'standard' },
          { key: 'standardEventName', type: 'template', value: 'Lead' }] },
      { tagId: '3', name: 'Meta - brochure <b>', type: 'html', firingTriggerId: ['6'],
        parameter: [{ key: 'html', type: 'template', value: "<script>fbq('trackCustom', 'Brochure');</script>" }] },
      { tagId: '4', name: 'Meta - variable event', type: 'html', firingTriggerId: ['6'],
        parameter: [{ key: 'html', type: 'template', value: "<script>fbq('track', '{{DL - event}}');</script>" }] },
      { tagId: '5', name: 'Meta - paused', type: 'html', paused: true, firingTriggerId: ['5'],
        parameter: [{ key: 'html', type: 'template', value: "<script>fbq('track', 'Purchase');</script>" }] },
      { tagId: '6', name: 'GA4 - not Meta', type: 'gaawe', firingTriggerId: ['5'] },
      { tagId: '7', name: 'Meta - never triggered', type: 'html', firingTriggerId: [],
        parameter: [{ key: 'html', type: 'template', value: "<script>fbq('track', 'Search');</script>" }] }
    ]
  }
};

// The page sends real-looking Meta requests to www.facebook.com, which the test
// browser maps to a closed local port: requests are observed, then fail fast.
const fbUrl = (ev, id) => 'https://www.facebook.com/tr/?id=' + (id || PIXEL) + '&ev=' + ev +
  '&ud[em]=DO_NOT_SAVE_HASH&cd[value]=DO_NOT_SAVE&dl=https%3A%2F%2Fexample.test%2Fsecret';
const page = `<!doctype html><html><body>
  <button id="reject">Reject all</button><button id="accept">Accept all</button>
  <form id="lead" onsubmit="event.preventDefault()"><button id="submit">Send</button></form>
  <button id="brochure">Brochure</button>
  <script>
    const choice = localStorage.getItem('choice');
    window.Cookiebot = { hasResponse: !!choice, consent: { marketing: choice === 'accept', statistics: choice === 'accept', preferences: choice === 'accept' } };
    const send = (url, body) => fetch(url, body ? { method: 'POST', body } : {}).catch(() => {});
    // Bug under test: the base pixel fires before any choice, not after Deny.
    if (choice !== 'deny') send(${JSON.stringify(fbUrl('PageView'))});
    if (choice === 'accept') send('https://www.facebook.com/tr/?id=${PIXEL}&ev=Microdata');
    document.querySelector('#reject').onclick = () => localStorage.setItem('choice', 'deny');
    document.querySelector('#accept').onclick = () => localStorage.setItem('choice', 'accept');
    document.querySelector('#submit').onclick = () => {
      // Wrong event name, sent as a POST form body.
      if (choice === 'accept') send('https://www.facebook.com/tr/', 'id=${PIXEL}&ev=Contact&ud%5Bem%5D=DO_NOT_SAVE_HASH');
    };
    document.querySelector('#brochure').onclick = () => {
      if (choice === 'accept') { send(${JSON.stringify(fbUrl('Brochure'))}); send(${JSON.stringify(fbUrl('Purchase', OTHER))}); }
    };
  </script></body></html>`;

let server, browser, base, output;
before(async () => {
  server = http.createServer((req, res) => {
    const route = new URL(req.url, 'http://localhost').pathname;
    if (route === '/site') { res.setHeader('content-type', 'text/html'); res.end(page); return; }
    const relative = route === '/' ? 'index.html' : route.slice(1);
    if (!/^(index\.html|js\/[a-z0-9-]+\.js|css\/(?:app|report)\.css)$/.test(relative)) { res.writeHead(404); res.end(); return; }
    fs.readFile(path.join(root, ...relative.split('/'))).then(data => {
      res.setHeader('content-type', relative.endsWith('.js') ? 'application/javascript'
        : relative.endsWith('.css') ? 'text/css' : 'text/html');
      res.end(data);
    }).catch(() => { res.writeHead(500); res.end(); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP www.facebook.com 127.0.0.1:9'] });
});
after(async () => {
  if (browser) await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
});

test('Meta tags are read from Custom HTML and Facebook Pixel templates, with constants resolved', () => {
  const c = readContainer(JSON.stringify(exportFixture));
  const byName = Object.fromEntries(c.meta.map(t => [t.tag, t]));
  assert.deepEqual(Object.keys(byName).sort(), ['Meta - Lead', 'Meta - base', 'Meta - brochure <b>',
    'Meta - never triggered', 'Meta - paused', 'Meta - variable event']);
  assert.deepEqual(byName['Meta - base'].pixelIds, [PIXEL]);
  assert.deepEqual(byName['Meta - base'].events, ['PageView']);
  assert.deepEqual(byName['Meta - base'].triggers, ['All Pages (built-in)']);
  assert.deepEqual(byName['Meta - Lead'].pixelIds, [PIXEL]);
  assert.deepEqual(byName['Meta - Lead'].events, ['Lead']);
  assert.equal(byName['Meta - variable event'].dynamic, true);
  assert.deepEqual(byName['Meta - variable event'].events, []);
  assert.equal(byName['Meta - paused'].paused, true);
  const single = metaTags({ tag: [{ name: 'x', type: 'html', parameter: [{ key: 'html',
    value: "fbq('init', 333333333333333); fbq('trackSingle', '444444444444444', 'Lead')" }] }] }, []);
  assert.deepEqual(single[0].pixelIds, ['333333333333333', '444444444444444']);
});

test('Meta requests keep only the pixel ID and event name', () => {
  assert.deepEqual(metaEvent(fbUrl('Lead')), { pixelId: PIXEL, event: 'Lead' });
  assert.deepEqual(metaEvent('https://www.facebook.com/tr/', 'id=' + PIXEL + '&ev=PageView&ud%5Bem%5D=x'), { pixelId: PIXEL, event: 'PageView' });
  assert.deepEqual(metaEvent('https://www.facebook.com/tr?id=abc&ev=<script>'), { pixelId: null, event: 'Other' });
  assert.equal(metaEvent('https://connect.facebook.net/en_US/fbevents.js'), null);
  assert.equal(metaEvent('https://facebook.com.evil.test/tr?id=' + PIXEL + '&ev=Lead'), null);
});

test('runner records Meta events per action in each consent state and works out a result per tag', async () => {
  const container = readContainer(JSON.stringify(exportFixture));
  const actions = [
    { triggerId: '5', trigger: 'Form submit', type: 'click', value: '#submit' },
    { triggerId: '6', trigger: 'Brochure click', type: 'click', value: '#brochure' }
  ];
  const sessions = [];
  for (const stage of ['before', 'deny', 'accept']) {
    const prompt = async message => {
      if (message.includes('Approve click')) return 'CLICK';
      if (stage !== 'before') await browser.contexts().at(-1).pages()[0].click('#' + (stage === 'deny' ? 'reject' : 'accept'));
      return '';
    };
    const { session } = await runSession({ browser, url: base + '/site', stage, actions, prompt, settleMs: 150 });
    assert.ok(session.actions.every(a => a.status === 'Completed'));
    assert.deepEqual(session.actions.map(a => a.triggerId), ['5', '6']);
    sessions.push(session);
  }
  const accept = sessions[2].meta;
  assert.ok(accept.some(h => h.step === 'load' && h.event === 'PageView' && h.pixelId === PIXEL));
  assert.ok(accept.some(h => h.step === 0 && h.event === 'Contact'));
  assert.ok(accept.some(h => h.step === 1 && h.event === 'Purchase' && h.pixelId === OTHER));
  assert.deepEqual(sessions[1].meta, []);

  const check = metaCheck(container.meta, container.triggers, sessions);
  const row = name => check.rows.find(r => r.tag === name);
  assert.equal(row('Meta - base').verdict, 'Fires without consent');
  assert.equal(row('Meta - base').stages.before.status, 'Fired without consent');
  assert.equal(row('Meta - base').stages.deny.status, 'Blocked');
  assert.equal(row('Meta - base').stages.accept.status, 'Fired');
  assert.equal(row('Meta - Lead').verdict, 'Check event or pixel ID');
  assert.deepEqual(row('Meta - Lead').stages.accept.seen, [{ pixelId: PIXEL, event: 'Contact', count: 1 }]);
  assert.equal(row('Meta - brochure <b>').verdict, 'Working');
  assert.equal(row('Meta - variable event').verdict, 'Meta event seen; check the tag in GTM Preview');
  assert.equal(row('Meta - paused').verdict, 'Paused');
  assert.equal(row('Meta - never triggered').verdict, 'Not tested');
  // Contact matched no tag exactly; Microdata is Meta's own automatic event and is ignored.
  const unlinked = check.unlinked.find(u => u.stage === 'accept').events;
  assert.ok(unlinked.some(h => h.event === 'Contact' && h.step === 'Form submit'));
  assert.ok(!unlinked.some(h => h.event === 'Microdata'));

  output = { tool: 'tag-audit-local-runner', v: 1, time: new Date().toISOString(),
    container: { id: container.id, name: container.name }, coverage: [], meta: check,
    results: [], sessions: [] };
  for (const [i, stage] of ['before', 'deny', 'accept'].entries()) {
    output.sessions.push(Object.assign({ stage }, sessions[i]));
    output.results.push({ tool: 'tag-scanner-live-test', stage, url: base, time: new Date().toISOString(),
      gcs: [], vendors: {}, otherHosts: [], cookieCount: 0 });
  }
  const saved = JSON.stringify(output);
  assert.ok(!saved.includes('DO_NOT_SAVE'));
  assert.ok(!saved.includes('example.test'));
  assert.ok(!saved.includes('facebook.com/tr'));
});

test('the app validates Meta results, raises audit issues and shows an escaped Meta checker table', async () => {
  const engine = await fs.readFile(path.join(root, 'js', 'engine.js'), 'utf8');
  const web = await fs.readFile(path.join(root, 'js', 'engine-web.js'), 'utf8');
  const context = vm.createContext({ URL, console });
  vm.runInContext(engine + '\n' + web, context);
  context.input = JSON.stringify(output);
  const issues = vm.runInContext(
    'resetAudit_(); AUDIT.liveData = mergeLiveResults_(null, parseRunnerResults_(input)).data; liveTestIssues_(); AUDIT.issues', context);
  assert.ok(issues.some(i => /did not fire after Accept|different event or pixel ID/.test(i.finding)));
  assert.ok(issues.some(i => /different event or pixel ID/.test(i.finding) && /Meta - Lead/.test(JSON.stringify(i))));
  for (const tamper of [
    m => { m.rows[0].verdict = 'Invented'; },
    m => { m.rows[0].pixelIds = ['<img src=x>']; },
    m => { m.rows[0].stages.accept.seen = [{ pixelId: PIXEL, event: 'x<y', count: 1 }]; },
    m => { m.unlinked = 'nope'; }
  ]) {
    const bad = structuredClone(output);
    tamper(bad.meta);
    context.input = JSON.stringify(bad);
    assert.throws(() => vm.runInContext('parseRunnerResults_(input)', context), /Invalid local runner/);
  }
  const legacy = structuredClone(output);
  delete legacy.meta;
  context.input = JSON.stringify(legacy);
  assert.equal(vm.runInContext('parseRunnerResults_(input)[0].runner.meta', context), null);

  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    await ctx.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    const p = await ctx.newPage();
    const errors = [];
    p.on('pageerror', e => errors.push(e.message));
    await p.goto(base);
    await p.locator('[data-runner-file]').setInputFiles({
      name: 'meta.runner.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(output)) });
    await p.waitForFunction(() => STATE.inputs.live && STATE.inputs.live.stages.accept);
    await p.click('#run-btn');
    await p.waitForFunction(() => STATE.result && !STATE.running);
    await p.evaluate(() => { STATE.view = 'live'; renderLive(); });
    const text = await p.locator('#view').innerText();
    assert.match(text, /Meta checker/);
    assert.match(text, /Fires without consent/);
    assert.match(text, /Check event or pixel ID/);
    assert.match(text, /Meta - brochure <b>/);
    assert.equal(await p.locator('#view b').count(), 0);
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
  }
});
