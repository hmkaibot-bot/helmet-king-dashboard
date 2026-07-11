import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { Link } from 'wouter';
import { supabase } from '@/lib/supabase';
import { queryAllPages, clearQueryCache } from '@/lib/query-helpers';
import { formatCurrency, formatNumber } from '@/lib/format';
import {
  Radar,
  RefreshCw,
  AlertCircle,
  Calendar,
  Package,
  ImageOff,
  ExternalLink,
  Search,
  PenLine,
  ArrowUp,
  ArrowDown,
} from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Promotion,
  PromotionItem,
  STATUS_LABEL,
  STATUS_COLOR,
  fetchAllRows,
  effectiveStatus,
} from '@/lib/promotions-shared';

/**
 * 推廣監察 — marketing 做 post 選品 + 監察推廣成效。
 * 揀推廣活動 → 商品列表(Shopify 主圖、庫存、建議零售價、推廣價)
 * + 推廣期內實際售出(咩商品、幾多件、幾多錢)。
 */

interface InventoryRow {
  sku: string;
  product_id: number | string | null;
  product_title: string | null;
  vendor: string | null;
  product_type: string | null;
  inventory_quantity: number | null;
  price: number | null;
  compare_at_price: number | string | null;
}

interface OrderLineRow {
  sku: string | null;
  quantity: number | null;
  price: number | null;
  order_id: string | number | null;
}

interface OrderRow {
  id: string | number;
  created_at: string;
  cancelled_at: string | null;
}

interface ProductRow {
  product_id: string;
  title: string;
  vendor: string;
  product_type: string;
  skus: string[];
  numSkus: number;
  inventory: number;
  retailPrice: number;
  comparePrice: number;
  promoPrice: number | null;
  soldQty: number;
  soldRevenue: number;
}

// 主圖 URL cache(module-level — 轉活動/轉頁唔使重新問 Shopify)
const _imgCache = new Map<string, string | null>();

// Shopify CDN 圖可以用 width param 攞細圖,慳流量
function thumbUrl(u: string, w = 120): string {
  return u.includes('?') ? `${u}&width=${w}` : `${u}?width=${w}`;
}

async function fetchFeaturedImages(productIds: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const missing = productIds.filter(id => !_imgCache.has(id));
  for (const id of productIds) {
    if (_imgCache.has(id)) out.set(id, _imgCache.get(id) ?? null);
  }
  if (missing.length === 0) return out;
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return out;
  // 每批 200(server 上限 250,留 margin)
  const chunks: string[][] = [];
  for (let i = 0; i < missing.length; i += 200) chunks.push(missing.slice(i, i + 200));
  for (const chunk of chunks) {
    try {
      const resp = await fetch('/api/shopify-product', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'featuredImages', productIds: chunk }),
      });
      const j: any = await resp.json().catch(() => null);
      const images = j?.images;
      if (resp.ok && images && typeof images === 'object') {
        for (const id of chunk) {
          const url = Object.prototype.hasOwnProperty.call(images, id) ? images[id] : null;
          _imgCache.set(id, url ?? null);
          out.set(id, url ?? null);
        }
      }
    } catch {
      // 圖片攞唔到唔算致命 — 顯示 placeholder
    }
  }
  return out;
}

type SoldFilter = 'all' | 'sold' | 'unsold';
type SortKey = 'title' | 'inventory' | 'comparePrice' | 'retailPrice' | 'promoPrice' | 'soldQty' | 'soldRevenue';

