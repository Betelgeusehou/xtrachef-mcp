// Grubhub for Restaurants adapter -> delivery_orders, delivery_payouts.
//
// Files: restaurant.grubhub.com > Financials > Transactions > Download (CSV, one row
// per transaction: orders, adjustments, cancellations) -> delivery_orders, plus
// payouts derived from the deposit columns; Financials > Deposits/Statements
// export -> delivery_payouts.
// Grubhub publishes no column spec. Fee categories are VERIFIED from Lunchbox's
// and other reconciliation glossaries (Commission, Delivery Commission, Payment
// Transaction Fee, Marketing Fee, Tax Remitted, Tips, Net Payout); exact header
// spellings are ASSUMED and matched through wide alias lists.
// Run `npm run ops:record grubhub` once and replace aliases with what the file shows.
// See ops/vendors/DELIVERY.md.
import {
  csvRows, getter, finalizeOrders, finalizePayouts, derivePayouts, emptyResult, mergeResults, round2, abs2, sum2,
  fromDomain, isTabular, collectWithFallback, paginate, runUiDownload, urlLooksLoggedIn, dateWindows,
  ShapeError, dig, normHeader,
} from './_delivery-common.mjs';

const VENDOR = 'grubhub';

// ---------------------------------------------------------------------------
// Session-mode endpoints.
// UNVERIFIED until confirmed with: npm run ops:record grubhub
// Host api-gtm.grubhub.com is the gateway Grubhub's web apps call (it also
// appears in jentic.com/apis/grubhub with /restaurants/{id}/reports/financials and
// /reports/orders; that catalog is not an official source). The restaurant
// portal authenticates with a bearer token kept in the page's storage; ctx.api
// runs inside the page so token lookup happens there (see authHeaders()).
// ---------------------------------------------------------------------------
export const ENDPOINTS = {
  base: 'https://api-gtm.grubhub.com',
  restaurants: {
    label: 'restaurants',
    method: 'GET',
    url: 'https://api-gtm.grubhub.com/merchant/v1/restaurants?page={page}&page_size={limit}',
    itemsPath: ['restaurants', 'merchants', 'results', 'data'],
    pageSize: 50,
    firstPage: 1,
  },
  transactions: {
    label: 'transactions',
    method: 'GET',
    url: 'https://api-gtm.grubhub.com/merchant/v1/restaurants/{restaurant_id}/reports/financials/transactions?start_date={from}&end_date={through}&page={page}&page_size={limit}',
    itemsPath: ['transactions', 'results', 'data.transactions'],
    pageSize: 100,
    firstPage: 1,
    windowDays: 31,
  },
  deposits: {
    label: 'deposits',
    method: 'GET',
    url: 'https://api-gtm.grubhub.com/merchant/v1/restaurants/{restaurant_id}/reports/financials/deposits?start_date={from}&end_date={through}&page={page}&page_size={limit}',
    itemsPath: ['deposits', 'results', 'data.deposits'],
    pageSize: 100,
    firstPage: 1,
    windowDays: 92,
  },
};

// UI fallback. UNVERIFIED until confirmed with: npm run ops:record grubhub
export const SELECTORS = {
  loggedInShell: 'nav, [data-testid="navigation"], a[href*="/financials"]',
  transactions: {
    reportsUrl: 'https://restaurant.grubhub.com/financials/transactions',
    steps: [
      { click: 'button:has-text("Date"), [data-testid="date-range-picker"]' },
      { fill: 'input[name="startDate"], input[placeholder*="Start"]', value: '{from_us}' },
      { fill: 'input[name="endDate"], input[placeholder*="End"]', value: '{through_us}' },
      { click: 'button:has-text("Apply")' },
    ],
    download: 'button:has-text("Download"), a:has-text("Download"), button:has-text("Export")',
    maxWaitMs: 120_000,
    reloadWhilePolling: false,
  },
};

