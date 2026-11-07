// Uber Eats Manager adapter -> delivery_orders, delivery_payouts.
//
// Files: Uber Eats Manager > Reports > Create report >
//   "Payment details" (one row per order, US layout)  -> delivery_orders (+ payouts
//                                                        derived from Payout reference ID)
//   "Payout summary"                                   -> delivery_payouts
// Payment details columns are VERIFIED against Uber's help article "Reviewing
// Payment Details Report" (US list). Payout summary columns are ASSUMED.
// See ops/vendors/DELIVERY.md.
import {
  csvRows, getter, finalizeOrders, finalizePayouts, derivePayouts, emptyResult, mergeResults, round2, abs2, sum2,
  fromDomain, isTabular, collectWithFallback, paginate, runUiDownload, urlLooksLoggedIn, dateWindows,
  ShapeError, dig, normHeader,
} from './_delivery-common.mjs';
import { canonicalStore } from '../core/stores.mjs';

const VENDOR = 'ubereats';

// ---------------------------------------------------------------------------
// Session-mode endpoints.
// UNVERIFIED until confirmed with: npm run ops:record ubereats
// The official Reporting API (POST https://api.uber.com/v1/eats/report, report
// types incl. "Payment Details Report", 32-day max range) needs an Uber partner
// OAuth app; operators don't get one. The Manager web app's internal calls are
// not publicly documented; these are placeholders in the shape of its JSON
// (POST + JSON body, cursor pagination). Responses are validated and a mismatch
// throws "endpoint shape changed: ..." so the runner falls back.
// ---------------------------------------------------------------------------
export const ENDPOINTS = {
  base: 'https://merchants.ubereats.com',
  stores: {
    label: 'stores',
    method: 'POST',
    url: 'https://merchants.ubereats.com/manager/api/getStores',
    body: {},
    headers: { 'x-csrf-token': 'x' }, // Uber web apps accept a literal "x" CSRF header
    itemsPath: ['data.stores', 'stores'],
  },
  paymentDetails: {
    label: 'paymentDetails',
    method: 'POST',
    url: 'https://merchants.ubereats.com/manager/api/getPaymentDetails',
    body: { storeUUIDs: ['{store_id}'], startDate: '{from}', endDate: '{through}', cursor: '{cursor}', limit: '{limit}' },
    headers: { 'x-csrf-token': 'x' },
    itemsPath: ['data.orders', 'data.paymentDetails', 'orders'],
    cursorPath: ['data.nextCursor', 'data.pagination.nextCursor', 'nextCursor'],
    pageSize: 200,
    windowDays: 31, // mirrors the official API's 32-day cap
  },
  payouts: {
    label: 'payouts',
    method: 'POST',
    url: 'https://merchants.ubereats.com/manager/api/getPayouts',
    body: { storeUUIDs: ['{store_id}'], startDate: '{from}', endDate: '{through}', cursor: '{cursor}' },
    headers: { 'x-csrf-token': 'x' },
    itemsPath: ['data.payouts', 'payouts'],
    cursorPath: ['data.nextCursor', 'nextCursor'],
    windowDays: 92,
  },
};

// UI fallback. UNVERIFIED until confirmed with: npm run ops:record ubereats
// Flow per Uber/Loop docs: Reports > Create report > Payment details > dates > Create.
export const SELECTORS = {
  loggedInShell: 'nav, [data-testid="sidebar"], [data-baseweb="side-navigation"]',
  paymentDetails: {
    reportsUrl: 'https://merchants.ubereats.com/manager/reports',
    steps: [
      { click: 'button:has-text("Create report")' },
      { click: 'text=Payment details' },
      { fill: 'input[aria-label*="Start"], input[placeholder*="Start"]', value: '{from_us}' },
      { fill: 'input[aria-label*="End"], input[placeholder*="End"]', value: '{through_us}' },
      { click: 'button:has-text("Create report"), button:has-text("Request")' },
    ],
    download: 'a:has-text("Download"), button:has-text("Download")',
    maxWaitMs: 600_000,
  },
};

