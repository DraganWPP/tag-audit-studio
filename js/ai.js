// ════════════════════════════════════════════════════════════════════
//  Tag Audit Studio — AI assistant
//  Providers: Anthropic Claude, any OpenAI-compatible endpoint (OpenAI,
//  Azure / internal gateways) and Google Gemini. Calls go straight from
//  the browser to the provider with the user's own key.
// ════════════════════════════════════════════════════════════════════

const AI_PROVIDERS = {
  anthropic: { label: 'Anthropic Claude', defaultModel: 'claude-sonnet-5-5', needsBase: false },
  openai:    { label: 'OpenAI-compatible (OpenAI, Azure, internal gateway)', defaultModel: 'gpt-4.1', needsBase: true,
               defaultBase: 'https://api.openai.com/v1' },
  gemini:    { label: 'Google Gemini', defaultModel: 'gemini-2.5-pro', needsBase: false }
};

const AI_SYSTEM = [
  'You are a senior analytics and privacy consultant at a media agency, reviewing a client\'s',
  'tag management (GTM), GA4 and cookie-consent setup. You are given structured audit data.',
  'Rules:',
  '- Use only the audit data provided. Never invent tags, IDs, vendors or numbers. If something',
  '  is not in the data, say it was not checked.',
  '- Assume UK/EU rules (UK GDPR, PECR, ePrivacy) unless the client settings say analytics',
  '  does not need consent.',
  '- Be specific: name the tag, trigger, vendor or ID each point is about.',
  '- Write in clear, plain English for a mixed audience (marketing + developers). No hype.',
  '- You are not giving legal advice; flag where the client\'s legal/DPO team should confirm.'
].join('\n');

const AI = {
  config() {
    const s = loadAppSettings();
    const provider = s.aiProvider || 'anthropic';
    return {
      provider: provider,
      key: s.aiKey || '',
      model: s.aiModel || AI_PROVIDERS[provider].defaultModel,
      base: (s.aiBase || AI_PROVIDERS[provider].defaultBase || '').replace(/\/+$/, '')
    };
  },

  isConfigured() { return !!this.config().key; },

  /** messages: [{ role: 'user'|'assistant', content }] */
  async chat(messages, opts) {
    opts = opts || {};
    const c = this.config();
    if (!c.key) throw new Error('Add an AI provider and API key in Settings to use the assistant.');
    const system = opts.system || AI_SYSTEM;
    const maxTokens = opts.maxTokens || 4000;
    let res, data;

    if (c.provider === 'anthropic') {
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json', 'x-api-key': c.key, 'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify({ model: c.model, max_tokens: maxTokens, system: system, messages: messages })
      });
      data = await readJson_(res);
      return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
    }

    if (c.provider === 'openai') {
      res = await fetch(c.base + '/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + c.key },
        body: JSON.stringify({
          model: c.model, max_tokens: maxTokens,
          messages: [{ role: 'system', content: system }].concat(messages)
        })
      });
      data = await readJson_(res);
      return data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : '';
    }

    if (c.provider === 'gemini') {
      res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(c.model) +
                        ':generateContent?key=' + encodeURIComponent(c.key), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
          generationConfig: { maxOutputTokens: maxTokens }
        })
      });
      data = await readJson_(res);
      const cand = data.candidates && data.candidates[0];
      return cand && cand.content ? cand.content.parts.map(p => p.text || '').join('') : '';
    }
    throw new Error('Unknown AI provider: ' + c.provider);
  }
};

async function readJson_(res) {
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) { /* not JSON */ }
  if (!res.ok) {
    const msg = data && (data.error && (data.error.message || data.error)) || text.slice(0, 300);
    if (res.status === 401 || res.status === 403) throw new Error('The AI provider rejected the API key (' + res.status + '). Check it in Settings. ' + msg);
    if (res.status === 404) throw new Error('Model or endpoint not found — check the model name and base URL in Settings. ' + msg);
    if (res.status === 429) throw new Error('The AI provider is rate-limiting this key. Wait a minute and try again.');
    throw new Error('AI request failed (' + res.status + '): ' + msg);
  }
  return data || {};
}

// ── Audit context for the model ─────────────────────────────────────

