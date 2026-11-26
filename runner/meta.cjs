'use strict';

// Meta checker: which Meta Pixel tags a GTM export expects to fire, which Meta
// events the browser actually sent during each runner step, and a per-tag
// result for each consent state. Only pixel IDs and event names are kept:
// never URLs, custom data, user data (hashed or not) or cookie values.

const PAGE_LOAD_TYPES = new Set(['pageview', 'domReady', 'windowLoaded', 'built-in']);
// Events Meta's own script sends without a tag asking for them.
const AUTOMATIC_EVENTS = new Set(['Microdata', 'SubscribedButtonClick']);
const PIXEL_ID = /^\d{10,20}$/;
const EVENT_NAME = /^[A-Za-z0-9_ .:-]{1,80}$/;

const params = list => (Array.isArray(list) ? list : []);
const stringValues = p => {
  if (!p) return [];
  if (typeof p.value === 'string') return [p.value];
  return params(p.list).concat(params(p.map)).flatMap(stringValues);
};

function constantVariables(version) {
  const out = {};
  params(version.variable).forEach(v => {
    const value = params(v.parameter).find(p => p.key === 'value');
    if (v.type === 'c' && value && typeof value.value === 'string') out[v.name] = value.value;
  });
  return out;
}

/** Replaces {{Constant}} references; anything else stays dynamic (null). */
function resolve(value, constants) {
  let dynamic = false;
  const text = String(value).replace(/\{\{([^}]+)\}\}/g, (m, name) => {
    if (Object.prototype.hasOwnProperty.call(constants, name)) return constants[name];
    dynamic = true;
    return m;
  }).trim();
  return dynamic ? null : text;
}

