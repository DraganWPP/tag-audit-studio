'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const engine = fs.readFileSync(path.join(__dirname, '..', 'js', 'engine.js'), 'utf8');
const { snippet, builtIns } = vm.runInNewContext(engine +
  '\n({ snippet: liveTestSnippet_.toString(), builtIns: BUILT_IN_TRIGGERS })');
const STAGES = ['before', 'deny', 'accept'];

function websiteUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Use an HTTP(S) website URL without embedded credentials.');
  }
  return url.href;
}

function readContainer(text) {
  const input = JSON.parse(text);
  const version = input && (input.containerVersion || input);
  if (!version || !Array.isArray(version.tag) || (version.trigger !== undefined && !Array.isArray(version.trigger))) {
    throw new Error('Use a GTM container export containing a tag array and optional trigger array.');
  }
  const triggers = (version.trigger || []).map(t => ({
    id: String(t.triggerId), name: t.name || String(t.triggerId), type: t.type || 'UNKNOWN',
    conditions: JSON.stringify({
      filter: t.filter, customEventFilter: t.customEventFilter,
      autoEventFilter: t.autoEventFilter, parameter: t.parameter
    })
  }));
  const tags = version.tag.map(t => ({
    id: String(t.tagId), name: t.name || String(t.tagId), paused: !!t.paused,
    triggers: (t.firingTriggerId || []).map(String),
    blockers: (t.blockingTriggerId || []).map(String)
  }));
  Object.keys(builtIns).forEach(id => {
    if (tags.some(t => t.triggers.includes(id)) && !triggers.some(t => t.id === id)) {
      triggers.push({ id, name: builtIns[id], type: 'built-in', conditions: 'All pages' });
    }
  });
  return {
    id: version.container && version.container.publicId || 'GTM export',
    name: version.container && version.container.name || '',
    triggers, tags
  };
}

function coverage(container, actions) {
  const selected = new Set(actions.map(a => a.triggerId));
  return container.tags.map(t => ({
    tag: t.name,
    status: t.paused ? 'Paused' : t.triggers.some(id => selected.has(id))
      ? 'Action planned; firing not verified' : 'Not tested / manual verification required',
    triggers: t.triggers.map(id => (container.triggers.find(t => t.id === id) || {}).name || id),
    blockers: t.blockers.map(id => (container.triggers.find(t => t.id === id) || {}).name || id)
  }));
}

function observeDataLayer() {
  const layer = window.dataLayer = window.dataLayer || [];
  const push = layer.push;
  layer.push = function () {
    for (const entry of arguments) {
      if (entry && typeof entry.event === 'string') {
        window.tasRunnerEvent(entry.event.slice(0, 120));
      }
    }
    return push.apply(this, arguments);
  };
}

