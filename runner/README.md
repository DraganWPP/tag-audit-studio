# Local GTM-guided runner

This optional Node.js tool opens Chromium on your computer. The GitHub Pages app
remains static and needs neither Node.js nor a backend to serve reports.

## Setup

Install Node.js 22 or newer, then run these commands from the repository folder:

```powershell
npm install
npx playwright install chromium
npm run runner -- --url https://example.com --export "C:\Audits\container.json"
```

In GTM, download the container using **Admin > Export Container**. Keep exports
outside the repository or in its ignored `exports` folder.

## Workflow

1. Confirm you have permission to test the site. Prefer a staging site or test
   analytics property: real interactions can create real conversions.
2. Read the listed triggers, conditions and directly associated active tags.
   Select trigger numbers and choose an action for each:
   - `visit`: visit a same-origin URL/path.
   - `click`: use a CSS/Playwright selector; type `CLICK` to approve each execution.
   - `scroll`: scroll to the bottom (not a guarantee that every threshold fires).
   - `wait`: wait for up to 60 seconds.
   - `manual`: perform the genuine journey in the browser, then confirm in the terminal.
   - `skip`: leave that trigger untested.
3. The runner opens a fresh browser context for each scenario:
   - **Before choice:** leave the banner untouched and confirm.
   - **Deny:** manually reject all, confirm, then the runner reloads the starting
     page before collecting evidence.
   - **Accept:** manually accept all, confirm, then the runner reloads.
4. It repeats your selected actions in order in each context. Use `manual` for
   custom events, forms, purchases, login flows and trigger groups. Never submit
   a lead or purchase without explicit permission. No custom events are injected.
5. Import the generated `.runner.json` file in the app's **Live consent test**
   section on New audit or the Live test results page. Add the GTM export
   separately for the normal static audit.

Results default to the ignored `runner-results` folder. Use
`--out "C:\Audits\example.runner.json"` to choose another location; existing files
are never overwritten at startup. Results are checkpointed after each completed
scenario, so a failed later scenario leaves earlier results available.

## Evidence and limits

- Vendor requests and cookie names use the same classifier as the console
  snippet. Failed network requests are listed but excluded from vendor counts.
- The runner observes requests across main-page navigation and default
  `dataLayer.push` event names. It saves request hosts, methods, types, response
  status and failure state, not request paths, query strings, bodies, headers,
  cookie values, or other data-layer fields. Consent signals are retained.
- Raw request URLs exist only in memory to classify vendors and read `gcs`.
  Tag/trigger names, event names and site origins are still client data: inspect
  results before sharing them. There are no AI/provider calls.
- Deny/Accept exclude requests from before the manual choice. Reloading assumes
  the CMP persists the choice. Consent is checked before and after the planned
  actions; a detected CMP state mismatch aborts that scenario;
  for unrecognised CMPs, the analyst's confirmation is the only consent evidence.
- The runner does not infer a journey from trigger conditions or prove a trigger
  matched. Actions are analyst-selected hints, not individual-tag firing evidence.
  Coverage always says firing is unverified. Use GTM Preview / Tag Assistant to
  confirm exact tags, conditions, exceptions, sequencing and custom templates.
- Service workers are blocked for observability; this can change site behaviour.
  Popups/iframes may contribute network requests but their cookie jars and
  data layers are not inspected. Non-default data layers and server-side activity
  are not covered. Browser location, timing and CMP geography affect results.
- Automation does not prevent a permitted click or manual interaction from
  submitting data. Don't select destructive or transactional actions casually.
- This first version is deterministic and analyst-guided, not AI navigation.

## Checks

```powershell
npm run check
npm test
```

Tests use a synthetic local website and mocked tracking endpoints, not client data.
