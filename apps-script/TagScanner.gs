/**
 * ════════════════════════════════════════════════════════════════════
 *  GA4 / GTM Tag Scanner for Google Sheets
 * ════════════════════════════════════════════════════════════════════
 *
 *  HOW TO INSTALL
 *    1. Open a Google Sheet → Extensions → Apps Script
 *    2. Replace the contents of Code.gs with this file and save
 *    3. Reload the Sheet — a "🔍 Tag Scanner" menu appears
 *
 *  This is a spreadsheet-bound script, NOT a web app. Do not deploy it
 *  as a web app (that is what causes "Script function not found: doGet").
 *
 *  Requires the V8 runtime (the default for all new Apps Script projects).
 *
 *  THREE LEVELS OF DETAIL
 *    • Basic / Deep Scan, Pasted HTML, GTM Direct — public data only.
 *      Tag names are stripped from published containers, so tags are
 *      described by type, settings and firing conditions.
 *    • Scan GTM via API — real names, triggers, folders, notes, paused
 *      tags and unpublished workspace changes. Needs Read access to the
 *      container plus a one-time setup: Apps Script editor → Services (+)
 *      → Tag Manager API → Add.
 *    • Import Container Export — the same detail from a JSON file
 *      (GTM → Admin → Export Container). No API setup needed.
 *
 *  OPTIONAL
 *    • GA4 property checks — Apps Script editor → Services (+) →
 *      Google Analytics Admin API → Add. Needs Viewer access to the property.
 *    • ⚙️ Client Settings tab — consent category IDs, naming pattern,
 *      approved vendors / IDs (Tag Scanner → Client Settings).
 *    • Export Audit Report (PDF) — asks once for Google Drive permission
 *      to save the PDF.
 *
 *    • 🧪 Live Consent Test — run a console snippet on the site before
 *      choice / after Deny / after Accept and paste the results.
 *
 *  OUTPUT TABS: 🔍 Tag Scanner (all findings), 📋 Audit Summary,
 *  🛡️ Consent Matrix, 🧪 Live Consent Test, 🪪 ID Inventory.
 *
 *  Naming convention: functions ending in "_" are private helpers and
 *  are hidden from the Apps Script "Run" menu. Menu actions and
 *  processPastedHtml (called from the paste dialog) are public.
 * ════════════════════════════════════════════════════════════════════
 */


// ════════════════════════════════════════════════════════════════════
//  1. CONFIGURATION
// ════════════════════════════════════════════════════════════════════

const CONFIG = {
  SHEET_NAME:       '🔍 Tag Scanner',
  GUIDE_NAME:       '📖 Tag Guide',
  SUMMARY_NAME:     '📋 Audit Summary',
  MATRIX_NAME:      '🛡️ Consent Matrix',
  INVENTORY_NAME:   '🪪 ID Inventory',
  SETTINGS_NAME:    '⚙️ Client Settings',
  LIVE_NAME:        '🧪 Live Consent Test',
  URL_LABEL:        '🌐 Website URL:',
  PLACEHOLDER_URL:  'https://example.com',
  FIRST_RESULT_ROW: 4,
  NUM_COLS:         5,
  COLUMN_WIDTHS:    [210, 380, 200, 340, 260],
  HEADER_COLOR:     '#1a73e8',
  WARNING_BG:       '#fef7e0',
  BROWSER_UA:       'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
                    '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  GOOGLEBOT_UA:     'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  SUBPAGES:         ['/', '/about', '/contact', '/privacy-policy']
};

// Global ID patterns (only ever used with String.match, so lastIndex is never an issue)
const ID_PATTERNS = {
  GA4: /\bG-[A-Z0-9]{4,20}\b/g,
  GTM: /\bGTM-[A-Z0-9]{4,10}\b/g,
  ADS: /\bAW-[0-9]{7,12}(?:\/[A-Za-z0-9_-]+)?/g,
  UA:  /\bUA-[0-9]{4,12}-[0-9]{1,4}\b/g
};

const HTTP_MESSAGES = {
  401: 'This page requires a login.',
  404: 'The page does not exist.',
  429: 'Rate limited — wait a few minutes and try again.'
};

const FIND_GTM_ID_HELP =
  'To find a GTM ID manually:\n' +
  '  1. Open the site in Chrome and press F12 (DevTools)\n' +
  '  2. Open the Network tab and reload the page\n' +
  '  3. Filter for "gtm.js" — the ID is in the URL: ?id=GTM-XXXXXX\n' +
  '  (Or press Ctrl+U and search the page source for "GTM-")';


// ════════════════════════════════════════════════════════════════════
//  2. RESULT CATEGORIES  (first matching rule wins — order matters)
// ════════════════════════════════════════════════════════════════════

const CATEGORIES = [
  { name: '🚨 Warnings & Errors',    test: /EXPOSED|Error|Restricted|No Consent Default|Audit Warning/, color: '#ffcdd2', header: '#c62828' },
  { name: '⚠️ Legacy Tags',           test: /Universal Analytics|UA Collect/,              color: '#fff9c4', header: '#f57f17' },
  { name: '📊 Google Analytics 4',   test: /GA4|gtag (Config|Event)/,                     color: '#e3f2fd', header: '#1565c0' },
  { name: '🏷️ GTM Containers',        test: /GTM Container|GTM Workspace/,                 color: '#e8f5e9', header: '#2e7d32' },
  { name: '🏷️ GTM Tags',              test: /GTM Tag/,                                     color: '#f1f8e9', header: '#558b2f' },
  { name: '⚡ GTM Triggers & Events', test: /GTM Listener|Custom Event|GTM Trigger/,       color: '#f9fbe7', header: '#827717' },
  { name: '📐 GTM Variables',         test: /GTM Variable|Data Layer Variable/,            color: '#f3f6f4', header: '#33691e' },
  { name: '🎯 Google Ads',            test: /Google Ads|Floodlight/,                       color: '#fff3e0', header: '#e65100' },
  { name: '🧩 Third-Party Tags',      test: /Third-Party/,                                 color: '#ede7f6', header: '#4527a0' },
  { name: '✅ Consent Mode',          test: /Consent/,                                     color: '#f3e8fd', header: '#6a1b9a' },
  { name: '🛒 Ecommerce',             test: /Ecommerce/,                                   color: '#e0f2f1', header: '#00695c' },
  { name: '📦 Data Layer',            test: /dataLayer/,                                   color: '#fff8e1', header: '#f9a825' },
  { name: '🚫 Referrals',             test: /Referral|Payment Domain/,                     color: '#fce8e6', header: '#b71c1c' },
  { name: '🔗 Cross-Domain',          test: /Cross-Domain|Linker|Decorate/,                color: '#e8eaf6', header: '#283593' },
  { name: '🍪 Cookies',               test: /Cookie/,                                      color: '#fffde7', header: '#9e9d24' },
  { name: '📡 Measurement Protocol',  test: /MP /,                                         color: '#fce4ec', header: '#880e4f' },
  { name: '📜 Scripts & Loaders',     test: /Script|Loader|Loaded|Initialised/,            color: '#e1f5fe', header: '#0277bd' },
  { name: '🔍 Other Findings',        test: /[\s\S]*/,                                     color: '#f5f5f5', header: '#424242' }
];


// ════════════════════════════════════════════════════════════════════
//  3. GTM FUNCTION CATALOG
//     Every tag / variable in a compiled gtm.js is an object with a
//     "function" key (e.g. "__googtag"). These maps translate them.
// ════════════════════════════════════════════════════════════════════

// Tag types, keyed by GTM type (API / export name, i.e. without the "__"
// prefix used in gtm.js). `param` gives the headline value, `extra` adds
// details. Both receive an adapter `p` with get / pairs / fromVariable.
const GTM_TAGS = {
  googtag: { name: 'Google Tag', emoji: '📊',
             param: p => p.get('tagId') || p.get('measurementId'),
             extra: p => settingsSummary_(p.pairs('configSettingsTable')),
             note: 'Check the tag ID matches your GA4 data stream' },
  gaawc:   { name: 'GA4 Configuration (legacy)', emoji: '📊',
             param: p => p.get('measurementId'),
             extra: p => settingsSummary_(p.pairs('fieldsToSet')),
             note: 'Legacy GA4 config tag type — GTM has replaced it with the Google Tag' },
  gaawe:   { name: 'GA4 Event', emoji: '📌',
             param: p => p.get('eventName'),
             extra: p => {
               const target = p.get('measurementIdOverride') || p.get('measurementId');
               const params = p.pairs('eventSettingsTable').concat(p.pairs('eventParameters')).map(x => x.k);
               return joinParts_(target && 'Sends to ' + target,
                                 params.length && 'Params: ' + params.join(', '),
                                 p.get('sendEcommerceData') === 'true' && 'Sends ecommerce data');
             },
             note: 'Sends a GA4 event' },
  ua:      { name: 'Universal Analytics', emoji: '⚠️',
             param: p => p.get('trackingId') || p.fromVariable('gaSettings', 'trackingId'),
             extra: p => joinParts_(
               p.get('trackType') && 'Type: ' + p.get('trackType'),
               p.get('eventCategory') && 'Event: ' +
                 [p.get('eventCategory'), p.get('eventAction'), p.get('eventLabel')].filter(Boolean).join(' / ')),
             note: '⚠️ UA stopped processing data in July 2024 — remove this tag' },
  awct:    { name: 'Google Ads Conversion', emoji: '🎯', param: adsParam_,
             extra: p => p.get('conversionValue') && 'Value: ' + p.get('conversionValue'),
             note: 'Google Ads conversion tracking' },
  sp:      { name: 'Google Ads Remarketing', emoji: '🎯', param: adsParam_,
             note: 'Builds Google Ads audiences — check consent handling' },
  gclidw:  { name: 'Conversion Linker', emoji: '🔗',
             note: '✅ Should fire on all pages for accurate Ads conversions' },
  flc:     { name: 'Floodlight Counter', emoji: '💡', param: floodlightParam_, note: 'Campaign Manager 360 Floodlight' },
  fls:     { name: 'Floodlight Sales', emoji: '💡', param: floodlightParam_, note: 'Campaign Manager 360 Floodlight' },
  baut:    { name: 'Microsoft Advertising UET', emoji: '🪟', param: p => p.get('tagId'),
             note: 'Microsoft / Bing Ads tracking' },
  bzi:     { name: 'LinkedIn Insight Tag', emoji: '💼', param: p => p.get('id') || p.get('partnerId'),
             note: 'LinkedIn conversion tracking — check consent handling' },
  hjtc:    { name: 'Hotjar', emoji: '🔥', param: p => p.get('hotjar_site_id') || p.get('siteId'),
             note: 'Session recording — check consent handling' },
  html:    { name: 'Custom HTML', emoji: '📝', param: p => htmlSummary_(p.get('html')),
             note: 'Review for security, performance and consent' },
  img:     { name: 'Custom Image', emoji: '🖼️', param: p => hostOf_(p.get('url')) || p.get('url'),
             note: 'Tracking pixel' },
  opt:     { name: 'Google Optimize', emoji: '⚠️', param: p => p.get('optimizeContainerId'),
             note: '⚠️ Google Optimize was shut down in September 2023 — remove' }
};

const CUSTOM_TEMPLATE_TAG = { name: 'Custom Template', emoji: '🧩',
  param: p => vendorIn_(p.allText()),
  note: 'Gallery or custom template — check what it loads' };
const UNKNOWN_TAG = { name: 'Other tag type', emoji: '❓', note: 'Check this tag in GTM' };

const GTM_LISTENERS = {
  __cl:  'Click',               __lcl: 'Link Click',
  __fsl: 'Form Submit',         __sdl: 'Scroll Depth',
  __tl:  'Timer',               __evl: 'Element Visibility',
  __hl:  'History Change',      __ytl: 'YouTube Video',
  __jel: 'JavaScript Error'
};

const GTM_VARIABLES = {
  __v:    'Data Layer Variable',      __u:    'URL',
  __e:    'Event',                    __jsm:  'Custom JavaScript',
  __j:    'JavaScript Variable',      __c:    'Constant',
  __k:    '1st-Party Cookie',         __f:    'HTTP Referrer',
  __aev:  'Auto-Event Variable',      __remm: 'RegEx Table',
  __smm:  'Lookup Table',             __gas:  'GA Settings (UA)',
  __r:    'Random Number',            __cid:  'Container ID',
  __ctv:  'Container Version',        __dbg:  'Debug Mode',
  __d:    'DOM Element',              __vis:  'Element Visibility',
  __gtes: 'Google Tag: Event Settings',
  __gtcs: 'Google Tag: Config Settings',
  __uv:   'Undefined Value'
};