function fromCustomHtml(html, constants) {
  const pixelIds = [], events = [];
  let dynamic = false;
  const code = String(html);
  for (const m of code.matchAll(/fbq\(\s*['"]init['"]\s*,\s*(?:['"]([^'"]+)['"]|(\d+))/g)) {
    const id = resolve(m[1] || m[2], constants);
    if (id && PIXEL_ID.test(id)) pixelIds.push(id); else dynamic = true;
  }
  const track = /fbq\(\s*['"](track|trackCustom|trackSingle|trackSingleCustom)['"]\s*,\s*['"]([^'"]+)['"](?:\s*,\s*['"]([^'"]+)['"])?/g;
  for (const m of code.matchAll(track)) {
    const single = /^trackSingle/.test(m[1]);
    const id = single ? resolve(m[2], constants) : null;
    const event = resolve(single ? m[3] || '' : m[2], constants);
    if (single && id && PIXEL_ID.test(id)) pixelIds.push(id);
    if (event && EVENT_NAME.test(event)) events.push(event); else dynamic = true;
  }
  return { pixelIds, events, dynamic };
}

function fromTemplate(tag, constants) {
  const pixelIds = [], events = [];
  let dynamic = false;
  params(tag.parameter).forEach(p => {
    const key = String(p.key || '');
    stringValues(p).forEach(raw => {
      if (/pixel/i.test(key)) {
        const value = resolve(raw, constants);
        if (value === null) { dynamic = true; return; }
        value.split(/[\s,]+/).filter(id => PIXEL_ID.test(id)).forEach(id => pixelIds.push(id));
      } else if (/event/i.test(key) && !/(param|data|id|callback|type)$/i.test(key)) {
        const value = resolve(raw, constants);
        if (value === null) { dynamic = true; return; }
        if (/^(standard|custom|true|false)$/i.test(value) || !value) return;
        if (EVENT_NAME.test(value)) events.push(value);
      }
    });
  });
  return { pixelIds, events, dynamic };
}

function isMetaTemplate(tag, templates) {
  const match = /^cvt_(?:\d+_)?(\d+)$/.exec(tag.type || '');
  const template = match && templates.find(t => String(t.templateId) === match[1]);
  const text = template ? (template.name || '') + ' ' + JSON.stringify(template.galleryReference || {}) + ' ' +
    String(template.templateData || '').slice(0, 200000) : '';
  return /facebook|fbevents|\bfbq\b|meta pixel/i.test(text) ||
    (/\b(meta|facebook|fb)\b/i.test(tag.name || '') && params(tag.parameter).some(p => /pixel/i.test(p.key || '')));
}

/** Meta Pixel tags in a GTM export, with what each is expected to send. */
function metaTags(version, triggers) {
  const constants = constantVariables(version);
  const templates = params(version.customTemplate);
  const triggerName = id => (triggers.find(t => t.id === id) || {}).name || id;
  return params(version.tag).map(tag => {
    let found = null;
    if (tag.type === 'html') {
      const html = params(tag.parameter).find(p => p.key === 'html');
      if (html && /\bfbq\(|connect\.facebook\.net\/[^'"]*fbevents/.test(html.value || '')) found = fromCustomHtml(html.value, constants);
    } else if (/^cvt_/.test(tag.type || '') && isMetaTemplate(tag, templates)) {
      found = fromTemplate(tag, constants);
    }
    if (!found) return null;
    const ids = (tag.firingTriggerId || []).map(String);
    return {
      tag: String(tag.name || tag.tagId).slice(0, 500), paused: !!tag.paused,
      pixelIds: Array.from(new Set(found.pixelIds)).slice(0, 20),
      events: Array.from(new Set(found.events)).slice(0, 20),
      dynamic: found.dynamic,
      triggerIds: ids, triggers: ids.map(triggerName).map(n => String(n).slice(0, 500))
    };
  }).filter(Boolean);
}

/** Pixel ID and event name of a Meta Pixel event request, or null. Nothing else is read. */
function metaEvent(url, postData) {
  let u;
  try { u = new URL(url); } catch (e) { return null; }
  if (!/(^|\.)facebook\.com$/.test(u.hostname) || !/^\/tr\/?$/.test(u.pathname)) return null;
  let id = u.searchParams.get('id'), ev = u.searchParams.get('ev');
  if ((!id || !ev) && typeof postData === 'string' && postData.length < 200000) {
    try {
      const body = new URLSearchParams(postData);
      id = id || body.get('id');
      ev = ev || body.get('ev');
    } catch (e) { /* not form data */ }
  }
  return {
    pixelId: id && PIXEL_ID.test(id) ? id : null,
    event: ev && EVENT_NAME.test(ev) ? ev : ev ? 'Other' : null
  };
}

/** Adds one observed event to a step's tally ([{step, pixelId, event, count}]). */
function recordMetaEvent(list, step, hit) {
  const same = list.find(x => x.step === step && x.pixelId === hit.pixelId && x.event === hit.event);
  if (same) same.count++;
  else if (list.length < 5000) list.push({ step, pixelId: hit.pixelId, event: hit.event, count: 1 });
}

const matches = (tag, hit) =>
  (!tag.pixelIds.length || tag.pixelIds.includes(hit.pixelId)) &&
  (!tag.events.length || tag.events.includes(hit.event));

/**
 * One row per Meta tag: for each consent state, whether its expected event was
 * seen during the steps that exercise its triggers.
 *   triggers: from readContainer; sessions: [{stage, actions:[{triggerId, type, status}], meta:[…]}]
 */
function metaCheck(tags, triggers, sessions) {
  const pageLoad = new Set(triggers.filter(t => PAGE_LOAD_TYPES.has(t.type)).map(t => t.id));
  const used = new Map(); // stage → Set of "step|pixel|event" matched to a tag
  const rows = tags.map(tag => {
    const loads = tag.triggerIds.some(id => pageLoad.has(id));
    const stages = {};
    sessions.forEach(s => {
      if (!used.has(s.stage)) used.set(s.stage, new Set());
      if (tag.paused) { stages[s.stage] = { status: 'Paused', seen: [] }; return; }
      const steps = [];
      if (loads) steps.push('load');
      s.actions.forEach((a, i) => {
        if (a.status === 'Completed' && (tag.triggerIds.includes(a.triggerId) || (loads && a.type === 'visit'))) steps.push(i);
      });
      if (!steps.length) { stages[s.stage] = { status: 'Not tested', seen: [] }; return; }
      const inSteps = (s.meta || []).filter(h => steps.includes(h.step) && !AUTOMATIC_EVENTS.has(h.event));
      const hits = inSteps.filter(h => matches(tag, h));
      hits.forEach(h => used.get(s.stage).add(h.step + '|' + h.pixelId + '|' + h.event));
      const seen = (hits.length ? hits : inSteps).map(h => ({ pixelId: h.pixelId, event: h.event, count: h.count }));
      const consented = s.stage === 'accept';
      const unknown = !tag.pixelIds.length && !tag.events.length;
      const status = hits.length ? (!consented ? 'Fired without consent' : unknown ? 'Meta event seen' : 'Fired')
        : inSteps.length ? (consented ? 'Different event or pixel' : 'Fired without consent')
        : consented ? 'Not fired' : 'Blocked';
      stages[s.stage] = { status, seen: seen.slice(0, 20) };
    });
    return { tag: tag.tag, pixelIds: tag.pixelIds, events: tag.events, dynamic: tag.dynamic,
      triggers: tag.triggers, stages, verdict: verdict(tag, stages) };
  });
  const unlinked = sessions.map(s => ({
    stage: s.stage,
    events: (s.meta || []).filter(h => !AUTOMATIC_EVENTS.has(h.event) &&
      !(used.get(s.stage) || new Set()).has(h.step + '|' + h.pixelId + '|' + h.event))
      .map(h => ({ step: h.step === 'load' ? 'Page load' : (s.actions[h.step] || {}).trigger || 'Action ' + (h.step + 1),
        pixelId: h.pixelId, event: h.event, count: h.count })).slice(0, 200)
  })).filter(u => u.events.length);
  return { rows, unlinked };
}

function verdict(tag, stages) {
  if (tag.paused) return 'Paused';
  const s = k => (stages[k] || {}).status;
  if (s('before') === 'Fired without consent' || s('deny') === 'Fired without consent') return 'Fires without consent';
  if (s('accept') === 'Fired') return 'Working';
  if (s('accept') === 'Meta event seen') return 'Meta event seen; check the tag in GTM Preview';
  if (s('accept') === 'Different event or pixel') return 'Check event or pixel ID';
  if (s('accept') === 'Not fired') return 'Not firing after Accept';
  return 'Not tested';
}

module.exports = { metaTags, metaEvent, recordMetaEvent, metaCheck, AUTOMATIC_EVENTS };