// ------------------------------------------------------------ field aliases --
export const F = {
  store: ['Restaurant', 'Restaurant Name', 'restaurant_name', 'Location', 'Store', 'Store Name', 'restaurantName', 'merchant_name'],
  restaurant_id: ['Restaurant ID', 'restaurant_id', 'restaurantId', 'merchant_id'],
  order_id: ['Order Number', 'Order #', 'Order', 'order_number', 'orderNumber', 'Order ID', 'order_id'],
  txn_id: ['Transaction ID', 'transaction_id', 'transactionId'],
  txn_type: ['Transaction Type', 'Type', 'transaction_type', 'transactionType'],
  fulfillment: ['Fulfillment Type', 'Fulfillment', 'Order Type', 'fulfillment_type', 'fulfillmentType', 'Order Method'],
  channel: ['Order Channel', 'Channel', 'order_channel', 'Brand'],
  date: ['Order Date', 'Date', 'Transaction Date', 'order_date', 'transaction_date', 'orderDate'],
  time: ['Order Time', 'Time', 'Transaction Time', 'order_time', 'orderTime'],
  utc: ['timestamp', 'time_placed', 'timePlaced', 'transaction_time_utc', 'created_at'],
  status: ['Status', 'Order Status', 'status'],
  subtotal: ['Subtotal', 'Food Subtotal', 'Order Subtotal', 'subtotal', 'food_and_beverage'],
  delivery_fee: ['Delivery Fee', 'Self Delivery Fee', 'self_delivery_charge', 'delivery_fee', 'deliveryFee'],
  service_fee: ['Restaurant Service Fee', 'Service Fee', 'service_fee'],
  tax: ['Sales Tax', 'Tax', 'Restaurant Sales Tax', 'sales_tax', 'subtotal_sales_tax', 'tax'],
  withheld_tax: ['Withheld Tax', 'Tax Withheld', 'Marketplace Facilitator Tax', 'Tax Remitted By Grubhub', 'withheld_tax', 'withheldTax', 'tax_withheld'],
  tip: ['Tip', 'Tips', 'tip', 'tips'],
  total: ['Total', 'Order Total', 'total', 'orderTotal'],
  commission: ['Commission', 'Marketing Commission', 'Marketing Fee', 'commission', 'marketing_commission'],
  delivery_commission: ['Delivery Commission', 'Grubhub Delivery Commission', 'delivery_commission', 'deliveryCommission'],
  processing_fee: ['Processing Fee', 'Payment Transaction Fee', 'Credit Card Processing Fee', 'processing_fee', 'processingFee'],
  promo: ['Promotion', 'Promo', 'Promo Value', 'Restaurant Funded Promotion', 'Merchant Funded Promotion', 'promotion', 'merchant_funded_promotion'],
  loyalty: ['Loyalty', 'Restaurant Funded Loyalty', 'loyalty'],
  targeted_promo: ['Targeted Promotion', 'targeted_promotion'],
  adjustment: ['Adjustment', 'Adjustments', 'Refund', 'Refunds and Adjustments', 'adjustment', 'adjustments'],
  error_charges: ['Error Charges', 'Error Charge', 'Order Error Charge', 'error_charges'],
  other: ['Other Payments', 'Other', 'other_payments'],
  net: ['Restaurant Total', 'Net Payout', 'Net Total', 'Merchant Net Total', 'Net', 'Payout', 'restaurant_total', 'merchant_net_total', 'net_total', 'netPayout'],
  deposit_id: ['Deposit ID', 'Deposit Number', 'Payout ID', 'Settlement ID', 'deposit_id', 'payout_id', 'depositId'],
  deposit_date: ['Deposit Date', 'Payout Date', 'Payment Date', 'deposit_date', 'payout_date', 'depositDate'],
  period_start: ['Period Start', 'Start Date', 'Statement Start', 'period_start', 'periodStart'],
  period_end: ['Period End', 'End Date', 'Statement End', 'period_end', 'periodEnd'],
  deposit_amount: ['Deposit Amount', 'Deposit Total', 'Amount', 'Net Deposit', 'deposit_amount', 'amount'],
  gross: ['Gross Sales', 'Total Sales', 'Gross Order Subtotals', 'Revenue', 'gross_sales'],
  fees: ['Total Fees', 'Fees', 'Total Fees and Commissions', 'total_fees'],
};
const flatAliases = Object.values(F).flat();