// Third-party vendors: [name, detection pattern, purpose], detected by the script/domain they load.
// Far more reliable than guessing from short GTM type codes.
const VENDORS = [
  ['Meta Pixel',             /connect\.facebook\.net|fbevents\.js|\bfbq\(|facebook\.com\/tr/, 'advertising'],
  ['TikTok Pixel',           /analytics\.tiktok\.com|\bttq\.(load|track|page)/, 'advertising'],
  ['LinkedIn Insight Tag',   /snap\.licdn\.com|_linkedin_partner_id/, 'advertising'],
  ['Microsoft Ads UET',      /bat\.bing\.com/, 'advertising'],
  ['Microsoft Clarity',      /clarity\.ms/, 'analytics'],
  ['Pinterest Tag',          /s\.pinimg\.com\/ct|ct\.pinterest\.com|\bpintrk\(/, 'advertising'],
  ['X (Twitter) Pixel',      /static\.ads-twitter\.com|\btwq\(/, 'advertising'],
  ['Snap Pixel',             /sc-static\.net\/scevent|\bsnaptr\(/, 'advertising'],
  ['Reddit Pixel',           /redditstatic\.com\/ads|\brdt\(/, 'advertising'],
  ['Criteo',                 /static\.criteo\.net/, 'advertising'],
  ['Taboola',                /cdn\.taboola\.com/, 'advertising'],
  ['Outbrain',               /amplify\.outbrain\.com/, 'advertising'],
  ['Hotjar',                 /static\.hotjar\.com/, 'analytics'],
  ['FullStory',              /edge\.fullstory\.com|fullstory\.com\/s\/fs\.js/, 'analytics'],
  ['Contentsquare',          /contentsquare\.net/, 'analytics'],
  ['Segment',                /cdn\.segment\.com/, 'analytics'],
  ['Amplitude',              /cdn\.amplitude\.com/, 'analytics'],
  ['Mixpanel',               /cdn\.mxpnl\.com|mixpanel\.init/, 'analytics'],
  ['Heap',                   /cdn\.heapanalytics\.com/, 'analytics'],
  ['HubSpot',                /js\.hs-scripts\.com|js\.hs-analytics\.net/, 'advertising'],
  ['Klaviyo',                /static\.klaviyo\.com/, 'advertising'],
  ['Intercom',               /widget\.intercom\.io/, 'functional'],
  ['VWO',                    /visualwebsiteoptimizer\.com/, 'analytics'],
  ['Optimizely',             /cdn\.optimizely\.com/, 'analytics'],
  ['Adobe Launch / Analytics', /assets\.adobedtm\.com/, 'analytics'],
  ['Adform',                 /adform\.net/, 'advertising'],
  ['Amazon Ads',             /amazon-adsystem\.com|\bapstag\b|\bamzn_/, 'advertising'],
  ['Chartbeat',              /chartbeat\.(?:com|net)|_sf_async_config/, 'analytics'],
  ['Teads',                  /teads\.tv/, 'advertising'],
  ['Xandr (AppNexus)',       /adnxs\.com/, 'advertising'],
  ['The Trade Desk',         /adsrvr\.org/, 'advertising'],
  ['Quantcast',              /quantserve\.com|quantcount\.com/, 'advertising'],
  ['Google Floodlight',      /fls\.doubleclick\.net/, 'advertising'],
  ['Cookiebot (CMP)',        /consent\.cookiebot\.com/, 'necessary'],
  ['OneTrust (CMP)',         /cdn\.cookielaw\.org|otSDKStub/, 'necessary'],
  ['Usercentrics (CMP)',     /usercentrics\.eu/, 'necessary'],
  ['Didomi (CMP)',           /sdk\.privacy-center\.org/, 'necessary'],
  ['TrustArc (CMP)',         /consent\.trustarc\.com/, 'necessary']
];

const PAYMENT_DOMAINS = [
  ['paypal.com', 'PayPal'],             ['stripe.com', 'Stripe'],
  ['worldpay.com', 'Worldpay'],         ['opayo.com', 'Opayo (Sage Pay)'],
  ['sagepay.com', 'Sage Pay'],          ['braintreegateway.com', 'Braintree'],
  ['authorize.net', 'Authorize.Net'],   ['squareup.com', 'Square'],
  ['klarna.com', 'Klarna'],             ['afterpay.com', 'Afterpay'],
  ['clearpay.co.uk', 'Clearpay'],       ['adyen.com', 'Adyen'],
  ['cybersource.com', 'CyberSource'],   ['gocardless.com', 'GoCardless'],
  ['checkout.com', 'Checkout.com'],     ['mollie.com', 'Mollie'],
  ['2checkout.com', '2Checkout'],       ['amazonpay.com', 'Amazon Pay']
];

// GA4 / gtag settings recognised in both gtag() objects and GTM parameter tables
const GA_SETTINGS = [
  { key: 'send_page_view',       type: '⚙️ GA4 Send Page View',
    describe: v => v === 'false' ? 'Page views are NOT sent automatically — must be sent manually'
                                 : 'Page view sent automatically when the tag loads' },
  { key: 'debug_mode',           type: '🐛 GA4 Debug Mode',
    describe: v => v === 'true' ? '⚠️ Debug mode is ON — should be off in production' : 'Debug mode off' },
  { key: 'user_id',              type: '👤 GA4 User ID',
    describe: () => 'user_id is set — enables cross-device reporting',
    note: 'Set only for signed-in users; never use personal data such as email' },
  { key: 'server_container_url', type: '🖥️ GA4 Server Container URL',
    describe: () => 'Data is routed through a server-side GTM container' },
  { key: 'transport_url',        type: '🖥️ GA4 Transport URL',
    describe: () => 'Hits are sent to a custom endpoint (often server-side GTM)' },
  { key: 'ignore_referrer',      type: '🚫 GA4 Ignore Referrer',
    describe: v => 'ignore_referrer = ' + v + ' — referrer ignored for matching pages' },
  { key: 'cookie_domain',        type: '🍪 Cookie Domain',
    describe: v => v === 'auto' ? 'auto — GA4 default (root domain)' : 'Custom cookie domain' },
  { key: 'cookie_expires',       type: '🍪 Cookie Expiry',
    describe: describeCookieExpiry_ },
  { key: 'cookie_prefix',        type: '🍪 Cookie Prefix',
    describe: () => 'Custom prefix added to GA cookie names' },
  { key: 'cookie_flags',         type: '🍪 Cookie Flags',
    describe: v => 'Flags: ' + v + (/SameSite=None/i.test(v) && !/Secure/i.test(v) ? ' — ⚠️ SameSite=None needs Secure' : '') },
  { key: 'cookie_update',        type: '🍪 Cookie Update',
    describe: v => v === 'false' ? 'Cookie expiry NOT refreshed on each page' : 'Cookie expiry refreshed on each page' }
];

const CONSENT_SIGNALS = [
  'ad_storage', 'analytics_storage', 'ad_user_data', 'ad_personalization',
  'functionality_storage', 'personalization_storage', 'security_storage'
];

const ECOMMERCE_EVENTS = [
  'view_item_list', 'view_item', 'select_item', 'add_to_cart', 'remove_from_cart',
  'view_cart', 'begin_checkout', 'add_shipping_info', 'add_payment_info', 'purchase', 'refund'
];

const BUILT_IN_EVENTS = new Set([
  'page_view', 'session_start', 'first_visit', 'user_engagement', 'optimize.activate'
]);


// ════════════════════════════════════════════════════════════════════
//  4. MENU
// ════════════════════════════════════════════════════════════════════

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🔍 Tag Scanner')
    .addItem('⚙️ Setup Scanner Sheet',         'setupTagScannerSheet')
    .addItem('📖 Open Tag Guide',              'createTagGuideSheet')
    .addSeparator()
    .addItem('🔍 Basic Scan',                  'scanWebsiteForTags')
    .addItem('🔍 Deep Scan (GTM + Config)',    'deepScanPage')
    .addSeparator()
    .addItem('🏷️ Scan GTM Container Directly', 'scanGTMDirectly')
    .addItem('🔎 Find GTM ID Automatically',   'findGTMIdAuto')
    .addItem('📋 Scan from Pasted HTML',       'scanFromPastedHtml')
    .addSeparator()
    .addItem('🔐 Scan GTM via API (full detail)', 'scanGTMViaApi')
    .addItem('📥 Import Container Export (JSON)', 'importContainerExport')
    .addSeparator()
    .addItem('🧪 Live Consent Test',          'openLiveConsentTest')
    .addItem('⚙️ Client Settings',            'openClientSettings')
    .addItem('📄 Export Audit Report (PDF)',  'exportAuditPdf')
    .addSeparator()
    .addItem('🗑️ Clear Results',               'clearScanResults')
    .addToUi();
}


// ════════════════════════════════════════════════════════════════════
//  5. MENU ACTIONS
// ════════════════════════════════════════════════════════════════════

function setupTagScannerSheet() {
  const sheet = getScannerSheet_();
  setupSheet_(sheet);
  SpreadsheetApp.getActiveSpreadsheet().setActiveSheet(sheet);
  toast_('Enter a URL in cell B2, then run Tag Scanner → Deep Scan', '✅ Sheet Ready', 5);
}

function scanWebsiteForTags() {
  runSafely_('Basic Scan', () => {
    const url = readUrlFromSheet_();
    if (!url) return;
    toast_('Scanning ' + url, '🔍 Basic Scan', 30);
    const html = fetchPage_(url);
    if (!html) return;
    renderFindings_(analyseHtml_(html, false), url, {
      emptyHint: 'The page may load its tags with JavaScript after page load. Try Deep Scan.'
    });
  });
}

function deepScanPage() {
  runSafely_('Deep Scan', () => {
    const url = readUrlFromSheet_();
    if (!url) return;
    toast_('Fetching ' + url, '🔍 Deep Scan', 60);
    const html = fetchPage_(url);
    if (!html) return;
    renderFindings_(deepAnalyse_(html), url, {
      showSummary: true,
      emptyHint: 'This usually means:\n' +
                 '• Tags are injected by JavaScript after load (SPA / React / Angular)\n' +
                 '• The site blocks automated requests\n' +
                 '• Tracking is fully server-side'
    });
  });
}

function scanGTMDirectly() {
  runSafely_('GTM Direct Scan', () => {
    const ui = SpreadsheetApp.getUi();
    const response = ui.prompt(
      '🏷️ GTM Container Direct Scan',
      'Enter one or more GTM container IDs, separated by commas.\n' +
      'Example: GTM-XXXXXX, GTM-YYYYYY\n\n' + FIND_GTM_ID_HELP,
      ui.ButtonSet.OK_CANCEL
    );
    if (response.getSelectedButton() !== ui.Button.OK) return;

    const ids = uniqueMatches_(response.getResponseText().toUpperCase(), ID_PATTERNS.GTM);
    if (ids.length === 0) {
      alert_('❌ No valid GTM IDs found',
             'The format is GTM- followed by 4–10 letters or numbers, e.g. GTM-K2JL4P');
      return;
    }
    renderFindings_(analyseContainers_(ids), 'GTM Direct: ' + ids.join(', '), {
      showSummary: true,
      emptyHint: 'The container may be unpublished, server-side only, or the ID may be wrong.'
    });
  });
}

function findGTMIdAuto() {
  runSafely_('Find GTM ID', () => {
    const url = readUrlFromSheet_();
    if (!url) return;

    const attempts = buildIdSearchAttempts_(url);
    const found = locateGtmIds_(attempts);

    if (!found) {
      alert_('❌ Could not find a GTM ID automatically',
             'Tried:\n' + attempts.map(a => '  • ' + a.name).join('\n') + '\n\n' +
             FIND_GTM_ID_HELP + '\n\n' +
             'Then use Tag Scanner → Scan GTM Container Directly,\n' +
             'or Tag Scanner → Scan from Pasted HTML.');
      return;
    }

    const ui = SpreadsheetApp.getUi();
    const choice = ui.alert(
      '🏷️ GTM ID(s) found',
      'Found via ' + found.source + ':\n\n' + found.ids.join('\n') + '\n\nScan these containers now?',
      ui.ButtonSet.YES_NO
    );
    if (choice !== ui.Button.YES) return;

    renderFindings_(deepAnalyse_(found.html), url + ' (via ' + found.source + ')', { showSummary: true });
  });
}

function scanFromPastedHtml() {
  const html = HtmlService.createHtmlOutput(PASTE_DIALOG_HTML_).setWidth(720).setHeight(500);
  SpreadsheetApp.getUi().showModalDialog(html, '📋 Scan from Pasted HTML');
}

/** Called from the paste dialog via google.script.run — must stay public. */
function processPastedHtml(html) {
  if (!html || html.length < 50) throw new Error('Paste the full page source first.');
  const result = renderFindings_(deepAnalyse_(html), 'Pasted HTML', {
    emptyHint: 'No Google tags or known third-party tags were found in the pasted source.'
  });
  return result.summary;
}

function clearScanResults() {
  clearResultRows_(getScannerSheet_());
  toast_('Results cleared', 'Done', 3);
}


// ════════════════════════════════════════════════════════════════════
//  6. SCAN PIPELINE
// ════════════════════════════════════════════════════════════════════

/** Everything a Deep Scan does: page analysis + every GTM container on the page. */
function deepAnalyse_(html) {
  toast_('Analysing page source…', '🔍 Deep Scan', 60);
  const findings = analyseHtml_(html, true);
  const ids = uniqueMatches_(html, ID_PATTERNS.GTM);
  return findings.concat(analyseContainers_(ids));
}

/** Analyses page HTML. `deep` adds inline config, events, consent etc. */
function analyseHtml_(html, deep) {
  let findings = [].concat(
    findGA4Ids_(html),
    findGTMIds_(html),
    findAdsIds_(html),
    findUAIds_(html),
    findInitialisation_(html),
    findScriptTags_(html),
    findVendors_(html, 'Page source')
  );
  if (!deep) return findings;

  AUDIT.pageScanned = true;
  collectIds_(html, null, 'Page source', 'Page source', true);
  return findings.concat(
    findGtagConfigCalls_(html),
    findGtagEvents_(html),
    findDataLayerPushes_(html),
    findMeasurementProtocol_(html),
    analyseConfigText_(html, 'Page source', 'page')
  );
}

/** Settings shared by page source and GTM containers. */
function analyseConfigText_(text, source, context) {
  return [].concat(
    findSettings_(text, source, context),
    findConsentMode_(text, source, context),
    findCrossDomain_(text, source),
    findPaymentDomains_(text, source),
    findEcommerce_(text, source)
  );
}

/**
 * Groups, de-duplicates and writes findings to the sheet.
 * Returns { count, summary } so callers (e.g. the paste dialog) can show it.
 */
function renderFindings_(findings, label, opts) {
  opts = opts || {};
  const sheet = ensureScannerSheet_();
  clearResultRows_(sheet);

  const unique = dedupe_(findings.concat(runAuditChecks_()));
  if (unique.length === 0) {
    const msg = 'Nothing found for ' + label + (opts.emptyHint ? '\n\n' + opts.emptyHint : '');
    writeNoResults_(sheet, msg);
    toast_('No tags found', '🔍 Scan Complete', 5);
    return { count: 0, summary: msg };
  }

  const groups = groupFindings_(unique);
  writeResults_(sheet, unique.length, groups);
  writeAuditTabs_(label);
  const summary = buildSummary_(unique.length, groups, label);

  toast_('✅ ' + unique.length + ' items found', '🔍 Scan Complete', 5);
  if (opts.showSummary) alert_('🔍 Scan Summary', summary);
  return { count: unique.length, summary: summary };
}


// ════════════════════════════════════════════════════════════════════
//  7. PAGE-SOURCE DETECTORS
// ════════════════════════════════════════════════════════════════════

function findGA4Ids_(html) {
  return uniqueMatches_(html, ID_PATTERNS.GA4).map(id => row_(
    '📊 GA4 Measurement ID', id, 'Page source',
    'Google Analytics 4 data stream ID',
    'Verify in GA4 → Admin → Data Streams'
  ));
}

function findGTMIds_(html) {
  return uniqueMatches_(html, ID_PATTERNS.GTM).map(id => row_(
    '🏷️ GTM Container ID', id, 'Page source',
    containerSummary_(id),
    'Run Deep Scan to analyse its tags'
  ));
}

function findAdsIds_(html) {
  return uniqueMatches_(html, ID_PATTERNS.ADS).map(match => {
    const parts = match.split('/');
    return row_(
      '🎯 Google Ads Tag', parts[0], 'Page source',
      'Google Ads conversion tracking' + (parts[1] ? ' | Conversion label: ' + parts[1] : ''),
      'Check it matches a conversion action in Google Ads'
    );
  });
}

function findUAIds_(html) {
  const ids = uniqueMatches_(html, ID_PATTERNS.UA);
  if (ids.length) {
    recordIssue_('Legacy', 'Medium', 'Universal Analytics code on the page (' + ids.join(', ') + ')',
                 'Remove the UA code from the site', 'Page source', null, { row: false });
  }
  return ids.map(id => row_(
    '⚠️ Universal Analytics (Legacy)', id, 'Page source',
    'UA stopped processing data in July 2024',
    'Remove this code and rely on GA4'
  ));
}

function findInitialisation_(html) {
  const out = [];
  if (/gtag\(\s*['"]js['"]/.test(html)) {
    out.push(row_('⚙️ gtag.js Initialised', 'window.gtag', 'Inline script',
                  'The Google tag (gtag.js) is initialised on this page', ''));
  }
  if (/dataLayer\s*=\s*(?:window\.dataLayer\s*\|\|\s*|dataLayer\s*\|\|\s*)?\[\s*\]/.test(html)) {
    out.push(row_('📦 dataLayer Declared', 'window.dataLayer', 'Inline script',
                  'dataLayer array declared before tags load', '✅ Standard GTM prerequisite'));
  }
  return out;
}

function findScriptTags_(html) {
  const out = [];
  const re = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const src  = m[1].replace(/&amp;/g, '&');
    const id   = (src.match(/[?&]id=([A-Za-z0-9-]+)/) || [])[1] || '(no ID in URL)';
    const host = (src.match(/^(?:https?:)?\/\/([^\/?#]+)/i) || [])[1] || '(same domain)';
    const isGoogleHost = /(^|\.)googletagmanager\.com$/i.test(host);

    if (/\/gtm\.js\?/.test(src)) {
      out.push(row_('📜 GTM Loader', id, host,
        isGoogleHost ? 'Standard GTM loader' : 'GTM served from a custom domain or path',
        isGoogleHost ? '' : 'Likely server-side GTM / first-party serving'));
    } else if (/\/gtag\/js\?/.test(src)) {
      out.push(row_('📜 gtag.js Loaded', id, host,
        isGoogleHost ? 'Google tag library' : 'Google tag served from a custom domain or path',
        isGoogleHost ? '' : 'Likely server-side GTM / first-party serving'));
    } else if (/google-analytics\.com\/(analytics|ga)\.js/.test(src)) {
      out.push(row_('⚠️ Universal Analytics Script', host, 'Script src',
        'Legacy analytics.js / ga.js library', 'Remove — UA no longer processes data'));
    } else if (/googleadservices\.com|googlesyndication\.com|doubleclick\.net/i.test(src)) {
      out.push(row_('🎯 Google Ads Script', host, 'Script src',
        'Google Ads / remarketing script', truncate_(src, 120)));
    }
  }
  return out;
}

function findVendors_(text, source) {
  const normalised = unescapeJs_(text);
  return VENDORS
    .filter(v => v[1].test(normalised))
    .map(v => row_(
      '🧩 Third-Party Tag', v[0], source,
      'Detected by its script / endpoint',
      /CMP/.test(v[0]) ? 'Consent management platform' : 'Check that it respects user consent'
    ));
}

function findGtagConfigCalls_(html) {
  const out  = [];
  const seen = new Set();
  const re = /gtag\(\s*['"]config['"]\s*,\s*['"]([^'"]+)['"]\s*(?:,\s*(\{[^}]{0,800}\}))?/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    const obj = m[2] || '';
    const params = summariseSettings_(obj);
    AUDIT.pageGoogleConfigs.push({ id: m[1], sendPageView: getSetting_(obj, 'send_page_view') !== 'false' });
    out.push(row_(
      '⚙️ gtag Config Call', m[1], 'Inline gtag()',
      params.length ? params.join(' | ') : 'Default config — no extra parameters',
      obj ? truncate_(obj.replace(/\s+/g, ' '), 180) : ''
    ));
  }
  return out;
}

function findGtagEvents_(html) {
  const out  = [];
  const seen = new Set();
  const re = /gtag\(\s*['"]event['"]\s*,\s*['"]([^'"]+)['"]\s*(?:,\s*(\{[^}]{0,400}\}))?/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    const params = (m[2] || '').replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();
    AUDIT.ga4Events.push({ name: m[1], params: keyValuePairs_(m[2] || '').map(s => s.split(':')[0]), where: 'Page source (gtag)' });
    out.push(row_('📌 gtag Event', m[1], 'Inline gtag()',
                  truncate_(params, 200) || 'No parameters', 'Event hard-coded in the page'));
  }
  return out;
}

function findDataLayerPushes_(html) {
  const out  = [];
  const seen = new Set();
  const re = /dataLayer\.push\(\s*(\{[^}]{0,600}\})\s*\)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const body  = m[1];
    const event = (body.match(/['"]?event['"]?\s*:\s*['"]([^'"]+)['"]/) || [])[1];
    const key   = event || body.substring(0, 40);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row_(
      '📦 dataLayer.push()', event || '(no event key)', 'Inline script',
      truncate_(keyValuePairs_(body).join(' | '), 250),
      truncate_(body.replace(/\s+/g, ' '), 200)
    ));
  }
  return out;
}

function findMeasurementProtocol_(html) {
  const out = [];
  const re = /api_secret\s*["']?\s*[=:]\s*["']([A-Za-z0-9_\-]{10,60})["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    recordIssue_('Security', 'High', 'Measurement Protocol API secret exposed in page source',
                 'Rotate the secret in GA4 and move Measurement Protocol calls server-side',
                 'Page source', null, { row: false });
    out.push(row_(
      '🔑 MP API Secret EXPOSED', maskSecret_(m[1]), 'Page source',
      'A Measurement Protocol API secret is visible in public page source',
      '🚨 Rotate it in GA4 → Admin → Data Streams → Measurement Protocol API secrets'
    ));
  }
  if (html.includes('google-analytics.com/mp/collect')) {
    out.push(row_('📡 MP Collect Endpoint', '/mp/collect', 'Page source',
                  'GA4 Measurement Protocol endpoint referenced', 'Server-side or hybrid tracking'));
  } else if (/google-analytics\.com\/(?:r\/)?collect/.test(html)) {
    out.push(row_('📡 UA Collect Endpoint', '/collect', 'Page source',
                  'Legacy Universal Analytics endpoint referenced', '⚠️ UA no longer processes data'));
  }
  return out;
}


// ════════════════════════════════════════════════════════════════════
//  8. SHARED CONFIG DETECTORS  (page source and GTM containers)
// ════════════════════════════════════════════════════════════════════

function findSettings_(text, source, context) {
  const out = [];
  GA_SETTINGS.forEach(s => {
    const value = getSetting_(text, s.key);
    if (value === null) return;
    const viaVariable = value.charAt(0) === '(';
    out.push(row_(
      s.type, value, source,
      viaVariable ? 'Value comes from a GTM variable' : s.describe(value),
      s.note || 'Parameter: ' + s.key
    ));
  });

  const hasCookieSetting = out.some(r => /Cookie/.test(r[0]));
  if (context === 'page' && !hasCookieSetting && /gtag\(|googletagmanager/.test(text)) {
    out.push(row_('🍪 Cookie Config', 'GA4 defaults', source,
                  'cookie_domain=auto, cookie_expires=2 years, SameSite=Lax',
                  'No custom cookie settings found'));
  }
  return out;
}

function summariseSettings_(text) {
  const params = [];
  GA_SETTINGS.forEach(s => {
    const v = getSetting_(text, s.key);
    if (v !== null) params.push(s.key + ': ' + v);
  });
  if (/\blinker\s*:/.test(text))     params.push('🔗 cross-domain linker');
  if (/\bgroups\s*:/.test(text))     params.push('groups set');
  if (/\bcustom_map\s*:/.test(text)) params.push('custom_map set');
  return params;
}

function findConsentMode_(text, source, context) {
  if (/ads_data_redaction/.test(text)) AUDIT.consentMode.redaction = true;
  if (/url_passthrough/.test(text)) AUDIT.consentMode.passthrough = true;
  const signals = CONSENT_SIGNALS.filter(s => text.includes(s));
  if (signals.length === 0) return [];

  const out = signals.map(signal => {
    const re = new RegExp(signal + '["\']?\\s*[:,]\\s*(?:["\'][A-Za-z_]+["\']\\s*,\\s*)?["\']?(granted|denied)', 'i');
    const state = ((text.match(re) || [])[1] || '').toLowerCase();
    return row_(
      '✅ Consent Signal', signal, source,
      state ? 'Default: ' + state : 'Referenced (default state not visible)',
      state === 'granted' ? 'Tags may use storage before consent — check against your consent requirements'
        : state === 'denied' ? 'Waits for consent before using storage'
        : 'Check the default state in your CMP or GTM'
    );
  });

  const isV2 = signals.includes('ad_user_data') || signals.includes('ad_personalization');
  if (context === 'page') AUDIT.consentMode.v2 = isV2;
  out.push(isV2
    ? row_('✅ Consent Mode Version', 'v2', source,
           'ad_user_data / ad_personalization signals present',
           'Meets Google\'s EEA consent requirements (since March 2024)')
    : row_('✅ Consent Mode Version', 'v1 (legacy)', source,
           'Missing ad_user_data and ad_personalization',
           '⚠️ Upgrade to Consent Mode v2 for EEA traffic'));

  const hasDefault = /['"]consent['"]\s*,\s*['"]default['"]/.test(text);
  if (context === 'page' && hasDefault) AUDIT.consentMode.defaultOnPage = true;
  if (context === 'page' && !hasDefault) {
    out.push(row_('⚠️ No Consent Default', 'Missing', source,
                  'No gtag("consent", "default", …) call found in the page source',
                  'Defaults should be set before any tag fires (may also be set by a CMP template in GTM)'));
  }
  return out;
}

function findCrossDomain_(text, source) {
  const out  = [];
  const seen = new Set();
  const normalised = unescapeJs_(text);
  const re = /linker|cross[_\s-]?domain/gi;
  let m;
  while ((m = re.exec(normalised)) !== null) {
    const snippet = normalised.substring(m.index, m.index + 400);
    (snippet.match(/["']([a-z0-9][a-z0-9\-.]*\.[a-z]{2,})["']/gi) || []).forEach(q => {
      const domain = q.replace(/["']/g, '').toLowerCase();
      if (seen.has(domain) || !isValidDomain_(domain) || /^internal\.|google|gstatic|schema\.org/.test(domain)) return;
      seen.add(domain);
      out.push(row_('🔗 Cross-Domain Domain', domain, source,
                    'Listed near linker / cross-domain configuration',
                    'Sessions continue across this domain — check it is intended'));
    });
  }
  if (/accept_incoming/.test(normalised)) {
    out.push(row_('🔗 Linker: Accept Incoming', 'accept_incoming', source,
                  'Accepts linker parameters from other domains', 'Needed on the destination domain'));
  }
  if (/decorate_forms/.test(normalised)) {
    out.push(row_('🔗 Linker: Decorate Forms', 'decorate_forms', source,
                  'Form submissions carry linker parameters', ''));
  }
  return out;
}

function findPaymentDomains_(text, source) {
  const normalised = unescapeJs_(text).toLowerCase();
  return PAYMENT_DOMAINS
    .filter(p => new RegExp('(^|[^a-z0-9-])' + escapeRegex_(p[0]) + '(?=$|[^a-z0-9-])').test(normalised))
    .map(p => {
      if (AUDIT.paymentDomains.indexOf(p[0]) < 0) AUDIT.paymentDomains.push(p[0]);
      return p;
    })
    .map(p => row_(
      '💳 Payment Domain Referenced', p[0], source,
      p[1] + ' is referenced — users may be redirected there and back',
      'Add to GA4 → Data Streams → Configure tag settings → List unwanted referrals'
    ));
}

function findEcommerce_(text, source) {
  const found = ECOMMERCE_EVENTS.filter(e => text.includes('"' + e + '"') || text.includes("'" + e + "'"));
  if (found.length === 0) return [];
  const out = found.map(e => row_(
    '🛒 Ecommerce Event', e, source, 'GA4 ecommerce event referenced', ''
  ));
  const currency = (text.match(/["']currency["']\s*[:,]\s*["']([A-Z]{3})["']/) || [])[1];
  if (currency) {
    if (AUDIT.currencies.indexOf(currency) < 0) AUDIT.currencies.push(currency);
    out.push(row_('🛒 Ecommerce Currency', currency, source, 'Currency code used in ecommerce data', ''));
  }
  return out;
}


// ════════════════════════════════════════════════════════════════════
//  9. GTM CONTAINER ANALYSIS — published gtm.js (no access needed)
//
//  gtm.js starts with `var data = {"resource": {...}, "runtime": ...}`.
//  "resource" is this site's own container config:
//     macros     → variables (referenced as ["macro", index])
//     tags       → tags, listeners and trigger groups
//     predicates → trigger conditions
//     rules      → ["rule", ["if", preds…], ["unless", …], ["add", tags…], ["block", tags…]]
//  Everything after it is Google's library code, which mentions every
//  ecommerce event, consent signal etc. — so only "resource" is analysed.
//  Tag / trigger / folder NAMES are stripped by GTM before publishing.
// ════════════════════════════════════════════════════════════════════

const GTM_EVENTS = {
  'gtm.js': 'Page View',                 'gtm.dom': 'DOM Ready',
  'gtm.load': 'Window Loaded',           'gtm.click': 'Click',
  'gtm.linkClick': 'Link Click',         'gtm.formSubmit': 'Form Submit',
  'gtm.scrollDepth': 'Scroll Depth',     'gtm.timer': 'Timer',
  'gtm.elementVisibility': 'Element Visibility',
  'gtm.historyChange': 'History Change', 'gtm.historyChange-v2': 'History Change',
  'gtm.video': 'YouTube Video',          'gtm.pageError': 'JavaScript Error',
  'gtm.init': 'Initialization',          'gtm.init_consent': 'Consent Initialization',
  'gtm.triggerGroup': 'Trigger Group'
};

const BUILTIN_DLV = {
  'gtm.element': 'Click/Form Element',   'gtm.elementClasses': 'Click/Form Classes',
  'gtm.elementId': 'Click/Form ID',      'gtm.elementTarget': 'Click/Form Target',
  'gtm.elementUrl': 'Click/Form URL',    'gtm.errorMessage': 'Error Message',
  'gtm.errorUrl': 'Error URL',           'gtm.errorLine': 'Error Line',
  'gtm.newUrlFragment': 'New History Fragment', 'gtm.oldUrlFragment': 'Old History Fragment',
  'gtm.newHistoryState': 'New History State',   'gtm.oldHistoryState': 'Old History State',
  'gtm.historyChangeSource': 'History Source',
  'gtm.scrollThreshold': 'Scroll Depth Threshold', 'gtm.scrollUnits': 'Scroll Depth Units',
  'gtm.scrollDirection': 'Scroll Direction',
  'gtm.visibleRatio': 'Percent Visible', 'gtm.visibleTime': 'On-Screen Duration',
  'gtm.videoProvider': 'Video Provider', 'gtm.videoUrl': 'Video URL',
  'gtm.videoTitle': 'Video Title',       'gtm.videoDuration': 'Video Duration',
  'gtm.videoPercent': 'Video Percent',   'gtm.videoVisible': 'Video Visible',
  'gtm.videoStatus': 'Video Status',     'gtm.videoCurrentTime': 'Video Current Time',
  'gtm.triggers': '_triggers'
};

const PRED_OPS = {
  _eq: 'equals', _cn: 'contains', _re: 'matches regex', _sw: 'starts with',
  _ew: 'ends with', _lt: '<', _le: '≤', _gt: '>', _ge: '≥', _css: 'matches CSS selector'
};

function analyseContainers_(ids) {
  let findings = [];
  ids.forEach(id => {
    toast_('Analysing ' + id + '…', '🏷️ GTM', 60);
    findings = findings.concat(analyseContainer_(id));
  });
  return findings;
}

function analyseContainer_(id) {
  const container = fetchContainer_(id);
  if (container.code === 403 || container.code === 404) {
    return [row_('🔒 GTM Container Restricted', id, 'HTTP ' + container.code,
                 'Container is unpublished, private, or the ID is wrong',
                 'Check the ID and that a version is published')];
  }
  if (!container.js) {
    return [row_('❌ GTM Fetch Error', id, container.code ? 'HTTP ' + container.code : 'Network error',
                 'The container could not be downloaded', 'Try again, or verify the ID')];
  }
  try {
    const data = getContainerData_(id);
    return data && data.resource
      ? analyseCompiledResource_(id, container.js, data.resource)
      : analyseContainerRegex_(id, container.js);
  } catch (e) {
    Logger.log('analyseContainer_(' + id + ') failed: ' + e.stack);
    return [row_('❌ GTM Analysis Error', id, 'Exception', e.message, 'See Apps Script → Executions')];
  }
}

function getContainerData_(id) {
  const c = fetchContainer_(id);
  if (!c.js) return null;
  if (c.parsed === undefined) c.parsed = parseContainerData_(c.js);
  return c.parsed;
}

/** Extracts and parses the `var data = {...}` object from gtm.js. */
function parseContainerData_(js) {
  const at = js.search(/var data\s*=\s*\{/);
  if (at < 0) return null;
  const start = js.indexOf('{', at);
  const end = matchingBrace_(js, start);
  if (end < 0) return null;

  // gtm.js uses JavaScript escapes (\x3c, \') that JSON does not allow
  const jsonText = js.substring(start, end + 1).replace(/\\(x[0-9a-fA-F]{2}|[\s\S])/g, (all, s) => {
    if (s.length === 3) return '\\u00' + s.slice(1);
    if ('"\\/bfnrtu'.indexOf(s) >= 0) return all;
    return s === '\n' ? '' : s;
  });
  try {
    return JSON.parse(jsonText);
  } catch (e) {
    Logger.log('Container JSON parse failed, using regex fallback: ' + e.message);
    return null;
  }
}

function matchingBrace_(s, start) {
  let depth = 0, inString = false;
  for (let i = start; i < s.length; i++) {
    const c = s.charAt(i);
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function analyseCompiledResource_(id, js, res) {
  const macros = res.macros || [], tags = res.tags || [];
  const preds = res.predicates || [], rules = res.rules || [];
  const R = compiledRenderer_(macros);
  const eventMacros = new Set();
  macros.forEach((m, i) => { if (m.function === '__e') eventMacros.add(i); });

  // Which conditions add / block each tag
  const firing = tags.map(() => ({ add: [], block: [] }));
  rules.forEach(rule => {
    if (!Array.isArray(rule)) return;
    const parts = {};
    rule.slice(1).forEach(p => { if (Array.isArray(p)) parts[p[0]] = p.slice(1); });
    const cond = describeRule_(parts['if'] || [], parts['unless'] || [], preds, R, eventMacros);
    (parts.add || []).forEach(i => { if (firing[i]) firing[i].add.push(cond); });
    (parts.block || []).forEach(i => { if (firing[i]) firing[i].block.push(cond); });
  });

  // Tags started by other tags (tag sequencing) have no rule of their own
  const sequenced = new Set();
  tags.forEach(t => [t.setup_tags, t.teardown_tags].forEach(v => collectTagRefs_(v, sequenced)));

  const kindOf = t => GTM_LISTENERS[t.function] ? 'listener' : t.function === '__tg' ? 'group' : 'tag';
  const realTags  = [];
  tags.forEach((t, i) => { if (kindOf(t) === 'tag') realTags.push({ t: t, i: i }); });
  const listeners = tags.filter(t => kindOf(t) === 'listener');
  const groups    = tags.filter(t => kindOf(t) === 'group');
  const paused    = realTags.filter(x => x.t.function === '__paused').length;
  const version   = res.version || (js.match(/"version"\s*:\s*"([^"]+)"/) || [])[1] || 'unknown';
  const text      = JSON.stringify(res);
  const out = [];

  out.push(row_(
    '🏷️ GTM Container', id, 'gtm.js (' + Math.round(js.length / 1024) + ' KB)',
    'Version ' + version + ' | ' + realTags.length + ' tags (' + paused + ' paused) | ' +
      groups.length + ' trigger groups | ' + listeners.length + ' listeners | ' + macros.length + ' variables',
    'Published container: tag names are not included. For names, folders and notes use ' +
      'Scan GTM via API or Import Container Export'
  ));

  uniqueMatches_(text, ID_PATTERNS.GA4).forEach(ga => out.push(row_(
    '📊 GA4 ID in GTM', ga, id, 'GA4 measurement ID configured in this container',
    'Check it matches your GA4 data stream')));
  uniqueMatches_(text, /\bAW-\d{7,12}\b/g).forEach(aw => out.push(row_(
    '🎯 Google Ads ID in GTM', aw, id, 'Google Ads account ID configured in this container', '')));

  if (consentDefaultIn_(text)) AUDIT.consentMode.defaultViaGtm = true;

  realTags.forEach(x => {
    const t = x.t;
    const isPaused = t.function === '__paused';
    const type = isPaused ? String(R.render(t.vtp_originalTagType) || '') : t.function.replace(/^__/, '');
    const checks = Array.isArray(t.consent) ? R.render(t.consent).split(/,\s*/).filter(Boolean) : [];
    out.push(buildTagRow_({
      def: tagDef_(type), p: compiledAdapter_(t, R), type: type || 'paused',
      paused: isPaused, tagNumber: t.tag_id, source: id,
      firesOn: firing[x.i].add, blockedBy: firing[x.i].block, sequenced: sequenced.has(x.i),
      gateText: firing[x.i].add.concat(firing[x.i].block).join(' | '),
      additionalChecks: checks,
      consent: checks.length ? 'Consent: requires ' + checks.join(', ') : ''
    }));
  });

  groups.forEach(t => {
    const members = R.render(t.vtp_triggerIds);
    const count = members ? members.split(',').length : 0;
    out.push(row_('⚡ GTM Trigger Group', 'Trigger group' + (t.tag_id ? ' #' + t.tag_id : ''), id,
                  'Fires once all ' + count + ' member triggers have fired', ''));
  });

  countBy_(listeners, t => GTM_LISTENERS[t.function]).forEach(c => out.push(row_(
    '⚡ GTM Listener', c.key, id, c.count + ' instance(s)', 'Auto-event listener used by triggers')));

  countBy_(macros, m => GTM_VARIABLES[m.function] || ('Custom (' + m.function + ')')).forEach(c => out.push(row_(
    '📐 GTM Variable', c.key, id, c.count + ' variable(s) of this type', '')));

  const dlvNames = Array.from(new Set(macros
    .filter(m => m.function === '__v')
    .map(m => R.render(m.vtp_name))
    .filter(Boolean)));
  dlvNames.filter(n => !/^gtm\./.test(n)).forEach(name => out.push(row_(
    '📋 Data Layer Variable', name, id, 'GTM reads "' + name + '" from the dataLayer',
    'The site must push it: dataLayer.push({ "' + name + '": … })')));
  const builtIns = dlvNames.filter(n => /^gtm\./.test(n) && n !== 'gtm.triggers').map(n => BUILTIN_DLV[n] || n);
  if (builtIns.length) {
    out.push(row_('📐 GTM Variable', 'Built-in variables', id, builtIns.join(', '),
                  builtIns.length + ' built-in variables in use (provided by GTM, not the site)'));
  }

  compiledCustomEvents_(preds, R, eventMacros).forEach(name => out.push(row_(
    '📌 GTM Custom Event', name, id,
    'Triggers fire on dataLayer.push({ event: "' + name + '" })', '')));

  findUserProperties_(text).forEach(name => out.push(row_(
    '👤 GA4 User Property', name, id, 'User property set on a GA4 tag',
    'Register it as a custom dimension in GA4')));

  return out.concat(findVendors_(text, id), analyseConfigText_(text, id, 'gtm'));
}

/** Turns compiled values (["macro",3], ["template",…], ["list",…]) into readable text. */
function compiledRenderer_(macros) {
  const R = { macros: macros };
  R.render = (v, depth) => {
    depth = depth || 0;
    if (depth > 6) return '…';
    if (v == null) return '';
    if (!Array.isArray(v)) return typeof v === 'object' ? truncate_(JSON.stringify(v), 80) : String(v);
    const rest = v.slice(1), r = x => R.render(x, depth + 1);
    switch (v[0]) {
      case 'macro':    return R.macroLabel(v[1], depth + 1);
      case 'template': return rest.map(r).join('');
      case 'escape':   return r(v[1]);
      case 'list':     return rest.map(r).filter(Boolean).join(', ');
      case 'map': {
        const parts = [];
        for (let i = 0; i + 1 < rest.length; i += 2) parts.push(r(rest[i]) + '=' + r(rest[i + 1]));
        return parts.join('; ');
      }
      case 'tag':      return 'tag #' + v[1];
      default:         return rest.map(r).join(' ');
    }
  };
  R.macroLabel = (i, depth) => {
    const m = macros[i];
    if (!m) return '{{variable ' + i + '}}';
    const type = String(m.function || '').replace(/^__/, '');
    const name = m.vtp_name != null ? R.render(m.vtp_name, depth) : '';
    switch (type) {
      case 'c':   return R.render(m.vtp_value, depth);
      case 'v':   return '{{' + (BUILTIN_DLV[name] || 'DLV: ' + name) + '}}';
      case 'e':   return '{{Event}}';
      case 'u': {
        const part = R.render(m.vtp_component, depth);
        return '{{' + (part && part !== 'URL' ? 'URL ' + part.toLowerCase() : 'Page URL') + '}}';
      }
      case 'k':   return '{{Cookie: ' + name + '}}';
      case 'j':   return '{{JS: ' + name + '}}';
      case 'aev': return '{{Auto-Event: ' + R.render(m.vtp_varType, depth) + '}}';
      case 'gas': return '{{GA Settings: ' + R.render(m.vtp_trackingId, depth) + '}}';
      default:    return '{{' + (GTM_VARIABLES['__' + type] || type) + '}}';
    }
  };
  return R;
}

function describeRule_(ifs, unless, preds, R, eventMacros) {
  const conds = ifs.map(i => describePredicate_(preds[i], R, eventMacros)).filter(Boolean)
    .concat(unless.map(i => describePredicate_(preds[i], R, eventMacros)).filter(Boolean).map(s => 'NOT ' + s));
  return conds.length ? conds.join(' & ') : 'Always';
}

function describePredicate_(pr, R, eventMacros) {
  if (!pr) return null;
  const op = PRED_OPS[pr.function] || pr.function;
  if (isMacroRef_(pr.arg0) && eventMacros.has(pr.arg0[1])) {
    const names = eventNamesFromPredicate_(pr, R);
    if (names.length) return names.map(n => GTM_EVENTS[n] || 'Custom Event "' + n + '"').join(' / ');
    return 'Event ' + op + ' "' + truncate_(R.render(pr.arg1), 50) + '"';
  }
  const left = R.render(pr.arg0);
  if (/_triggers|gtm\.triggers/.test(left)) return null;   // internal trigger-ID check
  return left + ' ' + op + ' "' + truncate_(R.render(pr.arg1), 50) + '"';
}

function eventNamesFromPredicate_(pr, R) {
  const value = R.render(pr.arg1);
  if (pr.function === '_eq') return value ? [value] : [];
  if (pr.function === '_re') return splitRegexAlternatives_(value) || [];
  return [];
}

/** "^(gtm\.click|purchase)$" → ["gtm.click", "purchase"]; null if it is a real regex. */
function splitRegexAlternatives_(value) {
  const m = /^\^?\(?([^()]*?)\)?\$?$/.exec(value || '');
  if (!m) return null;
  const parts = m[1].split('|').map(s => s.replace(/\\(.)/g, '$1'));
  return parts.length && parts.every(s => /^[\w.\- %]+$/.test(s)) ? parts : null;
}

function compiledCustomEvents_(preds, R, eventMacros) {
  const names = new Set();
  preds.forEach(pr => {
    if (pr && isMacroRef_(pr.arg0) && eventMacros.has(pr.arg0[1])) {
      eventNamesFromPredicate_(pr, R).forEach(n => names.add(n));
    }
  });
  return Array.from(names).filter(n => !/^gtm\./.test(n) && !BUILT_IN_EVENTS.has(n));
}

function collectTagRefs_(v, set) {
  if (!Array.isArray(v)) return;
  if (v[0] === 'tag' && typeof v[1] === 'number') { set.add(v[1]); return; }
  v.forEach(x => collectTagRefs_(x, set));
}

function isMacroRef_(v) {
  return Array.isArray(v) && v[0] === 'macro' && typeof v[1] === 'number';
}


// ── Shared tag description (compiled, API and export formats) ───────

function tagDef_(type) {
  if (GTM_TAGS[type]) return GTM_TAGS[type];
  if (/^cvt_/.test(type)) return CUSTOM_TEMPLATE_TAG;
  return UNKNOWN_TAG;
}

/**
 * o: { def, p, type, name?, paused, tagNumber, source, folder?, firesOn (array|null),
 *      blockedBy, sequenced, consent, sequence, notes }
 */
function buildTagRow_(o) {
  const def = o.def;
  let param = null, extra = null;
  try {
    param = def.param ? def.param(o.p) : null;
    extra = def.extra ? def.extra(o.p) : null;
  } catch (e) {
    Logger.log('Tag parameter read failed (' + o.type + '): ' + e.message);
  }
  const label   = o.paused && def === UNKNOWN_TAG ? 'Paused tag'
                : o.templateName ? 'Template: ' + o.templateName.replace(/\s\(.*\)$/, '') : def.name;
  const summary = label + (param ? ': ' + truncate_(param, 90) : '');
  const value   = (o.paused ? '⏸️' : def.emoji) + ' ' + (o.name || summary);
  const details = joinParts_(o.name ? summary : null, extra) || 'Type: ' + (o.type || 'unknown');

  let fires = '';
  if (o.firesOn && o.firesOn.length) fires = 'Fires on: ' + truncate_(o.firesOn.join(' OR '), 300);
  else if (o.firesOn && !o.paused) fires = o.sequenced ? 'Fired by tag sequencing' : '⚠️ No firing trigger';

  const notes = joinParts_(
    o.paused && '⏸️ PAUSED — not firing',
    fires,
    o.blockedBy && o.blockedBy.length && 'Blocked by: ' + truncate_(o.blockedBy.join(' OR '), 150),
    o.consent, o.sequence, def.note,
    o.notes && 'Note: ' + truncate_(o.notes, 150)
  );
  const source = o.source + (o.tagNumber ? ' · Tag #' + o.tagNumber : '') + (o.folder ? ' · 📁 ' + o.folder : '');
  let allText = '';
  try { allText = o.p.allText(); } catch (e) { /* ignore */ }
  const group = tagGroupOf_(o.type || '', allText, [o.name, o.templateName]);
  recordTag_(o, value.replace(/^\S+\s/, ''), summary, source, group);

  const row = row_((o.paused ? '⏸️ Paused · ' : '🏷️ ') + label, value, source, details, notes);
  row.group = group;   // used by groupFindings_ to file the row under its platform
  return row;
}

// ── Platform groups for the results sheet ───────────────────────────

// `logo` is a domain whose site icon is shown next to the group heading
const TAG_GROUPS = {
  ga4:        { rank: 1,  label: '📊 GA4 Tags',                logo: 'analytics.google.com', header: '#e37400' },
  gads:       { rank: 2,  label: '🎯 Google Ads Tags',         logo: 'ads.google.com',       header: '#1a73e8' },
  floodlight: { rank: 3,  label: '💡 Floodlight (CM360) Tags', logo: 'marketingplatform.google.com', header: '#0f9d58' },
  meta:       { rank: 4,  label: '📘 Meta Tags',               logo: 'facebook.com',         header: '#1877f2' },
  tiktok:     { rank: 5,  label: '🎵 TikTok Tags',             logo: 'tiktok.com',           header: '#212121' },
  linkedin:   { rank: 6,  label: '💼 LinkedIn Tags',           logo: 'linkedin.com',         header: '#0a66c2' },
  microsoft:  { rank: 7,  label: '🪟 Microsoft Ads Tags',      logo: 'ads.microsoft.com',    header: '#0078d4' },
  amazon:     { rank: 8,  label: '🛒 Amazon Ads Tags',         logo: 'advertising.amazon.com', header: '#ff9900' },
  cmp:        { rank: 40, label: '🔐 {name} Tags (consent platform)', header: '#00796b' },
  vendor:     { rank: 50, label: '🧩 {name} Tags',             header: '#4527a0' },
  ua:         { rank: 90, label: '⚠️ Universal Analytics Tags (legacy)', logo: 'analytics.google.com', header: '#f57f17' },
  optimize:   { rank: 91, label: '⚠️ Google Optimize Tags (legacy)',     logo: 'optimize.google.com',  header: '#f57f17' },
  html:       { rank: 95, label: '📝 Custom HTML Tags (no known vendor)',     header: '#455a64' },
  template:   { rank: 96, label: '🧩 Custom Template Tags (no known vendor)', header: '#5e35b1' },
  image:      { rank: 97, label: '🖼️ Custom Image Tags (no known vendor)',    header: '#6d4c41' },
  other:      { rank: 99, label: '❓ Other Tags',                             header: '#616161' }
};

const TYPE_GROUP = {
  googtag: 'ga4', gaawc: 'ga4', gaawe: 'ga4',
  awct: 'gads', sp: 'gads', gclidw: 'gads',
  flc: 'floodlight', fls: 'floodlight',
  baut: 'microsoft', bzi: 'linkedin',
  ua: 'ua', opt: 'optimize'
};

const VENDOR_GROUP = {
  'Meta Pixel': 'meta', 'TikTok Pixel': 'tiktok', 'LinkedIn Insight Tag': 'linkedin',
  'Microsoft Ads UET': 'microsoft', 'Google Floodlight': 'floodlight', 'Amazon Ads': 'amazon'
};

// Site-icon domains for the other vendors
const VENDOR_LOGOS = {
  'Microsoft Clarity': 'clarity.microsoft.com', 'Pinterest Tag': 'pinterest.com',
  'X (Twitter) Pixel': 'x.com', 'Snap Pixel': 'snapchat.com', 'Reddit Pixel': 'reddit.com',
  'Criteo': 'criteo.com', 'Taboola': 'taboola.com', 'Outbrain': 'outbrain.com',
  'Hotjar': 'hotjar.com', 'FullStory': 'fullstory.com', 'Contentsquare': 'contentsquare.com',
  'Segment': 'segment.com', 'Amplitude': 'amplitude.com', 'Mixpanel': 'mixpanel.com',
  'Heap': 'heap.io', 'HubSpot': 'hubspot.com', 'Klaviyo': 'klaviyo.com',
  'Intercom': 'intercom.com', 'VWO': 'vwo.com', 'Optimizely': 'optimizely.com',
  'Adobe Launch / Analytics': 'adobe.com', 'Adform': 'adform.com', 'Chartbeat': 'chartbeat.com',
  'Teads': 'teads.com', 'Xandr (AppNexus)': 'xandr.com', 'The Trade Desk': 'thetradedesk.com',
  'Quantcast': 'quantcast.com', 'Cookiebot (CMP)': 'cookiebot.com', 'OneTrust (CMP)': 'onetrust.com',
  'Usercentrics (CMP)': 'usercentrics.com', 'Didomi (CMP)': 'didomi.io', 'TrustArc (CMP)': 'trustarc.com'
};

// Fallback when the code gives no clue (e.g. gallery templates): match the
// tag name or template name. Each rule maps to a VENDORS name or a group key.
const NAME_RULES = [
  [/\b(meta|fb|fbq|capi)\b|facebook/i,               { vendor: 'Meta Pixel' }],
  [/amazon|\bamzn\b|\baap\b|\bapstag\b/i,            { vendor: 'Amazon Ads' }],
  [/lin?ked\s*-?in|\bli insight/i,                   { vendor: 'LinkedIn Insight Tag' }],
  [/tik\s*-?tok/i,                                   { vendor: 'TikTok Pixel' }],
  [/floodlight|\bcm\s?360\b|\bdcm\b|\bdv\s?360\b/i,  { vendor: 'Google Floodlight' }],
  [/\bbing\b|\buet\b|microsoft\s*ads/i,              { vendor: 'Microsoft Ads UET' }],
  [/clarity/i,                                       { vendor: 'Microsoft Clarity' }],
  [/pinterest/i,                                     { vendor: 'Pinterest Tag' }],
  [/snap\s*chat|\bsnap\b/i,                          { vendor: 'Snap Pixel' }],
  [/reddit/i,                                        { vendor: 'Reddit Pixel' }],
  [/twitter|\bx\s*(pixel|ads)\b/i,                   { vendor: 'X (Twitter) Pixel' }],
  [/criteo/i,                                        { vendor: 'Criteo' }],
  [/taboola/i,                                       { vendor: 'Taboola' }],
  [/outbrain/i,                                      { vendor: 'Outbrain' }],
  [/adform/i,                                        { vendor: 'Adform' }],
  [/hotjar/i,                                        { vendor: 'Hotjar' }],
  [/trade\s*desk|\bttd\b/i,                          { vendor: 'The Trade Desk' }],
  [/teads/i,                                         { vendor: 'Teads' }],
  [/xandr|appnexus/i,                                { vendor: 'Xandr (AppNexus)' }],
  [/quantcast/i,                                     { vendor: 'Quantcast' }],
  [/hubspot/i,                                       { vendor: 'HubSpot' }],
  [/cookiebot/i,                                     { vendor: 'Cookiebot (CMP)' }],
  [/onetrust|optanon/i,                              { vendor: 'OneTrust (CMP)' }],
  [/usercentrics/i,                                  { vendor: 'Usercentrics (CMP)' }],
  [/didomi/i,                                        { vendor: 'Didomi (CMP)' }],
  [/\bga4\b|google analytics 4/i,                    { group: 'ga4' }],
  [/google\s*ads|adwords|conversion linker/i,        { group: 'gads' }],
  [/universal analytics|\bua\b/i,                    { group: 'ua' }]
];

function vendorByName_(name) {
  return VENDORS.filter(v => v[0] === name)[0] || null;
}

function logoUrl_(domain) {
  return domain ? 'https://www.google.com/s2/favicons?sz=64&domain=' + domain : '';
}

/**
 * Decides a tag's platform group: tag type → what its code loads →
 * tag / template name. Returns { key, rank, header, label, plain, logo, vendorEntry }.
 */
function tagGroupOf_(type, text, names) {
  const make = (key, vendorEntry) => {
    const g = TAG_GROUPS[key];
    const name = vendorEntry ? vendorEntry[0].replace(/ \(CMP\)$/, '').replace(/ (Pixel|Tag)$/, '') : '';
    const label = g.label.replace('{name}', name);
    const domain = g.logo || (vendorEntry && VENDOR_LOGOS[vendorEntry[0]]) || '';
    return {
      key: key + (name && !VENDOR_GROUP[vendorEntry[0]] ? ':' + name : ''),
      rank: g.rank, header: g.header, label: label,
      plain: label.replace(/^\S+\s/, ''), logo: logoUrl_(domain), vendorEntry: vendorEntry || null
    };
  };
  const forVendor = entry => VENDOR_GROUP[entry[0]] ? make(VENDOR_GROUP[entry[0]], entry)
                           : make(/\(CMP\)$/.test(entry[0]) ? 'cmp' : 'vendor', entry);

  if (TYPE_GROUP[type]) return make(TYPE_GROUP[type]);
  if (type === 'hjtc') return forVendor(vendorByName_('Hotjar'));

  const plain = unescapeJs_(text || '');
  const vendor = vendorInfo_(plain);
  if (vendor) return forVendor(vendor);
  // Google code pasted into Custom HTML
  if (/gtag\/js\?id=G-|gtag\(\s*['"]config['"]\s*,\s*['"]G-/.test(plain)) return make('ga4');
  if (/gtag\/js\?id=AW-|gtag\(\s*['"](config|event)['"]\s*,\s*['"](AW-|conversion)/.test(plain)) return make('gads');

  // Tag name / template name
  const nameText = (names || []).filter(Boolean).join(' | ');
  if (nameText) {
    const rule = NAME_RULES.filter(r => r[0].test(nameText))[0];
    if (rule) {
      if (rule[1].group) return make(rule[1].group);
      const entry = vendorByName_(rule[1].vendor);
      if (entry) return forVendor(entry);
    }
  }

  if (type === 'html') return make('html');
  if (/^cvt_/.test(type)) return make('template');
  if (type === 'img') return make('image');
  return make('other');
}

/** Mixes a colour with white (amount 0–1) for light row backgrounds. */
function tint_(hex, amount) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return '#f5f5f5';
  const n = parseInt(m[1], 16);
  return '#' + [16, 8, 0].map(s => {
    const c = (n >> s) & 255;
    return Math.round(c + (255 - c) * amount).toString(16).padStart(2, '0');
  }).join('');
}

/** Adapter over a compiled gtm.js object (keys are "vtp_" + name). */
function compiledAdapter_(obj, R) {
  const raw = key => obj['vtp_' + key];
  return {
    get: key => {
      const v = raw(key);
      if (v == null) return null;
      const s = R.render(v);
      return s === '' ? null : s;
    },
    pairs: key => {
      const v = raw(key);
      if (!Array.isArray(v) || v[0] !== 'list') return [];
      return v.slice(1).filter(m => Array.isArray(m) && m[0] === 'map').map(m => {
        const o = {};
        for (let i = 1; i + 1 < m.length; i += 2) o[R.render(m[i])] = m[i + 1];
        return toPair_(o, x => R.render(x));
      }).filter(Boolean);
    },
    fromVariable: (key, sub) => {
      const v = raw(key);
      if (!isMacroRef_(v)) return null;
      const m = R.macros[v[1]];
      return m && m['vtp_' + sub] != null ? R.render(m['vtp_' + sub]) || null : null;
    },
    allText: () => JSON.stringify(obj)
  };
}

/** Adapter over a raw text snippet (regex fallback only). */
function regexAdapter_(ctx) {
  return {
    get: key => getVtp_(ctx, 'vtp_' + key),
    pairs: () => [],
    fromVariable: () => null,
    allText: () => ctx
  };
}

/** Reduces a settings map to { k, v } (parameter/parameterValue, name/value, key/value). */
function toPair_(o, render) {
  const k = firstDefined_(o.parameter, o.name, o.key, o.fieldName);
  const v = firstDefined_(o.parameterValue, o.value);
  if (k == null) return null;
  return { k: render(k), v: v == null ? '' : render(v) };
}

function settingsSummary_(pairs) {
  return pairs.length ? 'Settings: ' + pairs.map(x => x.k + '=' + truncate_(x.v, 40)).join(', ') : null;
}

function adsParam_(p) {
  const id = p.get('conversionId'), label = p.get('conversionLabel');
  if (!id) return null;
  return (/^\d+$/.test(id) ? 'AW-' + id : id) + (label ? ' / ' + label : '');
}

function floodlightParam_(p) {
  const parts = ['advertiserId', 'groupTag', 'activityTag'].map(k => p.get(k)).filter(Boolean);
  return parts.length ? parts.join(' / ') : null;
}

/** Best one-line description of Custom HTML: vendor → hosts it loads → first text. */
function htmlSummary_(html) {
  if (!html) return null;
  const vendor = vendorIn_(html);
  if (vendor) return vendor;
  const hosts = loadedHosts_(html);
  if (hosts.length) {
    return 'loads ' + hosts.slice(0, 3).join(', ') + (hosts.length > 3 ? ' +' + (hosts.length - 3) + ' more' : '');
  }
  const text = html.replace(/<\/?script[^>]*>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return text ? truncate_(text, 60) : null;
}

function loadedHosts_(text) {
  const hosts = new Set();
  const re = /(?:https?:)?\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?=[\/:'"?#\s\\]|$)/gi;
  let m;
  while ((m = re.exec(unescapeJs_(text))) !== null) {
    const h = m[1].toLowerCase();
    if (isValidDomain_(h) && !/(^|\.)(w3\.org|schema\.org)$/.test(h)) hosts.add(h);
  }
  return Array.from(hosts);
}

function hostOf_(url) {
  return (String(url || '').match(/^(?:https?:)?\/\/([^\/?#]+)/i) || [])[1] || null;
}

function vendorIn_(text) {
  const normalised = unescapeJs_(text || '');
  const hit = VENDORS.filter(v => v[1].test(normalised))[0];
  return hit ? hit[0] : null;
}

/** Reads a "vtp_*" value from a GTM object: string, number or {{variable}}. */
function getVtp_(ctx, key) {
  const re = new RegExp('"' + escapeRegex_(key) +
    '"\\s*:\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|(-?\\d+(?:\\.\\d+)?)|(\\[\\s*"macro"))');
  const m = ctx.match(re);
  if (!m) return null;
  if (m[3]) return '{{variable}}';
  const v = m[1] !== undefined ? unescapeJs_(m[1]) : m[2];
  return v || null;
}


// ── Regex fallback (only if the container JSON cannot be parsed) ────

function analyseContainerRegex_(id, js) {
  const runtimeAt = js.search(/"runtime"\s*:/);
  const configText = runtimeAt > 0 ? js.substring(0, runtimeAt) : js;
  const entries   = parseContainerEntries_(configText);
  const tags      = entries.filter(e => e.kind === 'tag');
  const listeners = entries.filter(e => e.kind === 'listener');
  const variables = entries.filter(e => e.kind === 'variable');
  const version   = (js.match(/"version"\s*:\s*"([^"]+)"/) || [])[1] || 'unknown';
  const out = [];

  out.push(row_('🏷️ GTM Container', id, 'gtm.js (' + Math.round(js.length / 1024) + ' KB)',
    'Version ' + version + ' | ' + tags.length + ' tags | ' + listeners.length + ' listeners | ' +
      variables.length + ' variables',
    'Limited analysis (container format not recognised)'));

  uniqueMatches_(configText, ID_PATTERNS.GA4).forEach(ga => out.push(row_(
    '📊 GA4 ID in GTM', ga, id, 'GA4 measurement ID configured in this container', '')));

  tags.forEach(t => {
    const type = t.fn.replace(/^__/, '');
    out.push(buildTagRow_({
      def: tagDef_(type), p: regexAdapter_(t.ctx), type: type, paused: type === 'paused',
      tagNumber: (t.ctx.match(/"tag_id"\s*:\s*(\d+)/) || [])[1], source: id, firesOn: null
    }));
  });
  countBy_(listeners, e => GTM_LISTENERS[e.fn]).forEach(c => out.push(row_(
    '⚡ GTM Listener', c.key, id, c.count + ' instance(s)', '')));
  countBy_(variables, e => GTM_VARIABLES[e.fn] || ('Custom (' + e.fn + ')')).forEach(c => out.push(row_(
    '📐 GTM Variable', c.key, id, c.count + ' variable(s) of this type', '')));

  return out.concat(findVendors_(configText, id), analyseConfigText_(configText, id, 'gtm'));
}

function parseContainerEntries_(js) {
  const sections = {
    macros:     js.search(/"macros"\s*:\s*\[/),
    tags:       js.search(/"tags"\s*:\s*\[/),
    predicates: js.search(/"predicates"\s*:\s*\[/)
  };
  const sectionAt = i => {
    if (sections.tags >= 0 && i > sections.tags &&
        (sections.predicates < 0 || i < sections.predicates)) return 'tags';
    if (sections.macros >= 0 && i > sections.macros &&
        (sections.tags < 0 || i < sections.tags)) return 'macros';
    return 'unknown';
  };

  const matches = [];
  const re = /"function"\s*:\s*"(__[A-Za-z0-9_]+)"/g;
  let m;
  while ((m = re.exec(js)) !== null) matches.push({ fn: m[1], index: m.index });

  return matches.map((match, i) => {
    const end     = i + 1 < matches.length ? matches[i + 1].index : js.length;
    const ctx     = js.substring(match.index, Math.min(end, match.index + 20000));
    const section = sectionAt(match.index);
    let kind;
    if (section === 'macros')               kind = 'variable';
    else if (GTM_LISTENERS[match.fn])       kind = 'listener';
    else if (match.fn === '__tg')           kind = 'group';
    else if (section === 'tags')            kind = 'tag';
    else if (GTM_TAGS[match.fn.replace(/^__/, '')] || /^__cvt_/.test(match.fn)) kind = 'tag';
    else if (GTM_VARIABLES[match.fn])       kind = 'variable';
    else                                    kind = 'unknown';
    return { fn: match.fn, ctx: ctx, kind: kind };
  });
}

function findUserProperties_(text) {
  const names = new Set();
  const re = /"vtp_userProperties"\s*:\s*\[([\s\S]{0,1500}?)\]\s*\]?\s*[,}]/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const inner = /"name"\s*,\s*"([A-Za-z_][\w]{0,40})"/g;
    let n;
    while ((n = inner.exec(m[1])) !== null) names.add(n[1]);
  }
  return Array.from(names);
}


// ════════════════════════════════════════════════════════════════════
//  9b. FULL-DETAIL MODES — GTM API and container export
//
//  Both return the same "ContainerVersion" structure:
//    { container, tag[], trigger[], variable[], builtInVariable[], folder[] }
//  with real names, folders, notes, paused flags and consent settings.
// ════════════════════════════════════════════════════════════════════

const TRIGGER_TYPES = {
  pageview: 'Page View',            domReady: 'DOM Ready',
  windowLoaded: 'Window Loaded',    customEvent: 'Custom Event',
  click: 'Click – All Elements',    linkClick: 'Click – Just Links',
  formSubmission: 'Form Submission', timer: 'Timer',
  scrollDepth: 'Scroll Depth',      youTubeVideo: 'YouTube Video',
  elementVisibility: 'Element Visibility', historyChange: 'History Change',
  jsError: 'JavaScript Error',      triggerGroup: 'Trigger Group',
  init: 'Initialization',           consentInit: 'Consent Initialization',
  always: 'Always'
};

const BUILT_IN_TRIGGERS = {
  '2147479553': 'All Pages (built-in)',
  '2147479572': 'Consent Initialization – All Pages (built-in)',
  '2147479573': 'Initialization – All Pages (built-in)'
};

const API_OPS = {
  equals: 'equals', contains: 'contains', matchRegex: 'matches regex',
  startsWith: 'starts with', endsWith: 'ends with', cssSelector: 'matches CSS selector',
  less: '<', lessOrEquals: '≤', greater: '>', greaterOrEquals: '≥'
};

function scanGTMViaApi() {
  runSafely_('GTM API Scan', () => {
    if (typeof TagManager === 'undefined') {
      alert_('🔐 Tag Manager API is not enabled',
        'One-time setup in the Apps Script editor:\n\n' +
        '  1. Click "+" next to Services in the left sidebar\n' +
        '  2. Choose "Tag Manager API" and click Add\n' +
        '  3. Save, then run this menu item again\n\n' +
        'You need at least Read access to the client\'s GTM container.');
      return;
    }
    const ids = promptForGtmIds_('🔐 Scan GTM via API',
      'Enter one or more GTM container IDs, separated by commas.\n' +
      'Your Google account needs at least Read access to each container.');
    if (!ids) return;

    let findings = [];
    ids.forEach(id => {
      toast_('Reading ' + id + ' from the GTM API…', '🔐 GTM API', 60);
      findings = findings.concat(scanContainerViaApi_(id));
    });
    renderFindings_(findings, 'GTM API: ' + ids.join(', '), { showSummary: true });
  });
}

function scanContainerViaApi_(id) {
  let container;
  try {
    container = findContainerByPublicId_(id);
  } catch (e) {
    return [row_('❌ GTM API Error', id, 'GTM API', e.message, 'Check the Tag Manager API service is enabled')];
  }
  if (!container) {
    return [row_('🔒 GTM Container Restricted', id, 'GTM API',
                 'Your Google account has no access to this container',
                 'Ask for Read access, or use Import Container Export')];
  }

  let version;
  try {
    version = gtmCall_(() => TagManager.Accounts.Containers.Versions.live(container.path));
  } catch (e) {
    return [row_('❌ GTM API Error', id, 'GTM API', 'Could not read the live version: ' + e.message,
                 'The container may never have been published')];
  }

  const findings = analyseContainerVersion_(version, {
    publicId: id,
    source: 'GTM API · live version ' + (version.containerVersionId || '?'),
    note: joinParts_(container.accountName && 'Account: ' + container.accountName, 'Full detail from the GTM API')
  });
  return findings.concat(workspaceRows_(container.path, id));
}

/** Finds a container's API path from its public ID (GTM-XXXX), with caching. */
function findContainerByPublicId_(publicId) {
  const props = PropertiesService.getUserProperties();
  const cacheKey = 'gtmContainer:' + publicId;
  const cached = props.getProperty(cacheKey);
  if (cached) {
    try { return JSON.parse(cached); } catch (e) { /* ignore bad cache */ }
  }
  const remember = c => {
    const slim = { path: c.path, name: c.name, publicId: c.publicId, accountName: c.accountName || '' };
    props.setProperty(cacheKey, JSON.stringify(slim));
    return slim;
  };

  // Fast path: direct lookup by tag ID
  try {
    const c = gtmCall_(() => TagManager.Accounts.Containers.lookup({ tagId: publicId }));
    if (c && c.path) return remember(c);
  } catch (e) {
    Logger.log('Container lookup unavailable, scanning accounts: ' + e.message);
  }

  // Slow path: walk every account the user can see
  let token = null;
  do {
    const res = gtmCall_(() => TagManager.Accounts.list(token ? { pageToken: token } : {}));
    const accounts = res.account || [];
    for (let i = 0; i < accounts.length; i++) {
      toast_('Searching account "' + accounts[i].name + '"…', '🔐 GTM API', 30);
      let cToken = null;
      do {
        const cres = gtmCall_(() => TagManager.Accounts.Containers.list(
          accounts[i].path, cToken ? { pageToken: cToken } : {}));
        const match = (cres.container || []).filter(c => c.publicId === publicId)[0];
        if (match) {
          match.accountName = accounts[i].name;
          return remember(match);
        }
        cToken = cres.nextPageToken;
      } while (cToken);
    }
    token = res.nextPageToken;
  } while (token);
  return null;
}

/** Calls the GTM API, retrying with back-off when rate-limited. */
function gtmCall_(fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return fn();
    } catch (e) {
      const retryable = /quota|rate|429|too many|backend error|503|500/i.test(e.message);
      if (!retryable || attempt >= 5) throw e;
      Utilities.sleep(Math.min(32000, 2000 * Math.pow(2, attempt)));
    }
  }
}

function workspaceRows_(containerPath, id) {
  try {
    const workspaces = gtmCall_(() => TagManager.Accounts.Containers.Workspaces.list(containerPath)).workspace || [];
    return workspaces.map(ws => {
      const status  = gtmCall_(() => TagManager.Accounts.Containers.Workspaces.getStatus(ws.path)) || {};
      const changes = status.workspaceChange || [];
      if (!changes.length) {
        return row_('📝 GTM Workspace', ws.name, id, 'No unpublished changes', '');
      }
      const names = changes.map(ch => {
        const kind = Object.keys(ch).filter(k => k !== 'changeStatus')[0] || 'item';
        const item = ch[kind] || {};
        return (ch.changeStatus || 'changed') + ' ' + kind + ' "' + (item.name || '?') + '"';
      });
      recordIssue_('Hygiene', 'Low', 'Workspace "' + ws.name + '" has ' + changes.length + ' unpublished change(s)',
                   'Publish or discard stale workspace changes', id, names, { row: false });
      return row_('📝 GTM Workspace', ws.name, id,
                  changes.length + ' unpublished change(s): ' + truncate_(names.join(', '), 300),
                  joinParts_(status.mergeConflict && status.mergeConflict.length && '⚠️ Has merge conflicts',
                             'Not live until published'));
    });
  } catch (e) {
    return [row_('📝 GTM Workspace', 'Not readable', id, e.message, 'Workspace details need at least Read access')];
  }
}

function importContainerExport() {
  const html = HtmlService.createHtmlOutput(EXPORT_DIALOG_HTML_).setWidth(720).setHeight(520);
  SpreadsheetApp.getUi().showModalDialog(html, '📥 Import GTM Container Export');
}

/** Called from the import dialog via google.script.run — must stay public. */
function processContainerExport(text) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    throw new Error('That is not valid JSON. Use GTM → Admin → Export Container and upload the file as-is.');
  }
  const version = obj.containerVersion || obj;
  if (!version.tag && !version.trigger && !version.variable) {
    throw new Error('No tags, triggers or variables found — is this a GTM container export?');
  }
  const id = (version.container && version.container.publicId) || 'GTM export';
  const findings = analyseContainerVersion_(version, {
    publicId: id,
    source: 'Container export',
    note: 'Full detail from an exported container' +
          (obj.exportTime ? ' (exported ' + obj.exportTime + ')' : '')
  });
  return renderFindings_(findings, 'Export: ' + id).summary;
}

/** Shared analysis for API and export formats. */
function analyseContainerVersion_(version, meta) {
  const id        = (version.container && version.container.publicId) || meta.publicId || 'GTM';
  const tags      = version.tag || [];
  const triggers  = version.trigger || [];
  const variables = version.variable || [];
  const builtIns  = version.builtInVariable || [];
  const folders   = version.folder || [];

  const folderName = {};
  folders.forEach(f => { folderName[f.folderId] = f.name; });
  const triggerById = {};
  triggers.forEach(t => { triggerById[t.triggerId] = t; });
  const varByName = {};
  variables.forEach(v => { varByName[v.name] = v; });
  // Custom templates: tag type "cvt_<container>_<templateId>" → template name + gallery repo
  const templates = version.customTemplate || [];
  const templateNameOf = type => {
    const t = templates.filter(x => x.templateId && new RegExp('_' + x.templateId + '$').test(type || ''))[0];
    if (!t) return null;
    const g = t.galleryReference || {};
    return t.name + (g.owner || g.repository ? ' (' + [g.owner, g.repository].filter(Boolean).join('/') + ')' : '');
  };
  const triggerName = tid => triggerById[tid] ? triggerById[tid].name : (BUILT_IN_TRIGGERS[tid] || 'Trigger ' + tid);
  const withFolder = item => id + (folderName[item.parentFolderId] ? ' · 📁 ' + folderName[item.parentFolderId] : '');

  // Trigger usage and tag sequencing
  const usage = {};
  const use = (tid, label) => { (usage[tid] = usage[tid] || []).push(label); };
  const sequenced = new Set();
  tags.forEach(t => {
    (t.firingTriggerId || []).forEach(tid => use(tid, t.name));
    (t.blockingTriggerId || []).forEach(tid => use(tid, t.name + ' (blocking)'));
    [].concat(t.setupTag || [], t.teardownTag || []).forEach(s => sequenced.add(s.tagName));
  });
  triggers.filter(t => t.type === 'triggerGroup').forEach(g => {
    apiTriggerRefs_(g.parameter).forEach(tid => use(tid, 'group "' + g.name + '"'));
  });

  const text = JSON.stringify(version);
  const pausedCount = tags.filter(t => t.paused).length;
  const out = [];

  out.push(row_('🏷️ GTM Container', id, meta.source, joinParts_(
    (version.container && version.container.name) || '',
    'Version ' + (version.containerVersionId || '?') + (version.name ? ' "' + version.name + '"' : ''),
    tags.length + ' tags (' + pausedCount + ' paused)',
    triggers.length + ' triggers', variables.length + ' variables', folders.length + ' folders'
  ), meta.note || ''));

  uniqueMatches_(text, ID_PATTERNS.GA4).forEach(ga => out.push(row_(
    '📊 GA4 ID in GTM', ga, id, 'GA4 measurement ID configured in this container',
    'Check it matches your GA4 data stream')));
  uniqueMatches_(text, /\bAW-\d{7,12}\b/g).forEach(aw => out.push(row_(
    '🎯 Google Ads ID in GTM', aw, id, 'Google Ads account ID configured in this container', '')));

  // Full trigger description (with data-layer keys) for consent-gate detection
  const resolveVars = s => String(s).replace(/\{\{([^}]+)\}\}/g, (m, n) => {
    const v = varByName[n];
    const key = v && v.type === 'v' ? apiAdapter_(v.parameter, varByName).get('name') : null;
    return key ? m + '[' + key + ']' : m;
  });
  const triggerText = tid => {
    const t = triggerById[tid];
    if (!t) return triggerName(tid);
    const r = describeApiTrigger_(t, '', []);
    return resolveVars(t.name + ' ' + r[3]);
  };

  AUDIT.fullDetail = true;
  if (consentDefaultIn_(text)) AUDIT.consentMode.defaultViaGtm = true;
  if (/ads_data_redaction/.test(text)) AUDIT.consentMode.redaction = true;
  if (/url_passthrough/.test(text)) AUDIT.consentMode.passthrough = true;

  tags.forEach(t => {
    const p = apiAdapter_(t.parameter, varByName);
    const cs = t.consentSettings || {};
    out.push(buildTagRow_({
      def: tagDef_(t.type), p: p, type: t.type, name: t.name,
      templateName: /^cvt_/.test(t.type || '') ? templateNameOf(t.type) : null,
      paused: !!t.paused, tagNumber: t.tagId, source: id, folder: folderName[t.parentFolderId],
      firesOn: (t.firingTriggerId || []).map(triggerName),
      blockedBy: (t.blockingTriggerId || []).map(triggerName),
      gateText: (t.firingTriggerId || []).concat(t.blockingTriggerId || []).map(triggerText).join(' | '),
      additionalChecks: cs.consentStatus === 'needed' ? renderApiParam_(cs.consentType).split(/,\s*/).filter(Boolean) : [],
      consentNotNeeded: cs.consentStatus === 'notNeeded',
      sequenced: sequenced.has(t.name),
      consent: describeConsentSettings_(t.consentSettings),
      sequence: describeSequence_(t),
      notes: t.notes
    }));
    if (t.type === 'googtag' || t.type === 'gaawc') {
      settingRows_(p.pairs('configSettingsTable').concat(p.pairs('fieldsToSet')), id + ' · ' + t.name)
        .forEach(r => out.push(r));
    }
  });

  triggers.forEach(t => out.push(describeApiTrigger_(t, withFolder(t), usage[t.triggerId] || [])));

  const refsText = JSON.stringify([tags, triggers, variables]);
  let unusedVars = 0;
  variables.forEach(v => {
    const p = apiAdapter_(v.parameter, varByName);
    const refs = refsText.split('{{' + v.name + '}}').length - 1;
    if (!refs) unusedVars++;
    out.push(row_('📐 GTM Variable', v.name, withFolder(v),
                  joinParts_(varTypeLabel_(v.type), variableKeyInfo_(v.type, p)),
                  refs ? 'Referenced ' + refs + ' time(s)' : '⚠️ Not referenced anywhere — candidate for removal'));
  });
  if (builtIns.length) {
    out.push(row_('📐 GTM Variable', 'Built-in variables', id, builtIns.map(b => b.name).join(', '),
                  builtIns.length + ' built-in variables enabled'));
  }

  // Housekeeping only visible with full detail (tag-level checks run in runAuditChecks_)
  const namesOf = arr => arr.map(x => x.name);
  const unusedTriggers = triggers.filter(t => !(usage[t.triggerId] || []).length);
  if (unusedTriggers.length) {
    recordIssue_('Hygiene', 'Low', unusedTriggers.length + ' unused trigger(s)',
                 'Delete triggers that no tag uses', id, namesOf(unusedTriggers));
  }
  if (unusedVars) {
    recordIssue_('Hygiene', 'Low', unusedVars + ' unreferenced variable(s)',
                 'Delete variables that nothing references', id,
                 variables.filter(v => refsText.split('{{' + v.name + '}}').length === 1).map(v => v.name));
  }
  if (folders.length) {
    const loose = tags.filter(t => !t.parentFolderId);
    if (loose.length) {
      recordIssue_('Hygiene', 'Low', loose.length + ' tag(s) not in a folder',
                   'File every tag in a folder (e.g. by vendor or purpose)', id, namesOf(loose));
    }
  }
  const pattern = readClientSettings_().namingPattern || /\S\s[-–|:]\s\S/;
  if (readClientSettings_().namingPattern) {
    const off = tags.filter(t => !pattern.test(t.name || ''));
    if (off.length) {
      recordIssue_('Hygiene', 'Low', off.length + ' tag name(s) do not follow the naming convention',
                   'Rename them to match the pattern in Client Settings', id, namesOf(off));
    }
  } else if (tags.length >= 5) {
    const conventional = tags.filter(t => pattern.test(t.name || '')).length;
    if (conventional / tags.length < 0.7) {
      recordIssue_('Hygiene', 'Low', 'Inconsistent tag naming (' + conventional + ' of ' + tags.length + ' follow a pattern)',
                   'Adopt a naming convention such as "Platform - Type - Detail"', id,
                   namesOf(tags.filter(t => !/\S\s[-–|:]\s\S/.test(t.name || ''))));
    }
  }

  // Consent Mode is skipped here: tag-level consent settings are not Consent Mode defaults
  return out.concat(
    findVendors_(JSON.stringify(tags), id),
    findCrossDomain_(text, id),
    findPaymentDomains_(text, id),
    findEcommerce_(text, id)
  );
}

/** Adapter over API / export parameters ([{type, key, value, list, map}]). */
function apiAdapter_(params, varByName) {
  const find = key => (params || []).filter(p => p.key === key)[0];
  const adapter = {
    get: key => {
      const s = renderApiParam_(find(key));
      if (s === '') return null;
      // Show constants by value: {{GA4 ID}} → G-XXXX ({{GA4 ID}})
      const ref = /^\{\{(.+)\}\}$/.exec(s);
      const v = ref && varByName[ref[1]];
      if (v && v.type === 'c') {
        const value = renderApiParam_((v.parameter || []).filter(p => p.key === 'value')[0]);
        if (value) return value + ' (' + s + ')';
      }
      return s;
    },
    pairs: key => {
      const p = find(key);
      if (!p || p.type !== 'list') return [];
      return (p.list || []).filter(i => i.type === 'map').map(i => {
        const o = {};
        (i.map || []).forEach(e => { o[e.key] = e; });
        return toPair_(o, renderApiParam_);
      }).filter(Boolean);
    },
    fromVariable: (key, sub) => {
      const m = /^\{\{(.+)\}\}$/.exec(adapter.get(key) || '');
      const v = m && varByName[m[1]];
      return v ? apiAdapter_(v.parameter, varByName).get(sub) : null;
    },
    allText: () => JSON.stringify(params || [])
  };
  return adapter;
}

function renderApiParam_(p) {
  if (!p) return '';
  if (p.type === 'list') return (p.list || []).map(renderApiParam_).filter(Boolean).join(', ');
  if (p.type === 'map') {
    const o = {};
    (p.map || []).forEach(e => { o[e.key] = e; });
    const pair = toPair_(o, renderApiParam_);
    if (pair) return pair.k + '=' + pair.v;
    return (p.map || []).map(e => e.key + '=' + renderApiParam_(e)).join('; ');
  }
  return p.value == null ? '' : String(p.value);
}

function apiTriggerRefs_(params) {
  const ids = [];
  const walk = p => {
    if (!p) return;
    if (p.type === 'triggerReference' && p.value) ids.push(p.value);
    (p.list || []).forEach(walk);
    (p.map || []).forEach(walk);
  };
  (params || []).forEach(walk);
  return ids;
}

function describeApiTrigger_(t, source, users) {
  const conds = (t.filter || []).concat(t.autoEventFilter || []).map(describeApiCondition_);
  let label = TRIGGER_TYPES[t.type] || t.type;
  if (t.type === 'customEvent') {
    const f = (t.customEventFilter || [])[0];
    const name = f ? apiCondArg_(f, 'arg1') : '';
    label = f && f.type === 'matchRegex' ? 'Custom Event matching /' + name + '/' : 'Custom Event "' + name + '"';
  }
  if (t.type === 'triggerGroup') label += ' (' + apiTriggerRefs_(t.parameter).length + ' triggers)';
  const notes = users.length
    ? 'Used by ' + users.length + ': ' + truncate_(users.join(', '), 200)
    : '⚠️ Not used by any tag — candidate for removal';
  return row_('⚡ GTM Trigger', t.name, source,
              joinParts_(label, conds.length && 'When ' + conds.join(' & ')), notes);
}

function apiCondArg_(c, key) {
  return renderApiParam_((c.parameter || []).filter(p => p.key === key)[0]);
}

function describeApiCondition_(c) {
  const negate = apiCondArg_(c, 'negate') === 'true';
  return apiCondArg_(c, 'arg0') + ' ' + (negate ? 'NOT ' : '') + (API_OPS[c.type] || c.type) +
         ' "' + truncate_(apiCondArg_(c, 'arg1'), 60) + '"';
}

function describeConsentSettings_(cs) {
  if (!cs || !cs.consentStatus || cs.consentStatus === 'notSet') return '';
  if (cs.consentStatus === 'notNeeded') return 'Consent: no additional checks needed';
  return 'Consent: requires ' + (renderApiParam_(cs.consentType) || 'consent');
}

function describeSequence_(t) {
  return joinParts_(
    (t.setupTag || []).length && 'Setup tag: ' + t.setupTag.map(s => s.tagName).join(', '),
    (t.teardownTag || []).length && 'Cleanup tag: ' + t.teardownTag.map(s => s.tagName).join(', '));
}

function settingRows_(pairs, source) {
  return pairs.map(x => {
    const s = GA_SETTINGS.filter(g => g.key === x.k)[0];
    const viaVariable = /^\{\{.*\}\}$/.test(x.v);
    if (s) {
      return row_(s.type, x.v, source,
                  viaVariable ? 'Value comes from GTM variable ' + x.v : s.describe(x.v),
                  s.note || 'Parameter: ' + s.key);
    }
    return row_('⚙️ GA4 Tag Setting', x.k + ' = ' + truncate_(x.v, 80), source,
                'Google tag configuration parameter', '');
  });
}

function varTypeLabel_(type) {
  return GTM_VARIABLES['__' + type] || (/^cvt_/.test(type) ? 'Custom Template' : type);
}

function variableKeyInfo_(type, p) {
  switch (type) {
    case 'v':    return p.get('name') && 'Key: ' + p.get('name');
    case 'c':    return 'Value: ' + truncate_(p.get('value') || '', 80);
    case 'k':    return p.get('name') && 'Cookie: ' + p.get('name');
    case 'j':    return p.get('name') && 'Global: ' + p.get('name');
    case 'u':    return 'Component: ' + (p.get('component') || 'URL');
    case 'aev':  return p.get('varType') && 'Type: ' + p.get('varType');
    case 'gas':  return p.get('trackingId') && 'Tracking ID: ' + p.get('trackingId');
    case 'smm':
    case 'remm': return 'Input: ' + (p.get('input') || '?') + ' (' + p.pairs('map').length + ' rows)';
    case 'gtcs':
    case 'gtes': return settingsSummary_(p.pairs('configSettingsTable').concat(p.pairs('eventSettingsTable')));
    case 'd':    return p.get('elementId') && 'Element: ' + p.get('elementId');
    default:     return null;
  }
}

function promptForGtmIds_(title, intro) {
  const ui = SpreadsheetApp.getUi();
  const response = ui.prompt(title, intro + '\nExample: GTM-XXXXXX, GTM-YYYYYY', ui.ButtonSet.OK_CANCEL);
  if (response.getSelectedButton() !== ui.Button.OK) return null;
  const ids = uniqueMatches_(response.getResponseText().toUpperCase(), ID_PATTERNS.GTM);
  if (ids.length === 0) {
    alert_('❌ No valid GTM IDs found', 'The format is GTM- followed by 4–10 letters or numbers, e.g. GTM-K2JL4P');
    return null;
  }
  return ids;
}


// ════════════════════════════════════════════════════════════════════
//  9c. AUDIT ENGINE
//
//  Scans fill AUDIT as they run (one Apps Script execution = one scan,
//  so it starts empty every time). runAuditChecks_() then assesses
//  consent per tag, runs the cross-cutting checks and writes the
//  "Audit Summary" and "Consent Matrix" tabs.
// ════════════════════════════════════════════════════════════════════

const AUDIT = {
  tags: [],                 // one record per GTM tag (see recordTag_)
  issues: [],               // { area, severity, finding, action, where, items, row }
  ga4Events: [],            // { name, params[], where }
  googleTags: [],           // GA4 Google tags in GTM: { id, sendPageView, paused, where }
  pageGoogleConfigs: [],    // gtag('config', …) calls on the page
  externalHosts: {},        // host → [tag labels]
  consentMode: { defaultOnPage: false, defaultViaGtm: false, v2: false, redaction: false, passthrough: false },
  ids: {},                  // platform|id → { platform, id, kind, tags[], where[], live }
  userProps: new Set(),     // GA4 user properties set in GTM
  currencies: [],           // ecommerce currency codes seen
  paymentDomains: [],       // payment providers referenced
  extraRows: [],            // extra rows for the results sheet (e.g. GA4 property info)
  pageScanned: false,
  fullDetail: false,
  ga4PropertyChecked: false
};

const AREAS = ['Consent', 'Security', 'GA4 Setup', 'GA4 Property', 'Ads Setup', 'Accounts & IDs',
               'Legacy', 'Hygiene', 'Third Parties'];
const SEVERITY_ORDER = { High: 0, Medium: 1, Low: 2 };

// OneTrust default category IDs (sites can rename them — check the CMP)
const ONETRUST_GROUPS = {
  C0001: 'Strictly Necessary', C0002: 'Performance', C0003: 'Functional',
  C0004: 'Targeting', C0005: 'Social Media'
};

const TAG_PURPOSE = {
  googtag: 'analytics', gaawc: 'analytics', gaawe: 'analytics', ua: 'analytics', opt: 'analytics',
  hjtc: 'analytics',
  awct: 'advertising', sp: 'advertising', gclidw: 'advertising', flc: 'advertising',
  fls: 'advertising', baut: 'advertising', bzi: 'advertising'
};

// Google tags with built-in consent checks (they react to Consent Mode)
const GOOGLE_CONSENT_AWARE = new Set(['googtag', 'gaawc', 'gaawe', 'ua', 'awct', 'sp', 'gclidw', 'flc', 'fls']);

const EXPECTED_CONSENT = {
  advertising: 'ad_storage (+ ad_user_data, ad_personalization) · OneTrust C0004 Targeting · Cookiebot marketing',
  analytics:   'analytics_storage · OneTrust C0002 Performance · Cookiebot statistics',
  functional:  'functionality_storage · OneTrust C0003 Functional · Cookiebot preferences',
  necessary:   'None (strictly necessary)',
  unknown:     'Depends on what the code does'
};

const GA4_RESERVED_EVENTS = new Set([
  'ad_activeview', 'ad_click', 'ad_exposure', 'ad_impression', 'ad_query', 'ad_reward',
  'adunit_exposure', 'app_background', 'app_clear_data', 'app_exception', 'app_install',
  'app_remove', 'app_store_refund', 'app_update', 'app_upgrade', 'dynamic_link_app_open',
  'dynamic_link_app_update', 'dynamic_link_first_open', 'error', 'first_open', 'first_visit',
  'in_app_purchase', 'notification_dismiss', 'notification_foreground', 'notification_open',
  'notification_receive', 'notification_send', 'os_update', 'screen_view', 'session_start',
  'user_engagement'
]);
const GA4_RESERVED_PREFIX = /^(_|firebase_|ga_|google_|gtag\.)/;

function recordIssue_(area, severity, finding, action, where, items, opts) {
  AUDIT.issues.push({
    area: area, severity: severity, finding: finding, action: action,
    where: where || '', items: items || [], row: !(opts && opts.row === false)
  });
}

/** Called by buildTagRow_ for every tag in every mode. */
function recordTag_(o, label, summary, source, group) {
  let text = '';
  try { text = o.p.allText(); } catch (e) { /* ignore */ }
  const vendorEntry = vendorInfo_(text) || (group && group.vendorEntry) || null;
  const vendor = vendorEntry ? vendorEntry[0] : null;
  const purpose = vendorEntry ? vendorEntry[2] : (TAG_PURPOSE[o.type] || 'unknown');

  const rec = {
    label: label, summary: summary, where: source, type: o.type || '',
    platform: group ? group.label.replace(/^\S+\s/, '').replace(/ Tags.*$/, '') : '',
    vendor: vendor, purpose: purpose, paused: !!o.paused, named: !!o.name,
    firesOn: o.firesOn || [], blockedBy: o.blockedBy || [],
    gateText: o.gateText || (o.firesOn || []).concat(o.blockedBy || []).join(' | '),
    additionalChecks: o.additionalChecks || [], consentNotNeeded: !!o.consentNotNeeded,
    noTrigger: !!(o.firesOn && !o.firesOn.length && !o.paused && !o.sequenced),
    text: String(text).substring(0, 30000)
  };
  AUDIT.tags.push(rec);

  // IDs (pixel / account / measurement) for the ID Inventory
  collectIds_(text + ' ' + summary, rec.platform, source, label, !o.paused);
  const nameId = rec.platform === 'Meta' && /\b(\d{15,16})\b/.exec(label);
  if (nameId) addId_('Meta', nameId[1], 'Pixel ID', source, label, !o.paused);
  try {
    o.p.pairs('userProperties').forEach(x => { if (!/\{\{/.test(x.k)) AUDIT.userProps.add(x.k); });
  } catch (e) { /* ignore */ }

  // GA4 data for double-counting and naming checks
  if (!o.paused && (o.type === 'googtag' || o.type === 'gaawc')) {
    const id = ((o.p.get('tagId') || o.p.get('measurementId') || '').match(/G-[A-Z0-9]{4,20}/) || [])[0];
    const spv = o.p.pairs('configSettingsTable').concat(o.p.pairs('fieldsToSet'))
                 .filter(x => x.k === 'send_page_view')[0];
    if (id) AUDIT.googleTags.push({ id: id, sendPageView: !spv || spv.v !== 'false', where: source, label: label });
  }
  if (o.type === 'gaawe' && !o.paused) {
    const name = o.p.get('eventName');
    const params = o.p.pairs('eventSettingsTable').concat(o.p.pairs('eventParameters')).map(x => x.k);
    if (name) AUDIT.ga4Events.push({ name: name, params: params, where: source + (o.name ? ' · ' + o.name : '') });
  }

  // Custom HTML / template security
  if (!o.paused && (o.type === 'html' || /^cvt_/.test(o.type || ''))) {
    checkCodeSecurity_(o.type === 'html' ? (o.p.get('html') || '') : text, label, source);
  }
}

function checkCodeSecurity_(code, label, where) {
  const plain = unescapeJs_(code);
  const where2 = where + ' · ' + truncate_(label, 60);

  const secret = /(api[_-]?key|api[_-]?token|apitoken|access[_-]?token|auth[_-]?token|client[_-]?secret|secret|password|bearer)["']?\s*[:=]\s*["']([A-Za-z0-9_\-.]{12,})["']/i.exec(plain);
  if (secret) {
    recordIssue_('Security', 'High', 'Hard-coded credential in a tag (' + secret[1] + ' = ' + maskSecret_(secret[2]) + ')',
                 'Check whether it is a private key; if so rotate it and remove it from GTM (anyone can read published tags)',
                 where2);
  }
  if (/\beval\s*\(|new\s+Function\s*\(/.test(plain)) {
    recordIssue_('Security', 'Medium', 'Tag runs dynamic code (eval / new Function)',
                 'Review the code; dynamic code execution makes tags harder to audit and easier to abuse', where2);
  }
  if (/document\.write\s*\(/.test(plain)) {
    recordIssue_('Security', 'Low', 'Tag uses document.write',
                 'Replace document.write — it blocks rendering and is ignored by some browsers after page load', where2);
  }
  if (/<script[^>]+src=["']http:\/\//i.test(plain)) {
    recordIssue_('Security', 'Medium', 'Tag loads a script over plain http://',
                 'Load scripts over https:// only', where2);
  }
  loadedHosts_(plain).forEach(h => {
    (AUDIT.externalHosts[h] = AUDIT.externalHosts[h] || []).push(label);
  });
}

function vendorInfo_(text) {
  const normalised = unescapeJs_(text || '');
  return VENDORS.filter(v => v[1].test(normalised))[0] || null;
}

/** Looks for consent defaults set from GTM (e.g. a CMP or Consent Mode template). */
function consentDefaultIn_(text) {
  return /setDefaultConsentState|(ad_storage|analytics_storage)["']?\s*[:,]\s*(?:"value"\s*:\s*)?["'](denied|granted)/.test(text);
}

/** Detects consent gating in trigger conditions: OneTrust, Cookiebot, generic. */
function detectConsentGate_(text) {
  if (!text) return null;
  if (/onetrust|optanon/i.test(text)) {
    const cats = uniqueMatches_(text, /\bC\d{4}\b/g);
    return {
      cmp: 'OneTrust', categories: cats,
      label: cats.length ? 'OneTrust: ' + cats.map(c => c + (ONETRUST_GROUPS[c] ? ' ' + ONETRUST_GROUPS[c] : '')).join(', ')
                         : 'OneTrust event (no category check)'
    };
  }
  if (/cookiebot|cookie_consent_|CookieConsent/i.test(text)) {
    const cats = uniqueMatches_(text.toLowerCase(), /\b(marketing|statistics|preferences|necessary)\b/g);
    return { cmp: 'Cookiebot', categories: cats,
             label: cats.length ? 'Cookiebot: ' + cats.join(', ') : 'Cookiebot event (no category check)' };
  }
  const m = text.match(/\b(ad_storage|analytics_storage|consent\w*|marketing|statistics|targeting)\b/i);
  return m ? { cmp: 'Custom', categories: [m[1].toLowerCase()], label: 'Consent condition (' + m[1] + ')' } : null;
}

function gateMatchesPurpose_(gate, purpose) {
  const S = readClientSettings_();
  const cats = gate.categories.join(' ').toLowerCase();
  const any = (list, words) => list.concat(words).some(w => w && cats.indexOf(String(w).toLowerCase()) >= 0);
  if (purpose === 'advertising') return any(S.adsCats, ['marketing', 'ad_storage', 'targeting']);
  if (purpose === 'analytics')   return any(S.analyticsCats, ['statistics', 'analytics_storage', 'performance']);
  if (purpose === 'functional')  return any(S.functionalCats, ['preferences', 'functionality']);
  return cats.length > 0;
}

/** Fills rec.risk / rec.handling / rec.recommendation. */
function assessConsent_(rec) {
  const gate = detectConsentGate_(rec.gateText);
  const google = GOOGLE_CONSENT_AWARE.has(rec.type);
  const handling = [];
  if (google) handling.push('Built-in Consent Mode checks');
  if (rec.additionalChecks.length) handling.push('Additional checks: ' + rec.additionalChecks.join(', '));
  if (gate) handling.push('Trigger: ' + gate.label);
  if (rec.consentNotNeeded) handling.push('Marked "no additional consent required"');
  rec.handling = handling.join(' | ') || 'None found';
  rec.expected = EXPECTED_CONSENT[rec.purpose] || EXPECTED_CONSENT.unknown;

  const set = (risk, recommendation) => { rec.risk = risk; rec.recommendation = recommendation; };
  const modeSeen = AUDIT.consentMode.defaultOnPage || AUDIT.consentMode.defaultViaGtm;
  const checksMatch = rec.additionalChecks.length &&
    gateMatchesPurpose_({ categories: rec.additionalChecks }, rec.purpose);

  if (rec.paused) return set('—', 'Paused — delete if no longer needed');
  if (rec.purpose === 'necessary') return set('OK', 'Consent platform / necessary');
  if (checksMatch) return set('OK', 'Additional consent checks match its purpose');
  if (gate && gateMatchesPurpose_(gate, rec.purpose)) return set('OK', 'Gated by the right consent category');

  if (google) {
    if (modeSeen) return set('OK', 'Relies on Consent Mode — verify defaults are "denied" before consent');
    if (AUDIT.pageScanned) {
      return set(rec.purpose === 'advertising' ? 'High' : 'Medium',
                 'No Consent Mode default found — set defaults (denied) before Google tags load');
    }
    return set('Check', 'Relies on Consent Mode — confirm the site sets consent defaults');
  }
  if (gate) {
    return set('Medium', gate.categories.length
      ? 'Gated by ' + gate.label + ' — expected ' + rec.expected.split(' · ')[1]
      : 'Fires on a CMP event but does not check the consent category');
  }
  if (rec.additionalChecks.length) {
    return set('Medium', 'Consent checks (' + rec.additionalChecks.join(', ') + ') do not match its purpose (' + rec.purpose + ')');
  }
  if (rec.purpose === 'unknown') {
    return set('Medium', 'Custom code with no consent gating — check what it does and gate it if it tracks users');
  }
  if (rec.purpose === 'functional') {
    return set('Medium', 'Functional tag with no consent gating — fine if strictly needed for a feature the visitor asked for; otherwise gate it on preferences consent');
  }
  if (rec.purpose === 'analytics' && !readClientSettings_().analyticsConsent) {
    return set('Check', 'No consent gating — allowed by Client Settings (analytics does not need consent); confirm with legal');
  }
  return set('High', (rec.consentNotNeeded ? 'Marked as not needing consent, but this is an ' : 'No consent gating on this ') +
                     rec.purpose + ' tag — add a consent trigger condition or Additional Consent Checks');
}

/** Runs every cross-cutting check. Returns rows for the main results sheet. */
function runAuditChecks_() {
  const live = AUDIT.tags.filter(t => !t.paused);

  // ── Consent ──
  AUDIT.tags.forEach(assessConsent_);
  const byRisk = r => live.filter(t => t.risk === r);
  const highs = byRisk('High'), mediums = byRisk('Medium');
  if (highs.length) {
    recordIssue_('Consent', 'High', highs.length + ' tag(s) may fire without consent',
                 'Gate each tag on the right consent category (see Consent Matrix)', 'GTM',
                 highs.map(t => t.label));
  }
  if (mediums.length) {
    recordIssue_('Consent', 'Medium', mediums.length + ' tag(s) with incomplete consent gating',
                 'Check the category each tag waits for (see Consent Matrix)', 'GTM',
                 mediums.map(t => t.label));
  }
  if (AUDIT.pageScanned && !AUDIT.consentMode.defaultOnPage && !AUDIT.consentMode.defaultViaGtm) {
    recordIssue_('Consent', 'High', 'No Consent Mode default found (page or GTM)',
                 'Set gtag("consent","default",{…denied}) or use a CMP template in GTM before any tag fires',
                 'Page source');
  } else if (AUDIT.pageScanned && AUDIT.consentMode.defaultOnPage && !AUDIT.consentMode.v2) {
    recordIssue_('Consent', 'Medium', 'Consent Mode v1 only (ad_user_data / ad_personalization missing)',
                 'Upgrade to Consent Mode v2 for EEA/UK traffic', 'Page source', null, { row: false });
  }

  // ── GA4 setup ──
  AUDIT.pageGoogleConfigs.filter(c => /^G-/.test(c.id) && c.sendPageView).forEach(c => {
    const inGtm = AUDIT.googleTags.filter(g => g.id === c.id && g.sendPageView);
    if (inGtm.length) {
      recordIssue_('GA4 Setup', 'High', c.id + ' is configured on the page AND in GTM',
                   'Page views may be counted twice — keep one Google tag for this ID',
                   'Page source + ' + inGtm[0].where, inGtm.map(g => g.label));
    }
  });
  const idCounts = countBy_(AUDIT.googleTags, g => g.id).filter(c => c.count > 1);
  idCounts.forEach(c => recordIssue_('GA4 Setup', 'Medium', c.count + ' Google tags in GTM for ' + c.key,
    'Make sure they never fire on the same page, or merge them', 'GTM',
    AUDIT.googleTags.filter(g => g.id === c.key).map(g => g.label)));
  if (!AUDIT.googleTags.length && !AUDIT.pageGoogleConfigs.some(c => /^G-/.test(c.id)) &&
      (AUDIT.tags.length || AUDIT.pageScanned)) {
    recordIssue_('GA4 Setup', 'Medium', 'No GA4 Google tag found',
                 'Check how GA4 is deployed (it may be server-side or set up elsewhere)', '');
  }
  checkGa4Naming_();

  // ── Legacy & hygiene from tag records ──
  const ua = live.filter(t => t.type === 'ua'), opt = live.filter(t => t.type === 'opt');
  if (ua.length) recordIssue_('Legacy', 'Medium', ua.length + ' Universal Analytics tag(s) still live',
    'UA stopped processing data in July 2024 — delete these tags', 'GTM', ua.map(t => t.label));
  if (opt.length) recordIssue_('Legacy', 'Medium', opt.length + ' Google Optimize tag(s) still live',
    'Optimize was shut down in September 2023 — delete these tags', 'GTM', opt.map(t => t.label));
  const paused = AUDIT.tags.filter(t => t.paused);
  if (paused.length) recordIssue_('Hygiene', 'Low', paused.length + ' paused tag(s)',
    'Delete paused tags that are no longer needed', 'GTM', paused.map(t => t.label));
  const orphan = live.filter(t => t.noTrigger);
  if (orphan.length) recordIssue_('Hygiene', 'Medium', orphan.length + ' tag(s) without a firing trigger',
    'These never fire — fix or delete them', 'GTM', orphan.map(t => t.label));

  // ── Third parties (information) ──
  const hosts = Object.keys(AUDIT.externalHosts);
  if (hosts.length) {
    recordIssue_('Third Parties', 'Low', 'Custom code loads from ' + hosts.length + ' external domain(s)',
                 'Confirm each vendor is approved and listed in the cookie policy', 'GTM', hosts);
  }

  runBestPracticeChecks_();
  checkIds_();
  runGa4PropertyChecks_();
  liveTestIssues_();

  return AUDIT.issues.filter(i => i.row).map(i => row_(
    '⚠️ Audit Warning', i.finding, i.where || i.area,
    i.items.length ? truncate_(i.items.join(', '), 300) : '', i.severity + ' · ' + i.action))
    .concat(AUDIT.extraRows);
}

function checkGa4Naming_() {
  const problems = { Medium: [], Low: [] };
  const dynamic = [];
  const seen = new Set();
  AUDIT.ga4Events.forEach(e => {
    const name = String(e.name).replace(/\s\(\{\{[^}]*\}\}\)$/, '');
    if (seen.has(name)) return;
    seen.add(name);
    if (/\{\{/.test(name)) { dynamic.push(name); return; }

    const issues = [];
    if (name.length > 40) issues.push(['Medium', 'over 40 characters']);
    if (GA4_RESERVED_PREFIX.test(name)) issues.push(['Medium', 'reserved prefix']);
    if (GA4_RESERVED_EVENTS.has(name)) issues.push(['Medium', 'reserved event name']);
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) issues.push(['Medium', 'spaces or special characters']);
    else if (/[A-Z]/.test(name)) issues.push(['Low', 'not lowercase snake_case']);
    if (e.params.length > 25) issues.push(['Medium', e.params.length + ' parameters (limit 25)']);
    e.params.forEach(pn => {
      if (pn.length > 40) issues.push(['Medium', 'parameter "' + pn + '" over 40 characters']);
      else if (GA4_RESERVED_PREFIX.test(pn)) issues.push(['Medium', 'parameter "' + pn + '" uses a reserved prefix']);
    });
    issues.forEach(i => problems[i[0]].push(name + ' (' + i[1] + ')'));
  });

  if (problems.Medium.length) {
    recordIssue_('GA4 Setup', 'Medium', problems.Medium.length + ' GA4 event naming problem(s)',
                 'Rename them — GA4 may reject or mis-report these events', 'GA4 events', problems.Medium);
  }
  if (problems.Low.length) {
    recordIssue_('GA4 Setup', 'Low', problems.Low.length + ' GA4 event name(s) not in snake_case',
                 'GA4 is case-sensitive — use lowercase_with_underscores consistently', 'GA4 events', problems.Low);
  }
  if (dynamic.length) {
    recordIssue_('GA4 Setup', 'Low', dynamic.length + ' dynamic GA4 event name(s)',
                 'Names are built from variables — check the real values in GA4 DebugView', 'GA4 events', dynamic);
  }
}


// ── Audit tabs ──────────────────────────────────────────────────────

function writeAuditTabs_(label) {
  try {
    writeAuditSummary_(label);
    if (AUDIT.tags.length) writeConsentMatrix_(label);
    writeIdInventory_(label);
  } catch (e) {
    Logger.log('Writing audit tabs failed: ' + e.stack);
  }
}

function getOrCreateSheet_(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  sheet.clear();
  try { sheet.getRange(1, 1, sheet.getMaxRows(), sheet.getMaxColumns()).breakApart(); } catch (e) { /* none */ }
  return sheet;
}

const RISK_COLORS = { High: '#ffcdd2', Medium: '#fff3cd', Check: '#e3f2fd', OK: '#e8f5e9', '—': '#eeeeee' };
const SEVERITY_COLORS = { High: '#ffcdd2', Medium: '#fff3cd', Low: '#e3f2fd' };

function writeConsentMatrix_(label) {
  const sheet = getOrCreateSheet_(CONFIG.MATRIX_NAME);
  const n = 9;
  const order = { High: 0, Medium: 1, Check: 2, OK: 3, '—': 4 };
  const recs = AUDIT.tags.slice().sort((a, b) => (order[a.risk] - order[b.risk]) || a.label.localeCompare(b.label));
  const count = r => recs.filter(t => t.risk === r).length;
  const cm = AUDIT.consentMode;
  const modeText = cm.defaultOnPage ? 'Consent Mode default on page' + (cm.v2 ? ' (v2)' : ' (v1)')
    : cm.defaultViaGtm ? 'Consent Mode default set from GTM'
    : AUDIT.pageScanned ? '⚠️ No Consent Mode default found' : 'Page not scanned — Consent Mode defaults not checked';

  const values = [
    ['🛡️ Consent Matrix — ' + label, '', '', '', '', '', '', '', ''],
    ['🔴 High: ' + count('High') + '   🟡 Medium: ' + count('Medium') + '   🔵 Check: ' + count('Check') +
       '   🟢 OK: ' + count('OK') + '   ⏸️ Paused: ' + count('—'), '', '', '', modeText, '', '', '', ''],
    ['Risk', 'Tag', 'Container / Location', 'Type / Vendor', 'Purpose', 'Fires on',
     'Consent handling found', 'Expected consent', 'Recommendation']
  ];
  const bgs = [fill_(CONFIG.HEADER_COLOR, n), fill_('#f1f3f4', n), fill_('#34495e', n)];

  recs.forEach(t => {
    const fires = t.firesOn.length ? t.firesOn.join(' OR ') : (t.noTrigger ? 'No trigger' : '');
    values.push([
      t.risk, t.label, t.where,
      joinParts_(t.named ? t.summary : t.summary.split(':')[0], t.vendor && t.summary.indexOf(t.vendor) < 0 ? t.vendor : null),
      t.purpose, truncate_(fires + (t.blockedBy.length ? ' | Blocked by: ' + t.blockedBy.join(' OR ') : ''), 300),
      t.handling, t.expected, t.recommendation
    ].map(safeCell_));
    bgs.push(fill_(RISK_COLORS[t.risk] || '#ffffff', n));
  });

  [70, 260, 200, 200, 95, 300, 260, 230, 320].forEach((w, i) => sheet.setColumnWidth(i + 1, w));
  sheet.getRange(1, 1, values.length, n).setValues(values).setBackgrounds(bgs)
    .setWrap(true).setVerticalAlignment('top').setFontSize(9);
  sheet.getRange(1, 1, 1, n).setFontColor('#ffffff').setFontSize(13).setFontWeight('bold').setWrap(false);
  sheet.getRange(2, 1, 1, n).setFontWeight('bold').setWrap(false);
  sheet.getRange(3, 1, 1, n).setFontColor('#ffffff').setFontWeight('bold');
  if (values.length > 3) sheet.getRange(4, 1, values.length - 3, 2).setFontWeight('bold');
  sheet.setFrozenRows(3);
  sheet.setRowHeight(1, 36);
}

function writeAuditSummary_(label) {
  const sheet = getOrCreateSheet_(CONFIG.SUMMARY_NAME);
  const n = 6;
  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  const values = [], bgs = [], bold = [];
  const add = (row, bg, isBold) => {
    const r = row.slice(0, n);
    while (r.length < n) r.push('');
    values.push(r.map(safeCell_)); bgs.push(fill_(bg, n)); bold.push(!!isBold);
  };

  const issues = AUDIT.issues.slice().sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  const counts = s => issues.filter(i => i.severity === s).length;
  const live = AUDIT.tags.filter(t => !t.paused);

  const client = readClientSettings_().clientName;
  const health = overallScore_();
  add(['📋 Tag Audit Summary — ' + (client ? client + ' — ' : '') + label], CONFIG.HEADER_COLOR, true);
  add(['Health score', health.score + ' / 100   ·   Grade ' + health.grade], health.score >= 75 ? '#e8f5e9' : health.score >= 50 ? '#fff3cd' : '#ffcdd2', true);
  add(['Date', Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm')], '#f1f3f4');
  add(['Detail level', AUDIT.fullDetail ? 'Full (GTM API / export: names, triggers, folders)'
                                        : 'Public (published container — tag names not available)'], '#f1f3f4');
  add(['Scope', joinParts_(AUDIT.pageScanned && 'Page source', AUDIT.tags.length + ' GTM tags (' + live.length + ' live)',
                           AUDIT.liveTest && 'Live consent test: ' + hostOf_(AUDIT.liveTest.url) + ' (' + AUDIT.liveTest.stages.length + '/3 states)')], '#f1f3f4');
  add(['Issues', '🔴 ' + counts('High') + ' high   🟡 ' + counts('Medium') + ' medium   🔵 ' + counts('Low') + ' low'], '#f1f3f4', true);
  add([''], '#ffffff');

  add(['Area', 'Status', 'Key findings', 'Score', 'Recommended action', ''], '#34495e', true);
  AREAS.forEach(area => {
    const list = issues.filter(i => i.area === area);
    let status, findings, action;
    if (list.length) {
      const top = list[0].severity;
      status = top === 'High' ? '❌ Action needed' : top === 'Medium' ? '⚠️ Review' : 'ℹ️ Minor';
      findings = list.map(i => '• ' + i.finding).join('\n');
      action = list[0].action;
    } else if (area === 'GA4 Property' && !AUDIT.ga4PropertyChecked) {
      status = 'ℹ️ Not checked'; findings = 'Retention, custom dimensions, key events and links need the Google Analytics Admin API';
      action = 'Apps Script editor → Services (+) → Google Analytics Admin API, then scan again';
    } else if (area === 'Hygiene' && !AUDIT.fullDetail) {
      status = 'ℹ️ Partly checked'; findings = 'Unused triggers/variables, folders and naming need GTM API scan or export';
      action = 'Run Scan GTM via API or Import Container Export';
    } else {
      status = '✅ No issues found'; findings = ''; action = '';
    }
    if (area === 'Third Parties') {
      const vendors = Array.from(new Set(AUDIT.tags.map(t => t.vendor).filter(Boolean)));
      if (vendors.length) findings = joinParts_('Vendors: ' + vendors.join(', '), findings.replace(/^• /, ''));
    }
    const score = areaChecked_(area) ? areaScore_(area) + '/100' : 'n/a';
    add([area, status, findings, score, action, ''],
        status.charAt(0) === '❌' ? SEVERITY_COLORS.High : status.charAt(0) === '⚠' ? SEVERITY_COLORS.Medium : '#ffffff');
  });
  add([''], '#ffffff');

  add(['Prioritised actions'], '#34495e', true);
  add(['#', 'Severity', 'Area', 'Finding', 'Action', 'Where / Items'], '#455a64', true);
  issues.forEach((i, k) => add([
    k + 1, i.severity, i.area, i.finding, i.action,
    joinParts_(i.where, i.items.length && truncate_(i.items.join(', '), 400))
  ], SEVERITY_COLORS[i.severity] || '#ffffff'));
  if (!issues.length) add(['', '✅', '', 'No issues found', '', ''], '#e8f5e9');

  [130, 150, 260, 300, 320, 360].forEach((w, i) => sheet.setColumnWidth(i + 1, w));
  sheet.getRange(1, 1, values.length, n).setValues(values).setBackgrounds(bgs)
    .setWrap(true).setVerticalAlignment('top').setFontSize(9)
    .setFontWeights(bold.map(b => fill_(b ? 'bold' : 'normal', n)));
  sheet.getRange(1, 1, 1, n).setFontColor('#ffffff').setFontSize(13).setWrap(false);
  values.forEach((r, i) => {
    if (bgs[i][0] === '#34495e' || bgs[i][0] === '#455a64') sheet.getRange(i + 1, 1, 1, n).setFontColor('#ffffff');
  });
  sheet.setRowHeight(1, 36);
}


// ════════════════════════════════════════════════════════════════════
//  9d. CLIENT SETTINGS
//  A "⚙️ Client Settings" tab tunes the audit per client. Every scan
//  reads it; if it is missing the defaults below are used.
// ════════════════════════════════════════════════════════════════════

const SETTINGS_DEFS = [
  // key, label, default, help
  ['clientName',    'Client name',                       '',             'Shown in report titles and the PDF file name'],
  ['adsCats',       'Advertising consent categories',    'C0004, C0005', 'CMP category IDs/names that allow advertising tags (OneTrust IDs, Cookiebot "marketing", …)'],
  ['analyticsCats', 'Analytics consent categories',      'C0002',        'CMP category IDs/names that allow analytics tags'],
  ['functionalCats','Functional consent categories',     'C0003',        'CMP category IDs/names that allow functional tags'],
  ['analyticsConsent', 'Analytics needs consent? (Yes/No)', 'Yes',       'Yes for UK/EEA. "No" turns ungated analytics tags from High into Check'],
  ['namingPattern', 'Tag naming pattern (regex)',        '',             'e.g. ^[^-]+ - [^-]+ - .+$   Empty = any "A - B" style name counts'],
  ['approvedVendors', 'Approved vendors (comma list)',   '',             'e.g. Meta, Google Ads, Adform. Empty = no vendor check'],
  ['approvedIds',   'Approved IDs (comma list)',         '',             'Pixel / account IDs the client confirmed. Empty = no ID check'],
  ['ga4Checks',     'GA4 property checks (Auto/Yes/No)', 'Auto',         'Auto = run when the Google Analytics Admin API service is enabled']
];

let settingsCache_ = null;

function openClientSettings() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(CONFIG.SETTINGS_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.SETTINGS_NAME);
    const values = [
      ['⚙️ Client Settings', '', ''],
      ['Edit the values in column B. They are used by every scan.', '', ''],
      ['Setting', 'Value', 'Help']
    ].concat(SETTINGS_DEFS.map(d => [d[1], d[2], d[3]]));
    sheet.getRange(1, 1, values.length, 3).setValues(values).setWrap(true).setVerticalAlignment('top');
    sheet.getRange(1, 1, 1, 3).setBackground(CONFIG.HEADER_COLOR).setFontColor('#ffffff')
      .setFontSize(13).setFontWeight('bold');
    sheet.getRange(2, 1, 1, 3).setFontStyle('italic').setFontColor('#5f6368');
    sheet.getRange(3, 1, 1, 3).setBackground('#34495e').setFontColor('#ffffff').setFontWeight('bold');
    sheet.getRange(4, 1, SETTINGS_DEFS.length, 1).setFontWeight('bold');
    sheet.getRange(4, 2, SETTINGS_DEFS.length, 1).setBackground('#fff9c4');
    sheet.getRange(4, 3, SETTINGS_DEFS.length, 1).setFontColor('#5f6368').setFontSize(9);
    [260, 300, 520].forEach((w, i) => sheet.setColumnWidth(i + 1, w));
    sheet.setFrozenRows(3);
  }
  ss.setActiveSheet(sheet);
}

function readClientSettings_() {
  if (settingsCache_) return settingsCache_;
  const s = {};
  SETTINGS_DEFS.forEach(d => { s[d[0]] = d[2]; });
  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SETTINGS_NAME);
    if (sheet && sheet.getLastRow() >= 4) {
      sheet.getRange(4, 1, sheet.getLastRow() - 3, 2).getValues().forEach(r => {
        const def = SETTINGS_DEFS.filter(d => d[1] === String(r[0]).trim())[0];
        if (def) s[def[0]] = String(r[1] == null ? '' : r[1]).trim();
      });
    }
  } catch (e) {
    Logger.log('Could not read client settings: ' + e.message);
  }
  const list = v => String(v || '').split(/[,;\n]/).map(x => x.trim()).filter(Boolean);
  settingsCache_ = {
    clientName: s.clientName,
    adsCats: list(s.adsCats), analyticsCats: list(s.analyticsCats), functionalCats: list(s.functionalCats),
    analyticsConsent: !/^n/i.test(s.analyticsConsent),
    namingPattern: safeRegex_(s.namingPattern),
    approvedVendors: list(s.approvedVendors).map(v => v.toLowerCase()),
    approvedIds: list(s.approvedIds).map(v => v.toUpperCase()),
    ga4Checks: /^y/i.test(s.ga4Checks) ? 'Yes' : /^n/i.test(s.ga4Checks) ? 'No' : 'Auto'
  };
  return settingsCache_;
}

function safeRegex_(pattern) {
  if (!pattern) return null;
  try { return new RegExp(pattern); } catch (e) { return null; }
}


// ════════════════════════════════════════════════════════════════════
//  9e. ID INVENTORY
//  Every pixel / account / measurement ID found, per platform, so the
//  client can confirm they own each one.
// ════════════════════════════════════════════════════════════════════

// [platform, regex (group 1 = ID), kind]
const ID_RULES = [
  ['GA4',                 /\b(G-[A-Z0-9]{6,12})\b/g,                                         'Measurement ID'],
  ['Google Ads',          /\b(AW-\d{7,12})\b/g,                                              'Conversion ID'],
  ['Floodlight (CM360)',  /\b(DC-\d{5,12})\b/g,                                              'Advertiser ID'],
  ['Universal Analytics', /\b(UA-\d{4,12}-\d{1,4})\b/g,                                      'Property ID'],
  ['Meta',                /fbq\(\s*['"]init['"]\s*,\s*['"]?(\d{10,20})/g,                    'Pixel ID'],
  ['TikTok',              /ttq\.load\(\s*['"]([A-Z0-9]{12,30})['"]/g,                        'Pixel ID'],
  ['LinkedIn',            /_linkedin_partner_id\s*=\s*["']?(\d{3,12})/g,                     'Partner ID'],
  ['Microsoft Ads',       /\bti\s*:\s*["'](\d{4,12})["']/g,                                  'UET tag ID'],
  ['Pinterest',           /pintrk\(\s*['"]load['"]\s*,\s*['"](\d{6,20})/g,                   'Tag ID'],
  ['Snap',                /snaptr\(\s*['"]init['"]\s*,\s*['"]([a-f0-9-]{20,40})/gi,          'Pixel ID'],
  ['Reddit',              /rdt\(\s*['"]init['"]\s*,\s*['"]([a-z0-9_]{5,30})/gi,              'Pixel ID'],
  ['Hotjar',              /\bhjid\s*:\s*(\d{4,10})/g,                                        'Site ID'],
  ['Microsoft Clarity',   /clarity\.ms\/tag\/([a-z0-9]{6,15})/gi,                            'Project ID'],
  ['Amazon Ads',          /pubID\s*:\s*['"]([A-Za-z0-9-]{6,40})['"]/g,                       'Publisher ID']
];

// Template / tag parameters whose key looks like an ID ("pixelId", "vtp_partnerId", …)
const ID_PARAM_RES = [
  /"key":"([A-Za-z_]*?(?:pixel|partner|advertiser|account|conversion|measurement|site|tracking|project|tag)_?id)","value":"([A-Za-z0-9_\-]{4,40})"/gi,
  /"vtp_([A-Za-z_]*?(?:pixel|partner|advertiser|account|conversion|measurement|site|tracking|project|tag)_?id)":"([A-Za-z0-9_\-]{4,40})"/gi
];

// Platforms where more than one ID usually means a leftover or a mistake
const SINGLE_ID_PLATFORMS = new Set(['Meta', 'TikTok', 'LinkedIn', 'Pinterest', 'Snap', 'Reddit',
                                     'Microsoft Ads', 'Hotjar', 'Microsoft Clarity', 'Amazon Ads']);

function addId_(platform, id, kind, where, label, live) {
  if (!id) return;
  if (platform === 'Google Ads' && /^\d+$/.test(id)) id = 'AW-' + id;
  if (platform === 'Floodlight (CM360)' && /^\d+$/.test(id)) id = 'DC-' + id;
  const key = platform + '|' + id.toUpperCase();
  const rec = AUDIT.ids[key] = AUDIT.ids[key] || { platform: platform, id: id, kind: kind, tags: [], where: [], live: false };
  if (label && rec.tags.indexOf(label) < 0) rec.tags.push(label);
  if (where && rec.where.indexOf(where) < 0) rec.where.push(where);
  if (live) rec.live = true;
}

/** Collects IDs from code / parameter text. `platform` is used for generic parameter IDs. */
function collectIds_(text, platform, where, label, live) {
  const plain = unescapeJs_(text || '');
  ID_RULES.forEach(rule => {
    rule[1].lastIndex = 0;
    let m;
    while ((m = rule[1].exec(plain)) !== null) addId_(rule[0], m[1], rule[2], where, label, live);
  });
  if (!platform) return;
  ID_PARAM_RES.forEach(re => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text || '')) !== null) {
      if (/^(G-|AW-|DC-|UA-|GTM-)/i.test(m[2])) continue;       // already covered by ID_RULES
      if (/^(tag|container)_?id$/i.test(m[1]) && /^\d{1,3}$/.test(m[2])) continue;   // GTM internal numbers
      addId_(platform, m[2], idKindLabel_(m[1]), where, label, live);
    }
  });
}

/** "pixelId" / "partner_id" → "Pixel ID" / "Partner ID" */
function idKindLabel_(key) {
  const base = String(key).replace(/^vtp_/, '').replace(/_?id$/i, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').trim();
  return base ? base.charAt(0).toUpperCase() + base.slice(1) + ' ID' : 'ID';
}

function writeIdInventory_(label) {
  const ids = Object.keys(AUDIT.ids).map(k => AUDIT.ids[k]);
  if (!ids.length) return;
  const S = readClientSettings_();
  const sheet = getOrCreateSheet_(CONFIG.INVENTORY_NAME);
  const n = 9;
  const counts = {};
  ids.filter(r => r.live).forEach(r => { counts[r.platform] = (counts[r.platform] || 0) + 1; });
  ids.sort((a, b) => a.platform.localeCompare(b.platform) || a.id.localeCompare(b.id));

  const values = [
    ['🪪 ID Inventory — ' + label, '', '', '', '', '', '', '', ''],
    ['Every account / pixel ID found. Ask the client to confirm they own each one (tick column H).', '', '', '', '', '', '', '', ''],
    ['Platform', 'ID', 'Type', 'Status', 'Used by', 'Found in', 'On approved list', 'Client confirms', 'Notes']
  ];
  const bgs = [fill_(CONFIG.HEADER_COLOR, n), fill_('#f1f3f4', n), fill_('#34495e', n)];
  ids.forEach(r => {
    const approved = S.approvedIds.length ? (S.approvedIds.indexOf(r.id.toUpperCase()) >= 0 ? '✅ Yes' : '⚠️ No') : '—';
    const notes = joinParts_(
      r.live && SINGLE_ID_PLATFORMS.has(r.platform) && counts[r.platform] > 1 && counts[r.platform] + ' ' + r.platform + ' IDs live — confirm all are the client\'s',
      !r.live && 'Only in paused tags');
    values.push([r.platform, r.id, r.kind, r.live ? 'Live' : 'Paused only',
                 truncate_(r.tags.join(', '), 300), truncate_(r.where.join(', '), 200), approved, false, notes]
                 .map(v => typeof v === 'boolean' ? v : safeCell_(v)));
    bgs.push(fill_(notes ? '#fff3cd' : r.live ? '#ffffff' : '#eeeeee', n));
  });

  [150, 210, 130, 95, 320, 220, 120, 110, 300].forEach((w, i) => sheet.setColumnWidth(i + 1, w));
  sheet.getRange(1, 1, values.length, n).setValues(values).setBackgrounds(bgs)
    .setWrap(true).setVerticalAlignment('top').setFontSize(9);
  sheet.getRange(1, 1, 1, n).setFontColor('#ffffff').setFontSize(13).setFontWeight('bold').setWrap(false);
  sheet.getRange(2, 1, 1, n).setFontStyle('italic').setWrap(false);
  sheet.getRange(3, 1, 1, n).setFontColor('#ffffff').setFontWeight('bold');
  if (values.length > 3) {
    sheet.getRange(4, 2, values.length - 3, 1).setFontWeight('bold').setFontFamily('Roboto Mono');
    sheet.getRange(4, 8, values.length - 3, 1)
      .setDataValidation(SpreadsheetApp.newDataValidation().requireCheckbox().build());
  }
  sheet.setFrozenRows(3);
}

function checkIds_() {
  const S = readClientSettings_();
  const live = Object.keys(AUDIT.ids).map(k => AUDIT.ids[k]).filter(r => r.live);
  const byPlatform = {};
  live.forEach(r => { (byPlatform[r.platform] = byPlatform[r.platform] || []).push(r); });

  Object.keys(byPlatform).forEach(p => {
    const list = byPlatform[p];
    if (list.length < 2) return;
    if (SINGLE_ID_PLATFORMS.has(p)) {
      recordIssue_('Accounts & IDs', 'Medium', list.length + ' different ' + p + ' IDs are live',
                   'Confirm every ID belongs to the client — extra IDs are often left by a previous agency or test setup',
                   'ID Inventory', list.map(r => r.id));
    } else {
      recordIssue_('Accounts & IDs', 'Low', list.length + ' ' + p + ' IDs are live',
                   'Confirm all are intended (e.g. roll-up properties or several Ads accounts)', 'ID Inventory',
                   list.map(r => r.id));
    }
  });
  if (S.approvedIds.length) {
    const unknown = live.filter(r => S.approvedIds.indexOf(r.id.toUpperCase()) < 0);
    if (unknown.length) {
      recordIssue_('Accounts & IDs', 'Medium', unknown.length + ' live ID(s) not on the approved list',
                   'Check who owns these IDs; remove any that are not the client\'s', 'ID Inventory',
                   unknown.map(r => r.platform + ' ' + r.id));
    }
  }
}


// ════════════════════════════════════════════════════════════════════
//  9f. PLATFORM BEST-PRACTICE CHECKS
// ════════════════════════════════════════════════════════════════════

function runBestPracticeChecks_() {
  const S = readClientSettings_();
  const live = AUDIT.tags.filter(t => !t.paused);
  const firesAll = t => t.firesOn.some(f => /^(All Pages|Page View|Initialization|Consent Initialization)\b/.test(f) &&
                                            !/&/.test(f));
  const adsConversion = live.filter(t => /^(awct|sp|flc|fls)$/.test(t.type));
  const linker = live.filter(t => t.type === 'gclidw');
  const googleTagForAds = live.some(t => t.type === 'googtag' && /AW-\d/.test(t.text));

  // Conversion Linker
  if (adsConversion.length && !linker.length && !googleTagForAds) {
    recordIssue_('Ads Setup', 'Medium', 'Google Ads / Floodlight tags without a Conversion Linker',
                 'Add a Conversion Linker tag on All Pages — without it ad clicks are not stored and conversions are under-reported',
                 'GTM', adsConversion.map(t => t.label));
  }
  linker.filter(t => t.firesOn.length && !firesAll(t)).forEach(t => recordIssue_('Ads Setup', 'Low',
    'Conversion Linker does not fire on every page', 'Fire it on All Pages (or Initialization – All Pages)',
    t.where, [t.label + ': ' + t.firesOn.join(' OR ')]));

  // Enhanced Conversions
  const awct = live.filter(t => t.type === 'awct');
  if (awct.length && !awct.some(t => /enhanced|user_data|cssProvidedEnhancedConversionValue/i.test(t.text)) &&
      !live.some(t => t.type === 'googtag' && /user_data|enhanced/i.test(t.text))) {
    recordIssue_('Ads Setup', 'Low', 'Enhanced Conversions not detected on Google Ads conversion tags',
                 'Consider Enhanced Conversions (hashed first-party data) to recover lost conversions — check the Ads account too',
                 'GTM', awct.map(t => t.label));
  }

  // CMP should load first
  live.filter(t => t.vendor && /\(CMP\)$/.test(t.vendor)).forEach(t => {
    if (!t.firesOn.some(f => /Consent Initialization/.test(f))) {
      recordIssue_('Consent', 'Medium', 'Consent platform tag does not fire on Consent Initialization',
                   'Fire the CMP tag on "Consent Initialization – All Pages" so consent is known before other tags',
                   t.where, [t.label + (t.firesOn.length ? ': ' + t.firesOn.join(' OR ') : '')]);
    }
  });

  // Duplicate base code: the same pixel initialised by several live tags on the same trigger
  Object.keys(AUDIT.ids).map(k => AUDIT.ids[k]).filter(r => r.kind === 'Pixel ID' && r.live).forEach(r => {
    const tags = live.filter(t => r.tags.indexOf(t.label) >= 0 && /fbq\(\s*['"]init|ttq\.load|pintrk\(\s*['"]load|snaptr\(\s*['"]init/.test(unescapeJs_(t.text)));
    const byTrigger = countBy_(tags, t => t.firesOn.join(' OR ')).filter(c => c.count > 1 && c.key);
    byTrigger.forEach(c => recordIssue_('Ads Setup', 'Medium',
      r.platform + ' pixel ' + r.id + ' base code loaded ' + c.count + ' times on the same trigger',
      'Keep one base-code tag per pixel — duplicates double-count page views and events', 'GTM',
      tags.filter(t => t.firesOn.join(' OR ') === c.key).map(t => t.label)));
  });

  // Consent Mode extras for Google Ads
  const adsLive = live.some(t => /^(awct|sp|gclidw|flc|fls)$/.test(t.type));
  const cm = AUDIT.consentMode;
  if (adsLive && (cm.defaultOnPage || cm.defaultViaGtm)) {
    if (!cm.redaction) {
      recordIssue_('Ads Setup', 'Low', 'ads_data_redaction is not set',
                   'Set ads_data_redaction: true so ad click IDs are redacted when ad_storage is denied', 'Consent Mode');
    }
    if (!cm.passthrough) {
      recordIssue_('Ads Setup', 'Low', 'url_passthrough is not set',
                   'Consider url_passthrough: true to keep ad click info across pages when cookies are denied', 'Consent Mode');
    }
  }

  // Meta Conversions API
  const meta = live.filter(t => t.vendor === 'Meta Pixel');
  if (meta.length && !meta.some(t => /event_?id|eventID|capi|conversions\s*api|server/i.test(t.text + ' ' + t.label))) {
    recordIssue_('Ads Setup', 'Low', 'Meta pixel runs in the browser only (no event IDs / Conversions API seen)',
                 'Consider the Meta Conversions API with event_id de-duplication to recover events lost to blockers and consent',
                 'GTM', meta.map(t => t.label));
  }

  // Approved vendors
  if (S.approvedVendors.length) {
    const vendors = Array.from(new Set(live.map(t => t.vendor).filter(Boolean)));
    const unapproved = vendors.filter(v => !S.approvedVendors.some(a => v.toLowerCase().indexOf(a) >= 0 || a.indexOf(v.toLowerCase().split(' ')[0]) >= 0));
    if (unapproved.length) {
      recordIssue_('Third Parties', 'Medium', unapproved.length + ' vendor(s) not on the approved list',
                   'Confirm the client has approved these vendors and lists them in the cookie policy', 'GTM', unapproved);
    }
  }

  // Payment domains (GA4 Admin API cannot read the unwanted-referrals list)
  if (AUDIT.paymentDomains.length) {
    recordIssue_('GA4 Setup', 'Low', 'Payment providers referenced on the site',
                 'Check they are in GA4 → Data Streams → Configure tag settings → List unwanted referrals',
                 'Page / GTM', AUDIT.paymentDomains);
  }
}


// ════════════════════════════════════════════════════════════════════
//  9g. GA4 PROPERTY CHECKS (Google Analytics Admin API)
//  Setup: Apps Script editor → Services (+) → Google Analytics Admin API.
//  Needs Viewer access to the GA4 property.
// ════════════════════════════════════════════════════════════════════

// Parameters GA4 handles without a custom dimension
const GA4_STANDARD_PARAMS = new Set([
  'page_location', 'page_referrer', 'page_title', 'language', 'screen_resolution', 'engagement_time_msec',
  'value', 'currency', 'items', 'transaction_id', 'tax', 'shipping', 'coupon', 'affiliation', 'payment_type',
  'shipping_tier', 'item_list_id', 'item_list_name', 'promotion_id', 'promotion_name', 'creative_name',
  'creative_slot', 'method', 'search_term', 'content_type', 'content_id', 'link_url', 'link_text', 'link_domain',
  'link_classes', 'link_id', 'outbound', 'file_name', 'file_extension', 'video_title', 'video_url',
  'video_percent', 'video_provider', 'video_current_time', 'video_duration', 'visible', 'percent_scrolled',
  'form_id', 'form_name', 'form_destination', 'form_submit_text', 'send_to', 'event_callback', 'event_timeout',
  'non_interaction', 'debug_mode', 'user_id', 'session_id', 'campaign', 'source', 'medium', 'term', 'content',
  'group_id', 'level', 'score', 'character', 'achievement_id', 'virtual_currency_name'
]);

const GA4_AUTO_EVENTS = new Set(['page_view', 'session_start', 'first_visit', 'user_engagement', 'scroll',
  'click', 'view_search_results', 'file_download', 'form_start', 'form_submit', 'video_start',
  'video_progress', 'video_complete']);

function runGa4PropertyChecks_() {
  const S = readClientSettings_();
  if (S.ga4Checks === 'No') return;
  const mids = Array.from(new Set(Object.keys(AUDIT.ids).map(k => AUDIT.ids[k])
    .filter(r => r.platform === 'GA4' && r.live).map(r => r.id)));
  if (!mids.length) return;
  if (typeof AnalyticsAdmin === 'undefined') {
    if (S.ga4Checks === 'Yes') {
      recordIssue_('GA4 Property', 'Low', 'GA4 property checks skipped — Analytics Admin API not enabled',
                   'Apps Script editor → Services (+) → Google Analytics Admin API → Add', '');
    }
    return;
  }
  AUDIT.ga4PropertyChecked = true;
  mids.forEach(mid => {
    toast_('Checking GA4 property for ' + mid + '…', '📈 GA4', 30);
    try {
      const prop = findGa4Property_(mid);
      if (!prop) {
        recordIssue_('GA4 Property', 'Low', mid + ': no access to its GA4 property',
                     'Ask for Viewer access to the property to run these checks', mid);
        return;
      }
      checkGa4Property_(prop, mid);
    } catch (e) {
      recordIssue_('GA4 Property', 'Low', mid + ': property checks failed (' + truncate_(e.message, 120) + ')',
                   'Check the Analytics Admin API service and your access', mid);
    }
  });
}

/** Finds the GA4 property that owns a measurement ID (cached per user). */
function findGa4Property_(mid) {
  const props = PropertiesService.getUserProperties();
  const cached = props.getProperty('ga4:' + mid);
  if (cached) {
    try { return JSON.parse(cached); } catch (e) { /* ignore */ }
  }
  let token = null, found = null;
  do {
    const res = gtmCall_(() => AnalyticsAdmin.AccountSummaries.list(token ? { pageSize: 200, pageToken: token } : { pageSize: 200 }));
    (res.accountSummaries || []).forEach(acc => (acc.propertySummaries || []).forEach(ps => {
      if (found) return;
      const streams = gtmCall_(() => AnalyticsAdmin.Properties.DataStreams.list(ps.property)).dataStreams || [];
      streams.forEach(ds => {
        const id = ds.webStreamData && ds.webStreamData.measurementId;
        if (!id) return;
        const info = { property: ps.property, displayName: ps.displayName, account: acc.displayName,
                       stream: ds.name, streams: streams.length };
        props.setProperty('ga4:' + id, JSON.stringify(info));
        if (id === mid) found = info;
      });
    }));
    token = found ? null : res.nextPageToken;
  } while (token);
  return found;
}

function checkGa4Property_(prop, mid) {
  const where = mid + ' · ' + prop.displayName;
  const p = prop.property;
  const info = [];
  const tryCall = (fn, fallback) => { try { return fn(); } catch (e) { Logger.log('GA4 Admin: ' + e.message); return fallback; } };

  const property = tryCall(() => AnalyticsAdmin.Properties.get(p), {}) || {};
  info.push(joinParts_(prop.account && 'Account: ' + prop.account, property.timeZone, property.currencyCode,
                       prop.streams + ' data stream(s)'));

  const retention = tryCall(() => AnalyticsAdmin.Properties.getDataRetentionSettings(p + '/dataRetentionSettings'), null);
  if (retention && retention.eventDataRetention) {
    info.push('Retention: ' + retention.eventDataRetention.toLowerCase().replace(/_/g, ' '));
    if (retention.eventDataRetention === 'TWO_MONTHS') {
      recordIssue_('GA4 Property', 'Medium', 'Event data retention is only 2 months',
                   'Set it to 14 months (Admin → Data collection and modification → Data retention) — Explorations cannot look further back',
                   where);
    }
  }

  // Custom dimensions vs what GTM sends
  const dims = tryCall(() => AnalyticsAdmin.Properties.CustomDimensions.list(p, { pageSize: 200 }), {}) || {};
  const eventDims = new Set(), userDims = new Set();
  (dims.customDimensions || []).forEach(d => (d.scope === 'USER' ? userDims : eventDims).add(d.parameterName));
  info.push(eventDims.size + ' event / ' + userDims.size + ' user custom dimensions');
  const sentParams = new Set();
  AUDIT.ga4Events.forEach(e => e.params.forEach(x => { if (!/\{\{/.test(x)) sentParams.add(x); }));
  const missing = Array.from(sentParams).filter(x => !eventDims.has(x) && !GA4_STANDARD_PARAMS.has(x));
  if (missing.length) {
    recordIssue_('GA4 Property', 'Low', missing.length + ' event parameter(s) sent but not registered as custom dimensions',
                 'Register the ones you need in reports (Admin → Custom definitions); unregistered parameters are not reportable',
                 where, missing);
  }
  const missingUser = Array.from(AUDIT.userProps).filter(x => !userDims.has(x));
  if (missingUser.length) {
    recordIssue_('GA4 Property', 'Low', missingUser.length + ' user propert(ies) not registered',
                 'Register them as user-scoped custom dimensions', where, missingUser);
  }

  // Key events
  let keyEvents = tryCall(() => (AnalyticsAdmin.Properties.KeyEvents.list(p).keyEvents || []).map(k => k.eventName), null);
  if (!keyEvents) keyEvents = tryCall(() => (AnalyticsAdmin.Properties.ConversionEvents.list(p).conversionEvents || []).map(k => k.eventName), []);
  info.push('Key events: ' + (keyEvents.length ? keyEvents.join(', ') : 'none'));
  const hasDynamic = AUDIT.ga4Events.some(e => /\{\{/.test(e.name));
  const sentEvents = new Set(AUDIT.ga4Events.map(e => String(e.name).replace(/\s\(\{\{[^}]*\}\}\)$/, '')));
  if (!keyEvents.length) {
    recordIssue_('GA4 Property', 'Medium', 'No key events (conversions) set up', 'Mark the business-critical events as key events', where);
  } else if (!hasDynamic) {
    const notSent = keyEvents.filter(k => !sentEvents.has(k) && !GA4_AUTO_EVENTS.has(k) && k !== 'purchase');
    if (notSent.length) {
      recordIssue_('GA4 Property', 'Low', notSent.length + ' key event(s) not found in GTM',
                   'Check these events still fire (they may come from another source)', where, notSent);
    }
  }

  // Links
  const adsLinks = tryCall(() => AnalyticsAdmin.Properties.GoogleAdsLinks.list(p).googleAdsLinks || [], null);
  if (adsLinks) {
    info.push(adsLinks.length + ' Google Ads link(s)');
    const adsLive = AUDIT.tags.some(t => !t.paused && /^(awct|sp|gclidw)$/.test(t.type));
    if (adsLive && !adsLinks.length) {
      recordIssue_('GA4 Property', 'Medium', 'GA4 is not linked to Google Ads, but Google Ads tags are live',
                   'Link the Ads account (Admin → Product links) to import key events and audiences', where);
    }
  }
  const bq = tryCall(() => (AnalyticsAdmin.Properties.BigQueryLinks.list(p).bigqueryLinks || []).length, null);
  if (bq !== null) info.push(bq ? 'BigQuery export linked' : 'No BigQuery link');

  // Currency
  if (property.currencyCode && AUDIT.currencies.length) {
    const other = AUDIT.currencies.filter(c => c !== property.currencyCode);
    if (other.length) {
      recordIssue_('GA4 Property', 'Low', 'Ecommerce currency differs from the property currency (' + property.currencyCode + ')',
                   'Fine if GA4 converts them; otherwise check the currency sent with ecommerce events', where, other);
    }
  }

  AUDIT.extraRows.push(row_('📈 GA4 Property', prop.displayName, mid, info.filter(Boolean).join(' | '),
                            'Checked via the Google Analytics Admin API'));
}


// ════════════════════════════════════════════════════════════════════
//  9h. HEALTH SCORE AND PDF EXPORT
// ════════════════════════════════════════════════════════════════════

const AREA_WEIGHTS = {
  'Consent': 3, 'Security': 2, 'GA4 Setup': 1.5, 'GA4 Property': 1, 'Ads Setup': 1,
  'Accounts & IDs': 1, 'Legacy': 1, 'Hygiene': 0.5, 'Third Parties': 0.5
};

function areaScore_(area) {
  const list = AUDIT.issues.filter(i => i.area === area);
  const pen = { High: 30, Medium: 12, Low: 4 };
  return Math.max(0, 100 - list.reduce((s, i) => s + pen[i.severity], 0));
}

function areaChecked_(area) {
  if (area === 'GA4 Property') return !!AUDIT.ga4PropertyChecked;
  if (area === 'Accounts & IDs') return Object.keys(AUDIT.ids).length > 0;
  if (area === 'Ads Setup') return AUDIT.tags.some(t => !t.paused && (t.purpose === 'advertising'));
  return true;
}

function overallScore_() {
  let total = 0, weight = 0;
  AREAS.forEach(a => {
    if (!areaChecked_(a)) return;
    total += areaScore_(a) * AREA_WEIGHTS[a];
    weight += AREA_WEIGHTS[a];
  });
  const score = weight ? Math.round(total / weight) : 100;
  const grade = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : score >= 40 ? 'D' : 'E';
  return { score: score, grade: grade };
}

/** Saves the Audit Summary, Consent Matrix and ID Inventory tabs as one PDF in Drive. */
function exportAuditPdf() {
  runSafely_('PDF export', () => {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const keep = [CONFIG.SUMMARY_NAME, CONFIG.MATRIX_NAME, CONFIG.LIVE_NAME, CONFIG.INVENTORY_NAME];
    if (!ss.getSheetByName(CONFIG.SUMMARY_NAME)) {
      alert_('Nothing to export', 'Run a scan first — the PDF contains the Audit Summary, Consent Matrix and ID Inventory tabs.');
      return;
    }
    toast_('Building the PDF…', '📄 Export', 30);
    const hidden = [];
    ss.setActiveSheet(ss.getSheetByName(CONFIG.SUMMARY_NAME));
    let response;
    try {
      ss.getSheets().forEach(s => {
        if (keep.indexOf(s.getName()) < 0 && !s.isSheetHidden()) { s.hideSheet(); hidden.push(s); }
      });
      SpreadsheetApp.flush();
      const url = 'https://docs.google.com/spreadsheets/d/' + ss.getId() + '/export?format=pdf' +
        '&size=A4&portrait=false&fitw=true&gridlines=false&printtitle=false&sheetnames=true' +
        '&pagenum=CENTER&fzr=true&top_margin=0.4&bottom_margin=0.4&left_margin=0.4&right_margin=0.4';
      response = UrlFetchApp.fetch(url, {
        headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true
      });
    } finally {
      hidden.forEach(s => s.showSheet());
    }
    if (response.getResponseCode() !== 200) {
      throw new Error('Google returned HTTP ' + response.getResponseCode() + ' while exporting');
    }
    const S = readClientSettings_();
    const tz = ss.getSpreadsheetTimeZone();
    const name = 'Tag Audit - ' + (S.clientName || ss.getName()) + ' - ' + Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd') + '.pdf';
    const file = DriveApp.createFile(response.getBlob().setName(name));
    const html = HtmlService.createHtmlOutput(
      '<p style="font-family:Arial">Saved to your Google Drive:</p>' +
      '<p style="font-family:Arial"><a href="' + file.getUrl() + '" target="_blank">' + name + '</a></p>'
    ).setWidth(420).setHeight(140);
    SpreadsheetApp.getUi().showModalDialog(html, '📄 Audit report exported');
  });
}


// ════════════════════════════════════════════════════════════════════
//  9i. LIVE CONSENT TEST
//
//  Proves what actually happens in the browser. In each state (before any
//  choice, after Deny, after Accept) the tester runs a console snippet on
//  the site; it reports which vendors sent requests, which cookie NAMES
//  exist (never values) and Google's consent signal (gcs). The results are
//  pasted into a dialog, stored with the spreadsheet, and turned into the
//  "🧪 Live Consent Test" tab plus Consent issues in the Audit Summary.
// ════════════════════════════════════════════════════════════════════

const LIVE_STAGES = { before: 'Before any choice', deny: 'After Deny / Reject', accept: 'After Accept all' };
const LIVE_PROP_KEY = 'liveConsentTest';

/**
 * Runs in the website's browser console — NOT in Apps Script.
 * Its source is shown in the dialog (via toString), so keep it self-contained.
 */
function liveTestSnippet_() {
  var V = [
    ['GA4', 'analytics', /\/g\/collect|google-analytics\.com\/(g|mp)\//],
    ['Google Ads', 'advertising', /googleadservices\.com|googleads\.g\.doubleclick\.net|\/pagead\/|\/ccm\/collect|google\.[a-z.]+\/(rmkt|pagead)/],
    ['Floodlight (CM360)', 'advertising', /fls\.doubleclick\.net|ad\.doubleclick\.net\/activity/],
    ['Meta', 'advertising', /facebook\.com\/tr|connect\.facebook\.net/],
    ['TikTok', 'advertising', /tiktok\.com/],
    ['LinkedIn', 'advertising', /px\.ads\.linkedin\.com|snap\.licdn\.com|linkedin\.com\/(px|collect)/],
    ['Microsoft Ads', 'advertising', /bat\.bing\.com/],
    ['Microsoft Clarity', 'analytics', /clarity\.ms/],
    ['Amazon Ads', 'advertising', /amazon-adsystem\.com/],
    ['Hotjar', 'analytics', /hotjar\.(com|io)/],
    ['Samba TV', 'advertising', /samba\.tv/],
    ['Pinterest', 'advertising', /pinimg\.com\/ct|ct\.pinterest\.com/],
    ['Snap', 'advertising', /sc-static\.net|tr\.snapchat\.com/],
    ['Reddit', 'advertising', /redditstatic\.com\/ads|alb\.reddit\.com/],
    ['X (Twitter)', 'advertising', /ads-twitter\.com|analytics\.twitter\.com|t\.co\/i\/adsct/],
    ['Criteo', 'advertising', /criteo\.(com|net)/],
    ['Taboola', 'advertising', /taboola\.com/],
    ['Outbrain', 'advertising', /outbrain\.com/],
    ['Adform', 'advertising', /adform\.net/],
    ['Teads', 'advertising', /teads\.tv/],
    ['The Trade Desk', 'advertising', /adsrvr\.org/],
    ['Xandr', 'advertising', /adnxs\.com/],
    ['Quantcast', 'advertising', /quantserve\.com|quantcount\.com/],
    ['HubSpot', 'advertising', /hs-scripts\.com|hs-analytics\.net|hs-banner\.com/],
    ['Cookiebot', 'necessary', /cookiebot\.com|consentcdn\.cookiebot/],
    ['OneTrust', 'necessary', /cookielaw\.org|onetrust\.com/],
    ['Usercentrics', 'necessary', /usercentrics\.eu/]
  ];
  var C = {
    '_ga': 'GA4', '_gid': 'GA4', '_gcl_au': 'Google Ads', '_gcl_aw': 'Google Ads', '_gcl_gb': 'Google Ads',
    '_gcl_dc': 'Floodlight (CM360)', '_fbp': 'Meta', '_fbc': 'Meta', '_ttp': 'TikTok',
    '_tt_enable_cookie': 'TikTok', 'ttcsid': 'TikTok', 'li_fat_id': 'LinkedIn', 'li_gc': 'LinkedIn',
    '_uetsid': 'Microsoft Ads', '_uetvid': 'Microsoft Ads', '_clck': 'Microsoft Clarity',
    '_clsk': 'Microsoft Clarity', '_pin_unauth': 'Pinterest', '_scid': 'Snap', '_rdt_uuid': 'Reddit',
    '_hjSessionUser': 'Hotjar', '_hjSession': 'Hotjar', 'CookieConsent': 'Cookiebot',
    'OptanonConsent': 'OneTrust', 'OptanonAlertBoxClosed': 'OneTrust'
  };
  var purposeOf = {};
  V.forEach(function (v) { purposeOf[v[0]] = v[1]; });
  var vendors = {}, other = {};
  var root = location.hostname.split('.').slice(-2).join('.');
  var add = function (name) {
    return vendors[name] = vendors[name] || { purpose: purposeOf[name] || 'unknown', requests: 0, cookies: [] };
  };
  var urls = performance.getEntriesByType('resource').map(function (r) { return r.name; });
  urls.forEach(function (u) {
    for (var i = 0; i < V.length; i++) {
      if (V[i][2].test(u)) { add(V[i][0]).requests++; return; }
    }
    try {
      var h = new URL(u).hostname;
      if (h.indexOf(root) < 0 && !/gstatic|googleapis|googletagmanager|fonts\.|cdnjs|jsdelivr|unpkg|cloudflare|jquery|youtube|ytimg|vimeo/.test(h)) other[h] = 1;
    } catch (e) { /* ignore */ }
  });
  var names = document.cookie.split(';').map(function (c) { return c.trim().split('=')[0]; }).filter(Boolean);
  names.forEach(function (n) {
    Object.keys(C).forEach(function (k) {
      if (n === k || n.indexOf(k + '_') === 0) {
        var v = add(C[k]);
        if (v.cookies.indexOf(n) < 0) v.cookies.push(n);
      }
    });
  });
  var gcs = [];
  urls.forEach(function (u) {
    var m = u.match(/[?&]gcs=([^&]+)/);
    if (m && gcs.indexOf(m[1]) < 0) gcs.push(m[1]);
  });
  var consentDefault = null;
  (window.dataLayer || []).forEach(function (e) {
    try {
      var a = Array.prototype.slice.call(e);
      if (a[0] === 'consent' && a[1] === 'default' && !consentDefault) consentDefault = a[2];
    } catch (x) { /* ignore */ }
  });
  var cmp = null, stage = 'unknown';
  if (window.Cookiebot) {
    var c = window.Cookiebot.consent || {};
    cmp = { name: 'Cookiebot', hasResponse: !!window.Cookiebot.hasResponse,
            marketing: !!c.marketing, statistics: !!c.statistics, preferences: !!c.preferences };
    stage = !cmp.hasResponse ? 'before' : (cmp.marketing && cmp.statistics) ? 'accept'
          : (!cmp.marketing && !cmp.statistics && !cmp.preferences) ? 'deny' : 'custom';
  } else if (window.OnetrustActiveGroups !== undefined) {
    var groups = String(window.OnetrustActiveGroups || '');
    var closed = !!(window.OneTrust && window.OneTrust.IsAlertBoxClosed && window.OneTrust.IsAlertBoxClosed());
    cmp = { name: 'OneTrust', groups: groups, closed: closed };
    stage = !closed ? 'before' : /C0002/.test(groups) && /C0004/.test(groups) ? 'accept'
          : groups.replace(/[,C0001]/g, '') === '' ? 'deny' : 'custom';
  }
  var out = {
    tool: 'tag-scanner-live-test', v: 1, stage: stage, url: location.href, time: new Date().toISOString(),
    cmp: cmp, consentDefault: consentDefault, gcs: gcs, vendors: vendors,
    otherHosts: Object.keys(other).slice(0, 40), cookieCount: names.length
  };
  var s = JSON.stringify(out);
  try { copy(s); console.log('✅ Copied (' + stage + ') — paste it into Tag Scanner → Live Consent Test'); } catch (e) { /* copy() only exists in DevTools */ }
  return s;
}

function openLiveConsentTest() {
  const snippet = '(' + liveTestSnippet_.toString() + ')()';
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = HtmlService.createHtmlOutput([
    '<style>',
    '  body { font-family: Arial, sans-serif; font-size: 13px; margin: 0; }',
    '  ol { padding-left: 18px; margin: 6px 0; } li { margin-bottom: 4px; }',
    '  textarea { width: 100%; box-sizing: border-box; font: 11px monospace; }',
    '  #snip { height: 70px; background: #f1f3f4; } #src { height: 150px; }',
    '  button { padding: 7px 14px; border: 0; border-radius: 4px; cursor: pointer; }',
    '  .primary { background: #1a73e8; color: #fff; } .ghost { background: #e8eaed; }',
    '  #out { white-space: pre-wrap; background: #f1f3f4; padding: 10px; display: none; font-size: 12px; max-height: 420px; overflow: auto; }',
    '  .row { margin: 8px 0; } #msg { margin-left: 8px; color: #5f6368; }',
    '</style>',
    '<div id="input">',
    '<ol>',
    '  <li>Open the site in Chrome in an <b>Incognito window</b> (or clear its cookies) and wait for the cookie banner.</li>',
    '  <li>Press <b>F12 → Console</b>, paste the snippet below and press Enter. The result is copied to your clipboard.</li>',
    '  <li>Paste it into the box below. Repeat after clicking <b>Deny / Reject all</b>, then in a fresh Incognito window after <b>Accept all</b>. Browse a page or two after each choice.</li>',
    '</ol>',
    '<div class="row"><b>Snippet</b> <button class="ghost" onclick="copySnip()">Copy snippet</button> <span id="copied"></span></div>',
    '<textarea id="snip" readonly>' + esc(snippet) + '</textarea>',
    '<div class="row"><b>Paste results</b> (one or more, any order)</div>',
    '<textarea id="src" placeholder="{&quot;tool&quot;:&quot;tag-scanner-live-test&quot;, …}"></textarea>',
    '<div class="row">Stage if not detected: <select id="stage"><option value="">Auto</option>',
    '  <option value="before">Before any choice</option><option value="deny">After Deny</option><option value="accept">After Accept</option></select>',
    '  &nbsp; <label><input type="checkbox" id="reset"> Start a new test (clear earlier results)</label></div>',
    '</div>',
    '<div id="out"></div>',
    '<button class="primary" id="go" onclick="run()">Add to report</button><span id="msg"></span>',
    '<script>',
    '  function copySnip() { var t = document.getElementById("snip"); t.select(); document.execCommand("copy");',
    '    document.getElementById("copied").textContent = "Copied"; }',
    '  function run() {',
    '    var src = document.getElementById("src").value.trim(), msg = document.getElementById("msg");',
    '    if (!src) { msg.textContent = "Paste at least one result first."; return; }',
    '    var go = document.getElementById("go"); go.disabled = true; msg.textContent = "Adding…";',
    '    google.script.run.withSuccessHandler(function (summary) {',
    '        document.getElementById("input").style.display = "none";',
    '        var out = document.getElementById("out"); out.textContent = summary; out.style.display = "block";',
    '        msg.textContent = ""; go.disabled = false; go.textContent = "Close";',
    '        go.onclick = function () { google.script.host.close(); };',
    '      }).withFailureHandler(function (e) { msg.textContent = "Error: " + e.message; go.disabled = false; })',
    '      .processLiveTest(src, document.getElementById("stage").value, document.getElementById("reset").checked);',
    '  }',
    '</script>'
  ].join('\n')).setWidth(760).setHeight(600);
  SpreadsheetApp.getUi().showModalDialog(html, '🧪 Live Consent Test');
}

/** Called from the dialog — must stay public. Returns a text summary. */
function processLiveTest(text, stageOverride, reset) {
  const results = parseLiveResults_(text);
  if (!results.length) throw new Error('No snippet results found — paste the text the snippet copied.');

  const props = PropertiesService.getDocumentProperties();
  let data = null;
  if (!reset) {
    try { data = JSON.parse(props.getProperty(LIVE_PROP_KEY) || 'null'); } catch (e) { data = null; }
  }
  data = data || { stages: {} };

  const added = [];
  results.forEach(r => {
    const stage = LIVE_STAGES[r.stage] ? r.stage : stageOverride;
    if (!LIVE_STAGES[stage]) {
      throw new Error('Could not tell the consent state of one result (' + (r.stage || 'unknown') +
                      ') — choose the stage in the dropdown and add it on its own.');
    }
    const vendors = {};
    Object.keys(r.vendors || {}).forEach(v => {
      vendors[v] = [r.vendors[v].requests || 0, r.vendors[v].cookies || [], r.vendors[v].purpose || 'unknown'];
    });
    data.stages[stage] = {
      url: r.url, time: r.time, cmp: r.cmp, consentDefault: r.consentDefault,
      gcs: r.gcs || [], vendors: vendors, other: (r.otherHosts || []).slice(0, 25), cookieCount: r.cookieCount
    };
    added.push(LIVE_STAGES[stage]);
  });

  let json = JSON.stringify(data);
  Object.keys(data.stages).forEach(s => {           // stay under the 9 KB property limit
    if (json.length > 8500) { data.stages[s].other = data.stages[s].other.slice(0, 5); json = JSON.stringify(data); }
  });
  props.setProperty(LIVE_PROP_KEY, json);

  const verdicts = liveTestVerdicts_(data);
  writeLiveTestTab_(data, verdicts);

  const missing = Object.keys(LIVE_STAGES).filter(s => !data.stages[s]).map(s => LIVE_STAGES[s]);
  const bad = verdicts.filter(v => v.verdict === 'High');
  return [
    'Added: ' + added.join(', '),
    missing.length ? 'Still to test: ' + missing.join(', ') : 'All three states tested ✓',
    '',
    bad.length ? '🔴 ' + bad.length + ' vendor(s) not respecting consent: ' + bad.map(v => v.vendor).join(', ')
               : '✅ No vendor fired without consent in the states tested',
    '',
    'See the "' + CONFIG.LIVE_NAME + '" tab. Run a scan again to include these results in the Audit Summary and PDF.'
  ].join('\n');
}

/**
 * Finds every snippet result in the pasted text, however it was pasted:
 * clean clipboard JSON, console output wrapped in '…', several results
 * on one line or with no separator at all.
 */
function parseLiveResults_(text) {
  const extract = src => {
    const found = [];
    const re = /\{\s*"tool"\s*:\s*"tag-scanner-live-test"/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const end = matchingBrace_(src, m.index);
      if (end < 0) continue;
      try {
        const o = JSON.parse(src.substring(m.index, end + 1));
        if (o && o.tool === 'tag-scanner-live-test') found.push(o);
      } catch (e) { /* skip a damaged result */ }
      re.lastIndex = end + 1;
    }
    return found;
  };
  const raw = String(text || '');
  let out = extract(raw);
  if (!out.length) out = extract(raw.replace(/\\"/g, '"'));   // console output with escaped quotes
  return out;
}

/** gcs = G1xy: x = ad_storage, y = analytics_storage (1 granted, 0 denied). */
function gcsDenied_(gcsList, purpose) {
  if (!gcsList || !gcsList.length) return null;
  const pos = purpose === 'analytics' ? 3 : 2;
  return gcsList.every(g => g.charAt(pos) === '0');
}

function liveTestVerdicts_(data) {
  const S = readClientSettings_();
  const stages = data.stages;
  const names = new Set();
  Object.keys(stages).forEach(s => Object.keys(stages[s].vendors || {}).forEach(v => names.add(v)));
  const consentWord = { advertising: 'marketing', analytics: 'statistics', functional: 'preferences' };

  return Array.from(names).map(vendor => {
    let purpose = 'unknown';
    Object.keys(stages).forEach(s => { const v = stages[s].vendors[vendor]; if (v && v[2]) purpose = v[2]; });
    const google = /^(GA4|Google Ads|Floodlight)/.test(vendor);
    const cell = {}, problems = [];

    Object.keys(LIVE_STAGES).forEach(s => {
      if (!stages[s]) { cell[s] = 'Not tested'; return; }
      const v = stages[s].vendors[vendor];
      if (!v || (!v[0] && !v[1].length)) { cell[s] = 'No activity'; return; }
      const parts = [];
      if (v[0]) parts.push(v[0] + ' request' + (v[0] > 1 ? 's' : ''));
      if (v[1].length) parts.push('cookies: ' + v[1].join(', '));
      const denied = google ? gcsDenied_(stages[s].gcs, purpose === 'analytics' ? 'analytics' : 'advertising') : null;
      if (google && denied !== null) parts.push(denied ? 'consent denied (' + stages[s].gcs.join('/') + ')' : 'consent granted (' + stages[s].gcs.join('/') + ')');
      cell[s] = (s === 'accept' ? '✔ ' : purpose === 'necessary' ? 'ℹ️ ' : '⚠️ ') + parts.join(' · ');

      if (s !== 'accept' && purpose !== 'necessary') {
        const when = s === 'before' ? 'before any choice' : 'after Deny';
        if (google) {
          if (v[1].length) problems.push('sets cookies ' + when);
          else if (denied === false) problems.push('sends data with consent granted ' + when);
          else cell[s] = '⚪ Cookieless pings · ' + (stages[s].gcs.join('/') || 'no gcs');
        } else {
          problems.push((v[1].length ? 'sets cookies and sends data ' : 'sends data ') + when);
        }
      }
    });

    let verdict, recommendation;
    const acceptActive = stages.accept && stages.accept.vendors[vendor] &&
                         (stages.accept.vendors[vendor][0] || stages.accept.vendors[vendor][1].length);
    if (purpose === 'necessary') {
      verdict = 'OK'; recommendation = 'Consent platform / necessary';
    } else if (problems.length) {
      verdict = purpose === 'analytics' && !S.analyticsConsent ? 'Check' : 'High';
      recommendation = 'Fires without consent (' + problems.join('; ') + '). Block it until ' +
        (consentWord[purpose] || 'the relevant') + ' consent is given — fire it on the CMP consent event or use a consent-aware template';
    } else if (google && (cell.before || '').indexOf('⚪') === 0) {
      verdict = 'Info';
      recommendation = 'Consent Mode "advanced": cookieless pings while denied. Allowed by Google\'s design — mention it in the cookie policy';
    } else if (acceptActive) {
      verdict = 'OK'; recommendation = 'Waits for consent';
    } else {
      verdict = 'Info'; recommendation = 'Not seen in the states tested';
    }
    return { vendor: vendor, purpose: purpose, cells: cell, verdict: verdict, recommendation: recommendation };
  }).sort((a, b) => ({ High: 0, Check: 1, Info: 2, OK: 3 }[a.verdict] - { High: 0, Check: 1, Info: 2, OK: 3 }[b.verdict]) ||
                    a.vendor.localeCompare(b.vendor));
}

function writeLiveTestTab_(data, verdicts) {
  const sheet = getOrCreateSheet_(CONFIG.LIVE_NAME);
  const n = 7;
  const st = data.stages;
  const any = st.before || st.deny || st.accept;
  const cmp = any && any.cmp ? any.cmp.name : 'Not detected';
  const def = (st.before || any || {}).consentDefault;
  const defText = def ? Object.keys(def).filter(k => /_storage|ad_/.test(k)).map(k => k + '=' + def[k]).join(', ') : 'No gtag consent default seen';
  const gcsText = Object.keys(LIVE_STAGES).map(s => LIVE_STAGES[s] + ': ' + (st[s] ? (st[s].gcs.join('/') || '—') : 'not tested')).join('   ·   ');

  const values = [
    ['🧪 Live Consent Test — ' + (any ? any.url : ''), '', '', '', '', '', ''],
    ['CMP: ' + cmp + '   ·   Consent Mode default: ' + defText, '', '', '', '', '', ''],
    ['Google consent signal (gcs): ' + gcsText, '', '', '', '', '', ''],
    ['Tested: ' + Object.keys(LIVE_STAGES).map(s => LIVE_STAGES[s] + ' ' + (st[s] ? '✓ ' + String(st[s].time || '').substring(0, 16).replace('T', ' ') : '✗')).join('   ·   '), '', '', '', '', '', ''],
    ['Vendor', 'Purpose', 'Before any choice', 'After Deny', 'After Accept', 'Verdict', 'Recommendation']
  ];
  const colors = { High: '#ffcdd2', Check: '#e3f2fd', Info: '#f5f5f5', OK: '#e8f5e9' };
  const bgs = [fill_(CONFIG.HEADER_COLOR, n), fill_('#f1f3f4', n), fill_('#f1f3f4', n), fill_('#f1f3f4', n), fill_('#34495e', n)];

  verdicts.forEach(v => {
    values.push([v.vendor, v.purpose, v.cells.before, v.cells.deny, v.cells.accept, v.verdict, v.recommendation].map(safeCell_));
    bgs.push(fill_(colors[v.verdict] || '#ffffff', n));
  });
  values.push(fill_('', n)); bgs.push(fill_('#ffffff', n));
  values.push(['Other third-party hosts (not recognised — review)', '', '', '', '', '', '']); bgs.push(fill_('#455a64', n));
  Object.keys(LIVE_STAGES).forEach(s => {
    values.push([LIVE_STAGES[s], '', st[s] ? (st[s].other.join(', ') || 'None') : 'Not tested', '', '', '', '']);
    bgs.push(fill_('#ffffff', n));
  });
  values.push(fill_('', n)); bgs.push(fill_('#ffffff', n));
  values.push(['gcs = G1[ad_storage][analytics_storage], 1 = granted, 0 = denied. Only cookie NAMES are read, never values. ' +
               'Results reflect one browser session from one location; server-side tracking is not visible.', '', '', '', '', '', '']);
  bgs.push(fill_('#ffffff', n));

  [170, 95, 260, 260, 260, 75, 380].forEach((w, i) => sheet.setColumnWidth(i + 1, w));
  sheet.getRange(1, 1, values.length, n).setValues(values).setBackgrounds(bgs)
    .setWrap(true).setVerticalAlignment('top').setFontSize(9);
  sheet.getRange(1, 1, 1, n).setFontColor('#ffffff').setFontSize(13).setFontWeight('bold').setWrap(false);
  sheet.getRange(2, 1, 3, n).setWrap(false);
  sheet.getRange(5, 1, 1, n).setFontColor('#ffffff').setFontWeight('bold');
  if (verdicts.length) sheet.getRange(6, 1, verdicts.length, 1).setFontWeight('bold');
  sheet.getRange(values.length, 1).setFontStyle('italic').setFontColor('#5f6368').setWrap(false);
  sheet.setFrozenRows(5);
}

/** Adds stored live-test results to the audit (called by runAuditChecks_). */
function liveTestIssues_() {
  let data = null;
  try { data = JSON.parse(PropertiesService.getDocumentProperties().getProperty(LIVE_PROP_KEY) || 'null'); } catch (e) { data = null; }
  if (!data || !Object.keys(data.stages || {}).length) return;
  const any = data.stages.before || data.stages.deny || data.stages.accept;
  AUDIT.liveTest = { url: any.url, stages: Object.keys(data.stages) };
  const where = 'Live Consent Test · ' + hostOf_(any.url);
  liveTestVerdicts_(data).filter(v => v.verdict === 'High').forEach(v => {
    recordIssue_('Consent', 'High', 'Live test: ' + v.vendor + ' fires without consent',
                 v.recommendation, where, [v.cells.before, v.cells.deny].filter(c => /⚠️/.test(c)));
  });
  if (data.stages.before && !data.stages.before.consentDefault &&
      Object.keys(data.stages.before.vendors).some(v => /^(GA4|Google Ads|Floodlight)/.test(v))) {
    recordIssue_('Consent', 'High', 'Live test: Google tags load with no Consent Mode default',
                 'Set gtag("consent","default",{…denied}) before Google tags load', where);
  }
  const missing = Object.keys(LIVE_STAGES).filter(s => !data.stages[s]);
  if (missing.length) {
    recordIssue_('Consent', 'Low', 'Live test incomplete (missing: ' + missing.map(s => LIVE_STAGES[s]).join(', ') + ')',
                 'Run the snippet in the missing states (Tag Scanner → Live Consent Test)', where, null, { row: false });
  }
}


// ════════════════════════════════════════════════════════════════════
//  10. NETWORK
// ════════════════════════════════════════════════════════════════════

/** Per-execution cache so each container is downloaded once per scan. */
const containerCache_ = {};

function fetchContainer_(id) {
  if (containerCache_[id]) return containerCache_[id];
  const res = httpGet_('https://www.googletagmanager.com/gtm.js?id=' + encodeURIComponent(id),
                       { 'User-Agent': CONFIG.BROWSER_UA, 'Accept': '*/*' });
  const result = {
    code: res ? res.code : 0,
    js:   res && res.code === 200 ? res.text : null
  };
  containerCache_[id] = result;
  return result;
}

function containerSummary_(id) {
  const c = fetchContainer_(id);
  if (!c.js) return 'Container not accessible' + (c.code ? ' (HTTP ' + c.code + ')' : '');
  const data = getContainerData_(id);
  let version, tags;
  if (data && data.resource) {
    version = data.resource.version;
    tags = (data.resource.tags || []).filter(t => !GTM_LISTENERS[t.function] && t.function !== '__tg').length;
  } else {
    version = (c.js.match(/"version"\s*:\s*"([^"]+)"/) || [])[1];
    tags = parseContainerEntries_(c.js).filter(e => e.kind === 'tag').length;
  }
  return ['Version ' + (version || '?'), tags + ' tags', Math.round(c.js.length / 1024) + ' KB'].join(' | ');
}

function httpGet_(url, headers) {
  try {
    const r = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      followRedirects:    true,
      headers:            headers || browserHeaders_()
    });
    return { code: r.getResponseCode(), text: r.getContentText(), headers: r.getHeaders() };
  } catch (e) {
    Logger.log('Fetch failed for ' + url + ': ' + e.message);
    return null;
  }
}

function browserHeaders_(userAgent) {
  return {
    'User-Agent':      userAgent || CONFIG.BROWSER_UA,
    'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control':   'no-cache'
  };
}

/** Fetches a page for scanning, falling back to an archived copy if blocked. */
function fetchPage_(url) {
  const res = httpGet_(url, browserHeaders_());
  if (!res) {
    alert_('❌ Network error', 'Could not reach ' + url);
    return null;
  }

  const blocked = isBotChallenge_(res) || res.code === 403;
  if (!blocked && res.code >= 200 && res.code < 300) {
    Logger.log('Fetched ' + url + ' (' + res.text.length + ' chars)');
    return res.text;
  }

  if (blocked) {
    toast_('Site blocks automated requests — looking for an archived copy…', '🔄', 30);
    const archived = fetchViaWayback_(url);
    if (archived) {
      toast_('ℹ️ Using the Wayback Machine copy — it may not be current', '✅', 8);
      return archived;
    }
    offerAlternatives_(url);
    return null;
  }

  const msg = HTTP_MESSAGES[res.code] || (res.code >= 500 ? 'Server error.' : 'Could not fetch the page.');
  alert_('❌ HTTP ' + res.code, msg + '\n\nURL: ' + url);
  return null;
}

/** Returns HTML only for a clean 200 response that isn't a bot challenge. */
function fetchHtml_(url, userAgent) {
  const res = httpGet_(url, browserHeaders_(userAgent));
  if (!res || res.code !== 200 || isBotChallenge_(res) || res.text.length < 500) return null;
  return res.text;
}

/** Latest Wayback Machine snapshot, requested raw ("id_") so scripts are untouched. */
function fetchViaWayback_(url) {
  const res = httpGet_('https://archive.org/wayback/available?url=' + encodeURIComponent(url),
                       { 'User-Agent': CONFIG.BROWSER_UA });
  if (!res || res.code !== 200) return null;

  let snap;
  try {
    snap = JSON.parse(res.text).archived_snapshots.closest;
  } catch (e) {
    return null;
  }
  if (!snap || !snap.available || !snap.timestamp) return null;

  Logger.log('Wayback snapshot ' + snap.timestamp + ' for ' + url);
  return fetchHtml_('https://web.archive.org/web/' + snap.timestamp + 'id_/' + url, CONFIG.BROWSER_UA);
}

function isBotChallenge_(res) {
  const headers = {};
  Object.keys(res.headers || {}).forEach(k => { headers[k.toLowerCase()] = String(res.headers[k]); });
  if (headers['cf-mitigated'] === 'challenge') return true;

  const head = (res.text || '').substring(0, 3000);
  return /cf-browser-verification|challenge-platform|Checking if the site connection is secure/i.test(head) ||
         (/Just a moment/i.test(head) && /cloudflare|cf-/i.test(head));
}

function buildIdSearchAttempts_(url) {
  const origin = (url.match(/^https?:\/\/[^\/?#]+/i) || [url])[0];
  const attempts = [
    { name: 'Direct fetch',          run: () => fetchHtml_(url, CONFIG.BROWSER_UA) },
    { name: 'Googlebot user agent',  run: () => fetchHtml_(url, CONFIG.GOOGLEBOT_UA) },
    { name: 'Wayback Machine',       run: () => fetchViaWayback_(url) }
  ];
  CONFIG.SUBPAGES.forEach(path => {
    const sub = origin + path;
    if (sub.replace(/\/$/, '') === url.replace(/\/$/, '')) return;
    attempts.push({ name: 'Page ' + path, run: () => fetchHtml_(sub, CONFIG.BROWSER_UA) });
  });
  return attempts;
}

function locateGtmIds_(attempts) {
  for (let i = 0; i < attempts.length; i++) {
    toast_('Trying ' + attempts[i].name + '…', '🔎 GTM Finder', 30);
    const html = attempts[i].run();
    if (!html) continue;
    const ids = uniqueMatches_(html, ID_PATTERNS.GTM);
    if (ids.length) return { ids: ids, html: html, source: attempts[i].name };
  }
  return null;
}

function offerAlternatives_(url) {
  const ui = SpreadsheetApp.getUi();
  const choice = ui.alert(
    '🛡️ Page could not be fetched',
    url + ' blocks automated requests, and no archived copy was found.\n\n' +
    'Two ways around this:\n' +
    '  • Scan the GTM container directly — containers are served by Google, not the site\n' +
    '  • Paste the page source via Tag Scanner → Scan from Pasted HTML\n\n' +
    FIND_GTM_ID_HELP + '\n\nClick OK to open GTM Direct Scan now.',
    ui.ButtonSet.OK_CANCEL
  );
  if (choice === ui.Button.OK) scanGTMDirectly();
}


// ════════════════════════════════════════════════════════════════════
//  11. SHEET OUTPUT
// ════════════════════════════════════════════════════════════════════

function getScannerSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName(CONFIG.SHEET_NAME) || ss.insertSheet(CONFIG.SHEET_NAME);
}

function isSheetSetUp_(sheet) {
  return sheet.getRange('A2').getValue() === CONFIG.URL_LABEL;
}

function ensureScannerSheet_() {
  const sheet = getScannerSheet_();
  if (!isSheetSetUp_(sheet)) setupSheet_(sheet);
  return sheet;
}

function setupSheet_(sheet) {
  const existingUrl = isSheetSetUp_(sheet) ? String(sheet.getRange('B2').getValue()).trim() : '';
  sheet.clear();
  CONFIG.COLUMN_WIDTHS.forEach((w, i) => sheet.setColumnWidth(i + 1, w));

  sheet.getRange(1, 1, 1, CONFIG.NUM_COLS)
    .setBackground(CONFIG.HEADER_COLOR).setFontColor('#ffffff')
    .setFontSize(14).setFontWeight('bold').setVerticalAlignment('middle');
  sheet.getRange('A1').setValue('🔍 GA4 / GTM Tag Scanner');
  sheet.setRowHeight(1, 45);

  sheet.getRange(2, 1, 1, CONFIG.NUM_COLS).setBackground('#f1f3f4');
  sheet.getRange('A2').setValue(CONFIG.URL_LABEL)
    .setFontWeight('bold').setFontColor('#5f6368').setHorizontalAlignment('right');
  sheet.getRange('B2').setValue(existingUrl || CONFIG.PLACEHOLDER_URL)
    .setBackground('#fff9c4').setFontWeight('bold')
    .setBorder(true, true, true, true, false, false, '#f9a825', SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
  sheet.getRange('C2').setValue('← Enter a public URL, then run Tag Scanner → Deep Scan')
    .setFontColor('#9e9e9e').setFontStyle('italic').setFontSize(10);
  sheet.setRowHeight(2, 34);

  sheet.getRange(3, 1, 1, CONFIG.NUM_COLS)
    .setValues([['Tag Type', 'ID / Value', 'Source', 'Details', 'Notes / Recommendations']])
    .setBackground('#34495e').setFontColor('#ffffff')
    .setFontWeight('bold').setHorizontalAlignment('center');
  sheet.setRowHeight(3, 32);

  sheet.setFrozenRows(3);
  sheet.setFrozenColumns(2);
}

function readUrlFromSheet_() {
  const sheet = getScannerSheet_();
  if (!isSheetSetUp_(sheet)) {
    setupSheet_(sheet);
    SpreadsheetApp.getActiveSpreadsheet().setActiveSheet(sheet);
    alert_('Sheet set up', 'Enter a URL in cell B2, then run the scan again.');
    return null;
  }
  const raw = String(sheet.getRange('B2').getValue()).trim().replace(/^["']|["']$/g, '');
  if (!raw || raw === CONFIG.PLACEHOLDER_URL) {
    alert_('❌ No URL entered', 'Enter a public website URL in cell B2.\nExample: https://www.yoursite.com');
    return null;
  }
  return /^https?:\/\//i.test(raw) ? raw : 'https://' + raw;
}

function clearResultRows_(sheet) {
  const first   = CONFIG.FIRST_RESULT_ROW;
  const lastRow = sheet.getLastRow();
  if (lastRow < first) return;
  const range = sheet.getRange(first, 1, lastRow - first + 1, CONFIG.NUM_COLS);
  try { range.breakApart(); } catch (e) { /* nothing merged */ }
  range.clear();
  sheet.setRowHeights(first, lastRow - first + 1, 21);
}

/**
 * Groups rows into categories. Tag rows (row.group set by buildTagRow_) get
 * one group per platform, placed where the "GTM Tags" category sits.
 */
function groupFindings_(rows) {
  const groups = {};
  const tagsAt = CATEGORIES.findIndex(c => c.name === '🏷️ GTM Tags');
  rows.forEach(r => {
    let key, def;
    if (r.group) {
      key = 'tag:' + r.group.key;
      def = { name: r.group.label, plain: r.group.plain, logo: r.group.logo, header: r.group.header,
              color: tint_(r.group.header, 0.88), order: tagsAt + r.group.rank / 1000 };
    } else {
      const idx = CATEGORIES.findIndex(c => c.test.test(r[0]));
      key = 'cat:' + idx;
      def = Object.assign({}, CATEGORIES[idx], { order: idx });
    }
    if (!groups[key]) groups[key] = Object.assign({ rows: [] }, def);
    groups[key].rows.push(r);
  });

  const list = Object.keys(groups).map(k => groups[k]);
  // Inside a tag group: live tags first, then paused; then alphabetical
  list.filter(g => g.rows[0].group).forEach(g => g.rows.sort((a, b) =>
    (/^⏸️/.test(a[0]) - /^⏸️/.test(b[0])) || String(a[1]).localeCompare(String(b[1]))));
  return list.sort((a, b) => (a.order - b.order) || a.name.localeCompare(b.name));
}

/** Writes all results in one batch (much faster than cell-by-cell). */
function writeResults_(sheet, total, groups) {
  const values = [], bgs = [], colors = [], weights = [], sizes = [], styles = [], heights = [];
  const add = (v, bg, color, weight, size, style, h) => {
    values.push(v.map(safeCell_)); bgs.push(bg); colors.push(color);
    weights.push(weight); sizes.push(size); styles.push(style); heights.push(h);
  };
  const n = CONFIG.NUM_COLS;

  add(['📊 TOTAL: ' + total + ' items',
       groups.map(g => g.name + ': ' + g.rows.length).join('   |   '), '', '', ''],
      fill_('#263238', n), ['#ffffff', '#b0bec5', '#ffffff', '#ffffff', '#ffffff'],
      ['bold', 'normal', 'normal', 'normal', 'normal'], [10, 8, 9, 9, 9], fill_('normal', n), 40);

  const logoRows = [];
  groups.forEach(g => {
    const count = g.rows.length + (g.rows.length === 1 ? ' item' : ' items');
    if (g.logo) {
      // Logo in column A (set as a formula below), name in B
      logoRows.push({ index: values.length, url: g.logo });
      add(['', g.plain, count, '', ''], fill_(g.header, n), fill_('#ffffff', n),
          ['normal', 'bold', 'normal', 'normal', 'normal'], [10, 11, 9, 9, 9], fill_('normal', n), 30);
    } else {
      add([g.name, count, '', '', ''], fill_(g.header, n), fill_('#ffffff', n),
          ['bold', 'normal', 'normal', 'normal', 'normal'], [10, 9, 9, 9, 9], fill_('normal', n), 30);
    }

    const alt = lighten_(g.color, 12);
    g.rows.forEach((r, i) => add(
      r, fill_(i % 2 ? alt : g.color, n),
      ['#212121', '#212121', '#546e7a', '#212121', '#78909c'],
      ['bold', 'bold', 'normal', 'normal', 'normal'], [9, 10, 9, 9, 9],
      ['normal', 'normal', 'normal', 'normal', 'italic'], 44
    ));

    add(fill_('', n), fill_('#eceff1', n), fill_('#212121', n),
        fill_('normal', n), fill_(9, n), fill_('normal', n), 8);
  });

  const first = CONFIG.FIRST_RESULT_ROW;
  sheet.getRange(first, 1, values.length, n)
    .setValues(values).setBackgrounds(bgs).setFontColors(colors)
    .setFontWeights(weights).setFontSizes(sizes).setFontStyles(styles)
    .setWrap(true).setVerticalAlignment('middle')
    .setBorder(null, null, true, null, null, true, '#e0e0e0', SpreadsheetApp.BorderStyle.SOLID);
  sheet.getRange(first, 1).setWrap(false);
  setRowHeights_(sheet, first, heights);
  logoRows.forEach(l => {
    sheet.getRange(first + l.index, 1)
      .setFormula('=IMAGE("' + l.url + '", 4, 22, 22)')
      .setBackground('#ffffff');
  });

  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  sheet.getRange(1, n)
    .setValue('Last scan: ' + Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm'))
    .setFontColor('#ffffff').setFontSize(10).setHorizontalAlignment('right');
}

function writeNoResults_(sheet, message) {
  const first = CONFIG.FIRST_RESULT_ROW;
  sheet.getRange(first, 1, 1, CONFIG.NUM_COLS).setBackground(CONFIG.WARNING_BG);
  sheet.getRange(first, 1)
    .setValue('⚠️ ' + message)
    .setFontColor('#e65100').setFontWeight('bold').setWrap(true).setVerticalAlignment('top');
  sheet.setRowHeight(first, 140);
}

function buildSummary_(total, groups, label) {
  const lines = ['Source: ' + label, 'Total items: ' + total, ''];
  groups.forEach(g => lines.push(g.name + ': ' + g.rows.length));

  const warnings = groups.filter(g => g.order === 0)[0];
  if (warnings) {
    lines.push('', 'Needs attention:');
    warnings.rows.slice(0, 6).forEach(r => lines.push('  • ' + r[0] + ' — ' + r[1]));
  }
  const hasLegacy = groups.some(g => g.rows.some(r => /Universal Analytics|Google Optimize/.test(r[0] + r[1])));
  if (hasLegacy) lines.push('', '⚠️ Legacy Universal Analytics / Optimize code found — remove it.');

  if (AUDIT.issues.length) {
    const high = AUDIT.issues.filter(i => i.severity === 'High').length;
    lines.push('', 'Audit: ' + AUDIT.issues.length + ' issue(s), ' + high + ' high priority');
  }
  lines.push('', 'Full results: "' + CONFIG.SHEET_NAME + '" · Overview: "' + CONFIG.SUMMARY_NAME + '"' +
             (AUDIT.tags.length ? ' · Consent: "' + CONFIG.MATRIX_NAME + '"' : '') +
             (Object.keys(AUDIT.ids).length ? ' · IDs: "' + CONFIG.INVENTORY_NAME + '"' : ''));
  const health = overallScore_();
  lines.splice(2, 0, 'Health score: ' + health.score + '/100 (' + health.grade + ')');
  return lines.join('\n');
}

/** Sets row heights, batching consecutive rows of equal height into one call. */
function setRowHeights_(sheet, startRow, heights) {
  let i = 0;
  while (i < heights.length) {
    let j = i;
    while (j + 1 < heights.length && heights[j + 1] === heights[i]) j++;
    sheet.setRowHeights(startRow + i, j - i + 1, heights[i]);
    i = j + 1;
  }
}


// ════════════════════════════════════════════════════════════════════
//  12. TAG GUIDE SHEET
// ════════════════════════════════════════════════════════════════════

const GUIDE_ENTRIES = [
  ['📊 GA4 Measurement ID', 'Google Analytics', 'Identifies a GA4 web data stream', 'All GA4 data flows to the property behind this ID', 'Check it matches GA4 → Admin → Data Streams'],
  ['⚙️ gtag Config Call', 'Google Analytics', 'Initialises GA4 with optional parameters', 'Controls page views, cookies, user ID and more', 'Review any custom parameters'],
  ['⚙️ GA4 Send Page View', 'Google Analytics', 'Whether the tag sends a page_view on load', 'If false, page views must be sent manually', 'Make sure page views are not lost or doubled'],
  ['🐛 GA4 Debug Mode', 'Google Analytics', 'Routes events to DebugView', 'Meant for testing only', '🚨 Turn off in production'],
  ['👤 GA4 User ID', 'Google Analytics', 'Associates sessions with a signed-in user', 'Enables cross-device reporting', 'Never send personal data such as email'],
  ['🖥️ GA4 Server Container URL', 'Google Analytics', 'Sends hits via server-side GTM', 'Data passes through your own server first', 'Check the server container is healthy'],

  ['🏷️ GTM Container', 'Tag Manager', 'A published Google Tag Manager container', 'One container controls all tags on the site', 'Check the right container is live'],
  ['🏷️ GTM Tag', 'Tag Manager', 'An individual tag inside the container', 'Tags send data when their triggers fire', 'Review triggers and consent settings'],
  ['⚡ GTM Listener', 'Tag Manager', 'Auto-event listener (clicks, forms, scroll…)', 'Powers click, form, scroll and visibility triggers', 'Remove listeners nothing uses'],
  ['📌 GTM Custom Event', 'Tag Manager', 'Event name a trigger waits for', 'Fires when the site calls dataLayer.push({event: …})', 'Confirm the site actually pushes it'],
  ['📐 GTM Variable', 'Tag Manager', 'Dynamic value used by tags and triggers', 'Feeds page, user and event data into tags', 'Check variables return expected values'],
  ['⏸️ GTM Tag (Paused)', 'Tag Manager', 'A tag that is paused in GTM', 'It is published but never fires', 'Delete it if it is no longer needed'],
  ['⚡ GTM Trigger', 'Tag Manager', 'A trigger and its conditions (API / export only)', 'Controls when tags fire', 'Remove triggers no tag uses'],
  ['⚡ GTM Trigger Group', 'Tag Manager', 'Fires once all its member triggers have fired', 'Used for "user did A and B" logic', 'Check member triggers still exist'],
  ['📝 GTM Workspace', 'Tag Manager', 'A GTM workspace with unpublished changes (API only)', 'Changes are not live until published', 'Publish or discard stale workspaces'],
  ['📋 Data Layer Variable', 'Tag Manager', 'Value GTM reads from the dataLayer', 'Connects site data to your tags', 'Make sure the site pushes this key'],

  ['🎯 Google Ads Tag', 'Google Ads', 'Google Ads conversion or remarketing tag', 'Reports conversions for bidding', 'Match it to conversion actions in Ads'],
  ['🔗 Conversion Linker', 'Google Ads', 'Stores ad click IDs in first-party cookies', 'Without it conversions can be under-reported', '✅ Should fire on every page'],

  ['✅ Consent Signal', 'Consent Mode', 'A Consent Mode storage / data signal', 'Controls what Google tags may store or send', 'Defaults should match your consent requirements'],
  ['✅ Consent Mode Version', 'Consent Mode', 'v1 or v2 of Consent Mode', 'v2 adds ad_user_data and ad_personalization', 'Use v2 for EEA traffic (since March 2024)'],
  ['⚠️ No Consent Default', 'Consent Mode', 'No consent default found in page source', 'Tags may fire before consent is known', 'Set defaults before tags load (page or CMP)'],

  ['🛒 Ecommerce Event', 'Ecommerce', 'A GA4 recommended ecommerce event', 'Drives funnel and revenue reports', 'Validate item arrays with GTM Preview'],

  ['📦 dataLayer.push()', 'Data Layer', 'Data the page sends to GTM', 'Passes events and values into tags', 'Check pushed data is complete and accurate'],

  ['💳 Payment Domain Referenced', 'Referrals', 'A payment provider appears in the code', 'Return visits from it can steal attribution', 'Add it to GA4\'s list of unwanted referrals'],

  ['🔗 Cross-Domain Domain', 'Cross-Domain', 'Domain listed in linker configuration', 'Keeps one session across your domains', 'Check every listed domain is yours'],

  ['🍪 Cookie Expiry', 'Cookies', 'How long GA4 cookies last', 'Default is 2 years', 'Check against your privacy policy'],
  ['🍪 Cookie Flags', 'Cookies', 'SameSite / Secure attributes', 'Controls cross-site cookie behaviour', 'SameSite=None requires Secure'],

  ['🧩 Third-Party Tag', 'Third-Party', 'A non-Google pixel or script', 'Shares visitor data with another vendor', 'Make sure it respects consent'],

  ['⚠️ Universal Analytics (Legacy)', 'Warnings', 'Old UA code still present', 'UA stopped processing data in July 2024', '🗑️ Remove it'],
  ['⚠️ Audit Warning', 'Warnings', 'Container housekeeping issue (API / export)', 'Unused, paused or legacy items and missing consent checks', 'Work through the list in GTM'],
  ['🔑 MP API Secret EXPOSED', 'Warnings', 'Measurement Protocol secret in public code', 'Anyone could send fake events to your property', '🚨 Rotate the secret immediately']
];

const GUIDE_COLORS = {
  'Google Analytics': '#e3f2fd', 'Tag Manager': '#e8f5e9', 'Google Ads': '#fff3e0',
  'Consent Mode': '#f3e8fd',     'Ecommerce': '#e0f2f1',   'Data Layer': '#fff8e1',
  'Referrals': '#fce8e6',        'Cross-Domain': '#e8eaf6', 'Cookies': '#fffde7',
  'Third-Party': '#ede7f6',      'Warnings': '#ffcdd2'
};

function createTagGuideSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let guide = ss.getSheetByName(CONFIG.GUIDE_NAME);
  if (guide) { ss.setActiveSheet(guide); return; }

  guide = ss.insertSheet(CONFIG.GUIDE_NAME);
  [220, 130, 340, 320, 260].forEach((w, i) => guide.setColumnWidth(i + 1, w));

  guide.getRange(1, 1, 1, 5).merge()
    .setValue('📖 GA4 / GTM Tag Reference Guide')
    .setBackground(CONFIG.HEADER_COLOR).setFontColor('#ffffff')
    .setFontSize(14).setFontWeight('bold').setVerticalAlignment('middle');
  guide.setRowHeight(1, 45);

  guide.getRange(2, 1, 1, 5)
    .setValues([['Finding', 'Category', 'What it is', 'Why it matters', 'What to do']])
    .setBackground('#37474f').setFontColor('#ffffff')
    .setFontWeight('bold').setHorizontalAlignment('center');
  guide.setRowHeight(2, 30);
  guide.setFrozenRows(2);

  const values = [], bgs = [], heights = [], headerRows = [];
  let lastCat = '';
  GUIDE_ENTRIES.forEach(entry => {
    if (entry[1] !== lastCat) {
      headerRows.push(values.length);
      values.push([entry[1].toUpperCase(), '', '', '', '']);
      bgs.push(fill_('#455a64', 5));
      heights.push(26);
      lastCat = entry[1];
    }
    values.push(entry);
    bgs.push(fill_(GUIDE_COLORS[entry[1]] || '#f5f5f5', 5));
    heights.push(52);
  });

  const first = 3;
  guide.getRange(first, 1, values.length, 5)
    .setValues(values).setBackgrounds(bgs)
    .setWrap(true).setVerticalAlignment('top').setFontSize(9);
  guide.getRange(first, 1, values.length, 1).setFontWeight('bold');
  guide.getRange(first, 5, values.length, 1).setFontWeight('bold');
  headerRows.forEach(i => {
    guide.getRange(first + i, 1, 1, 5).merge()
      .setFontColor('#ffffff').setFontWeight('bold').setFontSize(10).setVerticalAlignment('middle');
  });
  setRowHeights_(guide, first, heights);

  ss.setActiveSheet(guide);
  toast_('Tag Guide created', '📖', 5);
}


// ════════════════════════════════════════════════════════════════════
//  13. PASTE DIALOG
// ════════════════════════════════════════════════════════════════════

const PASTE_DIALOG_HTML_ = [
  '<style>',
  '  body { font-family: Arial, sans-serif; margin: 0; font-size: 13px; }',
  '  textarea { width: 100%; height: 330px; box-sizing: border-box; font: 11px monospace; }',
  '  button { margin-top: 8px; padding: 8px 18px; background: #1a73e8; color: #fff;',
  '           border: 0; border-radius: 4px; cursor: pointer; }',
  '  button:disabled { background: #9e9e9e; }',
  '  #out { white-space: pre-wrap; font-size: 12px; max-height: 380px; overflow: auto;',
  '         background: #f1f3f4; padding: 10px; border-radius: 4px; display: none; }',
  '  #msg { margin-left: 8px; color: #5f6368; }',
  '</style>',
  '<p>Open the page in your browser, press <b>Ctrl+U</b>, then <b>Ctrl+A</b> and <b>Ctrl+C</b>, and paste below.</p>',
  '<textarea id="src" placeholder="Paste page source here…"></textarea>',
  '<div id="out"></div>',
  '<button id="go" onclick="run()">Scan</button><span id="msg"></span>',
  '<script>',
  '  function run() {',
  '    var src = document.getElementById("src").value;',
  '    var msg = document.getElementById("msg");',
  '    if (src.length < 50) { msg.textContent = "Paste the page source first."; return; }',
  '    var go = document.getElementById("go");',
  '    go.disabled = true; msg.textContent = "Scanning… (GTM containers are downloaded too)";',
  '    google.script.run',
  '      .withSuccessHandler(function (summary) {',
  '        document.getElementById("src").style.display = "none";',
  '        var out = document.getElementById("out");',
  '        out.textContent = summary; out.style.display = "block";',
  '        msg.textContent = ""; go.disabled = false; go.textContent = "Close";',
  '        go.onclick = function () { google.script.host.close(); };',
  '      })',
  '      .withFailureHandler(function (err) {',
  '        msg.textContent = "Error: " + err.message; go.disabled = false;',
  '      })',
  '      .processPastedHtml(src);',
  '  }',
  '</script>'
].join('\n');


const EXPORT_DIALOG_HTML_ = [
  '<style>',
  '  body { font-family: Arial, sans-serif; margin: 0; font-size: 13px; }',
  '  textarea { width: 100%; height: 250px; box-sizing: border-box; font: 11px monospace; }',
  '  button { margin-top: 8px; padding: 8px 18px; background: #1a73e8; color: #fff;',
  '           border: 0; border-radius: 4px; cursor: pointer; }',
  '  button:disabled { background: #9e9e9e; }',
  '  #out { white-space: pre-wrap; font-size: 12px; max-height: 400px; overflow: auto;',
  '         background: #f1f3f4; padding: 10px; border-radius: 4px; display: none; }',
  '  #msg { margin-left: 8px; color: #5f6368; }',
  '  .box { border: 1px dashed #9e9e9e; padding: 10px; border-radius: 4px; margin-bottom: 8px; }',
  '</style>',
  '<p>In GTM open <b>Admin → Export Container</b>, choose the live version, and export the JSON file.</p>',
  '<div id="input">',
  '  <div class="box"><b>Upload the file:</b> <input type="file" id="file" accept=".json,application/json"></div>',
  '  <div>…or paste its contents:</div>',
  '  <textarea id="src" placeholder="{ &quot;exportFormatVersion&quot;: 2, &quot;containerVersion&quot;: … }"></textarea>',
  '</div>',
  '<div id="out"></div>',
  '<button id="go" onclick="run()">Import & Analyse</button><span id="msg"></span>',
  '<script>',
  '  document.getElementById("file").addEventListener("change", function (e) {',
  '    var f = e.target.files[0]; if (!f) return;',
  '    var reader = new FileReader();',
  '    reader.onload = function () { document.getElementById("src").value = reader.result;',
  '      document.getElementById("msg").textContent = f.name + " loaded (" + Math.round(f.size / 1024) + " KB)"; };',
  '    reader.readAsText(f);',
  '  });',
  '  function run() {',
  '    var src = document.getElementById("src").value.trim();',
  '    var msg = document.getElementById("msg");',
  '    if (!src) { msg.textContent = "Upload or paste the export first."; return; }',
  '    var go = document.getElementById("go");',
  '    go.disabled = true; msg.textContent = "Analysing…";',
  '    google.script.run',
  '      .withSuccessHandler(function (summary) {',
  '        document.getElementById("input").style.display = "none";',
  '        var out = document.getElementById("out");',
  '        out.textContent = summary; out.style.display = "block";',
  '        msg.textContent = ""; go.disabled = false; go.textContent = "Close";',
  '        go.onclick = function () { google.script.host.close(); };',
  '      })',
  '      .withFailureHandler(function (err) {',
  '        msg.textContent = "Error: " + err.message; go.disabled = false;',
  '      })',
  '      .processContainerExport(src);',
  '  }',
  '</script>'
].join('\n');


// ════════════════════════════════════════════════════════════════════
//  14. UTILITIES
// ════════════════════════════════════════════════════════════════════

/** Joins the truthy parts with " | ". Returns '' if none. */
function joinParts_() {
  return Array.prototype.slice.call(arguments).filter(Boolean).join(' | ');
}

function firstDefined_() {
  for (let i = 0; i < arguments.length; i++) {
    if (arguments[i] !== undefined && arguments[i] !== null) return arguments[i];
  }
  return undefined;
}

/** One result row: [Tag Type, ID / Value, Source, Details, Notes]. */
function row_(type, value, source, details, notes) {
  return [type, String(value == null ? '' : value), source || '', details || '', notes || ''];
}

function runSafely_(label, fn) {
  try {
    fn();
  } catch (e) {
    Logger.log(label + ' failed: ' + (e.stack || e.message));
    alert_('❌ ' + label + ' failed', e.message);
  }
}

function alert_(title, message) {
  const ui = SpreadsheetApp.getUi();
  ui.alert(title, message, ui.ButtonSet.OK);
}

function toast_(message, title, seconds) {
  SpreadsheetApp.getActiveSpreadsheet().toast(message, title, seconds);
}

function uniqueMatches_(text, globalRegex) {
  return Array.from(new Set(String(text).match(globalRegex) || []));
}

function dedupe_(rows) {
  const seen = new Set();
  return rows.filter(r => {
    const key = (r[0] + '|' + r[1] + '|' + r[2]).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function countBy_(items, keyFn) {
  const counts = new Map();
  items.forEach(item => {
    const k = keyFn(item);
    counts.set(k, (counts.get(k) || 0) + 1);
  });
  return Array.from(counts, ([key, count]) => ({ key, count }));
}

/**
 * Reads a GA/gtag setting from either format:
 *   GTM parameter table:  "cookie_expires","parameterValue","63072000"
 *   gtag object literal:  cookie_expires: 63072000
 * Returns null when the setting is not present.
 */
function getSetting_(text, key) {
  const k = escapeRegex_(key);
  let m = text.match(new RegExp('"' + k + '"\\s*,\\s*"(?:value|parameterValue)"\\s*,\\s*"([^"]*)"'));
  if (m) return m[1] || null;
  if (new RegExp('"' + k + '"\\s*,\\s*"(?:value|parameterValue)"\\s*,\\s*\\[\\s*"macro"').test(text)) {
    return '(set by a GTM variable)';
  }
  m = text.match(new RegExp('(?:^|[{,\\s])["\']?' + k + '["\']?\\s*:\\s*(?:["\']([^"\']*)["\']|([\\w.]+))'));
  if (m) return (m[1] !== undefined ? m[1] : m[2]) || null;
  return null;
}

function describeCookieExpiry_(value) {
  const seconds = parseInt(value, 10);
  if (isNaN(seconds)) return 'Expiry: ' + value;
  if (seconds === 0) return 'Session cookie (expires when the browser closes)';
  const days = Math.round(seconds / 86400);
  let text = days + ' days (' + (days / 365).toFixed(1) + ' years)';
  if (days < 30) text += ' — ⚠️ very short';
  if (days > 730) text += ' — longer than the GA4 default of 2 years';
  return text;
}

function keyValuePairs_(text) {
  const pairs = [];
  const re = /['"]?([A-Za-z_][\w]*)['"]?\s*:\s*['"]?([^'",{}]{1,60})['"]?/g;
  let m;
  while ((m = re.exec(text)) !== null && pairs.length < 8) {
    pairs.push(m[1] + ': ' + m[2].trim());
  }
  return pairs;
}

/** Turns escaped JS string content (\/  \x3c  \u003c  \n …) into plain text. */
function unescapeJs_(text) {
  return String(text)
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\[nrt]/g, ' ')
    .replace(/\\(.)/g, '$1');
}

function isValidDomain_(domain) {
  return /^[a-z0-9][a-z0-9\-.]{1,}\.[a-z]{2,}$/i.test(domain) &&
         domain.length < 80 &&
         !/^\d+\.\d+/.test(domain) &&
         !/\.(js|css|png|jpg|gif|svg|html?)$/i.test(domain);
}

function escapeRegex_(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function truncate_(s, max) {
  s = String(s || '');
  return s.length > max ? s.substring(0, max - 1) + '…' : s;
}

function maskSecret_(s) {
  return s.length <= 8 ? s : s.substring(0, 4) + '…' + s.substring(s.length - 4);
}

function fill_(value, n) {
  return Array(n).fill(value);
}

/** Prevents values like "=…" or "+…" from being interpreted as formulas. */
function safeCell_(v) {
  const s = String(v == null ? '' : v);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function lighten_(hex, amount) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return '#' + [16, 8, 0]
    .map(shift => Math.min(255, ((n >> shift) & 255) + amount).toString(16).padStart(2, '0'))
    .join('');
}
