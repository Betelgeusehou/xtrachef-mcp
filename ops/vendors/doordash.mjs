// DoorDash Merchant Portal adapter -> delivery_orders, delivery_payouts.
//
// Files: Merchant Portal > Reports > Create report > Financials >
//   "Transactions breakdown" (order level)  -> delivery_orders
//   "Payouts"                                -> delivery_payouts
// Column names come from DoorDash's published report schemas (TRANSACTION_DETAIL v4,
// PAYOUT_SUMMARY v3+) at developer.doordash.com; the portal CSV uses the same fields
// as title-case headers. Headers are matched after normalization (case, spaces,
// punctuation stripped), so "DoorDash order ID" == "doordash_order_id".
// Full column list with VERIFIED/ASSUMED marks: ops/vendors/DELIVERY.md.
import {
  csvRows, getter, finalizeOrders, finalizePayouts, emptyResult, mergeResults, round2, abs2, sum2,
  fromDomain, isTabular, collectWithFallback, paginate, runUiDownload, urlLooksLoggedIn, dateWindows,
  ShapeError, requireArray, dig,
} from './_delivery-common.mjs';

const VENDOR = 'doordash';

// ---------------------------------------------------------------------------
// Session-mode endpoints.
// UNVERIFIED until confirmed with: npm run ops:record doordash
// No public source documents the Merchant Portal's internal JSON API. Paths and
// response paths below are placeholders shaped like the portal's financial
// views; ops:record captures the real ones and they get pasted here. Every
// response is checked and a mismatch throws "endpoint shape changed: ..." so the
// runner falls back to the UI download / inbox.
// ---------------------------------------------------------------------------
export const ENDPOINTS = {
  base: 'https://merchant-portal.doordash.com',
  stores: {
    label: 'stores',
    method: 'GET',
    url: 'https://merchant-portal.doordash.com/merchant-portal-api/v1/stores',
    itemsPath: ['stores', 'data.stores', 'results'],
  },
  transactions: {
    label: 'transactions',
    method: 'GET',
    url: 'https://merchant-portal.doordash.com/merchant-portal-api/v1/financials/transactions?store_id={store_id}&start_date={from}&end_date={through}&limit={limit}&cursor={cursor}',
    itemsPath: ['transactions', 'data.transactions', 'results'],
    cursorPath: ['next_cursor', 'pagination.next_cursor', 'data.next_cursor'],
    pageSize: 200,
    windowDays: 31,
  },
  payouts: {
    label: 'payouts',
    method: 'GET',
    url: 'https://merchant-portal.doordash.com/merchant-portal-api/v1/financials/payouts?store_id={store_id}&start_date={from}&end_date={through}&limit={limit}&offset={offset}',
    itemsPath: ['payouts', 'data.payouts', 'results'],
    pageSize: 100,
    windowDays: 92,
  },
};

// UI fallback: build a Financials report and download it.
// UNVERIFIED until confirmed with: npm run ops:record doordash
// Steps follow DoorDash's own instructions (Reports > Create report > Financials >
// Transactions breakdown / Payouts > date range > Create report), selectors are text based.
export const SELECTORS = {
  loggedInShell: 'nav, [data-anchor-id="SideNav"], [data-testid="side-nav"]',
  transactions: {
    reportsUrl: 'https://merchant-portal.doordash.com/merchant/reports',
    steps: [
      { click: 'button:has-text("Create report")' },
      { click: 'text=Financials' },
      { click: 'text=Transactions breakdown' },
      { fill: 'input[name="startDate"], input[placeholder*="Start"]', value: '{from_us}' },
      { fill: 'input[name="endDate"], input[placeholder*="End"]', value: '{through_us}' },
      { click: 'button:has-text("Create report")' },
    ],
    download: 'a:has-text("Download"), button:has-text("Download")',
    maxWaitMs: 600_000,
  },
  payouts: {
    reportsUrl: 'https://merchant-portal.doordash.com/merchant/reports',
    steps: [
      { click: 'button:has-text("Create report")' },
      { click: 'text=Financials' },
      { click: 'text=Payouts' },
      { fill: 'input[name="startDate"], input[placeholder*="Start"]', value: '{from_us}' },
      { fill: 'input[name="endDate"], input[placeholder*="End"]', value: '{through_us}' },
      { click: 'button:has-text("Create report")' },
    ],
    download: 'a:has-text("Download"), button:has-text("Download")',
    maxWaitMs: 600_000,
  },
};

