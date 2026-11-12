'use strict';

const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { chromium } = require('playwright');
const { STAGES, readContainer, coverage, websiteUrl, runSession } = require('../runner/core.cjs');

const root = path.join(__dirname, '..');
const fixture = {
  containerVersion: {
    container: { publicId: 'GTM-TEST123', name: 'Synthetic test container' },
    trigger: [{ triggerId: '1', name: 'Brochure click', type: 'click',
      filter: [{ type: 'equals', parameter: [{ key: 'arg1', value: 'brochure' }] }] }],
    tag: [
      { tagId: '1', name: 'Test Meta', firingTriggerId: ['1'], blockingTriggerId: ['2'] },
      { tagId: '2', name: 'Paused test', firingTriggerId: ['1'], paused: true },
      { tagId: '3', name: 'All pages', firingTriggerId: ['2147479553'] },
      { tagId: '4', name: 'Manual only', firingTriggerId: [] }
    ]
  }
};
const fixtureHtml = `<!doctype html><html><body style="height:2000px">
  <button id="reject">Reject all</button><button id="accept">Accept all</button>
  <button id="brochure">Brochure</button>
  <script>
    const choice = localStorage.getItem('choice');
    window.Cookiebot = {hasResponse: !!choice, consent: {
      marketing: choice === 'accept', statistics: choice === 'accept', preferences: choice === 'accept'
    }};
    if (new URL(location.href).searchParams.has('nocmp')) delete window.Cookiebot;
    window.dataLayer = window.dataLayer || [];
    dataLayer.push({event: 'page_ready', privateField: 'DO_NOT_SAVE'});
    (function(){ dataLayer.push(arguments); })('consent', 'default', {
      ad_storage: 'denied', analytics_storage: 'denied', ad_user_data: 'denied',
      ad_personalization: 'denied', privateField: 'DO_NOT_SAVE'
    });
    const send = url => fetch(url).catch(error => console.log(error.message));
    send('/tiktok.com/failed');
    if (!choice) send('/clarity.ms/pre?secret=DO_NOT_SAVE');
    send('/g/collect?gcs=' + (choice === 'accept' ? 'G111' : 'G100') + '&client_id=DO_NOT_SAVE');
    if (choice === 'accept') document.cookie = '_ga=DO_NOT_SAVE; path=/';
    document.querySelector('#reject').onclick = () => localStorage.setItem('choice', 'deny');
    document.querySelector('#accept').onclick = () => localStorage.setItem('choice', 'accept');
    document.querySelector('#brochure').onclick = () => {
      dataLayer.push({event: 'brochure_click', email: 'DO_NOT_SAVE'});
      if (choice === 'accept') send('/facebook.com/tr?id=DO_NOT_SAVE');
    };
  </script></body></html>`;