export default function MarketingPromoWatchPage() {
  const [promos, setPromos] = useState<Promotion[]>([]);
  const [items, setItems] = useState<PromotionItem[]>([]);
  const [inventory, setInventory] = useState<InventoryRow[]>([]);
  const [orderLines, setOrderLines] = useState<OrderLineRow[]>([]);
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [images, setImages] = useState<Map<string, string | null>>(new Map());
  const [selectedPromoId, setSelectedPromoId] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [soldFilter, setSoldFilter] = useState<SoldFilter>('all');
  const [sortBy, setSortBy] = useState<SortKey>('soldQty');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [ps, its, inv, ol, os] = await Promise.all([
        fetchAllRows<Promotion>('promotions'),
        fetchAllRows<PromotionItem>('promotion_items'),
        queryAllPages(
          'shopify_inventory',
          'sku,product_id,product_title,vendor,product_type,inventory_quantity,price,compare_at_price'
        ) as Promise<InventoryRow[]>,
        queryAllPages('shopify_order_lines', 'sku,quantity,price,order_id') as Promise<OrderLineRow[]>,
        queryAllPages('shopify_orders', 'id,created_at,cancelled_at') as Promise<OrderRow[]>,
      ]);
      // 活動排序:進行中 → 計劃中 → 已結束/取消,各組內 start_date 新嘅先
      const stOrder = (p: Promotion) => {
        const st = effectiveStatus(p);
        return st === 'active' ? 0 : st === 'planned' ? 1 : 2;
      };
      const sorted = [...ps].sort(
        (a, b) => stOrder(a) - stOrder(b) || b.start_date.localeCompare(a.start_date)
      );
      setPromos(sorted);
      setItems(its.filter(i => !i.is_archived));
      setInventory(inv);
      setOrderLines(ol);
      setOrders(os);
      setSelectedPromoId(prev => (prev && sorted.some(p => p.id === prev) ? prev : (sorted[0]?.id ?? '')));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const refresh = useCallback(async () => {
    await Promise.all([clearQueryCache('shopify_orders'), clearQueryCache('shopify_order_lines'), clearQueryCache('shopify_inventory')]);
    await load();
  }, [load]);

  const promo = useMemo(
    () => promos.find(p => p.id === selectedPromoId) ?? null,
    [promos, selectedPromoId]
  );

  // ── 計每個商品:庫存/價/推廣價/推廣期售出 ─────────────────────────────────
  const rows = useMemo<ProductRow[]>(() => {
    if (!promo) return [];
    const myItems = items.filter(i => i.promotion_id === promo.id);
    if (myItems.length === 0) return [];
    const promoPriceByProduct = new Map<string, number | null>();
    for (const it of myItems) {
      promoPriceByProduct.set(String(it.product_id), it.promo_price != null ? Number(it.promo_price) : null);
    }
    const productIds = new Set(myItems.map(i => String(i.product_id)));

    const byProduct = new Map<string, InventoryRow[]>();
    for (const r of inventory) {
      if (r.product_id == null) continue;
      const key = String(r.product_id);
      if (!productIds.has(key)) continue;
      const arr = byProduct.get(key) ?? [];
      arr.push(r);
      byProduct.set(key, arr);
    }

    // 推廣期銷售(同 promotions-detail 一樣:訂單建立時間落喺 start 00:00 → end 23:59,排除已取消)
    const skuToProduct = new Map<string, string>();
    for (const [pidKey, skuRows] of byProduct.entries()) {
      for (const s of skuRows) skuToProduct.set(s.sku, pidKey);
    }
    const startDate = new Date(promo.start_date + 'T00:00:00');
    const endDate = new Date(promo.end_date + 'T23:59:59');
    const orderById = new Map<string, OrderRow>();
    for (const o of orders) {
      if (o.cancelled_at) continue;
      orderById.set(String(o.id), o);
    }
    const soldQtyByProduct = new Map<string, number>();
    const soldRevByProduct = new Map<string, number>();
    for (const line of orderLines) {
      if (!line.sku) continue;
      const pidKey = skuToProduct.get(line.sku);
      if (!pidKey) continue;
      const order = orderById.get(String(line.order_id));
      if (!order) continue;
      const createdAt = new Date(order.created_at);
      if (createdAt < startDate || createdAt > endDate) continue;
      const qty = line.quantity ?? 0;
      soldQtyByProduct.set(pidKey, (soldQtyByProduct.get(pidKey) ?? 0) + qty);
      soldRevByProduct.set(pidKey, (soldRevByProduct.get(pidKey) ?? 0) + qty * (line.price ?? 0));
    }

    const out: ProductRow[] = [];
    for (const [pidKey, skuRows] of byProduct.entries()) {
      // 代表價:第一個有值嘅 SKU(同 promotions-detail 一致,cast number 避免 numeric string)
      const repPrice = skuRows.map(s => Number(s.price ?? 0)).find(v => v > 0) ?? 0;
      const repCompare = skuRows.map(s => Number(s.compare_at_price ?? 0)).find(v => v > 0) ?? 0;
      out.push({
        product_id: pidKey,
        title: skuRows[0].product_title ?? '—',
        vendor: skuRows[0].vendor ?? '—',
        product_type: skuRows[0].product_type ?? '—',
        skus: skuRows.map(s => s.sku),
        numSkus: skuRows.length,
        inventory: skuRows.reduce((s, x) => s + (x.inventory_quantity ?? 0), 0),
        retailPrice: repPrice,
        comparePrice: repCompare,
        promoPrice: promoPriceByProduct.get(pidKey) ?? null,
        soldQty: soldQtyByProduct.get(pidKey) ?? 0,
        soldRevenue: soldRevByProduct.get(pidKey) ?? 0,
      });
    }
    return out;
  }, [promo, items, inventory, orderLines, orders]);

  // ── 攞主圖(揀咗活動先攞,module cache 免重覆) ────────────────────────────
  const imgSeqRef = useRef(0);
  useEffect(() => {
    if (rows.length === 0) return;
    const seq = ++imgSeqRef.current;
    const ids = rows.map(r => r.product_id);
    fetchFeaturedImages(ids).then(m => {
      if (imgSeqRef.current !== seq) return; // 已轉咗活動 — 唔好覆蓋
      setImages(m);
    });
  }, [rows]);

  // ── 篩選 + 排序 ───────────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    let list = rows;
    if (soldFilter === 'sold') list = list.filter(r => r.soldQty > 0);
    else if (soldFilter === 'unsold') list = list.filter(r => r.soldQty === 0);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(
        r =>
          r.title.toLowerCase().includes(q) ||
          r.vendor.toLowerCase().includes(q) ||
          r.skus.some(s => s.toLowerCase().includes(q))
      );
    }
    const mul = sortDir === 'desc' ? -1 : 1;
    return [...list].sort((a, b) => {
      if (sortBy === 'title') return a.title.localeCompare(b.title) * mul;
      const va = (a[sortBy] ?? -1) as number;
      const vb = (b[sortBy] ?? -1) as number;
      return (va - vb) * mul || a.title.localeCompare(b.title);
    });
  }, [rows, soldFilter, search, sortBy, sortDir]);

  const toggleSort = (col: SortKey) => {
    if (sortBy === col) setSortDir(d => (d === 'desc' ? 'asc' : 'desc'));
    else {
      setSortBy(col);
      setSortDir(col === 'title' ? 'asc' : 'desc');
    }
  };

  // ── KPI ───────────────────────────────────────────────────────────────────
  const kpi = useMemo(() => {
    const totalQty = rows.reduce((s, r) => s + r.soldQty, 0);
    const totalRev = rows.reduce((s, r) => s + r.soldRevenue, 0);
    const soldCount = rows.filter(r => r.soldQty > 0).length;
    const oosCount = rows.filter(r => r.inventory <= 0).length;
    return { totalQty, totalRev, soldCount, oosCount };
  }, [rows]);

  const promoStatus = promo ? effectiveStatus(promo) : null;

  const SortHeader = ({ col, label, className = '' }: { col: SortKey; label: string; className?: string }) => (
    <th className={`px-3 py-2 font-medium ${className}`}>
      <button onClick={() => toggleSort(col)} className="inline-flex items-center gap-0.5 hover:text-foreground">
        {label}
        {sortBy === col && (sortDir === 'desc' ? <ArrowDown className="h-3 w-3" /> : <ArrowUp className="h-3 w-3" />)}
      </button>
    </th>
  );

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <Radar className="h-5 w-5 text-primary" />
          <h1 className="text-lg font-semibold">推廣監察</h1>
          <span className="text-xs text-muted-foreground">做 post 選品 + 推廣成效</span>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <select
            value={selectedPromoId}
            onChange={e => setSelectedPromoId(e.target.value)}
            className="text-xs px-2 py-1.5 rounded-md border border-border bg-background max-w-[260px]"
            data-testid="promo-select"
          >
            {promos.length === 0 && <option value="">— 未有推廣活動 —</option>}
            {promos.map(p => (
              <option key={p.id} value={p.id}>
                {p.name}（{STATUS_LABEL[effectiveStatus(p)]}）
              </option>
            ))}
          </select>
          <Link
            to="/marketing/posts"
            className="text-xs px-3 py-1.5 rounded-md border border-border bg-card hover:bg-accent/60 transition-colors inline-flex items-center gap-1"
          >
            <PenLine className="h-3.5 w-3.5" />
            整貼文
          </Link>
          <button
            onClick={refresh}
            disabled={loading}
            className="text-xs px-3 py-1.5 rounded-md border border-border bg-card hover:bg-accent/60 transition-colors inline-flex items-center gap-1"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            重新整理
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-rose-500/40 bg-rose-500/10 p-3 text-rose-200 text-sm flex items-center gap-2">
          <AlertCircle className="h-4 w-4" />
          {error}
        </div>
      )}

      {/* 活動摘要 */}
      {promo && (
        <div className="rounded-md border border-border/60 bg-card p-3 flex items-center gap-x-5 gap-y-2 flex-wrap text-sm">
          <span className={`px-1.5 py-0.5 rounded text-[10px] border ${STATUS_COLOR[promoStatus!]}`}>
            {STATUS_LABEL[promoStatus!]}
          </span>
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <Calendar className="h-3.5 w-3.5" />
            <span className="tabular-nums">{promo.start_date} → {promo.end_date}</span>
          </span>
          <span className="inline-flex items-center gap-1 text-xs">
            <Package className="h-3.5 w-3.5 text-muted-foreground" />
            商品 <b className="tabular-nums">{formatNumber(rows.length)}</b> 款
            {kpi.oosCount > 0 && (
              <span className="text-[10px] text-rose-400 ml-1">（{kpi.oosCount} 款售罄）</span>
            )}
          </span>
          <span className="text-xs">
            已售出 <b className="tabular-nums text-primary">{formatNumber(kpi.totalQty)}</b> 件
            <span className="text-muted-foreground ml-1">（{kpi.soldCount}/{rows.length} 款有售出）</span>
          </span>
          <span className="text-xs">
            推廣期營收 <b className="tabular-nums text-primary">{formatCurrency(kpi.totalRev)}</b>
          </span>
          <Link
            to={`/retail/promotions/${promo.id}`}
            className="ml-auto inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
          >
            詳細成效分析 <ExternalLink className="h-3 w-3" />
          </Link>
        </div>
      )}

      {/* 篩選 */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative">
          <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="搜尋商品 / 品牌 / SKU…"
            className="pl-8 pr-3 py-1.5 text-xs rounded-md border border-border bg-background w-[220px]"
          />
        </div>
        <div className="flex rounded-md border border-border overflow-hidden text-xs">
          {([['all', '全部'], ['sold', '有售出'], ['unsold', '未售出']] as [SoldFilter, string][]).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setSoldFilter(k)}
              className={`px-3 py-1.5 transition-colors ${
                soldFilter === k ? 'bg-primary text-primary-foreground' : 'bg-card hover:bg-accent/60'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="text-xs text-muted-foreground">顯示 {formatNumber(filtered.length)} 款</span>
      </div>

      {/* 商品列表 */}
      {loading ? (
        <div className="space-y-2">
          {[...Array(6)].map((_, i) => <Skeleton key={i} className="h-16 w-full" />)}
        </div>
      ) : !promo ? (
        <div className="rounded-md border border-dashed border-border/60 p-12 text-center text-sm text-muted-foreground">
          未有推廣活動 — 去「推廣活動」頁建立先
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-md border border-dashed border-border/60 p-12 text-center text-sm text-muted-foreground">
          呢個活動未有分派商品 — 去「推廣商品池」分派
        </div>
      ) : (
        <div className="rounded-md border border-border/60 bg-card overflow-x-auto">
          <table className="w-full text-sm min-w-[860px]">
            <thead>
              <tr className="bg-muted/40 text-[11px] text-muted-foreground uppercase tracking-wide text-right">
                <th className="px-3 py-2 font-medium text-left w-[52px]">圖片</th>
                <SortHeader col="title" label="商品" className="text-left" />
                <SortHeader col="inventory" label="庫存" className="text-right" />
                <SortHeader col="comparePrice" label="建議零售價" className="text-right" />
                <SortHeader col="retailPrice" label="零售價" className="text-right" />
                <SortHeader col="promoPrice" label="推廣價" className="text-right" />
                <SortHeader col="soldQty" label="售出" className="text-right" />
                <SortHeader col="soldRevenue" label="營收" className="text-right" />
              </tr>
            </thead>
            <tbody>
              {filtered.map(r => {
                const img = images.get(r.product_id) ?? null;
                const baseline = r.comparePrice > 0 ? r.comparePrice : r.retailPrice;
                const discountPct =
                  r.promoPrice != null && baseline > 0 && r.promoPrice < baseline
                    ? Math.round(((baseline - r.promoPrice) / baseline) * 100)
                    : null;
                return (
                  <tr key={r.product_id} className="border-t border-border/40 hover:bg-accent/20">
                    <td className="px-3 py-1.5">
                      {img ? (
                        <img
                          src={thumbUrl(img)}
                          alt={r.title}
                          loading="lazy"
                          className="h-11 w-11 rounded-md object-cover border border-border/40 bg-background"
                        />
                      ) : (
                        <div className="h-11 w-11 rounded-md border border-border/40 bg-muted/30 flex items-center justify-center">
                          <ImageOff className="h-4 w-4 text-muted-foreground/50" />
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-1.5 max-w-[320px]">
                      <div className="font-medium truncate" title={r.title}>{r.title}</div>
                      <div className="text-[10px] text-muted-foreground truncate">
                        {r.vendor} · {r.product_type} · {r.numSkus} SKU
                      </div>
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      {r.inventory <= 0 ? (
                        <span className="px-1.5 py-0.5 rounded text-[10px] border text-rose-400 border-rose-500/40 bg-rose-500/10">售罄</span>
                      ) : (
                        formatNumber(r.inventory)
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">
                      {r.comparePrice > 0 ? formatCurrency(r.comparePrice) : '—'}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      {r.retailPrice > 0 ? formatCurrency(r.retailPrice) : '—'}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      {r.promoPrice != null ? (
                        <span className="text-primary font-medium">
                          {formatCurrency(r.promoPrice)}
                          {discountPct != null && (
                            <span className="text-[10px] text-emerald-400 ml-1">-{discountPct}%</span>
                          )}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums font-semibold">
                      {r.soldQty > 0 ? formatNumber(r.soldQty) : <span className="text-muted-foreground font-normal">0</span>}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      {r.soldRevenue > 0 ? formatCurrency(r.soldRevenue) : <span className="text-muted-foreground">—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-[11px] text-muted-foreground">
        售出/營收 = 推廣期內（{promo ? `${promo.start_date} → ${promo.end_date}` : '開始日 → 結束日'}）嘅訂單,排除已取消 ·
        訂單數據每日清晨同步一次,今日即市單未計 · 圖片即時由 Shopify 攞 · 建議零售價/零售價/庫存嚟自每日同步。
      </p>
    </div>
  );
}