// --------------------------------------------------------------- row mapping --
// Grubhub shows deductions as negatives in its transactions export (commission,
// processing fee, withheld tax). abs() keeps fees positive regardless.
export function mapOrderRow(row) {
  const g = getter(row);
  const n = a => g.num(a) || 0;
  const type = g.str(F.txn_type);
  const subtotal = g.num(F.subtotal);
  const tax = g.has(F.tax) ? round2(n(F.tax) - Math.abs(n(F.withheld_tax))) : null;
  const commission = sum2(abs2(g.num(F.commission)), abs2(g.num(F.delivery_commission)));
  const processing = abs2(g.num(F.processing_fee));
  const marketing = round2(Math.abs(n(F.promo)) + Math.abs(n(F.loyalty)) + Math.abs(n(F.targeted_promo)));
  const adjustments = round2(n(F.adjustment) + n(F.other) + n(F.delivery_fee) + n(F.service_fee));
  const isError = /error/i.test(type || '');
  return {
    order_id: g.str(F.order_id),
    store_label: g.str(F.store),
    time: { localDate: g.str(F.date), localTime: g.str(F.time), utc: g.raw(F.utc) },
    status: (g.str(F.status) || type || '').toLowerCase() || null,
    channel: [g.str(F.fulfillment), g.str(F.channel)].filter(Boolean).join(' / ') || null,
    row_type: type,
    subtotal,
    tax,
    tip: g.num(F.tip),
    commission: g.has(F.commission) || g.has(F.delivery_commission) ? commission : null,
    processing_fee: processing,
    marketing_fee: g.has(F.promo) || g.has(F.loyalty) || g.has(F.targeted_promo) ? marketing : null,
    error_charges: abs2(g.num(F.error_charges)) || (isError ? abs2(g.num(F.adjustment)) : 0),
    adjustments: isError ? round2(adjustments - n(F.adjustment)) : adjustments,
    payout: g.num(F.net),
    payout_id: g.str(F.deposit_id),
    payout_date: g.str(F.deposit_date),
    line: row.__line,
    extra: {
      transaction_id: g.str(F.txn_id) || undefined,
      restaurant_id: g.str(F.restaurant_id) || undefined,
      order_total: g.num(F.total) ?? undefined,
      tax_withheld_by_grubhub: g.num(F.withheld_tax) ?? undefined,
      delivery_commission: g.num(F.delivery_commission) ?? undefined,
      self_delivery_fee: g.num(F.delivery_fee) ?? undefined,
    },
  };
}

export function mapPayoutRow(row) {
  const g = getter(row);
  return {
    payout_id: g.str(F.deposit_id),
    store_label: g.str(F.store),
    payout_date: g.str(F.deposit_date),
    period_start: g.str(F.period_start),
    period_end: g.str(F.period_end),
    gross_sales: g.num(F.gross),
    total_fees: abs2(g.num(F.fees)),
    adjustments: g.num(F.adjustment),
    net_payout: g.num(F.deposit_amount) ?? g.num(F.net),
    line: row.__line,
    extra: { restaurant_id: g.str(F.restaurant_id) || undefined },
  };
}

// --------------------------------------------------------------- file parse --
export function detectReport(headers) {
  const h = new Set(headers);
  const any = list => list.some(a => h.has(normHeader(a)));
  // Grubhub's aliases are broad; refuse files that carry another vendor's signature columns.
  if (['doordashorderid', 'transactionstartlocaldate', 'merchantstoreid', 'workflowid', 'payoutreferenceid', 'marketplacefee'].some(k => h.has(k))) return null;
  if (any(F.order_id) && (any(F.net) || any(F.commission))) return 'orders';
  if (any(F.deposit_id) && any([...F.deposit_amount, ...F.net])) return 'payouts';
  return null;
}

export function parseFile(buffer, meta = {}) {
  const { headers, rows } = csvRows(buffer, flatAliases);
  const res = emptyResult();
  const type = detectReport(headers);
  res.stats.report = type;
  if (type === 'orders') {
    const partials = [];
    for (const r of rows) {
      // Footer "Total" rows: no order id but money columns filled.
      const p = mapOrderRow(r);
      if (!p.order_id || /^total/i.test(p.order_id)) { res.stats.rows++; res.stats.skipped_other++; continue; }
      partials.push(p);
    }
    finalizeOrders(VENDOR, partials, res);
    finalizePayouts(VENDOR, derivePayouts(VENDOR, res.delivery_orders), res);
    res.stats.rows -= res.delivery_payouts.length;
  } else if (type === 'payouts') {
    finalizePayouts(VENDOR, rows.map(mapPayoutRow), res);
  } else {
    res.stats.ignored = `unrecognized Grubhub file${meta.filename ? ` ${meta.filename}` : ''}`;
  }
  return res;
}

export function matchFile(meta = {}) {
  const name = String(meta.filename || '');
  const subject = String(meta.subject || '');
  if (!isTabular(meta) && !/\.zip$/i.test(name)) return false;
  const bySender = fromDomain(meta.from, ['grubhub.com', 'seamless.com']);
  const byName = /grub[\s_-]?hub|seamless/i.test(name) || (/transactions?|deposits?|statement/i.test(name) && /grub[\s_-]?hub/i.test(subject));
  return bySender || byName;
}

