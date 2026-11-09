// ════════════════════════════════════════════════════════════════════
//  Tag Audit Studio — audit engine
//  Ported from the TagScanner Apps Script. Pure analysis: no network, no UI.
//  Browser-specific replacements live in engine-web.js (loaded after this file).
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
  // AI / analyst overrides (engine-web.js) can name the vendor of an unknown tag
  o.key = source + '|' + (o.name || summary);
  const ov = tagOverride_(o.key);
  let group = tagGroupOf_(o.type || '', allText, [o.name, o.templateName, ov && ov.vendor]);
  if (ov && ov.vendor && /no known vendor|Other Tags/.test(group.label)) group = overrideGroup_(ov);
  recordTag_(o, value.replace(/^\S+\s/, ''), summary, source, group);

  const row = row_((o.paused ? '⏸️ Paused · ' : '🏷️ ') + label, value, source, details, notes);
  row.group = group;   // used by groupFindings_ to file the row under its platform
  return row;
}

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
  const vendor = vendorEntry ? vendorEntry[0] : (tagOverride_(o.key) && tagOverride_(o.key).vendor) || null;
  const ov = tagOverride_(o.key);
  const purpose = ov && ov.purpose ? ov.purpose
                : vendorEntry ? vendorEntry[2] : (TAG_PURPOSE[o.type] || 'unknown');

  const rec = {
    label: label, summary: summary, where: source, type: o.type || '',
    platform: group ? group.label.replace(/^\S+\s/, '').replace(/ Tags.*$/, '') : '',
    key: o.key, ai: ov || null, aiVendor: ov && ov.vendor ? ov.vendor : null,
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

const RISK_COLORS = { High: '#ffcdd2', Medium: '#fff3cd', Check: '#e3f2fd', OK: '#e8f5e9', '—': '#eeeeee' };

const SEVERITY_COLORS = { High: '#ffcdd2', Medium: '#fff3cd', Low: '#e3f2fd' };

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