// ------------------------------------------------------------ field aliases --
export const F = {
  store: ['Store Name', 'storeName', 'store_name', 'store'],
  store_id: ['Store ID', 'storeId', 'externalStoreId', 'storeUUID'],
  order_id: ['Order ID', 'orderId', 'displayId', 'order_display_id'],
  workflow_id: ['Workflow ID', 'workflowId', 'workflowUUID', 'orderUUID', 'order_uuid'],
  dining_mode: ['Dining Mode', 'diningMode', 'fulfillmentType'],
  payment_mode: ['Payment Mode', 'paymentMode'],
  order_channel: ['Order Channel', 'orderChannel'],
  status: ['Order Status', 'orderStatus', 'status'],
  order_date: ['Order Date', 'orderDate', 'date'],
  accept_time: ['Order Accept Time', 'orderAcceptTime', 'acceptTime', 'Order Time'],
  utc: ['orderAcceptedAt', 'createdAt', 'acceptedAtUTC', 'timestamp'],
  sales: ['Sales (excl. tax)', 'Sales (excluding tax)', 'Food Sales (excluding tax)', 'salesExclTax', 'sales'],
  tax_on_sales: ['Tax on Sales', 'Tax_on_sales', 'Tax on Food Sales', 'taxOnSales'],
  sales_incl: ['Sales (incl. tax)', 'Sales (including tax)'],
  price_adj: ['Price Adjustments (excl. tax)', 'Price Adjustments (excluding tax)', 'priceAdjustments'],
  tax_price_adj: ['Tax on Price Adjustments', 'Tax_on_price_adjustments', 'Tax on Adjustments', 'taxOnPriceAdjustments'],
  promo_items: ['Promotions on items', 'Promotions on Food', 'promotionsOnItems'],
  tax_promo_items: ['Tax on Promotions on items', 'Tax_on_Promotion_on_items', 'Tax on Promotion on Food', 'taxOnPromotionsOnItems'],
  promo_delivery: ['Promotions on delivery', 'promotionsOnDelivery'],
  tax_promo_delivery: ['Tax on Promotions on delivery', 'Tax_on_Promotions_on_Delivery', 'taxOnPromotionsOnDelivery'],
  bag_fee: ['Bag Fee', 'bagFee'],
  marketing_adj: ['Marketing adjustment', 'marketingAdjustment'],
  total_after_adj: ['Total Sales after Adjustments (incl. tax)', 'Total Sales after Adjustments (including tax)'],
  marketplace_fee: ['Marketplace fee', 'Marketplace Fee', 'marketplaceFee'],
  marketplace_fee_pct: ['Marketplace fee %', 'marketplaceFeePercent'],
  delivery_network_fee: ['Delivery Network Fee', 'deliveryNetworkFee'],
  order_processing_fee: ['Order Processing Fee', 'orderProcessingFee'],
  merchant_fee: ['Merchant Fee', 'merchantFee'],
  tax_merchant_fee: ['Tax on Merchant Fee', 'Tax_on_Merchant_Fee', 'taxOnMerchantFee'],
  tips: ['Tips', 'tips'],
  other_payments: ['Other payments', 'otherPayments'],
  other_desc: ['Other payments description', 'otherPaymentsDescription'],
  mf_tax: ['Marketplace Facilitator Tax', 'Marketplace facilitator tax', 'marketplaceFacilitatorTax'],
  backup_withholding: ['Backup Withholding Tax', 'backupWithholdingTax'],
  refund_incl: ['Refund (incl. tax)', 'Refunds (incl. tax)', 'refundInclTax'],
  refund_excl: ['Refund (excl. tax)', 'refundExclTax'],
  tax_refund: ['Tax on Refund', 'taxOnRefund'],
  total_payout: ['Total payout', 'Total Payout', 'totalPayout', 'payout'],
  payout_date: ['Payout Date', 'payoutDate'],
  payout_ref: ['Payout reference ID', 'Payout Reference ID', 'payoutReferenceId', 'payoutId', 'Payout ID'],
  payout_status: ['Payout Status', 'payoutStatus'],
  markup: ['Markup Amount', 'markupAmount'],
  markup_tax: ['Markup Tax', 'markupTax'],
  // payout summary (ASSUMED)
  period_start: ['Payout Period Start', 'Period Start', 'Start Date', 'periodStart', 'startDate'],
  period_end: ['Payout Period End', 'Period End', 'End Date', 'periodEnd', 'endDate'],
  order_count: ['Number of Orders', 'Orders', 'orderCount'],
};
const flatAliases = Object.values(F).flat();