async function runSession({ browser, url, stage, actions, prompt, settleMs = 1500 }) {
  if (!STAGES.includes(stage)) throw new Error('Unknown consent stage: ' + stage);
  url = websiteUrl(url);
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const records = new Map(), events = new Set(), cookieNames = new Set(), errors = [];
  let collecting = stage === 'before';
  let page;
  try {
    await context.exposeBinding('tasRunnerEvent', (source, name) => {
      if (collecting && page && source.frame === page.mainFrame() && typeof name === 'string') events.add(name.slice(0, 120));
    });
    await context.addInitScript(observeDataLayer);
    page = await context.newPage();
    context.on('request', request => {
      if (collecting) records.set(request, {
        url: request.url(), host: new URL(request.url()).hostname,
        method: request.method(), resourceType: request.resourceType(), outcome: 'pending'
      });
    });
    context.on('response', response => {
      const rec = records.get(response.request());
      if (rec) { rec.outcome = 'response'; rec.status = response.status(); }
    });
    context.on('requestfailed', request => {
      const rec = records.get(request);
      if (rec) rec.outcome = 'failed';
    });
    const visit = async target => {
      const response = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });
      if (response && response.status() >= 400) throw new Error('Page returned HTTP ' + response.status());
    };
    await visit(url);
    await prompt(stage === 'before'
      ? 'Leave the cookie banner untouched. Confirm this is BEFORE any choice, then press Enter.'
      : 'In the browser, click ' + (stage === 'deny' ? 'Reject all' : 'Accept all') +
        '. Confirm the choice is saved, then press Enter. The page will reload before collection.');
    if (stage !== 'before') {
      collecting = true;
      await visit(url);
    }
    const checkConsent = detected => {
      if (['before', 'deny', 'accept', 'custom'].includes(detected) && detected !== stage) {
        throw new Error('CMP reports "' + detected + '", not "' + stage + '". Repeat with the correct choice.');
      }
    };
    const snapshot = async () => {
      await page.waitForTimeout(settleMs);
      const state = JSON.parse(await page.evaluate('(' + snippet + ')({urls: [], cookieNames: []})'));
      checkConsent(state.stage);
      const names = await page.evaluate(() => document.cookie.split(';').map(c => c.trim().split('=')[0]).filter(Boolean));
      names.forEach(name => cookieNames.add(name));
    };
    await snapshot();
    const completed = [];
    for (const action of actions) {
      const result = { trigger: action.trigger, type: action.type, status: 'Completed' };
      try {
        if (action.type === 'visit') {
          const target = websiteUrl(new URL(action.value, url).href);
          if (new URL(target).origin !== new URL(url).origin) throw new Error('Planned visits must stay on the starting origin.');
          await visit(target);
        } else if (action.type === 'scroll') {
          await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        } else if (action.type === 'wait') {
          const ms = Number(action.value);
          if (!Number.isFinite(ms) || ms < 0 || ms > 60000) throw new Error('Wait must be between 0 and 60000 milliseconds.');
          await page.waitForTimeout(ms);
        } else if (action.type === 'click') {
          const answer = await prompt('Approve click for "' + action.trigger + '" (' + action.value +
            ')? This may submit data or cause a conversion. Type CLICK to allow; Enter skips: ');
          if (answer !== 'CLICK') result.status = 'Skipped (not approved)';
          else await page.locator(action.value).click({ timeout: 10000 });
        } else if (action.type === 'manual') {
          const answer = await prompt('Perform the real action for "' + action.trigger +
            '" in the browser. Do not submit leads or purchases without permission. Enter confirms; type SKIP to skip: ');
          if (answer === 'SKIP') result.status = 'Skipped by analyst';
        } else {
          throw new Error('Unsupported action type: ' + action.type);
        }
      } catch (error) {
        result.status = 'Failed';
        // Selector and navigation errors may contain client data; keep them on the local console.
        console.error('Action failed (' + action.trigger + '): ' + error.message);
        errors.push('Action failed: ' + action.trigger);
      }
      completed.push(result);
      await snapshot();
    }
    await snapshot();
    const urls = Array.from(records.values()).filter(r => r.outcome !== 'failed').map(r => r.url);
    const result = JSON.parse(await page.evaluate(
      '(' + snippet + ')(' + JSON.stringify({ urls, cookieNames: Array.from(cookieNames) }) + ')'
    ));
    checkConsent(result.stage);
    result.stage = stage;
    result.url = new URL(url).origin;
    if (result.consentDefault) {
      const clean = {};
      for (const key of ['ad_storage', 'analytics_storage', 'ad_user_data', 'ad_personalization', 'functionality_storage',
        'personalization_storage', 'security_storage']) {
        if (['granted', 'denied'].includes(result.consentDefault[key])) clean[key] = result.consentDefault[key];
      }
      result.consentDefault = clean;
    }
    const requests = Array.from(records.values()).map(({ host, method, resourceType, outcome, status }) =>
      ({ host, method, resourceType, outcome, status }));
    return {
      result,
      session: { stage, actions: completed, events: Array.from(events), requests, errors,
        consentConfirmation: result.cmp ? 'Analyst confirmed; CMP state matched at capture' : 'Analyst confirmed; CMP not detected' }
    };
  } finally {
    await context.close();
  }
}

module.exports = { STAGES, websiteUrl, readContainer, coverage, runSession };