// ------------------------------------------------------------ field aliases --
// Each list: DoorDash schema name first, then older portal export labels, then
// camelCase JSON spellings (normalization makes snake/camel/title identical).
export const F = {
  store: ['store_name', 'Store name', 'store', 'storeName', 'store_display_name', 'merchant_store_name'],
  store_id: ['store_id', 'Store ID'],
  order_id: ['doordash_order_id', 'DoorDash order ID', 'delivery_uuid', 'order_id', 'orderId', 'delivery_id'],
  txn_id: ['transaction_id', 'Transaction ID', 'doordash_transaction_id'],
  txn_type: ['transaction_type', 'Transaction type', 'type'],
  local_date: ['timestamp_local_date', 'Timestamp local date', 'local_date'],
  local_time: ['timestamp_local_time', 'Timestamp local time', 'local_time', 'created_at_local'],
  utc_date: ['timestamp_utc_date', 'Timestamp UTC date'],
  utc_time: ['timestamp_utc_time', 'Timestamp UTC time'],
  utc: ['created_at', 'timestamp_utc', 'createdAt', 'timestamp'],
  status: ['final_order_status', 'Final order status', 'order_status', 'status'],
  description: ['description', 'Description'],
  subtotal: ['subtotal', 'Subtotal', 'Sales (subtotal)'],
  // Texas is a marketplace-facilitator state: DoorDash collects and remits the
  // sales tax, so the merchant is passed only part (usually none) of tax_subtotal.
  tax_passed: ['subtotal_tax_passed_to_merchant', 'Subtotal tax passed to merchant', 'tax_passed_to_merchant'],
  tax_subtotal: ['tax_subtotal', 'Tax (subtotal)', 'Tax subtotal', 'subtotal_tax'],
  tax_remitted: ['subtotal_tax_remitted_by_doordash_to_tax_authorities', 'total_tax_remitted_by_doordash_to_tax_authorities', 'tax_remitted_by_doordash_to_state'],
  staff_tip: ['staff_tip', 'Staff tip', 'tips', 'Tips', 'merchant_tip'],
  commission: ['commission', 'Commission'],
  commission_tax: ['commission_tax', 'Commission tax'],
  processing_fee: ['payment_processing_fee', 'Payment processing fee', 'processing_fee', 'merchant_fees', 'Merchant fees'],
  merchant_fee_tax: ['tax_merchant_fees', 'Tax (merchant fees)', 'merchant_fees_tax'],
  other_fees: [
    ['tablet_fee'], ['tablet_fee_tax'], ['printer_fee'], ['printer_fee_tax'], ['alcohol_flat_fee'], ['alcohol_flat_fee_tax'],
    ['flexible_fulfillment_flat_fee'], ['flexible_fulfillment_flat_fee_tax'], ['drive_charge'],
  ],
  marketing_fee: ['marketing_fees_including_any_applicable_taxes', 'Marketing fees | (including any applicable taxes)', 'Marketing fees (including any applicable taxes)', 'marketing_fees', 'Marketing fees', 'marketing_fee'],
  discounts_you: ['customer_discounts_from_marketing_funded_by_you', 'Customer discounts from marketing | (funded by you)'],
  dd_marketing_credit: ['doordash_marketing_credit', 'DoorDash marketing credit'],
  third_party: ['third_party_contribution', 'Third-party contribution'],
  error_charges: ['error_charges', 'Error charges', 'error_charge'],
  adjustments: ['adjustments', 'Adjustments', 'adjustment'],
  net_total: ['net_total', 'Net total', 'net_payout_amount', 'netTotal'],
  credit: ['credit', 'Credit'],
  debit: ['debit', 'Debit'],
  payout_id: ['payout_id', 'Payout ID', 'payoutId', 'transfer_id'],
  payout_date: ['payout_date', 'Payout date', 'payoutDate', 'paid_at'],
  payout_status: ['payout_status', 'Payout status'],
  // payouts report
  period_start: ['transaction_start_local_date', 'Transaction start local date', 'start_date', 'period_start', 'Start date'],
  period_end: ['transaction_end_local_date', 'Transaction end local date', 'end_date', 'period_end', 'End date'],
  net_payout: ['net_payout', 'Net payout', 'netPayout', 'amount'],
  total_before_adjustments: ['total_before_adjustments', 'Total before adjustments'],
};
const flatAliases = Object.values(F).flatMap(v => (Array.isArray(v[0]) ? v.flat() : v));

