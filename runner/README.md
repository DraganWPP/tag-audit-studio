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

## Meta checker

If the export contains Meta Pixel tags (Custom HTML with `fbq(...)`, or the
Facebook Pixel template), the runner also checks each one:

1. From the export it reads each tag's pixel ID, event name and firing triggers.
   `{{Constant}}` variables are resolved; other variables are shown as
   "set by a variable".
2. While it runs, it notes each Meta Pixel event request (`facebook.com/tr`, GET
   or POST) and which step sent it: the page load or one of your actions. Only
   the **pixel ID** and **event name** are kept. Customer data (hashed or not),
   custom data, page URLs and the request itself are never saved.
3. For each tag and consent state it reports **Fired**, **Not fired**,
   **Different event or pixel**, **Fired without consent**, **Blocked** or
   **Not tested** (no completed action for its triggers). Page-load tags are
   checked on the starting page load and on `visit` actions.

Select the triggers of the Meta tags you want checked. The app shows the result
in a Meta checker table under Live test results and adds an audit issue for tags
that did not fire after Accept or sent a different event or pixel ID.

Limits: Conversions API (server-side) events aren't visible; two tags sending the
same event and pixel can't be told apart; Meta's automatic `Microdata` and
`SubscribedButtonClick` events are ignored; a Meta event listed as "not linked to
a tag" may come from the site's own code or another container.

## Evidence and limits

- Vendor requests and cookie names use the same classifier as the console
  snippet. Failed network requests are listed but excluded from vendor counts.
- The runner observes requests across main-page navigation and default
  `dataLayer.push` event names. It saves request hosts, methods, types, response
  status and failure state, not request paths, query strings, bodies, headers,
  cookie values, or other data-layer fields. Consent signals are retained. The
  Meta checker additionally keeps Meta pixel IDs and event names.
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
