# Tag Audit Studio — project notes for Claude

A static web app (hosted on GitHub Pages) for auditing a client's **GTM, GA4 and cookie-consent** setup and turning it into a client-ready report, with an AI assistant built in. It's used by agency analysts (WPP Media). The project started as a Google Sheets Apps Script (`apps-script/TagScanner.gs`), and its analysis engine was ported here.

## Constraints

- **No build step and no framework.** Plain HTML, CSS and classic `<script>` files that share global functions, so GitHub Pages serves the folder as it is. Don't add npm dependencies to the runtime.
- **No backend.** Everything runs in the browser:
  - `googletagmanager.com/gtm.js?id=…` and `gtag/js` can be fetched directly (verified: they're readable from another site in the browser).
  - Client websites can't be fetched (blocked by the browser). Page source comes from a console snippet the user pastes: `PAGE_SOURCE_SNIPPET` in `engine-web.js`.
  - The GTM API and GA4 Admin API are called with Google Identity Services tokens, using the read-only scopes `tagmanager.readonly` and `analytics.readonly`.
  - AI calls go straight from the browser to the provider with the user's own key, stored in localStorage:
    - Anthropic, using the `anthropic-dangerous-direct-browser-access` header
    - OpenAI-compatible endpoints, with a base URL (for Azure or an internal gateway)
    - Gemini
- **Privacy:** never write client data to the repo. Saved audits are downloaded `.json` files, which `.gitignore` excludes. Snippets read cookie **names** only, never values.

## Files and data flow

```
index.html          shell: left rail nav + #view; loads scripts in this order ↓
js/engine.js        pure audit engine, extracted from apps-script/TagScanner.gs (≈150 functions/consts)
js/engine-web.js    browser replacements: AUDIT state (let + resetAudit_), containerCache_, fetchContainer_,
                    readClientSettings_ (from WEB_SETTINGS), GA4 checks from prefetched data, live-test merge,
                    TAG_OVERRIDES (AI/analyst vendor overrides), analyseExportJson_, workspaceRowsFromData_
js/google.js        Google sign-in, GTM API (lookup → live version → workspaces/status), GA4 Admin API
js/ai.js            providers, AI_SYSTEM prompt, AI_TASKS (writeup, fixplan), aiExplainUnknownTags, aiAuditContext,
                    renderMarkdown (small, safe — escapes HTML first)
js/app.js           STATE, views (audit, summary, consent, tags, ids, live, findings, ai, settings), runAudit()
                    pipeline, exports (PDF via window.print + #print-report, CSV, save/open audit JSON)
css/app.css         design tokens, light/dark, print stylesheet
```

**`runAudit()` pipeline** (in `app.js`): the async fetch steps run first, then the synchronous engine.
1. Read containers through the GTM API, and parse the IDs in any exports. These count as "full detail".
2. Download the published `gtm.js` for public IDs, plus the GTM IDs found in page source. Containers that have full detail are skipped, so tags aren't counted twice.
3. Call `resetAudit_()`, then copy the downloads into `containerCache_`.
4. `analyseHtml_(page, true)`, then `analyseContainers_(publicIds)`, then `analyseExportJson_()`, then `analyseContainerVersion_()` for the API results.
5. Set `AUDIT.liveData`. If signed in, fetch GA4 data for the live GA4 IDs into `AUDIT.ga4Data`.
6. `rows = dedupe_(findings.concat(runAuditChecks_()))`, then `buildResult()`, which serialises the groups, issues, areas, score and live results.

**Engine conventions** (from the Apps Script; keep them):
- **Result rows** are `row_(type, value, source, details, notes)`. Tag rows carry a `.group` property (the platform group) that `groupFindings_` uses. `buildResult` serialises the groups because JSON drops that property.
- **Every tag** goes through `buildTagRow_` → `recordTag_`. That records the tag for the consent matrix, ID collection, GA4 events and the security checks. A tag's key is `source + '|' + (name || summary)` and is used for overrides.
- **Issues** are recorded with `recordIssue_(area, severity, finding, action, where, items, {row:false})`. The areas are listed in `AREAS`. Scoring is `areaScore_` (−30 High, −12 Medium, −4 Low), and `overallScore_` takes a weighted average.
- **Consent rating** happens in `assessConsent_`. It can return High, Medium, Check, OK, or `—` (paused). Category matching uses the client rules (`adsCats` / `analyticsCats` / `functionalCats`).
- **Platform groups** come from `TAG_GROUPS`, `TYPE_GROUP`, `VENDOR_GROUP` and `NAME_RULES`. Logos come from Google's favicon service.
- **Vendors** are `[name, regex, purpose]` entries in `VENDORS`.

## Design

The concept is an "inspection report":
- **Colours:** cool paper `#EDF0F3`, navy ink `#16233A`, and highlighter yellow `#FFE45C`, used ONLY to mark High items. Signal colours are reserved for risk.
- **Type:** Instrument Sans for the interface, IBM Plex Mono only for IDs and code.
- **The one bold moment:** the stamped health grade on the Summary.
- **Avoid:** generic SaaS card grids, all-caps labels, and decorative motion.
- Keep it accessible: visible focus, the reduced-motion setting respected, and no horizontal scroll at 390px wide.

## Testing

There are no unit tests yet. What was done during development:
- `npm run check` (`node --check` on every script).
- An end-to-end Playwright run against a mocked network:
  - `gtm.js` served from a fixture compiled container, which has paused tags, trigger groups, rules, OneTrust gating and a hard-coded token
  - a container export fixture with templates (Facebook Pixel, Amazon, Cookiebot), triggers and variables
  - live-test JSON for the before / deny / accept states
  - a mocked Anthropic API

  It checks the summary grade, nav counts, consent filter, AI overrides re-running the audit, the print report, and save → reopen.

Good next step: add these fixtures under `tests/` with a Playwright script (`npx playwright test`).

## Live findings so far (Omoda UK, omodaauto.co.uk)

The live site uses **GTM-WMTL9BKM**, GA4 **G-NHCZDNK9XQ** and **G-1B2T1Q5T3F**, and Google Ads **AW-11503056335**, with **Cookiebot** as the CMP.
- An earlier Sheet scan showed GTM-5ZT4J2M. That was probably an old Wayback copy.
- Live consent test (from a UK session):
  - Consent Mode v2 defaults are all denied.
  - Google tags send cookieless pings only (`gcs=G100`).
  - Meta, TikTok, LinkedIn and Amazon wait for consent.
  - **Microsoft Clarity sends data before any choice AND after Deny.** It sets no cookies in those states.
  - **Samba TV fires before any choice** and stops after Deny.
  - Udesk chat, Driftrock and cdn.sanity.io load regardless of consent.

## Open ideas / backlog

- **Tests:** commit the Playwright fixtures and tests.
- **Batch audits:** several sites or containers in one run.
- **Excel export:** probably via SheetJS from cdnjs, loaded only when needed.
- **Optional proxy:** a Cloudflare Worker to fetch client page source server-side.
- **AI changes in GTM:** let the AI suggest exact GTM changes in GTM's own import (JSON) format.
- **Keep the two versions in step:** `apps-script/TagScanner.gs` is the Sheets version. When engine logic changes here, consider porting it back.