// --------------------------------------------------------------- row mapping --
// Accept a CSV row object (normalized keys) or a JSON item. Return a partial
// for finalizeOrders / finalizePayouts.

// Tax the merchant actually receives: the explicit passed-to-merchant column, or
// tax_subtotal minus what DoorDash remitted.
function merchantTax(g) {
  const passed = g.num(F.tax_passed);
  if (passed !== null) return passed;
  const total = g.num(F.tax_subtotal);
  if (total === null) return null;
  return round2(total - Math.abs(g.num(F.tax_remitted) || 0));
}

function marketingCost(g) {
  const fee = abs2(g.num(F.marketing_fee)) || 0;
  const you = abs2(g.num(F.discounts_you)) || 0;
  const credit = abs2(g.num(F.dd_marketing_credit)) || 0;
  const third = abs2(g.num(F.third_party)) || 0;
  return { cost: round2(fee + you - credit - third), fee, you, credit, third };
}
function otherFees(g) {
  const parts = {};
  for (const a of F.other_fees) { const n = g.num(a); if (n) parts[a[0]] = abs2(n); }
  return parts;
}

export function mapOrderRow(row) {
  const g = getter(row);
  const type = g.str(F.txn_type);
  const commission = sum2(abs2(g.num(F.commission)), abs2(g.num(F.commission_tax)));
  const other = otherFees(g);
  const processing = sum2(abs2(g.num(F.processing_fee)), abs2(g.num(F.merchant_fee_tax)), ...Object.values(other));
  const mk = marketingCost(g);
  let payout = g.num(F.net_total);
  if (payout === null && (g.has(F.credit) || g.has(F.debit))) payout = round2((g.num(F.credit) || 0) - Math.abs(g.num(F.debit) || 0));
  const utcDate = g.str(F.utc_date);
  const utc = utcDate ? `${utcDate}T${g.str(F.utc_time) || '12:00:00'}Z` : g.raw(F.utc);
  const errorCharges = g.num(F.error_charges);
  return {
    order_id: g.str(F.order_id),
    store_label: g.str(F.store),
    time: { localDate: g.str(F.local_date), localTime: g.str(F.local_time), utc },
    status: g.str(F.status) || type,
    channel: type ? type.toLowerCase() : null,
    row_type: type,
    subtotal: g.num(F.subtotal),
    tax: merchantTax(g),
    tip: g.num(F.staff_tip),
    commission: commission || (g.has(F.commission) ? 0 : null),
    processing_fee: processing || (g.has(F.processing_fee) || Object.keys(other).length ? 0 : null),
    marketing_fee: g.has(F.marketing_fee) || g.has(F.discounts_you) ? mk.cost : null,
    error_charges: errorCharges,
    adjustments: g.num(F.adjustments),
    payout,
    payout_id: g.str(F.payout_id),
    payout_date: g.str(F.payout_date),
    line: row.__line,
    extra: {
      store_id: g.str(F.store_id) || undefined,
      transaction_id: g.str(F.txn_id) || undefined,
      description: g.str(F.description) || undefined,
      tax_collected: g.num(F.tax_subtotal) ?? undefined,
      tax_remitted_by_doordash: g.num(F.tax_remitted) ?? undefined,
      other_fees: Object.keys(other).length ? other : undefined,
      marketing_breakdown: mk.you || mk.credit || mk.third ? { fees: mk.fee, discounts_funded_by_you: mk.you, doordash_credit: mk.credit, third_party: mk.third } : undefined,
      payout_status: g.str(F.payout_status) || undefined,
    },
  };
}