function aiAuditContext(result, maxChars) {
  maxChars = maxChars || 90000;
  const a = result.audit;
  const ctx = {
    client: result.meta.client || null,
    site: result.meta.site || null,
    sources: result.meta.sources,
    detailLevel: a.fullDetail ? 'full (GTM API / export: real tag names)' : 'public (published container: no tag names)',
    healthScore: result.score,
    areaScores: result.areas.map(x => ({ area: x.area, score: x.score, status: x.status })),
    consentMode: a.consentMode,
    issues: a.issues.map(i => ({ severity: i.severity, area: i.area, finding: i.finding, action: i.action,
                                 where: i.where, items: (i.items || []).slice(0, 15) })),
    tags: a.tags.map(t => ({
      tag: t.label, platform: t.platform, type: t.type, vendor: t.vendor, purpose: t.purpose,
      paused: t.paused, firesOn: (t.firesOn || []).join(' OR ').slice(0, 200),
      blockedBy: (t.blockedBy || []).join(' OR ').slice(0, 120),
      consentRisk: t.risk, consentHandling: t.handling, aiNote: t.ai && t.ai.what || undefined
    })),
    ids: Object.keys(a.ids).map(k => a.ids[k]).map(r => ({ platform: r.platform, id: r.id, live: r.live, usedBy: r.tags.slice(0, 5) })),
    liveConsentTest: result.live ? result.live.verdicts.map(v => ({ vendor: v.vendor, purpose: v.purpose,
      beforeChoice: v.cells.before, afterDeny: v.cells.deny, afterAccept: v.cells.accept, verdict: v.verdict })) : 'not run',
    ga4Property: (result.rows || []).filter(r => r[0] === '📈 GA4 Property').map(r => ({ property: r[1], id: r[2], info: r[3] })),
    clientSettings: result.meta.settings
  };
  let json = JSON.stringify(ctx);
  if (json.length > maxChars) {                      // trim the bulkiest part first
    ctx.tags = ctx.tags.filter(t => t.consentRisk !== 'OK').slice(0, 120);
    json = JSON.stringify(ctx);
  }
  return json.length > maxChars ? json.slice(0, maxChars) + '…(truncated)' : json;
}

const AI_TASKS = {
  writeup: {
    title: 'Client write-up',
    prompt: [
      'Write a client-ready audit report in Markdown from this data. Structure:',
      '# Tag & consent audit — {client/site}',
      '## Executive summary — 4–6 bullets a marketing director can act on',
      '## Health score — one short paragraph on the score and what drives it',
      '## Top risks — numbered by priority; for each: what we found, why it matters (legal / data quality / media), what to do',
      '## What is working well',
      '## Recommendations — three sub-lists: Quick wins (this week), Next 30 days, Strategic',
      '## Scope and limitations — what was and was not checked',
      'Keep it under 900 words.'
    ].join('\n')
  },
  fixplan: {
    title: 'GTM fix plan',
    prompt: [
      'Write a step-by-step GTM / GA4 fix plan in Markdown for the developer or ad-ops person who will make the changes.',
      'Group steps under: Consent & CMP, Tags to remove, Triggers & firing, Tags to add or reconfigure, GA4 property settings, Verify.',
      'Use "- [ ]" checkboxes. Each step names the exact tag/trigger/vendor and the change (e.g. "Add Additional Consent Check ad_storage",',
      '"Change trigger to Cookiebot consent event with marketing = true"). Put the highest-risk fixes first within each group.',
      'End with how to verify: GTM Preview, Tag Assistant consent view, and re-running the live consent test.',
      'Only include steps supported by the audit data.'
    ].join('\n')
  }
};

