# Tag Audit Studio — project notes for Claude

A static web app (hosted on GitHub Pages) for auditing a client's **GTM, GA4 and cookie-consent** setup and turning it into a client-ready report, with an AI assistant built in. It's used by agency analysts (WPP Media). The project started as a Google Sheets Apps Script (`apps-script/TagScanner.gs`), and its analysis engine was ported here.

## Constraints

- **No build step and no framework.** Plain HTML, CSS and classic `<script>` files that share global functions, so GitHub Pages serves the folder as it is. Don't add npm dependencies to the runtime.
- **No backend.** Everything runs in the browser:
  - `googletagmanager.com/gtm.js?id=…` and `gtag/js` can be fetched directly (verified: they're readable from another site in the browser).
  - Client websites can't be fetched (blocked by the browser). Page source comes from a console snippet the user pastes: `PAGE_SOURCE_SNIPPET` in `engine-web.js`.
  - The GTM API, GA4 Admin API and GA4 Data API are called with an OAuth token from a full-page redirect sign-in (implicit flow; no popup, no Google Identity Services script). Scopes: `tagmanager.readonly`, `analytics.readonly` and `userinfo.email`, plus optional ones asked for only when a feature needs them: `dfareporting` (CM360 reports) and `webmasters.readonly` (Search Console). The token is kept in sessionStorage (this tab, at most an hour). The OAuth client ID is built in via `js/config.js`; Settings has an optional override.
  - AI calls go straight from the browser to the provider with the user's own key, stored in localStorage:
    - Anthropic, using the `anthropic-dangerous-direct-browser-access` header
    - OpenAI-compatible endpoints, with a base URL (for Azure or an internal gateway)
    - Gemini
- **Privacy:** never write client data to the repo. Saved audits are downloaded `.json` files, which `.gitignore` excludes. Snippets read cookie **names** only, never values.

## Files and data flow

```
index.html          shell: left rail nav + Google status (#rail-google) + #view; loads scripts in this order ↓
js/config.js        APP_CONFIG (built-in Google OAuth client ID)
js/engine.js        pure audit engine, extracted from apps-script/TagScanner.gs (≈150 functions/consts)
js/engine-web.js    browser replacements: AUDIT state (let + resetAudit_), containerCache_, fetchContainer_,
                    readClientSettings_ (from WEB_SETTINGS), GA4 checks from prefetched data, live-test merge,
                    TAG_OVERRIDES (AI/analyst vendor overrides), analyseExportJson_, workspaceRowsFromData_
js/google.js        Google sign-in (popup + redirect), GTM API (lookup → live version → workspaces/status), GA4 Admin API,
                    fetchGa4Full (GA4 Admin v1beta/v1alpha + Data API, PII-masked) for the GA4 audit
js/ga4.js           GA4 audit engine (browser-only, not in Apps Script): buildGa4Result → issues, GA4 areas/score,
                    event cross-reference with GTM (ga4GtmContext reads result.audit.ga4Events/googleTags), config, data quality
js/gsc.js           Search Console check (webmasters.readonly, optional): property found from the website (gscMatchSites),
                    fetchGscData (totals, top pages as masked paths, sitemaps), buildGscResult (access, sitemaps/hosts,
                    clicks vs GA4 organic sessions per site and landing page; GA4 side is data.organic from fetchGa4Full)
js/cm360.js         CM360 check (dfareporting scope, optional): profiles/configs/activities lookups, temporary reports
                    (manual download via browserUrl: Google's file server has no CORS), CSV parsing, buildCm360Result
                    (Floodlight ↔ GTM name matching + analyst mapping, CM360 clicks vs GA4 sessions per campaign)
js/ai.js            providers, AI_SYSTEM prompt, AI_TASKS (writeup, fixplan), aiExplainUnknownTags, aiAuditContext,
                    renderMarkdown (small, safe — escapes HTML first)
js/app.js           STATE, views (audit, overview, summary, consent, tags, ids, live, findings, ai, settings, ga4, cm360),
                    runFullAudit() (GTM → GA4 → Search Console → CM360 with STATE.auto run sheet; pauses for connect/downloads), runAudit()
                    pipeline, exports (PDF via window.print + #print-report, CSV, save/open audit JSON)
css/app.css         design tokens, light/dark, print stylesheet
```

**Run audit** calls `runFullAudit()`: it switches to the Overview, calls `runAudit({stay:true})` (which also runs the GA4 audit), then `autoContinue()` for the later steps (`AUTO_LATER_STEPS`: Search Console, CM360). Each has a blocker (skip reason or a missing scope); steps that need a scope pause at `connect` together and one redirect asks for all of them (`autoScopesNeeded`; `STATE.auto` is stashed and `autoContinue` resumes on return). CM360 then pauses at `waiting` (manual downloads + drop zone; `finishCm360` → `autoCm360Finished`). Combined client PDF = `combinedCoverHtml` + `clientReportHtml` for the GTM, GA4, Search Console (`gscClientReportModel`) and CM360 (`cm360ClientReportModel`) models.

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

`npm test` runs `tests/runner.test.cjs` (local runner + static app via Playwright) `tests/ga4.test.cjs` (GA4 audit engine on fixture Admin/Data API JSON, loaded in a `vm` context), `tests/cm360.test.cjs` (CM360 CSV parsing, Floodlight capture, matching) and `tests/gsc.test.cjs` (Search Console matching and check engine). What else was done during development:
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