export function mapPayoutRow(row) {
  const g = getter(row);
  const subtotal = g.num(F.subtotal) || 0, tax = merchantTax(g) || 0, tips = g.num(F.staff_tip) || 0;
  const commission = sum2(abs2(g.num(F.commission)), abs2(g.num(F.commission_tax)));
  const other = otherFees(g);
  const processing = sum2(abs2(g.num(F.processing_fee)), ...Object.values(other));
  const mk = marketingCost(g);
  const adjustments = round2((g.num(F.adjustments) || 0) - Math.abs(g.num(F.error_charges) || 0));
  return {
    payout_id: g.str(F.payout_id),
    store_label: g.str(F.store),
    payout_date: g.str(F.payout_date),
    period_start: g.str(F.period_start),
    period_end: g.str(F.period_end),
    gross_sales: round2(subtotal + tax + tips),
    total_fees: round2(commission + processing + mk.cost),
    adjustments,
    net_payout: g.num(F.net_payout) ?? g.num(F.net_total),
    line: row.__line,
    extra: {
      store_id: g.str(F.store_id) || undefined,
      subtotal, tax, tips, commission, processing_fee: processing, marketing_fee: mk.cost,
      error_charges: abs2(g.num(F.error_charges)) || 0,
      payout_status: g.str(F.payout_status) || undefined,
      total_before_adjustments: g.num(F.total_before_adjustments) ?? undefined,
    },
  };
}

// --------------------------------------------------------------- file parse --

export function detectReport(headers) {
  const h = new Set(headers);
  if (['doordashorderid', 'deliveryuuid'].some(k => h.has(k))) return 'orders';
  if (h.has('payoutid') && (h.has('netpayout') || h.has('transactionstartlocaldate'))) return 'payouts';
  if (['ddordernumber', 'orderitemid'].some(k => h.has(k))) return 'order_items';
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
      const p = mapOrderRow(r);
      // Ad fees / payout-level adjustments have no order id: not an order.
      if (!p.order_id) { res.stats.rows++; res.stats.skipped_other++; res.stats.non_order_rows = (res.stats.non_order_rows || 0) + 1; continue; }
      partials.push(p);
    }
    finalizeOrders(VENDOR, partials, res);
  } else if (type === 'payouts') {
    finalizePayouts(VENDOR, rows.map(mapPayoutRow), res);
  } else if (type === 'order_items') {
    res.stats.ignored = 'item-level Order Details report (no fees); use Transactions breakdown';
  } else {
    res.stats.ignored = `unrecognized DoorDash file${meta.filename ? ` ${meta.filename}` : ''}`;
  }
  return res;
}

export function matchFile(meta = {}) {
  const name = String(meta.filename || '');
  const subject = String(meta.subject || '');
  if (/\.(pdf|png|jpe?g)$/i.test(name)) return false;
  const byName = /doordash|door_dash|financial_?(detailed|summary|transactions|payout)|transactions?_(breakdown|overview|detail)|payout_?summary/i.test(name);
  const bySender = fromDomain(meta.from, ['doordash.com']);
  if (!isTabular(meta) && !/\.zip$/i.test(name)) return false;
  return bySender || (byName && (/doordash/i.test(name) || /doordash/i.test(subject)));
}

