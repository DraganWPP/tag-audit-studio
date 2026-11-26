# Tag Audit Studio

Audit a client's **Google Tag Manager, GA4 and cookie-consent** setup in the browser and turn it into a client-ready report, with an AI assistant built in.

It's a static web app (HTML, CSS and JavaScript only, with no build step and no server), so it runs on **GitHub Pages**.

## What it does

| Area | What you get |
|---|---|
| **Sources** | Published GTM container (no access needed) · GTM API with real names, triggers, folders and unpublished changes · container export (JSON) · page source · live consent test |
| **Summary** | Health score and grade, score per area (Consent, Security, GA4 Setup, GA4 Property, Ads Setup, Accounts & IDs, Legacy, Hygiene, Third Parties), prioritised actions |
| **Consent matrix** | Every tag with its purpose, how it waits for consent (built-in Consent Mode, Additional Consent Checks, CMP trigger) and a risk rating |
| **Tags** | Tags grouped by platform (GA4, Google Ads, Floodlight, Meta, TikTok, LinkedIn, Amazon, …) with vendor logos |
| **IDs** | Every pixel, account and measurement ID, with flags for leftover or duplicate IDs |
| **Live test** | What fired before a choice, after Deny and after Accept, from a console snippet |
| **AI assistant** | Client report · identify unknown tags from their code (updates the consent matrix) · GTM fix plan · chat about the audit |
| **Exports** | Client dashboard PDF, editable PowerPoint, technical PDF, CSV per table, save and reopen audits (`.json`) |

### Client reports

From **Summary**, choose:

- **Client PDF report**: a portrait A4 dashboard with the existing score and
  grade, priority totals, a five-area overview and the next two recommendations.
  Following pages include every recommendation, why it matters, suggested teams
  and how to confirm the fix. In the print dialog choose **Save as PDF**, use
  the document's page size, turn off browser headers/footers and enable
  background graphics.
- **Client PowerPoint**: a widescreen `.pptx` with the same visual style, an
  overview slide, two recommendations per action-plan slide, and a coverage
  slide. Text, shapes and the score's native PowerPoint doughnut chart are
  editable, rather than screenshots.
- **Technical PDF report**: the original detailed report, including findings,
  consent evidence and ID inventory, for the implementation team.

Client reports use shared, deterministic plain-language summaries, not AI
calls. They omit raw code, account IDs, internal tag names and AI conversations.
Unknown finding types receive an area-level recommendation; the technical
report retains the original finding and implementation detail. Live consent
observations are clearly separate from configuration findings and do not alter
the audit score. Missing evidence is labelled; no score is presented when no
configuration or page evidence is available. Suggested teams are recommendations,
not assigned owners or delivery commitments. A score is not a legal compliance
rating or a guarantee of data accuracy. Priority colors follow a traffic-light
key: red for high, amber for medium and green for low; the score uses red below
60, amber from 60–89 and green from 90.

PowerPoint export loads **PptxGenJS 4.0.1** from jsDelivr only on demand, pinned
with a subresource-integrity hash. First use requires internet/CDN access;
failure is shown and can be retried. Audit data stays in the browser: no backend
or provider upload is used. The npm package is a **development-only** dependency
for tests; `node_modules` is not deployed. Its Node-only image parser is
overridden to a patched version; no image files are processed by these exports.
Reports can still contain client-sensitive conclusions: review them before sharing.

### Expandable tag details

Click an underlined tag name to expand its details in place; click again to
collapse it. The same inspector is available in Tags, All findings, Consent,
ID references, linked findings on Summary, and recognised tag-name mentions in
AI reports/chat. Live test vendors link to related container tags when available,
but a vendor request is not proof that any particular GTM tag fired.

