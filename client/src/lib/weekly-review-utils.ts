// Shared helpers for Weekly Review / Yesterday / This Week pages.

export function getHKNow(): Date {
  const now = new Date();
  return new Date(now.getTime() + (now.getTimezoneOffset() + 480) * 60000);
}

export function toDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Default Wednesday → Tuesday week, anchored to *this* Tuesday or the most recent past Tuesday. */
export function getDefaultWeekRange(): { from: string; to: string } {
  const today = getHKNow();
  const dow = today.getDay(); // 0 Sun … 6 Sat
  // We want the latest Tuesday (>= last Tue, <= today). Tuesday = 2.
  // Days since last Tuesday:
  const diff = (dow - 2 + 7) % 7;
  const tue = new Date(today);
  tue.setHours(0, 0, 0, 0);
  tue.setDate(today.getDate() - diff);
  const wed = new Date(tue);
  wed.setDate(tue.getDate() - 6);
  return { from: toDateStr(wed), to: toDateStr(tue) };
}

/** Previous same-length range immediately before [from..to]. */
export function getPrevRange(from: string, to: string): { from: string; to: string } {
  const f = new Date(from);
  const t = new Date(to);
  const days = Math.round((t.getTime() - f.getTime()) / 86400000) + 1;
  const prevTo = new Date(f);
  prevTo.setDate(f.getDate() - 1);
  const prevFrom = new Date(prevTo);
  prevFrom.setDate(prevTo.getDate() - (days - 1));
  return { from: toDateStr(prevFrom), to: toDateStr(prevTo) };
}

/** Same calendar period, last year. */
export function getYoYRange(from: string, to: string): { from: string; to: string } {
  const f = new Date(from);
  const t = new Date(to);
  const yf = new Date(f);
  yf.setFullYear(f.getFullYear() - 1);
  const yt = new Date(t);
  yt.setFullYear(t.getFullYear() - 1);
  return { from: toDateStr(yf), to: toDateStr(yt) };
}

export function getMonthBounds(): { from: string; to: string } {
  const today = getHKNow();
  const first = new Date(today.getFullYear(), today.getMonth(), 1);
  return { from: toDateStr(first), to: toDateStr(today) };
}

export function calcDelta(curr: number, prev: number): number | null {
  if (prev === 0) return null;
  return ((curr - prev) / prev) * 100;
}

/** Channel mapping (Shopify source_name → friendly bucket). */
export function mapChannel(src: string | null): string {
  const s = (src || '').toLowerCase();
  // 數字 source_name 係 POS 機號 — 同 daily-weekly 頁一致當門市
  if (s === 'pos' || /^\d+$/.test(s)) return '門市 POS';
  if (s === 'web' || s === 'shopify' || s === '') return '網店 Online';
  return '其他';
}

/**
 * Loyalty / reward codes are excluded from promo analysis to mirror
 * existing dashboard behaviour:
 *   loyalty: matches ^[A-Z]\d{7}$
 *   reward : contains a parenthesised "(K1234567)" id
 */
export function isLoyaltyOrReward(code: string): boolean {
  if (!code) return true;
  if (/^[A-Z]\d{7}$/.test(code)) return true;
  if (/\([A-Z]?\d{6,8}\)/.test(code)) return true;
  return false;
}

export type Order = {
  id: string | number;
  order_number?: string | number;
  created_at: string;
  total_price: string | number;
  total_discounts?: string | number;
  financial_status?: string | null;
  cancelled_at?: string | null;
  discount_codes?: string | any[] | null;
  source_name?: string | null;
};

export type Line = {
  order_id: string | number;
  product_id?: string | number;
  sku?: string | null;
  title?: string | null;
  vendor?: string | null;
  product_type?: string | null;
  quantity: string | number;
  price: string | number;
};