// --------------------------------------------------------------- row mapping --
// Uber reports deductions as negative numbers (marketplace fee, promotions,
// marketplace facilitator tax, refunds). Total payout =
//   sales + tax on sales + price adj (+tax) + promotions (+tax) + bag fee + marketing adj
//   + marketplace fee + delivery network fee + order processing fee + merchant fee (+tax)
//   + tips + other payments + marketplace facilitator tax + backup withholding + refunds
export function mapOrderRow(row) {
  const g = getter(row);
  const n = a => g.num(a) || 0;
  const subtotal = g.num(F.sales);
  // In Texas (marketplace facilitator state) Uber collects the tax and deducts it
  // again as Marketplace Facilitator Tax, so the merchant's tax nets to ~0.
  const tax = round2(n(F.tax_on_sales) + n(F.mf_tax));
  const commission = abs2(-n(F.marketplace_fee));
  const processing = abs2(-(n(F.delivery_network_fee) + n(F.order_processing_fee)));
  const marketing = round2(-(n(F.promo_items) + n(F.tax_promo_items) + n(F.promo_delivery) + n(F.tax_promo_delivery) + n(F.marketing_adj)));
  const refunds = n(F.refund_incl) || round2(n(F.refund_excl) + n(F.tax_refund));
  const adjustments = round2(n(F.price_adj) + n(F.tax_price_adj) + n(F.bag_fee) + n(F.merchant_fee) + n(F.tax_merchant_fee)
    + n(F.other_payments) + n(F.backup_withholding) + n(F.markup) + n(F.markup_tax));
  const status = g.str(F.status);
  const workflow = g.str(F.workflow_id);
  const display = g.str(F.order_id);
  return {
    // Workflow ID is Uber's unique order UUID; the short Order ID is what the tablet shows.
    order_id: workflow || display,
    store_label: g.str(F.store),
    time: { localDate: g.str(F.order_date), localTime: g.str(F.accept_time), utc: g.raw(F.utc) },
    status: status ? status.toLowerCase() : null,
    channel: [g.str(F.dining_mode), g.str(F.order_channel)].filter(Boolean).join(' / ') || null,
    row_type: status,
    subtotal,
    tax,
    tip: g.num(F.tips),
    commission,
    processing_fee: processing,
    marketing_fee: marketing,
    // Refunds charged back to the store are Uber's "error charges".
    error_charges: refunds < 0 ? abs2(refunds) : 0,
    adjustments: round2(adjustments + (refunds > 0 ? refunds : 0)),
    payout: g.num(F.total_payout),
    payout_id: g.str(F.payout_ref),
    payout_date: g.str(F.payout_date),
    line: row.__line,
    extra: {
      display_order_id: display && display !== workflow ? display : undefined,
      store_id: g.str(F.store_id) || undefined,
      payment_mode: g.str(F.payment_mode) || undefined,
      tax_on_sales: g.num(F.tax_on_sales) ?? undefined,
      marketplace_facilitator_tax: g.num(F.mf_tax) ?? undefined,
      marketplace_fee_pct: g.str(F.marketplace_fee_pct) || undefined,
      other_payments_description: g.str(F.other_desc) || undefined,
      payout_status: g.str(F.payout_status) || undefined,
    },
  };
}