For GTM API and export sources, the inspector preserves complete Custom HTML,
all tag configuration fields, notes, consent and sequencing settings, and related
trigger, variable and custom-template definitions. Tags, triggers and variables
first open a read-only GTM-style configuration view: labelled fields, settings
tables, full available custom code, consent settings and firing conditions.
Configuration cards follow GTM's type rows, labelled fields, section dividers
and compact two-column settings tables, with theme-aware colours. GA4 event
parameters, ecommerce and consent are grouped within the tag configuration.
**More details** expands the original technical inspector, including raw
configuration, analysis and related definitions. Unrecognised parameter keys
are split into readable labels; custom-template controls are not recreated.
Only supplied settings are shown, not assumed GTM defaults. Built-in consent
checks are not supplied as an authoritative list and must be verified in GTM.
Code is displayed as escaped
text, never executed. Published containers show the available compiled
configuration and clearly identify missing authoring details or partial parsing.
Older saved audits may contain only truncated analysis text; re-run the audit to
capture full configuration. New saved audits retain the full details, which may
include sensitive values in tag code/settings: inspect them before sharing.

In the Tags view, use **Tags / Triggers / Variables** beside the search and
Expand/Collapse controls. Triggers and Variables use the same searchable groups;
click a name to expand its configuration, complete available custom JavaScript,
template definition, and inbound/outbound references. Reference links also open
the corresponding tag, trigger or variable in place.

**Unused** means no *other* item references that definition in the supplied API
or export snapshot. Firing triggers, exceptions, trigger-group members,
references in parameter values, enabled built-in variables and references from
paused tags are accounted for. Self-references do not count as use. A reference
from an otherwise unused item still counts: this is not a reachability analysis
or proof of execution, and dynamic lookups cannot be inferred. Review before
deleting anything. The Hygiene findings use the same reference check for
custom variables and original triggers.

Published sources show available compiled rules and variables with **Not checked**
usage status, never an unused claim. Original names and authoring definitions
need an API source or export. Older saved audits need a re-run to capture the
complete inventory, especially unused definitions.

## Deploy to GitHub Pages

1. Create a repository (for example `tag-audit-studio`) and upload the contents of this folder to the root of its `main` branch: `index.html`, `css/`, `js/`, `.nojekyll`, `README.md`.
2. In the repository, open **Settings → Pages**, set **Source** to *Deploy from a branch*, choose **main / (root)**, then **Save**.
3. After about a minute the app is live at `https://<your-org-or-user>.github.io/tag-audit-studio/`.

> **Note:** GitHub Pages sites are public, even when the repository is private (unless you have GitHub Enterprise with access control). That's fine here: the site contains only code. Client data, API keys and audits stay in each user's browser and are never stored in the repository.

## One-time setup

### AI provider (optional, needed for the AI assistant)

In the app, open **Settings → AI assistant**, choose a provider, paste an API key and click **Test connection**.