// ------------------------------------------------------------- session mode --
export async function isLoggedIn(ctx) {
  return urlLooksLoggedIn(ctx, {
    host: 'restaurant.grubhub.com',
    loginPatterns: [/\/login/i, /\/signin/i, /\/auth/i],
    shellSelector: SELECTORS.loggedInShell,
  });
}

// Pull the portal's bearer token out of page storage (runs in the page).
async function authHeaders(ctx) {
  if (!ctx.page?.evaluate) return {};
  const token = await ctx.page.evaluate(() => {
    for (const store of [window.localStorage, window.sessionStorage]) {
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i), v = store.getItem(k) || '';
        if (!/token|auth|session/i.test(k)) continue;
        try { const j = JSON.parse(v); const t = j.access_token || j.accessToken || j.token || j?.credential?.access_token; if (t) return t; } catch { if (/^[\w-]+\.[\w-]+\.[\w-]+$/.test(v)) return v; }
      }
    }
    return null;
  }).catch(() => null);
  return token ? { authorization: `Bearer ${token}` } : {};
}

function checkTxn(it) {
  const keys = new Set(Object.keys(it).map(normHeader));
  const has = aliases => aliases.some(a => keys.has(normHeader(a)));
  if (!has(F.order_id)) throw new ShapeError('transactions: item missing order_number');
  if (!has(F.net)) throw new ShapeError('transactions: item missing restaurant_total/net');
}

async function collectViaApi(ctx, range) {
  const headers = await authHeaders(ctx);
  const withAuth = spec => ({ ...spec, headers: { ...(spec.headers || {}), ...headers } });
  const restaurants = await paginate(ctx, withAuth(ENDPOINTS.restaurants));
  if (!restaurants.length) throw new ShapeError('restaurants: empty list');
  const res = emptyResult();
  for (const r of restaurants) {
    const restaurant_id = dig(r, ['restaurant_id', 'restaurantId', 'id', 'merchant_id']);
    const name = dig(r, ['name', 'restaurant_name', 'restaurantName', 'short_name']);
    if (!restaurant_id) throw new ShapeError('restaurants: missing id');
    const partials = [];
    for (const w of dateWindows(range, ENDPOINTS.transactions.windowDays)) {
      for (const it of await paginate(ctx, withAuth(ENDPOINTS.transactions), { restaurant_id, from: w.from, through: w.through })) {
        checkTxn(it);
        const p = mapOrderRow({ restaurant_name: name, ...it });
        if (p.order_id) partials.push(p);
      }
    }
    const pr = emptyResult();
    finalizeOrders(VENDOR, partials, pr);
    const deposits = [];
    for (const w of dateWindows(range, ENDPOINTS.deposits.windowDays)) {
      for (const it of await paginate(ctx, withAuth(ENDPOINTS.deposits), { restaurant_id, from: w.from, through: w.through })) {
        if (!dig(it, ['deposit_id', 'depositId', 'payout_id', 'id'])) throw new ShapeError('deposits: item missing deposit_id');
        if (dig(it, ['deposit_amount', 'amount', 'net_payout', 'netPayout']) === undefined) throw new ShapeError('deposits: item missing amount');
        deposits.push(mapPayoutRow({ restaurant_name: name, deposit_id: dig(it, ['deposit_id', 'depositId', 'payout_id', 'id']), ...it }));
      }
    }
    const real = new Set(deposits.map(d => String(d.payout_id)));
    finalizePayouts(VENDOR, [...deposits, ...derivePayouts(VENDOR, pr.delivery_orders).filter(d => !real.has(String(d.payout_id)))], pr);
    mergeResults(res, pr);
  }
  return res;
}

async function collectViaUi(ctx, range) {
  const { buffer, filename } = await runUiDownload(ctx.page, SELECTORS.transactions, range);
  return parseFile(buffer, { filename });
}

export async function collect(ctx, range) {
  return collectWithFallback(ctx, range, { vendor: VENDOR, viaApi: () => collectViaApi(ctx, range), viaUi: () => collectViaUi(ctx, range) });
}

export default {
  id: VENDOR,
  name: 'Grubhub for Restaurants',
  domain: 'delivery',
  modes: ['session', 'inbox', 'drive'],
  kinds: ['delivery_orders', 'delivery_payouts'],
  loginUrl: 'https://restaurant.grubhub.com/login',
  handoffDomains: ['grubhub.com'],
  // no login(): restaurant.grubhub.com/login is an email + password form, but no
  // public source confirms whether it adds a bot check or verification step.
  // Use handoff until ops:record shows a plain form; see DELIVERY.md.
  isLoggedIn,
  collect,
  matchFile,
  parseFile,
};