let server, browser, base, output;
before(async () => {
  server = http.createServer((req, res) => {
    const route = new URL(req.url, 'http://localhost').pathname;
    if (route === '/fixture' || route === '/second') {
      res.setHeader('content-type', 'text/html');
      res.end(fixtureHtml);
    } else if (route === '/tiktok.com/failed') {
      req.socket.destroy();
    } else if (['/g/collect', '/clarity.ms/pre', '/facebook.com/tr'].includes(route)) {
      res.end('ok');
    } else {
      const relative = route === '/' ? 'index.html' : route.slice(1);
      if (!/^(index\.html|js\/[a-z-]+\.js|css\/app\.css)$/.test(relative)) {
        res.writeHead(404); res.end(); return;
      }
      fs.readFile(path.join(root, ...relative.split('/'))).then(data => {
        res.setHeader('content-type', relative.endsWith('.js') ? 'application/javascript'
          : relative.endsWith('.css') ? 'text/css' : 'text/html');
        res.end(data);
      }).catch(error => { res.writeHead(500); res.end(error.message); });
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  if (browser) await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
});

const fullTagCode = '<script>window.__tagExecuted = true; /* facebook.com/tr\n' +
  'synthetic code < > & "\n'.repeat(2200) + 'FULL_CODE_END */</script>';
const detailVersion = {
  container: { publicId: 'GTM-DETAIL1', name: 'Detail fixture' }, containerVersionId: '8',
  folder: [{ folderId: '9', name: 'Test folder' }],
  tag: [
    { tagId: '1', name: 'Analytics - custom <test>', type: 'html', parentFolderId: '9',
      parameter: [{ key: 'html', type: 'template', value: fullTagCode }, { key: 'setting', type: 'template', value: '{{First}}' }],
      firingTriggerId: ['3'], blockingTriggerId: ['2'], setupTag: [{ tagName: 'Setup template' }],
      consentSettings: { consentStatus: 'needed', consentType: { type: 'list', list: [{ type: 'template', value: 'ad_storage' }] } },
      notes: 'Complete original notes', tagFiringOption: 'oncePerEvent' },
    { tagId: '2', name: 'Setup template', type: 'cvt_123_7', paused: true,
      parameter: [{ key: 'pixel', type: 'template', value: '123456789012345' }] },
    { tagId: '3', name: 'Google - main', type: 'googtag', firingTriggerId: ['2147479553'],
      parameter: [{ key: 'tagId', type: 'template', value: 'G-TEST1234' }] }
  ],
  trigger: [
    { triggerId: '1', name: 'Brochure', type: 'click', filter: [{ type: 'equals',
      parameter: [{ key: 'arg0', type: 'template', value: '{{Click ID}}' }, { key: 'arg1', type: 'template', value: 'brochure' }] }] },
    { triggerId: '2', name: 'Blocking event', type: 'customEvent', customEventFilter: [] },
    { triggerId: '3', name: 'Group', type: 'triggerGroup',
      parameter: [{ type: 'list', key: 'triggerIds', list: [{ type: 'triggerReference', value: '1' }] }] }
  ],
  variable: [
    { name: 'First', type: 'c', parameter: [{ key: 'value', type: 'template', value: '{{Second}}' }] },
    { name: 'Second', type: 'jsm', parameter: [{ key: 'javascript', type: 'template', value: 'function(){ return "{{First}}"; }' }] }
  ],
  builtInVariable: [{ name: 'Click ID', type: 'clickId' }],
  customTemplate: [{ templateId: '7', name: 'Synthetic template', templateData: '___SANDBOXED_JS_FOR_WEB_TEMPLATE___\nsynthetic template code' }]
};

test('tag inspection preserves full API/compiled code and related configuration without serializing row properties', async () => {
  const engine = await fs.readFile(path.join(root, 'js', 'engine.js'), 'utf8');
  const web = await fs.readFile(path.join(root, 'js', 'engine-web.js'), 'utf8');
  const context = vm.createContext({ URL, console, version: detailVersion, html: fullTagCode });
  vm.runInContext(engine + '\n' + web, context);
  const api = vm.runInContext(
    'analyseContainerVersion_(version, {source: "GTM API workspace"}); AUDIT.tags[0]', context);
  assert.equal(api.inspection.code, fullTagCode);
  assert.equal(api.inspection.configuration.tagFiringOption, 'oncePerEvent');
  assert.equal(api.folder, 'Test folder');
  assert.equal(api.inspection.triggers.length, 3);
  assert.equal(api.inspection.variables.length, 3);
  assert.equal(api.inspection.sequence[0].name, 'Setup template');
  assert.match(api.inspection.templates[0].templateData, /synthetic template code/);
  assert.ok(api.text.length < fullTagCode.length);
  const restored = JSON.parse(JSON.stringify(api));
  assert.equal(restored.inspection.code, fullTagCode);
  const compiled = vm.runInContext(`resetAudit_(); analyseCompiledResource_("GTM-COMPILED", "", {
    tags: [{function: "__html", tag_id: 1, vtp_html: html, vtp_other: ["macro", 0], setup_tags: ["list", ["tag", 1]]},
      {function: "__googtag", tag_id: 2, vtp_tagId: "G-TEST1234"}],
    macros: [{function: "__c", vtp_value: "value"}],
    predicates: [{function: "_eq", arg0: ["macro", 0], arg1: "value"}],
    rules: [["list", ["if", 0], ["add", 0]]]
  }); AUDIT.tags[0]`, context);
  assert.equal(compiled.inspection.code, fullTagCode);
  assert.equal(compiled.inspection.variables.length, 1);
  assert.equal(compiled.inspection.predicates.length, 1);
  assert.equal(compiled.inspection.sequence[0].configuration.tag_id, 2);
});

const fullVariableCode = 'function(){\n/* ' + 'synthetic JavaScript < > & "\n'.repeat(1800) +
  'VARIABLE_CODE_END */\nreturn "synthetic";\n}';

function inventoryFixture() {
  const version = structuredClone(detailVersion);
  version.tag[0].notes = 'A note mentioning {{Notes only}} is not a parameter reference.';
  version.tag[0].parameter.push({ key: 'quoted', type: 'template', value: '{{Quoted "name"}}' });
  version.tag[1].firingTriggerId = ['6'];
  version.trigger.push(
    { triggerId: '4', name: 'Unused trigger', type: 'pageview' },
    { triggerId: '5', name: 'Self group', type: 'triggerGroup', parameter: [
      { key: 'triggerIds', type: 'list', list: [{ type: 'triggerReference', value: '5' }] }
    ] },
    { triggerId: '6', name: 'Paused tag trigger', type: 'pageview' }
  );
  version.variable.push(
    { name: 'Unused JavaScript', type: 'jsm', parameter: [{ key: 'javascript', type: 'template', value: fullVariableCode }] },
    { name: 'Self variable', type: 'c', parameter: [{ key: 'value', type: 'template', value: '{{Self variable}}' }] },
    { name: 'Notes only', type: 'c', parameter: [{ key: 'value', type: 'template', value: 'not referenced' }] },
    { name: 'Quoted "name"', type: 'c', parameter: [{ key: 'value', type: 'template', value: 'quoted variable value' }] }
  );
  version.builtInVariable.push({ name: 'Page Path', type: 'pagePath' });
  return version;
}

test('complete inventories distinguish unused, exception, group, paused and transitive references', async () => {
  const engine = await fs.readFile(path.join(root, 'js', 'engine.js'), 'utf8');
  const web = await fs.readFile(path.join(root, 'js', 'engine-web.js'), 'utf8');
  const context = vm.createContext({ URL, console, version: inventoryFixture() });
  vm.runInContext(engine + '\n' + web, context);
  const audit = JSON.parse(vm.runInContext(
    'analyseContainerVersion_(version, {source: "Container export"}); JSON.stringify(AUDIT)', context));
  const triggers = new Map(audit.triggers.map(t => [t.name, t]));
  const variables = new Map(audit.variables.map(v => [v.name, v]));
  assert.equal(triggers.get('Unused trigger').usage.length, 0);
  assert.equal(triggers.get('Self group').usage.length, 0);
  assert.equal(triggers.get('Blocking event').usage[0].role, 'Exception');
  assert.equal(triggers.get('Brochure').usage[0].kind, 'triggers');
  assert.equal(triggers.get('Brochure').usage[0].name, 'Group');
  assert.equal(triggers.get('Paused tag trigger').usage[0].paused, true);
  assert.equal(variables.get('Unused JavaScript').usage.length, 0);
  assert.equal(variables.get('Unused JavaScript').code, fullVariableCode);
  assert.equal(variables.get('Self variable').usage.length, 0);
  assert.equal(variables.get('Notes only').usage.length, 0);
  assert.equal(variables.get('Quoted "name"').usage[0].kind, 'tags');
  assert.ok(variables.get('Second').usage.some(r => r.kind === 'variables' && r.name === 'First'));
  assert.equal(variables.get('Click ID').usage[0].kind, 'triggers');
  assert.equal(variables.get('Page Path').usage.length, 0);
  const hygiene = audit.issues.filter(i => i.area === 'Hygiene');
  assert.ok(hygiene.some(i => i.items.includes('Self group') && i.items.includes('Unused trigger')));
  assert.ok(hygiene.some(i => i.items.includes('Self variable') && i.items.includes('Notes only')));
  const firstCount = audit.variables.length;
  const second = vm.runInContext(`version.container.publicId = "GTM-OTHER";
    analyseContainerVersion_(version, {source:"GTM API workspace"}); AUDIT.variables`, context);
  assert.equal(second[firstCount].container, 'GTM-OTHER');
  assert.ok(second[firstCount].usage.some(r => r.kind === 'tags' && r.index >= 3));
});

test('trigger and variable sections support full details, usage links, search, flags and saved inventories', async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  try {
    await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(base);
    await page.evaluate(async version => {
      STATE.inputs.exports = [{ name: 'inventory', text: JSON.stringify({ containerVersion: version }) }];
      STATE.inputs.ga4 = false;
      await runAudit();
      setView('tags');
    }, inventoryFixture());
    const section = kind => page.locator('[data-act="container-section"][data-section="' + kind + '"]');
    const entryButton = (kind, index) => page.locator('#tags-list [data-entity-kind="' + kind + '"][data-entity-index="' + index + '"]').first();
    await section('triggers').click();
    assert.equal(await section('triggers').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#view h1').innerText(), 'Triggers');
    const unusedTrigger = entryButton('triggers', 3);
    assert.equal(await unusedTrigger.locator('..').locator('..').locator('.sev').innerText(), 'Unused');
    await unusedTrigger.click();
    await page.locator('#tags-list .configuration-more > summary').click();
    assert.match(await page.locator('#tags-list .tag-detail-panel').innerText(), /"triggerId": "4"/);
    await page.locator('[data-act="collapse"]').click();
    assert.equal(await page.locator('#tags-list details.group').first().getAttribute('open'), null);
    await page.locator('[data-act="expand"]').click();
    await page.locator('#tags-q').fill('Blocking event');
    assert.equal(await page.locator('#tags-list .tag-toggle[data-act="entity-details"]').count(), 1);
    const blocking = entryButton('triggers', 1);
    await blocking.focus();
    await page.keyboard.press('Enter');
    assert.match(await page.locator('#tags-list .tag-detail-panel').innerText(), /Exception/);
    await section('variables').click();
    assert.equal(await page.locator('#view h1').innerText(), 'Variables');
    const unusedVariable = entryButton('variables', 2);
    await unusedVariable.click();
    assert.ok((await page.locator('#tags-list .tag-detail-panel pre code').allTextContents()).includes(fullVariableCode));
    const javascript = page.locator('#tags-list .configuration-card pre code').first();
    assert.equal(await javascript.isVisible(), true);
    assert.equal(await javascript.textContent(), fullVariableCode);
    await section('triggers').click();
    await entryButton('triggers', 0).click();
    const referencedGroup = page.locator('.tag-detail-panel [data-entity-kind="triggers"][data-entity-index="2"]').first();
    await referencedGroup.click();
    assert.equal(await page.locator('.tag-detail-panel .tag-detail-panel').count(), 1);
    const tagLink = page.locator('.tag-detail-panel .tag-detail-panel [data-tag-index="0"]').first();
    await tagLink.click();
    assert.ok((await page.locator('.tag-detail-panel .tag-detail-panel .tag-detail-panel pre code').allTextContents()).includes(fullTagCode));
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
    assert.equal(await page.locator('.tag-detail-panel').evaluateAll(nodes =>
      nodes.every(el => el.scrollWidth <= el.clientWidth)), true);
    const saved = await page.evaluate(() => JSON.stringify({
      app: 'tag-audit-studio', inputs: STATE.inputs, result: STATE.result
    }));
    await page.evaluate(text => { openAudit(text); setView('tags'); }, saved);
    await section('variables').click();
    await entryButton('variables', 2).click();
    assert.ok((await page.locator('#tags-list .tag-detail-panel pre code').allTextContents()).includes(fullVariableCode));
    await page.evaluate(() => {
      setView('findings');
    });
    assert.ok(await page.locator('#all-list [data-entity-kind="variables"]').count() > 0);
    await page.evaluate(() => {
      delete STATE.result.audit.triggers; delete STATE.result.audit.variables;
      setView('tags');
    });
    assert.match(await page.locator('#tags-list').innerText(), /predates the inventory/);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('published inventories expose raw compiled definitions without claiming unused status', async () => {
  const context = await browser.newContext();
  try {
    await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    const page = await context.newPage();
    await page.goto(base);
    await page.evaluate(() => {
      resetAudit_();
      const rows = analyseCompiledResource_('GTM-PUBLISHED', '', {
        tags: [{ function: '__googtag', tag_id: 1, vtp_tagId: ['macro', 0] }],
        macros: [{ function: '__c', vtp_value: 'G-TEST1234' }, { function: '__c', vtp_value: 'not referenced' }],
        predicates: [], rules: [['list', ['add', 0]]]
      });
      STATE.result = buildResult(rows.concat(runAuditChecks_()), ['Published container']);
      setView('tags');
    });
    await page.locator('[data-section="variables"]').click();
    assert.equal(await page.locator('#tags-list .sev').allTextContents().then(values =>
      values.every(v => v === 'Not checked')), true);
    await page.locator('#tags-list [data-entity-index="1"]').first().click();
    await page.locator('.configuration-more > summary').click();
    assert.match(await page.locator('.tag-detail-panel').innerText(), /"vtp_value": "not referenced"/);
    assert.match(await page.locator('.tag-detail-panel').innerText(), /Unused status cannot be established/);
    await page.locator('[data-section="triggers"]').click();
    assert.match(await page.locator('#tags-list').innerText(), /Compiled rule #0/);
    await page.locator('#tags-list [data-entity-index="0"]').first().click();
    await page.locator('.configuration-more > summary').click();
    assert.match(await page.locator('.tag-detail-panel').innerText(), /Compiled firing \/ blocking rule/);
  } finally {
    await context.close();
  }
});

test('GTM-style configuration views show readable settings and keep raw inspection behind More details', async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  try {
    await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const version = structuredClone(detailVersion);
    version.tag[2].parameter = [
      { key: 'tagId', type: 'template', value: '{{First}}' },
      { key: 'configSettingsTable', type: 'list', list: [
        { type: 'map', map: [
          { key: 'parameter', type: 'template', value: 'user_id' },
          { key: 'parameterValue', type: 'template', value: '{{Second}}' }
        ] },
        { type: 'map', map: [
          { key: 'parameter', type: 'template', value: 'send_page_view' },
          { key: 'parameterValue', type: 'boolean', value: 'false' }
        ] },
        { type: 'map', map: [
          { key: 'parameter', type: 'template', value: 'test_zero' },
          { key: 'parameterValue', type: 'integer', value: '0' }
        ] }
      ] },
      { key: 'eventSettingsVariable', type: 'template', value: '{{First}}' }
    ];
    version.tag[2].consentSettings = { consentStatus: 'notNeeded' };
    version.variable.push(
      { name: 'Page category', type: 'v', parameter: [
        { key: 'name', type: 'template', value: 'page.category' },
        { key: 'dataLayerVersion', type: 'integer', value: '2' }
      ] },
      { name: 'Category table', type: 'smm', parameter: [
        { key: 'input', type: 'template', value: '{{Page category}}' },
        { key: 'map', type: 'list', list: [{ type: 'map', map: [
          { key: 'key', type: 'template', value: '<script>window.__tagExecuted = true</script>' },
          { key: 'value', type: 'template', value: 'A & B' }
        ] }] }
      ] },
      { name: 'Country RegEx', type: 'remm', parameter: [
        { key: 'input', type: 'template', value: '{{Page category}}' },
        { key: 'map', type: 'list', list: [{ type: 'map', map: [
          { key: 'key', type: 'template', value: '^GB$' },
          { key: 'value', type: 'template', value: 'AW-123456789' }
        ] }] }
      ] }
    );
    version.tag.push({ tagId: '4', name: 'GA4 cart event', type: 'gaawe', parameter: [
      { key: 'measurementIdOverride', type: 'template', value: '{{First}}' },
      { key: 'eventName', type: 'template', value: 'add_to_cart' },
      { key: 'eventSettingsVariable', type: 'template', value: '{{First}}' },
      { key: 'eventSettingsTable', type: 'list', list: [{ type: 'map', map: [
        { key: 'parameter', type: 'template', value: 'atb_location' },
        { key: 'parameterValue', type: 'template', value: '{{Page category}}' }
      ] }] },
      { key: 'sendEcommerceData', type: 'boolean', value: 'true' },
      { key: 'getEcommerceDataFrom', type: 'template', value: 'dataLayer' }
    ] });
    version.trigger[1].customEventFilter = [{ type: 'matchRegex', parameter: [
      { key: 'arg0', type: 'template', value: '{{_event}}' },
      { key: 'arg1', type: 'template', value: 'purchase|checkout' },
      { key: 'ignore_case', type: 'boolean', value: 'true' }
    ] }];
    await page.goto(base);
    await page.evaluate(async version => {
      STATE.inputs.exports = [{ name: 'configuration', text: JSON.stringify({ containerVersion: version }) }];
      STATE.inputs.ga4 = false;
      await runAudit();
      setView('tags');
    }, version);
    await page.locator('#tags-list [data-tag-index="2"]').first().click();
    const panel = page.locator('#tags-list .tag-detail-panel').first();
    const configuration = panel.locator('.configuration-card').first();
    assert.match(await configuration.innerText(), /Tag Type\s+Google Tag/);
    assert.match(await configuration.innerText(), /Tag ID\n\{\{First\}\}/);
    assert.deepEqual(await configuration.locator('tbody tr').allTextContents(),
      ['user_id{{Second}}', 'send_page_viewfalse', 'test_zero0']);
    assert.match(await configuration.innerText(), /Event Settings Variable/);
    assert.match(await panel.innerText(), /No additional consent required/);
    const more = panel.locator(':scope > .tag-detail-content > .configuration-more');
    assert.equal(await more.getAttribute('open'), null);
    assert.equal(await more.locator('.tag-detail-content').isVisible(), false);
    assert.doesNotMatch(await panel.innerText(), /Complete tag configuration available/);
    await more.locator(':scope > summary').focus();
    await page.keyboard.press('Enter');
    assert.match(await panel.innerText(), /Complete tag configuration available/);
    assert.match(await panel.innerText(), /"configSettingsTable"/);
    await more.locator(':scope > summary').press('Space');
    assert.equal(await more.getAttribute('open'), null);
    const variableLink = configuration.locator('[data-entity-kind="variables"]').first();
    await variableLink.click();
    assert.equal(await panel.locator('.tag-detail-panel').count(), 1);
    await variableLink.click();
    assert.equal(await panel.count(), 1);
    assert.equal(await panel.locator('.tag-detail-panel').count(), 0, 'Closing a nested panel preserves its parent');
    const triggerLink = panel.locator('.configuration-card [data-entity-kind="triggers"]').first();
    await triggerLink.click();
    assert.match(await panel.locator('.tag-detail-panel').innerText(), /Trigger Configuration/);
    const htmlTag = page.locator('#tags-list [data-tag-index="0"]').first();
    await htmlTag.click();
    const html = page.locator('#' + await htmlTag.getAttribute('aria-controls')).locator('.configuration-card pre code').first();
    assert.equal(await html.isVisible(), true);
    assert.equal(await html.textContent(), fullTagCode);
    await page.locator('[data-section="triggers"]').click();
    await page.locator('#tags-list [data-entity-index="1"]').first().click();
    assert.match(await page.locator('.configuration-card').first().innerText(), /Event name[\s\S]*purchase\|checkout[\s\S]*Use regex matching \(ignore case\)/);
    await page.locator('[data-section="variables"]').click();
    await page.locator('#tags-list [data-entity-index="2"]').first().click();
    assert.match(await page.locator('.configuration-card').first().innerText(), /Data Layer Variable Name\npage.category/);
    assert.match(await page.locator('.configuration-card').first().innerText(), /Data Layer Version\nVersion 2/);
    await page.locator('#tags-list [data-entity-index="3"]').first().click();
    const lookup = page.locator('.tag-detail-panel').last();
    assert.match(await lookup.locator('.configuration-card').first().innerText(), /Lookup table[\s\S]*<script>window.__tagExecuted = true<\/script>[\s\S]*A & B/);
    assert.equal(await page.evaluate(() => window.__tagExecuted), undefined);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.equal(await lookup.evaluate(el => el.scrollWidth <= el.clientWidth), true);
    await page.emulateMedia({ colorScheme: 'dark' });
    assert.equal(await lookup.locator('.configuration-card').first().isVisible(), true);
    await page.locator('#tags-list [data-entity-index="4"]').first().click();
    const regex = page.locator('.tag-detail-panel').last().locator('.configuration-card').first();
    assert.deepEqual(await regex.locator('th').allTextContents(), ['Pattern', 'Output']);
    assert.match(await regex.innerText(), /\^GB\$\s+AW-123456789/);
    await page.locator('[data-section="tags"]').click();
    const eventTag = page.locator('#tags-list [data-tag-index="3"]').first();
    await eventTag.click();
    const eventCard = page.locator('#' + await eventTag.getAttribute('aria-controls')).locator('.configuration-card').first();
    assert.match(await eventCard.innerText(), /Google Analytics: GA4 Event/);
    assert.deepEqual(await eventCard.locator('.configuration-section > h4').allTextContents(),
      ['Event Parameters', 'Ecommerce', 'Consent Settings']);
    assert.match(await eventCard.innerText(), /Data source\nData Layer/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('tag accordions share full, escaped details across views and survive filtering and saved audits', async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  try {
    await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(base);
    const second = structuredClone(detailVersion);
    second.container.publicId = 'GTM-DETAIL2';
    second.tag[0].parameter[0].value = '<script>/* SECOND_CONTAINER */</script>';
    await page.evaluate(async exports => {
      STATE.inputs.exports = exports.map(v => ({ name: v.container.publicId, text: JSON.stringify({ containerVersion: v }) }));
      STATE.inputs.ga4 = false;
      await runAudit();
    }, [detailVersion, second]);
    const inspect = async (view, index, expectCode = fullTagCode) => {
      await page.evaluate(view => setView(view), view);
      const button = page.locator('#view .tag-toggle[data-tag-index="' + index + '"]').first();
      assert.equal(await button.count(), 1, 'Expected tag control in ' + view);
      await button.focus();
      await page.keyboard.press('Enter');
      assert.equal(await button.getAttribute('aria-expanded'), 'true');
      const id = await button.getAttribute('aria-controls');
      const region = page.locator('#' + id);
      assert.equal(await region.isVisible(), true);
      assert.ok((await region.locator('pre code').allTextContents()).includes(expectCode), 'Full code in ' + view);
      assert.match(await region.innerText(), /Complete original notes/);
      assert.match(await region.innerText(), /ad_storage/);
      assert.match(await region.innerText(), /Setup template/);
      assert.equal(await page.evaluate(() => window.__tagExecuted), undefined);
      await button.press('Space');
      assert.equal(await button.getAttribute('aria-expanded'), 'false');
      assert.equal(await region.count(), 0);
    };
    for (const view of ['tags', 'findings', 'consent', 'summary']) await inspect(view, 0);
    await inspect('tags', 3, second.tag[0].parameter[0].value);
    await page.locator('#tags-q').fill('Analytics - custom');
    await page.locator('#view .tag-toggle[data-tag-index="3"]').first().click();
    assert.match(await page.locator('#view .tag-detail-panel').innerText(), /SECOND_CONTAINER/);
    await page.evaluate(() => {
      STATE.ai.writeup = 'Review **Analytics - custom <test>**.\n\n`Analytics - custom <test>`';
      STATE.ai.chat = [{ role: 'assistant', content: 'Review Analytics - custom <test>.' }];
    });
    await inspect('ai', 0);
    assert.equal(await page.locator('#doc-writeup code .tag-toggle').count(), 0);
    await page.evaluate(() => {
      const stage = { url: 'https://example.test', gcs: [], other: [], consentDefault: null, cmp: null,
        vendors: { Meta: [1, [], 'advertising'] } };
      STATE.result.live = { data: { stages: { before: stage } }, verdicts: liveTestVerdicts_({ stages: { before: stage } }) };
    });
    await inspect('live', 0);
    await page.evaluate(() => setView('ids'));
    assert.equal(await page.locator('#view td:last-child .hl-mark').count(), 0, 'ID notes do not use yellow highlighting');
    const idButton = page.locator('#view .tag-toggle[data-tag-index="2"]').first();
    assert.equal(await idButton.count(), 1);
    await idButton.click();
    assert.match(await page.locator('#view .tag-detail-panel').innerText(), /G-TEST1234/);
    const saved = await page.evaluate(() => JSON.stringify({
      app: 'tag-audit-studio', inputs: STATE.inputs, result: STATE.result
    }));
    await page.evaluate(text => openAudit(text), saved);
    await inspect('tags', 0);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => setView('live'));
    await page.locator('#view .tag-toggle[data-tag-index="0"]').first().click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
    assert.equal(await page.locator('#view .tag-detail-panel').evaluate(el => el.scrollWidth > el.clientWidth), false);
    await page.evaluate(() => setView('tags'));
    await page.locator('#view .tag-toggle[data-tag-index="0"]').first().click();
    assert.equal(await page.locator('#view .tag-detail-panel').evaluate(el =>
      el.getBoundingClientRect().right <= window.innerWidth), true);
    await page.evaluate(() => {
      STATE.result.audit.tags.forEach(t => { delete t.inspection; });
      STATE.result.groups.forEach(g => { delete g.tagIndices; });
    });
    await page.evaluate(() => setView('tags'));
    await page.locator('#view .tag-toggle[data-tag-index="0"]').first().click();
    assert.match(await page.locator('#view .tag-detail-panel').innerText(), /Original configuration was not saved/);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('ID inventory removes approvals and confirmations from UI, exports and saved state', async () => {
  const context = await browser.newContext();
  try {
    await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    const page = await context.newPage();
    await page.goto(base);
    await page.evaluate(async version => {
      STATE.inputs.exports = [{ name: 'IDs', text: JSON.stringify({ containerVersion: version }) }];
      STATE.inputs.rules.approvedIds = 'G-OLD123';
      STATE.inputs.ga4 = false;
      await runAudit();
      const legacy = { app: 'tag-audit-studio', inputs: STATE.inputs, result: STATE.result,
        confirmations: { 'GA4|G-TEST1234': true } };
      openAudit(JSON.stringify(legacy));
      setView('ids');
    }, detailVersion);
    assert.deepEqual(await page.locator('#view th').allTextContents(),
      ['Platform', 'ID', 'Type', 'Status', 'Used by', 'Notes']);
    assert.equal(await page.locator('#view input[type="checkbox"]').count(), 0);
    assert.equal(await page.evaluate(() => STATE.result.issues.some(issue =>
      /live ID.*approved list/.test(issue.finding))), false);
    const exported = await page.evaluate(() => {
      const files = [];
      const originalDownload = download;
      const originalPrint = window.print;
      download = (name, content) => files.push({ name, content });
      window.print = () => {};
      try {
        document.querySelector('[data-act="csv-ids"]').click();
        saveAudit();
        exportPdf();
      } finally {
        download = originalDownload;
        window.print = originalPrint;
      }
      return files;
    });
    const csv = exported.find(file => file.name.endsWith('.csv')).content;
    assert.doesNotMatch(csv.split(/\r?\n/)[0], /Approved|Client confirms/);
    assert.equal(Object.hasOwn(JSON.parse(exported.find(file => file.name.endsWith('.json')).content), 'confirmations'), false);
    assert.equal(await page.locator('#print-report th').filter({ hasText: /^(Approved|Confirmed|Client confirms)$/ }).count(), 0);
    await page.evaluate(() => setView('audit'));
    assert.equal(await page.locator('[name="approvedIds"], #rule-approvedIds').count(), 0);
    assert.doesNotMatch(await page.locator('#view').innerText(), /Approved IDs/);
  } finally {
    await context.close();
  }
});

test('container parsing includes built-in triggers and honest coverage', () => {
  const c = readContainer(JSON.stringify(fixture));
  assert.equal(c.triggers.length, 2);
  assert.match(c.triggers[0].conditions, /brochure/);
  const rows = coverage(c, [{ triggerId: '1' }]);
  assert.equal(rows[0].status, 'Action planned; firing not verified');
  assert.equal(rows[1].status, 'Paused');
  assert.match(rows[2].status, /Not tested/);
  assert.match(rows[3].status, /manual verification/);
  const minimal = readContainer(JSON.stringify({ tag: [{ firingTriggerId: ['2147479553'] }] }));
  assert.equal(minimal.triggers[0].id, '2147479553');
  assert.throws(() => readContainer('{}'), /container export/);
  assert.throws(() => websiteUrl('file:///test'), /HTTP/);
  assert.throws(() => websiteUrl('https://user:pass@example.com'), /credentials/);
});

test('three consent contexts isolate evidence, replay actions and omit private values', async () => {
  const container = readContainer(JSON.stringify(fixture));
  const actions = [
    { triggerId: '1', trigger: 'Brochure click', type: 'click', value: '#brochure' },
    { triggerId: '1', trigger: 'Scroll', type: 'scroll' },
    { triggerId: '1', trigger: 'Timer', type: 'wait', value: '10' },
    { triggerId: '1', trigger: 'Next page', type: 'visit', value: '/second' }
  ];
  output = { tool: 'tag-audit-local-runner', v: 1, container: { id: container.id, name: container.name },
    results: [], sessions: [], coverage: coverage(container, actions) };
  for (const stage of STAGES) {
    const prompt = async message => {
      const page = browser.contexts().at(-1).pages()[0];
      if (message.includes('Approve click')) return 'CLICK';
      assert.equal(await page.evaluate(() => localStorage.getItem('choice')), null);
      if (stage !== 'before') await page.click('#' + (stage === 'deny' ? 'reject' : 'accept'));
      return '';
    };
    const data = await runSession({ browser, url: base + '/fixture', stage, actions, prompt, settleMs: 50 });
    output.results.push(data.result);
    output.sessions.push(data.session);
    assert.equal(data.result.stage, stage);
    assert.equal(data.result.url, base);
    assert.deepEqual(data.result.gcs, [stage === 'accept' ? 'G111' : 'G100']);
    assert.ok(data.session.events.includes('brochure_click'));
    assert.ok(data.session.events.includes('page_ready'));
    assert.ok(data.session.actions.every(a => a.status === 'Completed'));
    assert.equal(!!data.result.vendors['Microsoft Clarity'], stage === 'before');
    assert.equal(!!data.result.vendors.Meta, stage === 'accept');
    assert.equal(data.result.vendors.TikTok, undefined);
    assert.ok(data.session.requests.some(r => r.outcome === 'failed'));
    assert.equal(data.result.cookieCount, stage === 'accept' ? 1 : 0);
    assert.equal(browser.contexts().length, 0);
  }
  const saved = JSON.stringify(output);
  assert.ok(!saved.includes('DO_NOT_SAVE'));
  assert.ok(!saved.includes('/g/collect'));
  assert.ok(!saved.includes('client_id'));
  assert.ok(saved.includes('_ga'));
});

test('skipped/failed actions are explicit and a consent mismatch closes the context', async () => {
  const { session } = await runSession({
    browser, url: base + '/fixture', stage: 'before', settleMs: 10, prompt: async () => '',
    actions: [
      { trigger: 'Not approved', type: 'click', value: '#brochure' },
      { trigger: 'Invalid wait', type: 'wait', value: '-1' },
      { trigger: 'External visit', type: 'visit', value: 'https://example.invalid' }
    ]
  });
  assert.equal(session.actions[0].status, 'Skipped (not approved)');
  assert.equal(session.actions[1].status, 'Failed');
  assert.equal(session.actions[2].status, 'Failed');
  assert.equal(session.errors.length, 2);
  await assert.rejects(runSession({
    browser, url: base + '/fixture', stage: 'deny', settleMs: 10, actions: [],
    prompt: async () => { await browser.contexts().at(-1).pages()[0].click('#accept'); return ''; }
  }), /CMP reports "accept"/);
  assert.equal(browser.contexts().length, 0);
});

test('unrecognised CMPs retain explicit analyst confirmation rather than claiming verification', async () => {
  const { result, session } = await runSession({
    browser, url: base + '/fixture?nocmp=1', stage: 'deny', settleMs: 20, actions: [],
    prompt: async () => { await browser.contexts().at(-1).pages()[0].click('#reject'); return ''; }
  });
  assert.equal(result.stage, 'deny');
  assert.equal(result.cmp, null);
  assert.equal(session.consentConfirmation, 'Analyst confirmed; CMP not detected');
  assert.equal(browser.contexts().length, 0);
});

test('browser-layer import validates runner files and keeps legacy snippets compatible', async () => {
  const engine = await fs.readFile(path.join(root, 'js', 'engine.js'), 'utf8');
  const web = await fs.readFile(path.join(root, 'js', 'engine-web.js'), 'utf8');
  const context = vm.createContext({ URL, console });
  vm.runInContext(engine + '\n' + web, context);
  context.input = JSON.stringify(output);
  const merged = vm.runInContext('mergeLiveResults_(null, parseRunnerResults_(input))', context);
  assert.equal(merged.added.length, 3);
  assert.equal(merged.data.stages.accept.runner.session.actions.length, 4);
  assert.equal(vm.runInContext('parseRunnerResults_("not JSON")', context), null);
  context.input = JSON.stringify(output.results[0]);
  assert.equal(vm.runInContext('parseLiveResults_(input).length', context), 1);
  const bad = structuredClone(output);
  bad.sessions[0].requests[0].outcome = 'invented';
  context.input = JSON.stringify(bad);
  assert.throws(() => vm.runInContext('parseRunnerResults_(input)', context), /Invalid local runner/);
  const duplicate = structuredClone(output);
  duplicate.results[1].stage = 'before';
  context.input = JSON.stringify(duplicate);
  assert.throws(() => vm.runInContext('parseRunnerResults_(input)', context), /Invalid local runner/);
  const partial = structuredClone(output);
  partial.results = partial.results.slice(0, 1);
  partial.sessions = partial.sessions.slice(0, 1);
  context.input = JSON.stringify(partial);
  const missing = vm.runInContext(
    'resetAudit_(); AUDIT.liveData = mergeLiveResults_(null, parseRunnerResults_(input)).data; liveTestIssues_(); AUDIT.issues',
    context
  );
  assert.ok(missing.some(i => /Live test incomplete/.test(i.finding)));
});

test('static app imports runner evidence, renders it, prints it and reopens saved state', async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base);
    const upload = () => page.locator('[data-runner-file]').setInputFiles({
      name: 'synthetic.runner.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(output))
    });

    await upload();
    await page.waitForFunction(() => STATE.inputs.live && STATE.inputs.live.stages.accept);
    await page.click('#run-btn');
    await page.waitForFunction(() => STATE.view === 'summary');
    await page.click('#nav [data-view="live"]');
    assert.match(await page.locator('#view').innerText(), /Local runner evidence/);
    assert.match(await page.locator('#view').innerHTML(), /brochure_click/);
    assert.match(await page.locator('#view').innerHTML(), /firing not verified/);
    assert.match(await page.locator('#view').innerHTML(), /Test Meta/);
    const saved = await page.evaluate(() => JSON.stringify({
      app: 'tag-audit-studio', result: STATE.result, inputs: STATE.inputs
    }));
    await page.evaluate(text => openAudit(text), saved);
    await page.evaluate(() => { window.print = () => {}; exportPdf(); });
    assert.match(await page.locator('#print-report').innerHTML(), /Local runner evidence/);
    assert.equal(await page.locator('#print-report details').evaluateAll(ds => ds.every(d => d.open)), true);
    await page.emulateMedia({ media: 'print' });
    assert.equal(await page.locator('#print-report').getByText('Data-layer event names:', { exact: false }).first().isVisible(), true);
    await page.emulateMedia({ media: 'screen' });
    await page.click('#nav [data-view="live"]');
    const previousInput = await page.locator('[data-runner-file]').elementHandle();
    await upload();
    await page.waitForFunction(input => !input.isConnected, previousInput);
    await page.waitForFunction(() => !STATE.running && STATE.view === 'live');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
    const invalid = structuredClone(output);
    invalid.results[0].cookieCount = -1;
    await page.locator('[data-runner-file]').setInputFiles({
      name: 'invalid.runner.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(invalid))
    });
    await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('Invalid local runner'));
    assert.equal(await page.evaluate(() => Object.keys(STATE.inputs.live.stages).length), 3);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('live table keeps long cookie names readable in both themes, mobile and print', async () => {
  const context = await browser.newContext();
  try {
    await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    const page = await context.newPage();
    await page.goto(base);
    await page.evaluate(() => {
      const cookies = ['_ga', '_ga_SYNTHETIC_LONG_MEASUREMENT_IDENTIFIER', '_ga_SECOND_TEST_ID'];
      const stage = { url: 'https://example.test', cmp: null, consentDefault: null, gcs: ['G100'], other: [],
        vendors: { GA4: [25, cookies, 'analytics'] } };
      const data = { stages: { before: stage, deny: stage,
        accept: Object.assign({}, stage, { gcs: ['G111'] }) } };
      const live = { data, verdicts: liveTestVerdicts_(data) };
      document.querySelector('#view').innerHTML = liveSection(live);
      document.querySelector('#print-report').innerHTML = liveSection(live);
    });
    const table = page.locator('#view .live-table');
    assert.equal(await table.locator('thead th').count(), 5);
    assert.equal(await table.locator('.hl-mark').count(), 0);
    assert.equal(await table.locator('.live-risk-label').count(), 2);
    assert.ok((await table.locator('td').first().locator('code').allTextContents())
      .includes('_ga_SYNTHETIC_LONG_MEASUREMENT_IDENTIFIER'));
    assert.match(await table.innerText(), /25 requests/);
    assert.match(await table.innerText(), /consent denied \(G100\)/);
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => document.documentElement.setAttribute('data-theme', theme), theme);
      for (const width of [390, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        assert.equal(await table.evaluate(el => el.scrollWidth > el.clientWidth), false);
        assert.equal(await table.locator('code').evaluateAll(nodes =>
          nodes.every(n => n.getBoundingClientRect().right <= window.innerWidth)), true);
        if (width === 390) {
          assert.equal(await table.locator('td').first().evaluate(el => getComputedStyle(el, '::before').content),
            '"Before any choice"');
        }
      }
    }
    await page.emulateMedia({ media: 'print' });
    assert.equal(await page.locator('#print-report .live-table').evaluate(el => getComputedStyle(el).display), 'table');
    assert.equal(await page.locator('#print-report .live-cookies code').first().isVisible(), true);
  } finally {
    await context.close();
  }
});