export type ProcessResult = {
  revenue: number;
  orders: number;
  aov: number;
  promoCount: number;
  /** 毛利(淨計有成本價嘅 lines;costMap 冇俾就係 0) */
  profit: number;
  /** 有成本價 lines 嘅營收(毛利率分母) */
  coveredRev: number;
  channelMap: Record<string, { orders: number; revenue: number }>;
  brandMap: Record<string, { qty: number; revenue: number }>;
  catMap: Record<string, { qty: number; revenue: number }>;
  /** Rev/qty per (brand → product_title → sku). Used for drill-down. */
  brandTree: Record<
    string,
    {
      qty: number;
      revenue: number;
      variants: Record<
        string,
        {
          title: string;
          qty: number;
          revenue: number;
          skus: Record<string, { sku: string; title: string; qty: number; revenue: number }>;
        }
      >;
    }
  >;
  /** Same shape as brandTree but keyed by category. */
  catTree: Record<
    string,
    {
      qty: number;
      revenue: number;
      variants: Record<
        string,
        {
          title: string;
          qty: number;
          revenue: number;
          skus: Record<string, { sku: string; title: string; qty: number; revenue: number }>;
        }
      >;
    }
  >;
  topSkus: { title: string; sku: string; vendor: string; qty: number; revenue: number }[];
  /** 完整 SKU 彙總(對比上期用 — topSkus 淨係頭 5 唔夠) */
  skuMap: Record<string, { title: string; sku: string; vendor: string; qty: number; revenue: number }>;
  promoCodes: Record<
    string,
    {
      uses: number;
      discountAmt: number;
      revenue: number;
      orderIds: Set<string>;
    }
  >;
  promoOrderIndex: Map<string, string[]>; // orderId -> [code,...]
};