export function mapPayoutRow(row) {
  const g = getter(row);
  const n = a => g.num(a) || 0;
  const gross = round2(n(F.sales) + n(F.tax_on_sales) + n(F.mf_tax) + n(F.tips));
  const fees = round2(-(n(F.marketplace_fee) + n(F.delivery_network_fee) + n(F.order_processing_fee))
    - (n(F.promo_items) + n(F.tax_promo_items) + n(F.promo_delivery) + n(F.tax_promo_delivery) + n(F.marketing_adj)));
  const adjustments = round2(n(F.price_adj) + n(F.tax_price_adj) + n(F.bag_fee) + n(F.merchant_fee) + n(F.tax_merchant_fee)
    + n(F.other_payments) + n(F.backup_withholding) + (n(F.refund_incl) || n(F.refund_excl) + n(F.tax_refund)));
  return {
    payout_id: g.str(F.payout_ref),
    store_label: g.str(F.store),
    payout_date: g.str(F.payout_date),
    period_start: g.str(F.period_start),
    period_end: g.str(F.period_end),
    gross_sales: gross,
    total_fees: fees,
    adjustments,
    net_payout: g.num(F.total_payout),
    line: row.__line,
    extra: { store_id: g.str(F.store_id) || undefined, order_count: g.num(F.order_count) ?? undefined, payout_status: g.str(F.payout_status) || undefined },
  };
}

// Uber's CSVs put a one-line description under the header ("Store name as listed in
// Uber Eats Manager", ...). Those rows have no money in them.
function isDescriptionRow(row) {
  const g = getter(row);
  const money = [F.sales, F.total_payout, F.marketplace_fee, F.tips].map(a => g.raw(a)).filter(v => v !== null);
  return money.length > 0 && money.every(v => /[a-z]{3,}/i.test(String(v)) && !/^\(?-?\$?[\d,.]+\)?$/.test(String(v)));
}

// --------------------------------------------------------------- file parse --
export function detectReport(headers) {
  const h = new Set(headers);
  if ((h.has('workflowid') || h.has('orderid')) && h.has('totalpayout')) return 'orders';
  if (h.has('payoutreferenceid') && h.has('totalpayout')) return 'payouts';
  return null;
}

export function parseFile(buffer, meta = {}) {
  const { headers, rows } = csvRows(buffer, flatAliases);
  const res = emptyResult();
  const type = detectReport(headers);
  res.stats.report = type;
  const body = rows.filter(r => { if (isDescriptionRow(r)) { res.stats.description_rows = (res.stats.description_rows || 0) + 1; return false; } return true; });
  if (type === 'orders') {
    const partials = [], others = [];
    for (const r of body) {
      const p = mapOrderRow(r);
      if (!p.order_id) {
        // Store-level rows (ad spend, credits) with no order: kept for the payout total only.
        res.stats.rows++; res.stats.non_order_rows = (res.stats.non_order_rows || 0) + 1;
        const store = canonicalStore(p.store_label);
        if (!store) { res.stats.skipped_store++; continue; }
        if (p.payout_id && p.payout !== null) others.push({ payout_id: p.payout_id, store, payout_date: p.payout_date, amount: p.payout });
        continue;
      }
      partials.push(p);
    }
    finalizeOrders(VENDOR, partials, res);
    finalizePayouts(VENDOR, derivePayouts(VENDOR, res.delivery_orders, others), res);
    res.stats.rows -= res.delivery_payouts.length; // derived payouts are not source rows
  } else if (type === 'payouts') {
    finalizePayouts(VENDOR, body.map(mapPayoutRow), res);
  } else {
    res.stats.ignored = `unrecognized Uber Eats file${meta.filename ? ` ${meta.filename}` : ''}`;
  }
  return res;
}

export function matchFile(meta = {}) {
  const name = String(meta.filename || '');
  const subject = String(meta.subject || '');
  if (!isTabular(meta) && !/\.zip$/i.test(name)) return false;
  const bySender = fromDomain(meta.from, ['uber.com', 'ubereats.com']);
  const byName = /uber[\s_-]?eats|payment[\s_-]?details|payout[\s_-]?summary/i.test(name);
  // "payment_details" alone is generic; require Uber in name/subject unless the sender is Uber.
  return bySender || (byName && /uber/i.test(name + ' ' + subject));
}

