'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const readline = require('node:readline/promises');
const { parseArgs } = require('node:util');
const { chromium } = require('playwright');
const { STAGES, websiteUrl, readContainer, coverage, runSession } = require('./core.cjs');

async function main() {
  const { values } = parseArgs({ options: {
    url: { type: 'string' }, export: { type: 'string' }, out: { type: 'string' }, help: { type: 'boolean' }
  } });
  if (values.help) {
    console.log('npm run runner -- --url https://example.com --export "C:\\path\\container.json"');
    console.log('Optional: --out "C:\\path\\results.runner.json" (must not already exist)');
    return;
  }
  if (!values.url || !values.export) throw new Error('Provide --url and --export. Use --help for an example.');
  const url = websiteUrl(values.url);
  const container = readContainer(await fs.readFile(values.export, 'utf8'));
  const out = path.resolve(values.out || path.join('runner-results', Date.now() + '.runner.json'));
  if (!out.endsWith('.runner.json')) throw new Error('Output filename must end with .runner.json to keep client results out of Git.');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const prompt = message => rl.question(message + '\n> ');
  let browser;
  try {
    console.log('Local GTM-guided runner: ' + container.id + ' (' + container.tags.length + ' tags)');
    console.log('Only test sites you are authorised to audit. Real actions can send real analytics/conversions.');
    console.log('No AI calls, automatic form filling, synthetic data-layer pushes or proof of individual tag firing.');
    if (await prompt('Type START to confirm permission and continue:') !== 'START') return;
    container.triggers.forEach((t, i) => {
      const tags = container.tags.filter(tag => !tag.paused && tag.triggers.includes(t.id));
      console.log('\n' + (i + 1) + '. ' + t.name + ' [' + t.type + ']');
      console.log('   Tags: ' + (tags.map(t => t.name).join(', ') || 'No active direct tag references'));
      console.log('   Conditions: ' + t.conditions);
    });
    const selected = (await prompt('Select trigger numbers, separated by commas (Enter = baseline only):')).trim();
    const indices = selected ? Array.from(new Set(selected.split(',').map(s => Number(s.trim()) - 1))) : [];
    if (indices.some(i => !Number.isInteger(i) || i < 0 || i >= container.triggers.length)) {
      throw new Error('Invalid trigger selection.');
    }
    const actions = [];
    for (const index of indices) {
      const trigger = container.triggers[index];
      const type = (await prompt('Action for "' + trigger.name + '": visit, click, scroll, wait, manual, or skip:')).trim();
      if (type === 'skip') continue;
      if (!['visit', 'click', 'scroll', 'wait', 'manual'].includes(type)) throw new Error('Invalid action type.');
      const value = ['visit', 'click', 'wait'].includes(type)
        ? await prompt(type === 'visit' ? 'URL or path on the same origin:'
          : type === 'click' ? 'Playwright/CSS selector (each click requires approval):' : 'Wait in milliseconds (0-60000):') : '';
      actions.push({ triggerId: trigger.id, trigger: trigger.name, type, value });
    }
    console.log('\nThe same selected actions run in order in three fresh browser contexts.');
    console.log('Deny/Accept evidence starts after your choice, on a fresh page load. Before-choice requests are excluded.');
    console.log('Only request hosts/status, cookie names and data-layer event names are saved, not URLs, bodies or cookie values.');
    browser = await chromium.launch({ headless: false });
    const output = {
      tool: 'tag-audit-local-runner', v: 1, time: new Date().toISOString(),
      container: { id: container.id, name: container.name }, results: [], sessions: [], coverage: coverage(container, actions)
    };
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(out, JSON.stringify(output, null, 2), { encoding: 'utf8', flag: 'wx' });
    for (const stage of STAGES) {
      console.log('\n--- ' + stage.toUpperCase() + ' ---');
      const { result, session } = await runSession({ browser, url, stage, actions, prompt });
      output.results.push(result);
      output.sessions.push(session);
      await fs.writeFile(out, JSON.stringify(output, null, 2), 'utf8');
    }
    console.log('\nSaved: ' + out + '\nImport this file under Live consent test in Tag Audit Studio.');
  } finally {
    rl.close();
    if (browser) await browser.close();
  }
}

main().catch(error => { console.error('Runner failed: ' + error.message); process.exitCode = 1; });