export function processOrders(
  ordersRaw: Order[],
  linesRaw: Line[],
  from: string,
  to: string,
  productMeta?: Record<string, { product_type: string; vendor: string }>,
  costMap?: Record<string, number>
): ProcessResult {
  const fromStr = from;
  const toStr = to + '\xff';

  const orders = ordersRaw.filter(o => {
    if (o.financial_status === 'refunded') return false;
    if (o.cancelled_at) return false;
    const ca = String(o.created_at || '');
    return ca >= fromStr && ca <= toStr;
  });

  const orderIds = new Set(orders.map(o => String(o.id)));
  const lines = linesRaw.filter(l => orderIds.has(String(l.order_id)));

  const revenue = orders.reduce((s, o) => s + parseFloat(String(o.total_price || 0)), 0);
  const orderCount = orders.length;
  const aov = orderCount > 0 ? revenue / orderCount : 0;

  const channelMap: ProcessResult['channelMap'] = {};
  for (const o of orders) {
    const ch = mapChannel(o.source_name || null);
    if (!channelMap[ch]) channelMap[ch] = { orders: 0, revenue: 0 };
    channelMap[ch].orders += 1;
    channelMap[ch].revenue += parseFloat(String(o.total_price || 0));
  }

  const brandMap: ProcessResult['brandMap'] = {};
  const catMap: ProcessResult['catMap'] = {};
  const brandTree: ProcessResult['brandTree'] = {};
  const catTree: ProcessResult['catTree'] = {};
  const skuMapForTop: Record<string, { title: string; sku: string; vendor: string; qty: number; revenue: number }> = {};
  let profit = 0;
  let coveredRev = 0;

  for (const l of lines) {
    // Fallback to shopify_products meta when shopify_order_lines fields are null
    const meta = productMeta?.[String((l as any).product_id || '')];
    const rawVendor = (l.vendor || meta?.vendor || '').trim();
    const rawCat = (l.product_type || meta?.product_type || '').trim();
    const vendor = rawVendor || '未知品牌';
    const cat = rawCat || '未分類';
    const title = (l.title || '').trim() || (l.sku || 'N/A');
    const sku = (l.sku || '').trim() || title;
    const qty = parseInt(String(l.quantity || '1'), 10) || 0;
    const price = parseFloat(String(l.price || '0')) * qty;

    if (!brandMap[vendor]) brandMap[vendor] = { qty: 0, revenue: 0 };
    brandMap[vendor].qty += qty;
    brandMap[vendor].revenue += price;

    if (!catMap[cat]) catMap[cat] = { qty: 0, revenue: 0 };
    catMap[cat].qty += qty;
    catMap[cat].revenue += price;

    // ── brandTree: brand → variant(title) → sku
    if (!brandTree[vendor]) brandTree[vendor] = { qty: 0, revenue: 0, variants: {} };
    brandTree[vendor].qty += qty;
    brandTree[vendor].revenue += price;
    const bvar = brandTree[vendor].variants;
    if (!bvar[title]) bvar[title] = { title, qty: 0, revenue: 0, skus: {} };
    bvar[title].qty += qty;
    bvar[title].revenue += price;
    const bsk = bvar[title].skus;
    if (!bsk[sku]) bsk[sku] = { sku, title, qty: 0, revenue: 0 };
    bsk[sku].qty += qty;
    bsk[sku].revenue += price;

    // ── catTree: category → variant(title) → sku
    if (!catTree[cat]) catTree[cat] = { qty: 0, revenue: 0, variants: {} };
    catTree[cat].qty += qty;
    catTree[cat].revenue += price;
    const cvar = catTree[cat].variants;
    if (!cvar[title]) cvar[title] = { title, qty: 0, revenue: 0, skus: {} };
    cvar[title].qty += qty;
    cvar[title].revenue += price;
    const csk = cvar[title].skus;
    if (!csk[sku]) csk[sku] = { sku, title, qty: 0, revenue: 0 };
    csk[sku].qty += qty;
    csk[sku].revenue += price;

    // top SKU map
    const tk = sku;
    if (!skuMapForTop[tk]) skuMapForTop[tk] = { title, sku, vendor, qty: 0, revenue: 0 };
    skuMapForTop[tk].qty += qty;
    skuMapForTop[tk].revenue += price;

    // 毛利(costMap 淨存 >0 嘅成本;冇成本嘅 line 唔入分母)
    const rawSku = (l.sku || '').trim();
    const c = rawSku ? costMap?.[rawSku] : undefined;
    if (c !== undefined) {
      profit += price - c * qty;
      coveredRev += price;
    }
  }

  const topSkus = Object.values(skuMapForTop)
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 5);

  // Promo codes (excluding loyalty/reward).
  const promoCodes: ProcessResult['promoCodes'] = {};
  const promoOrderIndex: ProcessResult['promoOrderIndex'] = new Map();
  for (const o of orders) {
    let codes: { code?: string; amount?: string | number }[] = [];
    try {
      const dc = o.discount_codes;
      if (typeof dc === 'string' && dc.startsWith('[')) codes = JSON.parse(dc);
      else if (Array.isArray(dc)) codes = dc;
    } catch {
      // ignore
    }
    const rev = parseFloat(String(o.total_price || 0));
    const oid = String(o.id);
    const orderCodes: string[] = [];
    for (const c of codes) {
      const key = String(c.code || '').toUpperCase();
      if (!key) continue;
      if (isLoyaltyOrReward(key)) continue;
      if (!promoCodes[key]) {
        promoCodes[key] = { uses: 0, discountAmt: 0, revenue: 0, orderIds: new Set() };
      }
      promoCodes[key].uses += 1;
      promoCodes[key].discountAmt += parseFloat(String(c.amount || 0));
      promoCodes[key].revenue += rev;
      promoCodes[key].orderIds.add(oid);
      orderCodes.push(key);
    }
    if (orderCodes.length) promoOrderIndex.set(oid, orderCodes);
  }

  const promoCount = Object.keys(promoCodes).length;

  return {
    revenue,
    orders: orderCount,
    aov,
    promoCount,
    profit,
    coveredRev,
    channelMap,
    brandMap,
    catMap,
    brandTree,
    catTree,
    topSkus,
    skuMap: skuMapForTop,
    promoCodes,
    promoOrderIndex,
  };
}
