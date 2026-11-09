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
| **IDs** | Every pixel, account and measurement ID, with flags for leftover or duplicate IDs and a "client confirms" tick box |
| **Live test** | What fired before a choice, after Deny and after Accept, from a console snippet |
| **AI assistant** | Client report · identify unknown tags from their code (updates the consent matrix) · GTM fix plan · chat about the audit |
| **Exports** | PDF report (print), CSV per table, save and reopen audits (`.json`) |

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
2. Under **APIs & Services → Library**, enable the **Tag Manager API** and the **Google Analytics Admin API**.
3. Under **APIs & Services → OAuth consent screen**, choose **Internal** (only people in your Google Workspace can sign in), then add the scopes `…/auth/tagmanager.readonly` and `…/auth/analytics.readonly`.
4. Under **APIs & Services → Credentials → Create credentials → OAuth client ID**, choose **Web application** and add these **Authorised JavaScript origins**:
   - `https://<your-org-or-user>.github.io`
   - `http://localhost:8000` (for local testing)
5. Copy the client ID into **Settings → Google sign-in → OAuth client ID** in the app. Each user then signs in with their own Google account and sees only the containers and properties they can access. All access is read-only.

## Running an audit

1. **New audit**: enter the client name and website.
2. Add any combination of sources:
   - **Published container:** GTM IDs, read straight from Google.
   - **GTM and GA4 via Google:** sign in, then list GTM IDs for full detail. Tick the GA4 box to check the GA4 properties behind the measurement IDs found.
   - **Container export:** in GTM go to *Admin → Export Container* and upload the file.
   - **Page source:** browsers can't download other websites, so on the client's site press **F12 → Console** and run the page-source snippet (the copy button is in the app), then paste the result.
   - **Live consent test:** in an Incognito window, run the live-test snippet before choosing, after Deny, and after Accept (in a fresh window), and paste each result.
3. Optionally open **Client rules** to set the client's own CMP category IDs, whether analytics needs consent, their naming pattern, and approved vendors and IDs.
4. Click **Run audit**. Containers covered by the API or an export are not scanned publicly as well, so tags are not counted twice.
5. Use **Summary → Export PDF report**. The PDF includes the AI client report and fix plan if you generated them.

## Privacy

- Everything runs in the user's browser. The only network calls are:
  - `googletagmanager.com`, for published containers
  - Google APIs, when signed in
  - the chosen AI provider, when you use the assistant
  - Google's favicon service, for the vendor logos
- Snippets read cookie **names** only, never values.
- **Identify unknown tags** sends the code of those tags to the AI provider. The other AI features send only the findings.
- Saved audits are downloaded as files. Nothing is uploaded.

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
2. Right-click `index.html` → **Open with Live Server** (it serves on `http://localhost:8000`, matching the OAuth origin above).
   Alternatives: `npm start` (needs Node.js) or `python -m http.server 8000`.
3. Run `npm run check` to syntax-check the JavaScript before committing.
