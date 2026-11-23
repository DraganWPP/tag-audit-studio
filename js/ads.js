// ════════════════════════════════════════════════════════════════════
//  Google Ads API (optional permission "adwords")
//
//  Google Ads has no read-only permission. This app only ever calls the read endpoints
//  (listAccessibleCustomers and googleAds:search with GAQL SELECT queries); what an analyst
//  could change is limited by their own role in each Google Ads account.
//  Every call needs the agency's developer token (from the manager account's API Center),
//  entered in Settings and kept in this browser only.
// ════════════════════════════════════════════════════════════════════

const ADS_VERSIONS = ['v23', 'v22'];   // newest first; the first that answers is used
let adsVersion_ = null;

function adsDigits_(id) { return String(id || '').replace(/\D/g, ''); }

function adsHeaders_(opt, loginId) {
  const h = { 'developer-token': String(opt.devToken || '').trim() };
  const login = adsDigits_(loginId || opt.loginId);
  if (login) h['login-customer-id'] = login;
  return h;
}

async function adsFetch_(path, opt, init, loginId) {
  if (!String(opt.devToken || '').trim()) throw new Error('Enter the Google Ads developer token in Settings first.');
  const versions = adsVersion_ ? [adsVersion_] : ADS_VERSIONS;
  let last;
  for (const v of versions) {
    try {
      const res = await Google.request('https://googleads.googleapis.com/' + v + '/' + path,
        Object.assign({}, init || {}, { headers: Object.assign({}, (init || {}).headers || {}, adsHeaders_(opt, loginId)) }));
      adsVersion_ = v;
      return res;
    } catch (e) {
      last = e;
      if (e.status !== 404 || adsVersion_) throw e;   // a retired version answers 404; try the next one
    }
  }
  throw last;
}

/** Customer IDs the signed-in user can reach directly (not through a manager). */
async function adsAccessibleCustomers(opt) {
  const res = await adsFetch_('customers:listAccessibleCustomers', opt, { method: 'GET' });
  return (res.resourceNames || []).map(r => r.split('/').pop());
}

/** Runs a GAQL query (all pages). loginId: the manager account the customer is reached through. */
async function adsSearch(customerId, query, opt, loginId) {
  const out = [];
  let token = '';
  do {
    const res = await adsFetch_('customers/' + adsDigits_(customerId) + '/googleAds:search', opt, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ query: query }, token ? { pageToken: token } : {}))
    }, loginId);
    (res.results || []).forEach(r => out.push(r));
    token = res.nextPageToken || '';
  } while (token && out.length < 50000);
  return out;
}

const ADS_CUSTOMER_FIELDS = 'customer.id, customer.descriptive_name, customer.manager, customer.test_account, customer.status, ' +
  'customer.auto_tagging_enabled, customer.conversion_tracking_setting.conversion_tracking_id, ' +
  'customer.conversion_tracking_setting.cross_account_conversion_tracking_id, ' +
  'customer.conversion_tracking_setting.conversion_tracking_status, ' +
  'customer.conversion_tracking_setting.enhanced_conversions_for_leads_enabled, ' +
  'customer.conversion_tracking_setting.accepted_customer_data_terms';

async function adsCustomer(customerId, opt, loginId) {
  const rows = await adsSearch(customerId, 'SELECT ' + ADS_CUSTOMER_FIELDS + ' FROM customer', opt, loginId);
  return rows[0] ? rows[0].customer : null;
}

/** Client accounts under a manager account (all levels), without the manager itself. */
async function adsClients(managerId, opt) {
  const rows = await adsSearch(managerId, 'SELECT customer_client.id, customer_client.descriptive_name, customer_client.manager, ' +
    'customer_client.status, customer_client.level, customer_client.test_account FROM customer_client WHERE customer_client.level > 0', opt, managerId);
  return rows.map(r => r.customerClient);
}

/** "AW-123456789" → "123456789". */
function adsConversionId_(aw) { return adsDigits_(String(aw || '').replace(/^AW-/i, '')); }

/** Conversion ID/label pairs in a conversion action's tag snippets ("AW-123/abcDEF"). */
function adsSnippetLabels_(action) {
  const out = [];
  (action.tagSnippets || []).forEach(s => {
    const text = (s.eventSnippet || '') + ' ' + (s.globalSiteTag || '');
    const re = /AW-(\d+)\/([\w-]+)/g;
    let m;
    while ((m = re.exec(text))) { const k = m[1] + '/' + m[2]; if (out.indexOf(k) < 0) out.push(k); }
  });
  return out;
}