/** Asks the model what each unrecognised tag does. Returns override objects keyed by tag key. */
async function aiExplainUnknownTags(result, onProgress) {
  const unknown = result.audit.tags.filter(t => !t.paused && t.purpose === 'unknown' && !t.aiVendor);
  if (!unknown.length) return {};
  const batches = [];
  for (let i = 0; i < unknown.length; i += 12) batches.push(unknown.slice(i, i + 12));
  const out = {};
  for (let b = 0; b < batches.length; b++) {
    onProgress && onProgress('Reading tag code ' + (b * 12 + 1) + '–' + Math.min((b + 1) * 12, unknown.length) + ' of ' + unknown.length + '…');
    const payload = batches[b].map(t => ({
      key: t.key, tag: t.label, type: t.type, firesOn: (t.firesOn || []).join(' OR ').slice(0, 160),
      code: String(t.text || '').slice(0, 3500)
    }));
    const prompt = [
      'For each GTM tag below, read its code and identify what it does. Reply with ONLY a JSON array, no prose, one object per tag:',
      '{"key": <copy the key exactly>, "vendor": <company/product name, or "Internal / site code">,',
      ' "purpose": "advertising" | "analytics" | "functional" | "necessary" | "unknown",',
      ' "consent": <consent category it needs, e.g. "marketing", "statistics", "preferences", "none">,',
      ' "what": <one sentence: what the code does>, "confidence": "high" | "medium" | "low"}',
      'Use "necessary" only for code the site cannot work without (e.g. CMP, security). Code that sends visitor data to a third party is not necessary.',
      '',
      JSON.stringify(payload)
    ].join('\n');
    const text = await AI.chat([{ role: 'user', content: prompt }], { maxTokens: 4000 });
    const json = (text.match(/\[[\s\S]*\]/) || [])[0];
    if (!json) throw new Error('The AI reply did not contain the expected JSON. Try again or use another model.');
    JSON.parse(json).forEach(r => {
      if (!r || !r.key) return;
      const purpose = ['advertising', 'analytics', 'functional', 'necessary', 'unknown'].indexOf(r.purpose) >= 0 ? r.purpose : 'unknown';
      out[r.key] = { vendor: r.vendor, purpose: purpose, consent: r.consent, what: r.what, confidence: r.confidence, source: 'AI' };
    });
  }
  return out;
}

// ── Minimal, safe Markdown renderer for AI output ───────────────────

function renderMarkdown(md) {
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = s => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  const lines = String(md || '').replace(/\r/g, '').split('\n');
  let html = '', list = null, inCode = false, code = [], table = [];
  const closeList = () => { if (list) { html += '</' + list + '>'; list = null; } };
  const flushTable = () => {
    if (!table.length) return;
    const rows = table.filter(r => !/^\s*\|?\s*:?-{2,}/.test(r)).map(r => r.replace(/^\s*\||\|\s*$/g, '').split('|'));
    html += '<table><thead><tr>' + rows[0].map(c => '<th>' + inline(c.trim()) + '</th>').join('') + '</tr></thead><tbody>' +
            rows.slice(1).map(r => '<tr>' + r.map(c => '<td>' + inline(c.trim()) + '</td>').join('') + '</tr>').join('') + '</tbody></table>';
    table = [];
  };
  lines.forEach(line => {
    if (/^```/.test(line)) {
      if (inCode) { html += '<pre><code>' + esc(code.join('\n')) + '</code></pre>'; code = []; inCode = false; }
      else { closeList(); flushTable(); inCode = true; }
      return;
    }
    if (inCode) { code.push(line); return; }
    if (/^\s*\|.*\|\s*$/.test(line)) { closeList(); table.push(line); return; }
    flushTable();
    let m;
    if ((m = line.match(/^(#{1,4})\s+(.*)/))) { closeList(); const n = Math.min(m[1].length + 1, 5); html += '<h' + n + '>' + inline(m[2]) + '</h' + n + '>'; return; }
    if ((m = line.match(/^\s*[-*]\s+\[( |x|X)\]\s+(.*)/))) {
      if (list !== 'ul') { closeList(); html += '<ul class="checklist">'; list = 'ul'; }
      html += '<li><input type="checkbox" ' + (m[1] !== ' ' ? 'checked' : '') + '> <span>' + inline(m[2]) + '</span></li>'; return;
    }
    if ((m = line.match(/^\s*[-*]\s+(.*)/))) { if (list !== 'ul') { closeList(); html += '<ul>'; list = 'ul'; } html += '<li>' + inline(m[1]) + '</li>'; return; }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) { if (list !== 'ol') { closeList(); html += '<ol>'; list = 'ol'; } html += '<li>' + inline(m[1]) + '</li>'; return; }
    if (!line.trim()) { closeList(); return; }
    closeList();
    html += '<p>' + inline(line) + '</p>';
  });
  if (inCode) html += '<pre><code>' + esc(code.join('\n')) + '</code></pre>';
  closeList(); flushTable();
  return html;
}