// ------------------------------------------------------------- session mode --
export async function isLoggedIn(ctx) {
  return urlLooksLoggedIn(ctx, {
    host: 'merchants.ubereats.com',
    loginPatterns: [/auth\.uber\.com/, /\/login/i, /\/signin/i],
    shellSelector: SELECTORS.loggedInShell,
  });
}

function checkPaymentItem(it) {
  const keys = new Set(Object.keys(it).map(normHeader));
  const has = aliases => aliases.some(a => keys.has(normHeader(a)));
  if (!has([...F.workflow_id, ...F.order_id])) throw new ShapeError('paymentDetails: item missing workflowId/orderId');
  if (!has(F.total_payout)) throw new ShapeError('paymentDetails: item missing totalPayout');
}

async function collectViaApi(ctx, range) {
  const stores = await paginate(ctx, ENDPOINTS.stores);
  if (!stores.length) throw new ShapeError('stores: empty list');
  const res = emptyResult();
  for (const s of stores) {
    const store_id = dig(s, ['uuid', 'storeUUID', 'id', 'storeId']);
    const name = dig(s, ['name', 'storeName', 'title']);
    if (!store_id) throw new ShapeError('stores: missing uuid');
    const partials = [];
    for (const w of dateWindows(range, ENDPOINTS.paymentDetails.windowDays)) {
      for (const it of await paginate(ctx, ENDPOINTS.paymentDetails, { store_id, from: w.from, through: w.through })) {
        checkPaymentItem(it);
        const p = mapOrderRow({ storeName: name, ...it });
        if (p.order_id) partials.push(p);
      }
    }
    const pr = emptyResult();
    finalizeOrders(VENDOR, partials, pr);
    const payoutPartials = [];
    for (const w of dateWindows(range, ENDPOINTS.payouts.windowDays)) {
      for (const it of await paginate(ctx, ENDPOINTS.payouts, { store_id, from: w.from, through: w.through })) {
        if (!dig(it, ['payoutReferenceId', 'payoutId', 'id'])) throw new ShapeError('payouts: item missing payoutReferenceId');
        if (dig(it, ['totalPayout', 'amount']) === undefined) throw new ShapeError('payouts: item missing totalPayout');
        payoutPartials.push(mapPayoutRow({ storeName: name, payoutReferenceId: dig(it, ['payoutReferenceId', 'payoutId', 'id']), totalPayout: dig(it, ['totalPayout', 'amount']), ...it }));
      }
    }
    // Real payout records win over ones derived from order rows.
    const real = new Set(payoutPartials.map(p => String(p.payout_id)));
    finalizePayouts(VENDOR, [...payoutPartials, ...derivePayouts(VENDOR, pr.delivery_orders).filter(d => !real.has(String(d.payout_id)))], pr);
    mergeResults(res, pr);
  }
  return res;
}

async function collectViaUi(ctx, range) {
  const res = emptyResult();
  for (const w of dateWindows(range, ENDPOINTS.paymentDetails.windowDays)) {
    const { buffer, filename } = await runUiDownload(ctx.page, SELECTORS.paymentDetails, w);
    mergeResults(res, parseFile(buffer, { filename }));
  }
  return res;
}

export async function collect(ctx, range) {
  return collectWithFallback(ctx, range, { vendor: VENDOR, viaApi: () => collectViaApi(ctx, range), viaUi: () => collectViaUi(ctx, range) });
}

export default {
  id: VENDOR,
  name: 'Uber Eats Manager',
  domain: 'delivery',
  modes: ['session', 'inbox', 'drive'],
  kinds: ['delivery_orders', 'delivery_payouts'],
  loginUrl: 'https://merchants.ubereats.com/manager',
  handoffDomains: ['uber.com', 'ubereats.com'],
  // no login(): sign-in runs through auth.uber.com (SMS code first, password as a
  // fallback, bot/risk checks). Not a plain form; sessions come from handoff.
  isLoggedIn,
  collect,
  matchFile,
  parseFile,
};