| Provider | Key | Default model |
|---|---|---|
| Anthropic Claude | [console.anthropic.com](https://console.anthropic.com) → API keys | `claude-sonnet-5-5` |
| OpenAI-compatible | OpenAI, Azure OpenAI or an internal AI gateway; set its base URL | `gpt-4.1` |
| Google Gemini | [aistudio.google.com](https://aistudio.google.com) → API key | `gemini-2.5-pro` |

The key is stored in the browser's local storage and sent only to that provider. Use a personal or restricted key, and check that your client agreements allow audit data to go to the provider.

### Google sign-in (optional, needed for the GTM API and GA4 property checks)

1. In [Google Cloud Console](https://console.cloud.google.com), create or choose a project.
2. Under **APIs & Services → Library**, enable the **Tag Manager API**, the **Google Analytics Admin API** and the **Google Analytics Data API** (the Data API is used by the GA4 audit).
3. Under **APIs & Services → OAuth consent screen**, choose **Internal** (only people in your Google Workspace can sign in), then add the scopes `…/auth/tagmanager.readonly` and `…/auth/analytics.readonly`.
4. Under **APIs & Services → Credentials → Create credentials → OAuth client ID**, choose **Web application** and add these **Authorised redirect URIs**. Each one is the exact page address, with the trailing slash:
   - `https://<your-org-or-user>.github.io/tag-audit-studio/` (GitHub Pages)
   - `http://localhost:5500/` (VS Code Live Server) and/or `http://localhost:8000/` (`npm start`)
5. Put the client ID in [js/config.js](js/config.js) (`APP_CONFIG.googleClientId`). The client ID is not a secret, because Google shows it in every sign-in address, and it only works from the redirect URIs above. Users never need to see or paste it. **Settings → Google sign-in → Advanced** offers a per-browser override for testing another client.

**How sign-in works:**
- There is one **Sign in with Google** control, in the left rail and in the forms that need it. It goes to Google and comes back to the same page, with no popup, so corporate Chrome policies that block popups don't affect it.
- Each user signs in with their own Google account and sees only the containers and properties they can access. The app asks for read-only Tag Manager and Analytics access, plus the account's email address, which is used to show which account is signed in and to suggest it next time.
- The sign-in lasts an hour. It is kept in the browser tab (sessionStorage), so reloading doesn't sign you out, and closing the tab does.
- Audit results in memory are kept while you go to Google and back.
- When the hour is up, the rail shows **sign in again**. With the account suggested, Google usually sends you straight back.

## Running an audit

1. **New audit**: enter the client name and website.
2. Add any combination of sources:
   - **Published container:** GTM IDs, read straight from Google.
   - **GTM and GA4 via Google:** sign in, then list GTM IDs for full detail. Tick the GA4 box to check the GA4 properties behind the measurement IDs found.
   - **Container export:** in GTM go to *Admin → Export Container* and upload the file.
   - **Page source:** browsers can't download other websites, so on the client's site press **F12 → Console** and run the page-source snippet (the copy button is in the app), then paste the result.
   - **Live consent test:** in an Incognito window, run the live-test snippet before choosing, after Deny, and after Accept (in a fresh window), and paste each result.
3. Optionally open **Client rules** to set the client's own CMP category IDs, whether analytics needs consent, their naming pattern, and approved vendors.
4. Click **Run audit**. Containers covered by the API or an export are not scanned publicly as well, so tags are not counted twice.
5. Use **Summary → Export PDF report**. The PDF includes the AI client report and fix plan if you generated them.

### One click: GTM → GA4 → CM360

**Run audit** runs every check that applies, one after another, and shows progress on the **Overview** page:

1. **GTM and consent audit** from the sources you added.
2. **GA4 audit** (if *Also run the full GA4 audit* is ticked and you're signed in): finds the GA4 properties behind the live measurement IDs in GTM and audits them.
3. **Search Console check** (if *Then run the Search Console check* is ticked and the website is filled in): finds the Search Console property for the website and checks it against GA4. See below.
4. **CM360 check** (if *Then run the CM360 check* is ticked and GTM has Floodlight tags): finds the CM360 account that owns the Floodlight configuration, runs the two reports, then **pauses for you**:
   - if CM360 isn't connected yet, click **Connect CM360**; the run carries on by itself when you come back
   - download the two reports with one click each, then drag both files from Chrome's download bubble (or Ctrl+J) onto the drop zone. Chrome doesn't let websites read the Downloads folder, so this one step stays manual.

Steps that don't apply are marked *Skipped* with the reason (no GA4 ID, no website, no Floodlight tags, not signed in, no CM360 account owns the configuration). When Search Console and CM360 both need their extra permission, one **Connect** button asks for both in a single Google round trip. If only the GTM audit applied, the run opens the Summary as before.

The **Overview** shows each report's grade, the high and medium actions across all of them, and **Combined client PDF**: an overview page followed by the client report of each review (GTM and consent, each GA4 property, Search Console, CM360).

## GA4 audit (separate report)

**GA4 audit** in the left rail produces a separate report for one or more GA4 properties. It needs Google sign-in (the same read-only access) and works with or without a GTM audit.

- **Start it** from the GA4 audit page (pick any property your account can see), or tick **Also run the full GA4 audit** on New audit to run it for the GA4 IDs the GTM audit finds.
- **What it reads:**
  - every setting the GA4 Admin API exposes read-only: streams, enhanced measurement, redaction, retention, key events, custom definitions, links, attribution, Google signals, event rules, audiences, channel groups
  - the last 28 days of collected data from the Data API: events, streams, hostnames, channels, sources, purchases, custom dimension fill rates
  - **page URLs that look like they contain personal data are masked in the browser before anything is stored**
- **GTM cross-reference:** when the GTM audit in the same session sends data to the property, the report compares GTM's GA4 event tags with the events GA4 actually received. It flags events tagged but never received, events double-counted with enhanced measurement, and key events that GTM doesn't send.
- **Report:**
  - its own grade and areas (Collection & streams, Events & key events, Custom definitions, Data quality, Privacy & retention, Integrations, Attribution & reporting, GTM alignment)
  - tabs for events, configuration, data quality and coverage
  - a GA4 client PDF, a technical PDF and CSVs
  - **Save audit** includes the GA4 report
- **Not readable with read-only access, so listed as manual checks:** internal traffic and data filters, unwanted referrals, cross-domain domains, session timeout, user access and change history. Some settings come from Google's alpha Admin API and can be unavailable for some properties; the Coverage tab lists anything that couldn't be read.

## Search Console check

**Search Console** in the left rail (and step 3 of the automatic run) finds the site's Google Search Console property and compares Google search with GA4. Last 28 days, ending 3 days ago because Search Console data runs about 3 days behind.

**Setup:** enable the **Google Search Console API** in the Google Cloud project.

**Access:** **Connect Search Console** asks for one extra permission, `webmasters.readonly`, only when someone uses this check. It can read Search Console data and change nothing.

**Finding the property:** Search Console has no link to GTM, so the property is found from the website. The app lists the properties your Google account can see and picks the one covering the site's hostname: a Domain property (`sc-domain:`) first, then URL-prefix properties. If the property is under the client's or another agency's account and you were never added, the check reports that no property you can access covers the site.

**What it checks:**
- **Property & access:** no property you can access, only URL-prefix properties (no Domain property), restricted access, and several Search Console verification tags in the pasted page source (each is a verified owner, often including former agencies).
- **Sitemaps & indexing:** no sitemap, sitemaps with errors or warnings, sitemaps Google hasn't read for over 30 days, search traffic landing on `http://` pages or on test/staging hosts, and traffic split between `www` and non-`www`.
- **Search vs analytics** (needs the GA4 audit for the same site): Search Console clicks compared with GA4 organic Google sessions for the same 28 days, and landing pages with 20 or more search clicks but no GA4 organic sessions, which usually means the GA4 tag doesn't load on those pages.

**Kept:** totals, the top landing page paths (no query strings; addresses that look like personal data are masked) and sitemap addresses. Search queries are not read.

**Not readable with read-only access, so check by hand:** owners and users, indexing per page and the link between Search Console and GA4.

## CM360 check (Floodlight and delivery)

**CM360 check** in the left rail compares Campaign Manager 360 with the GTM and GA4 audits from the same session, using the last 30 days.

**Setup:**
- Enable the **Campaign Manager 360 API** in the Google Cloud project.
- Each user needs a CM360 user profile with API access in the advertiser's CM360 account.

**Access:**
- **Connect CM360** asks for one extra permission, `dfareporting` (reports only), only when someone uses this check.
- The app can create, run and delete its own temporary reports. It cannot change campaigns, ads or Floodlight.

**How it runs:**
1. The app picks the CM360 account and Floodlight configuration that GTM's Floodlight tags send to. You can change both.
2. It runs two temporary reports: Floodlight conversions per activity, and impressions and clicks per campaign for the advertiser.
3. Google doesn't let browsers download report files directly. **Download** each report with one click (Google's own link, using your browser's Google sign-in), then **drop both CSV files** onto the drop zone (or click it to choose them).
4. The files are read in the browser. Only counts per activity and campaign are kept, and both reports are then deleted from CM360. Reports left behind, for example if the tab was closed, are deleted on the next run.

**What it checks:**
- Floodlight configurations in GTM that none of your CM360 accounts can see (another advertiser, a previous agency or a test setup).
- GTM Floodlight tags whose activity recorded no conversions.
- Activities that record conversions but have no tag in the container.
- CM360 clicks compared with GA4 sessions per campaign: campaigns with no GA4 sessions, or fewer than half as many sessions as clicks. This needs the GA4 audit for the same site. Search campaigns are left out.

**Matching:**
- **Exact (optional):** connect **CM360 Floodlight setup** (Settings → Connections, or the link in the Floodlight mapping tab). The app then reads the configuration's Floodlight activities with their tag strings (`type`/`cat`) and matches every GTM tag exactly. This is the edit-level `dfatrafficking` permission; the app only ever reads Floodlight activities. With it, the check also reports:
  - GTM tags whose `type/cat` has no activity (deleted, or a typo: CM360 records nothing)
  - tags firing to inactive activities
  - a different counting method from the activity
  - custom variables (`u1`…) the activity doesn't collect
- **By name (without that permission):** reports-only access doesn't return the tag strings, so GTM tags are matched to activities by name. Each suggestion says why it was made (for example "activity name starts like the tag string + 2 words in common").

Either way, tags whose name and activity describe different things (a page visit recorded into a purchase activity) are flagged. Confirm or correct each match in the **Floodlight mapping** tab; your choices are saved with the audit.

### Optional local browser runner

The [local GTM-guided runner](runner/README.md) reads a GTM export and opens
Chromium on your computer. Select trigger actions (visits, clicks, scrolls,
waits or manual journeys), then manually confirm the cookie choice in three
isolated sessions: before a choice, reject all and accept all.

Install Node.js 22+, then run:

```powershell
npm install
npx playwright install chromium
npm run runner -- --url https://example.com --export "C:\Audits\container.json"
```

Import the generated `.runner.json` file under **Live consent test**. It includes
vendor observations, action outcomes, event names and a tag coverage plan.
Actions do not prove individual tags fired; confirm those in GTM Preview.

**Meta checker:** for each Meta Pixel tag in the export, the runner checks whether
Meta received the tag's event and pixel ID during the actions for its triggers, in
each consent state (fired, not fired, different event or pixel, fired without
consent). Only pixel IDs and event names are saved. See the
[runner README](runner/README.md#meta-checker).
Use only on authorised sites and avoid real purchases/leads. This first version
uses no AI navigation and requires no hosted backend. Playwright is a local
development dependency, not part of the static web app.

## Privacy

- Everything runs in the user's browser. The only network calls are:
  - `googletagmanager.com`, for published containers
  - Google APIs, when signed in
  - the chosen AI provider, when you use the assistant
  - Google's favicon service, for the vendor logos
- Snippets read cookie **names** only, never values.
- **Identify unknown tags** sends the code of those tags to the AI provider. The other AI features send only the findings.
- Saved audits are downloaded as files. Nothing is uploaded.
- The optional local runner visits the target site and its normal third parties.
  It saves request hosts/status, cookie names and event names locally; no request
  bodies, headers, full request URLs or cookie values are saved.

## Limitations

- The published container contains no tag, trigger or folder names. Use the GTM API or an export for those.
- The live consent test reflects one browser session from one location. CMPs often behave differently by country, and server-side tracking isn't visible.
- GA4 *unwanted referrals* and *cross-domain* settings aren't available through Google's API, so the report tells you to check them by hand.
- The consent rules follow UK/EU practice (UK GDPR / PECR). Set *Analytics needs consent* to **No** in Client rules for markets where that isn't required. This is not legal advice.

## Files

```
index.html          app shell
css/app.css         styles (light/dark, print report)
js/engine.js        audit engine (ported from the TagScanner Apps Script): parsing, checks, scoring
js/engine-web.js    browser state for the engine: settings, caches, GA4 data, live test, AI overrides
js/google.js        Google sign-in, GTM API, GA4 Admin API
js/ai.js            AI providers, prompts, Markdown rendering
js/app.js           views, audit pipeline, exports
```

## Working in VS Code

1. Open the folder in VS Code and install the recommended extensions when prompted (Live Server, ESLint, Prettier).
2. Right-click `index.html` → **Open with Live Server** (it serves on `http://localhost:5500` by default, matching the OAuth origin above).
   Alternatives: `npm start` (needs Node.js) or `python -m http.server 8000`.
3. Run `npm run check` to syntax-check the JavaScript before committing.