// ------------------------------------------------------------- session mode --

export async function isLoggedIn(ctx) {
  return urlLooksLoggedIn(ctx, {
    host: 'merchant-portal.doordash.com',
    loginPatterns: [/identity\.doordash\.com/, /\/login/i, /\/signin/i, /\/auth/i],
    shellSelector: SELECTORS.loggedInShell,
  });
}

async function collectViaApi(ctx, range) {
  const stores = await paginate(ctx, ENDPOINTS.stores);
  if (!stores.length) throw new ShapeError('stores: empty list');
  const res = emptyResult();
  for (const s of stores) {
    const store_id = dig(s, ['id', 'store_id', 'storeId']);
    const name = dig(s, ['name', 'store_name', 'storeName', 'business_name']);
    if (!store_id) throw new ShapeError('stores: missing id');
    const orderPartials = [];
    for (const w of dateWindows(range, ENDPOINTS.transactions.windowDays)) {
      const items = await paginate(ctx, ENDPOINTS.transactions, { store_id, from: w.from, through: w.through });
      for (const it of items) {
        if (!dig(it, ['doordash_order_id', 'doordashOrderId', 'delivery_uuid', 'order_id', 'transaction_type', 'transactionType']))
          throw new ShapeError('transactions: item missing doordash_order_id/transaction_type');
        if (dig(it, ['subtotal']) === undefined && dig(it, ['net_total', 'netTotal', 'credit']) === undefined)
          throw new ShapeError('transactions: item missing subtotal/net_total');
        const p = mapOrderRow({ store_name: name, ...it });
        if (!p.order_id) { res.stats.rows++; res.stats.skipped_other++; continue; }
        orderPartials.push(p);
      }
    }
    const pr = emptyResult();
    finalizeOrders(VENDOR, orderPartials, pr);
    mergeResults(res, pr);
    const payoutPartials = [];
    for (const w of dateWindows(range, ENDPOINTS.payouts.windowDays)) {
      const items = await paginate(ctx, ENDPOINTS.payouts, { store_id, from: w.from, through: w.through });
      for (const it of items) {
        if (!dig(it, ['payout_id', 'payoutId', 'id'])) throw new ShapeError('payouts: item missing payout_id');
        if (dig(it, ['net_payout', 'netPayout', 'amount']) === undefined) throw new ShapeError('payouts: item missing net_payout');
        payoutPartials.push(mapPayoutRow({ store_name: name, payout_id: dig(it, ['payout_id', 'payoutId', 'id']), ...it }));
      }
    }
    const pp = emptyResult();
    finalizePayouts(VENDOR, payoutPartials, pp);
    mergeResults(res, pp);
  }
  return res;
}

async function collectViaUi(ctx, range) {
  const res = emptyResult();
  for (const key of ['transactions', 'payouts']) {
    const { buffer, filename } = await runUiDownload(ctx.page, SELECTORS[key], range);
    mergeResults(res, parseFile(buffer, { filename }));
  }
  return res;
}

export async function collect(ctx, range) {
  return collectWithFallback(ctx, range, { vendor: VENDOR, viaApi: () => collectViaApi(ctx, range), viaUi: () => collectViaUi(ctx, range) });
}

export default {
  id: VENDOR,
  name: 'DoorDash Merchant',
  domain: 'delivery',
  modes: ['session', 'inbox', 'drive'],
  kinds: ['delivery_orders', 'delivery_payouts'],
  loginUrl: 'https://merchant-portal.doordash.com/',
  handoffDomains: ['doordash.com'],
  // no login(): DoorDash sign-in (identity.doordash.com) is bot-checked; sessions come from handoff.
  isLoggedIn,
  collect,
  matchFile,
  parseFile,
};

// exported for tests
export { requireArray };
