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
  ArrowUpDown,
  X,
} from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { MultiSelectChipFilter } from '@/components/multi-select-chip-filter';
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
 * + 可自訂日期範圍嘅實際售出(咩商品、幾多件、幾多錢)。
 */

interface InventoryRow {
  sku: string;
  product_id: number | string | null;
  product_title: string | null;
  variant_title: string | null;
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

// ── 子產品(variant)彈窗數據 ─────────────────────────────────────────────────
export interface VariantInfo {
  sku: string;
  title: string;
  options: Record<string, string>;   // 選項名 → 值(例 Colour → BLACK, Size → M)
  inventoryQuantity: number | null;
  imageUrl: string | null;
}
export interface VariantProduct {
  title: string;
  featuredImage: string | null;
  optionNames: string[];             // 產品選項名(有序,例 [Colour, Size])
  variants: VariantInfo[];
  live: boolean;                     // true = Shopify 即時;false = 每日同步 fallback
  truncated: boolean;                // true = 產品 variant 多過 250,只攞到頭 250
}
const _variantCache = new Map<string, VariantProduct>();

async function fetchVariants(productId: string): Promise<VariantProduct | null> {
  const hit = _variantCache.get(productId);
  if (hit) return hit;
  try {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) return null;
    const resp = await fetch('/api/shopify-product', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: 'variants', productId }),
    });
    const j: any = await resp.json().catch(() => null);
    const p = j?.product;
    if (!resp.ok || !p) return null;
    const out: VariantProduct = {
      title: String(p.title || ''),
      featuredImage: p.featuredImage || null,
      optionNames: Array.isArray(p.optionNames) ? p.optionNames.map(String) : [],
      variants: (Array.isArray(p.variants) ? p.variants : []).map((v: any) => ({
        sku: String(v?.sku || ''),
        title: String(v?.title || ''),
        options: v?.options && typeof v.options === 'object' ? v.options : {},
        inventoryQuantity: v?.inventoryQuantity ?? null,
        imageUrl: v?.imageUrl || null,
      })),
      live: true,
      truncated: !!p.truncated,
    };
    _variantCache.set(productId, out);
    return out;
  } catch {
    return null;
  }
}

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
  const [selectedVendors, setSelectedVendors] = useState<string[]>([]);
  const [selectedTypes, setSelectedTypes] = useState<string[]>([]);
  // 成效日期範圍(default = 推廣期,可用月曆自訂)
  const [rangeStart, setRangeStart] = useState('');
  const [rangeEnd, setRangeEnd] = useState('');
  const [sortBy, setSortBy] = useState<SortKey>('soldQty');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [lightbox, setLightbox] = useState<{ url: string; title: string } | null>(null);
  // 子產品彈窗:撳商品名開,顯示每個 variant 嘅圖/顏色/尺寸/庫存
  const [variantModal, setVariantModal] = useState<{ productId: string; title: string } | null>(null);
  const [variantData, setVariantData] = useState<{ loading: boolean; data: VariantProduct | null } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [ps, its, inv, ol, os] = await Promise.all([
        fetchAllRows<Promotion>('promotions'),
        fetchAllRows<PromotionItem>('promotion_items'),
        queryAllPages(
          'shopify_inventory',
          'sku,product_id,product_title,variant_title,vendor,product_type,inventory_quantity,price,compare_at_price'
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
    // 重要:圖片同子產品彈窗嘅庫存都聲稱係「Shopify 即時」,所以「重新整理」
    // 一定要連 module-level cache 一齊清,否則老闆改完貨撳 refresh 都仲係睇緊
    // session 頭嗰刻嘅舊 snapshot(被 label 成「即時」)。
    _imgCache.clear();
    _variantCache.clear();
    await Promise.all([clearQueryCache('shopify_orders'), clearQueryCache('shopify_order_lines'), clearQueryCache('shopify_inventory')]);
    await load();
  }, [load]);

  const promo = useMemo(
    () => promos.find(p => p.id === selectedPromoId) ?? null,
    [promos, selectedPromoId]
  );

  // 轉活動 → 成效日期重設做推廣期,品牌/類別 filter 清空(選項唔同咗)
  useEffect(() => {
    if (!promo) return;
    setRangeStart(promo.start_date);
    setRangeEnd(promo.end_date);
    setSelectedVendors([]);
    setSelectedTypes([]);
  }, [promo?.id, promo?.start_date, promo?.end_date]); // eslint-disable-line react-hooks/exhaustive-deps

  const rangeValid = !!rangeStart && !!rangeEnd && rangeStart <= rangeEnd;
  const isCustomRange = !!promo && (rangeStart !== promo.start_date || rangeEnd !== promo.end_date);

  // ── 計每個商品:庫存/價/推廣價/所選日期範圍內售出 ────────────────────────
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

    // 售出(同 promotions-detail 一樣計法:訂單建立時間落喺範圍內,排除已取消);
    // 範圍 default = 推廣期,可自訂
    const skuToProduct = new Map<string, string>();
    for (const [pidKey, skuRows] of byProduct.entries()) {
      for (const s of skuRows) skuToProduct.set(s.sku, pidKey);
    }
    const startDate = new Date((rangeValid ? rangeStart : promo.start_date) + 'T00:00:00');
    const endDate = new Date((rangeValid ? rangeEnd : promo.end_date) + 'T23:59:59');
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
  }, [promo, items, inventory, orderLines, orders, rangeStart, rangeEnd, rangeValid]);

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

  // ── Lightbox ESC 關閉 ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setLightbox(null); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [lightbox]);

  // 子產品彈窗 ESC 關閉(lightbox 開緊嗰陣唔郁 — 等 lightbox 先閂)
  useEffect(() => {
    if (!variantModal || lightbox) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setVariantModal(null); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [variantModal, lightbox]);

  // 開子產品彈窗:即時去 Shopify 攞 variant 選項/圖/庫存;
  // 攞唔到就 fallback 用每日同步嘅 variant_title + 庫存(冇圖)
  const openVariantModal = useCallback((r: ProductRow) => {
    setVariantModal({ productId: r.product_id, title: r.title });
    setVariantData({ loading: true, data: null });
    fetchVariants(r.product_id).then(v => {
      setVariantModal(cur => {
        if (!cur || cur.productId !== r.product_id) return cur; // 已閂/已轉第二款
        if (v) {
          setVariantData({ loading: false, data: v });
        } else {
          const fallbackRows = inventory.filter(
            i => i.product_id != null && String(i.product_id) === r.product_id
          );
          setVariantData({
            loading: false,
            data: {
              title: r.title,
              featuredImage: images.get(r.product_id) ?? null,
              optionNames: [],
              variants: fallbackRows.map(i => ({
                sku: i.sku,
                title: i.variant_title ?? '',
                options: {},
                inventoryQuantity: i.inventory_quantity ?? null,
                imageUrl: null,
              })),
              live: false,
              truncated: false,
            },
          });
        }
        return cur;
      });
    });
  }, [inventory, images]);

  // ── 品牌 / 類別選項(由現時活動嘅商品嚟) ─────────────────────────────────
  const vendorOptions = useMemo(
    () => Array.from(new Set(rows.map(r => r.vendor))).sort((a, b) => a.localeCompare(b)),
    [rows]
  );
  const typeOptions = useMemo(
    () => Array.from(new Set(rows.map(r => r.product_type))).sort((a, b) => a.localeCompare(b)),
    [rows]
  );

  // ── 篩選 + 排序 ───────────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    let list = rows;
    if (soldFilter === 'sold') list = list.filter(r => r.soldQty > 0);
    else if (soldFilter === 'unsold') list = list.filter(r => r.soldQty === 0);
    if (selectedVendors.length > 0) {
      const set = new Set(selectedVendors);
      list = list.filter(r => set.has(r.vendor));
    }
    if (selectedTypes.length > 0) {
      const set = new Set(selectedTypes);
      list = list.filter(r => set.has(r.product_type));
    }
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
      // 冇推廣價(promoPrice = null)嘅一律排最尾,唔受升/降序影響
      // (同 promotions-detail 一致;之前當 -1 會令升序時「—」浮上頂誤導)
      const av = a[sortBy] as number | null;
      const bv = b[sortBy] as number | null;
      if (av == null && bv == null) return a.title.localeCompare(b.title);
      if (av == null) return 1;
      if (bv == null) return -1;
      return (av - bv) * mul || a.title.localeCompare(b.title);
    });
  }, [rows, soldFilter, selectedVendors, selectedTypes, search, sortBy, sortDir]);

  const toggleSort = (col: SortKey) => {
    if (sortBy === col) setSortDir(d => (d === 'desc' ? 'asc' : 'desc'));
    else {
      setSortBy(col);
      setSortDir(col === 'title' ? 'asc' : 'desc');
    }
  };

  // ── KPI(跟所選日期範圍 + 現時篩選) ──────────────────────────────────────
  // 用 filtered(唔係 rows):揀咗品牌/類別/搜尋之後,摘要嘅已售出/營收/款數
  // 會同表格 + 「顯示 N 款」一致,唔會令人以為篩選後嘅營收其實係全推廣。
  // (同 promotions-detail 一致 — 佢個 KPI 都係計 filtered view)
  const kpi = useMemo(() => {
    const totalQty = filtered.reduce((s, r) => s + r.soldQty, 0);
    const totalRev = filtered.reduce((s, r) => s + r.soldRevenue, 0);
    const soldCount = filtered.filter(r => r.soldQty > 0).length;
    const oosCount = filtered.filter(r => r.inventory <= 0).length;
    return { totalQty, totalRev, soldCount, oosCount };
  }, [filtered]);

  const promoStatus = promo ? effectiveStatus(promo) : null;

  // 所有數字欄都可以撳嚟排序;未排嗰啲顯示淡色雙箭咀提示
  const SortHeader = ({ col, label, className = '' }: { col: SortKey; label: string; className?: string }) => (
    <th className={`px-3 py-2 font-medium ${className}`}>
      <button
        onClick={() => toggleSort(col)}
        className="inline-flex items-center gap-0.5 hover:text-foreground transition-colors"
        title="撳嚟排序"
      >
        {label}
        {sortBy === col
          ? (sortDir === 'desc' ? <ArrowDown className="h-3 w-3 text-primary" /> : <ArrowUp className="h-3 w-3 text-primary" />)
          : <ArrowUpDown className="h-3 w-3 opacity-40" />}
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

      {/* 篩選區:推廣活動 + 成效日期 + 搜尋 + 售出狀態 + 品牌 + 類別 */}
      <div className="rounded-md border border-border/60 bg-card p-3 space-y-2.5">
        <div className="flex items-center gap-x-4 gap-y-2 flex-wrap">
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] font-medium text-muted-foreground">推廣活動</span>
            <select
              value={selectedPromoId}
              onChange={e => setSelectedPromoId(e.target.value)}
              className="text-xs px-2 py-1.5 rounded-md border border-border bg-background max-w-[240px]"
              data-testid="promo-select"
            >
              {promos.length === 0 && <option value="">— 未有推廣活動 —</option>}
              {promos.map(p => (
                <option key={p.id} value={p.id}>
                  {p.name}（{STATUS_LABEL[effectiveStatus(p)]}）
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] font-medium text-muted-foreground">成效日期</span>
            <input
              type="date"
              value={rangeStart}
              onChange={e => setRangeStart(e.target.value)}
              className="text-xs px-2 py-1.5 rounded-md border border-border bg-background tabular-nums"
              data-testid="range-start"
            />
            <span className="text-xs text-muted-foreground">→</span>
            <input
              type="date"
              value={rangeEnd}
              onChange={e => setRangeEnd(e.target.value)}
              className="text-xs px-2 py-1.5 rounded-md border border-border bg-background tabular-nums"
              data-testid="range-end"
            />
            {isCustomRange && promo && (
              <button
                onClick={() => { setRangeStart(promo.start_date); setRangeEnd(promo.end_date); }}
                className="text-[11px] px-2 py-1 rounded-md border border-border/60 bg-background hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
                title="重設返成個推廣期"
              >
                重設推廣期
              </button>
            )}
          </div>
          <div className="relative">
            <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="搜尋商品 / 品牌 / SKU…"
              className="pl-8 pr-3 py-1.5 text-xs rounded-md border border-border bg-background w-[200px]"
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
          <span className="text-xs text-muted-foreground ml-auto">顯示 {formatNumber(filtered.length)} 款</span>
        </div>
        {!rangeValid && (
          <p className="text-[11px] text-rose-400">成效日期:結束日期必須 ≥ 開始日期(而家先用返成個推廣期計)</p>
        )}
        <MultiSelectChipFilter
          label="品牌"
          options={vendorOptions}
          selected={selectedVendors}
          onChange={setSelectedVendors}
          placeholder="搜尋品牌…"
        />
        <MultiSelectChipFilter
          label="類別"
          options={typeOptions}
          selected={selectedTypes}
          onChange={setSelectedTypes}
          placeholder="搜尋類別…"
        />
      </div>

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
            商品 <b className="tabular-nums">{formatNumber(filtered.length)}</b> 款
            {kpi.oosCount > 0 && (
              <span className="text-[10px] text-rose-400 ml-1">（{kpi.oosCount} 款售罄）</span>
            )}
          </span>
          <span className="text-xs">
            已售出 <b className="tabular-nums text-primary">{formatNumber(kpi.totalQty)}</b> 件
            <span className="text-muted-foreground ml-1">（{kpi.soldCount}/{filtered.length} 款有售出）</span>
          </span>
          <span className="text-xs">
            營收 <b className="tabular-nums text-primary">{formatCurrency(kpi.totalRev)}</b>
          </span>
          {isCustomRange && rangeValid && (
            <span className="text-[10px] px-1.5 py-0.5 rounded border border-sky-500/40 bg-sky-500/10 text-sky-300 tabular-nums">
              成效計 {rangeStart} → {rangeEnd}
            </span>
          )}
          <Link
            to={`/retail/promotions/${promo.id}`}
            className="ml-auto inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
          >
            詳細成效分析 <ExternalLink className="h-3 w-3" />
          </Link>
        </div>
      )}

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
                        <button
                          onClick={() => setLightbox({ url: img, title: r.title })}
                          className="block cursor-zoom-in"
                          title="撳嚟放大"
                        >
                          <img
                            src={thumbUrl(img)}
                            alt={r.title}
                            loading="lazy"
                            className="h-11 w-11 rounded-md object-cover border border-border/40 bg-background hover:border-primary/60 transition-colors"
                          />
                        </button>
                      ) : (
                        <div className="h-11 w-11 rounded-md border border-border/40 bg-muted/30 flex items-center justify-center">
                          <ImageOff className="h-4 w-4 text-muted-foreground/50" />
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-1.5 max-w-[320px]">
                      <button
                        onClick={() => openVariantModal(r)}
                        className="font-medium truncate block w-full text-left hover:underline hover:text-primary transition-colors"
                        title="撳嚟睇子產品庫存(顏色/尺寸)"
                      >
                        {r.title}
                      </button>
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
        售出/營收 = 成效日期範圍內（{rangeValid ? `${rangeStart} → ${rangeEnd}` : (promo ? `${promo.start_date} → ${promo.end_date}` : '推廣期')}）嘅訂單,排除已取消 ·
        訂單數據每日清晨同步一次,今日即市單未計 · 圖片即時由 Shopify 攞 · 建議零售價/零售價/庫存嚟自每日同步。
      </p>

      {/* 子產品(variant)庫存彈窗 */}
      {variantModal && (
        <div
          className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
          onClick={() => setVariantModal(null)}
        >
          <div
            className="bg-card border border-border rounded-lg shadow-xl w-full max-w-2xl max-h-[85vh] flex flex-col"
            onClick={e => e.stopPropagation()}
          >
            {/* 彈窗 header */}
            <div className="flex items-center gap-3 p-4 border-b border-border/60">
              {(variantData?.data?.featuredImage || images.get(variantModal.productId)) ? (
                <button
                  onClick={() => {
                    const u = variantData?.data?.featuredImage || images.get(variantModal.productId);
                    if (u) setLightbox({ url: u, title: variantModal.title });
                  }}
                  className="cursor-zoom-in shrink-0"
                  title="撳嚟放大"
                >
                  <img
                    src={thumbUrl((variantData?.data?.featuredImage || images.get(variantModal.productId))!, 120)}
                    alt={variantModal.title}
                    className="h-12 w-12 rounded-md object-cover border border-border/40"
                  />
                </button>
              ) : (
                <div className="h-12 w-12 rounded-md border border-border/40 bg-muted/30 flex items-center justify-center shrink-0">
                  <ImageOff className="h-4 w-4 text-muted-foreground/50" />
                </div>
              )}
              <div className="min-w-0 flex-1">
                <h2 className="text-sm font-semibold truncate">{variantModal.title}</h2>
                <p className="text-[11px] text-muted-foreground">
                  子產品庫存
                  {variantData?.data && (
                    <> · 共 {variantData.data.variants.length} 個 SKU · 合計{' '}
                      <b className="tabular-nums">
                        {formatNumber(variantData.data.variants.reduce((s, v) => s + (v.inventoryQuantity ?? 0), 0))}
                      </b> 件
                    </>
                  )}
                </p>
              </div>
              <button
                onClick={() => setVariantModal(null)}
                className="p-1.5 rounded hover:bg-accent/60 transition-colors text-muted-foreground shrink-0"
                title="關閉 (Esc)"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            {/* 彈窗 body */}
            <div className="overflow-y-auto p-2">
              {variantData?.loading ? (
                <div className="space-y-2 p-2">
                  {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
                </div>
              ) : variantData?.data && variantData.data.variants.length > 0 ? (() => {
                const vd = variantData.data;
                // "Title" 係 Shopify 冇選項時嘅 placeholder — 唔顯示做欄
                const optCols = vd.optionNames.filter(n => n && n.toLowerCase() !== 'title');
                const showStyleCol = optCols.length === 0;
                return (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-[11px] text-muted-foreground uppercase tracking-wide">
                        <th className="px-2 py-1.5 text-left font-medium w-[48px]">圖片</th>
                        {optCols.map(n => (
                          <th key={n} className="px-2 py-1.5 text-left font-medium">{n}</th>
                        ))}
                        {showStyleCol && <th className="px-2 py-1.5 text-left font-medium">款式</th>}
                        <th className="px-2 py-1.5 text-left font-medium">SKU</th>
                        <th className="px-2 py-1.5 text-right font-medium">庫存</th>
                      </tr>
                    </thead>
                    <tbody>
                      {vd.variants.map((v, i) => (
                        <tr key={`${v.sku}-${i}`} className="border-t border-border/30 hover:bg-accent/20">
                          <td className="px-2 py-1">
                            {v.imageUrl ? (
                              <button
                                onClick={() => setLightbox({ url: v.imageUrl!, title: `${vd.title} — ${v.title}` })}
                                className="block cursor-zoom-in"
                                title="撳嚟放大"
                              >
                                <img
                                  src={thumbUrl(v.imageUrl, 96)}
                                  alt={v.title}
                                  loading="lazy"
                                  className="h-9 w-9 rounded object-cover border border-border/40 bg-background hover:border-primary/60 transition-colors"
                                />
                              </button>
                            ) : (
                              <div className="h-9 w-9 rounded border border-border/40 bg-muted/30 flex items-center justify-center">
                                <ImageOff className="h-3.5 w-3.5 text-muted-foreground/40" />
                              </div>
                            )}
                          </td>
                          {optCols.map(n => (
                            <td key={n} className="px-2 py-1 text-xs">{v.options[n] || '—'}</td>
                          ))}
                          {showStyleCol && (
                            <td className="px-2 py-1 text-xs">
                              {v.title === 'Default Title' ? '—' : (v.title || '—')}
                            </td>
                          )}
                          <td className="px-2 py-1 text-[11px] text-muted-foreground tabular-nums">{v.sku || '—'}</td>
                          <td className="px-2 py-1 text-right tabular-nums">
                            {v.inventoryQuantity == null ? (
                              <span className="text-muted-foreground">—</span>
                            ) : v.inventoryQuantity <= 0 ? (
                              <span className="px-1.5 py-0.5 rounded text-[10px] border text-rose-400 border-rose-500/40 bg-rose-500/10">售罄</span>
                            ) : (
                              <span className={v.inventoryQuantity <= 2 ? 'text-amber-400 font-medium' : 'font-medium'}>
                                {formatNumber(v.inventoryQuantity)}
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                );
              })() : (
                <div className="p-6 text-center text-sm text-muted-foreground">攞唔到子產品資料</div>
              )}
            </div>
            {/* 彈窗 footer */}
            <div className="px-4 py-2 border-t border-border/60 text-[10px] text-muted-foreground space-y-0.5">
              {variantData?.data?.truncated && (
                <div className="text-amber-400">⚠️ 呢款子產品多過 250 個,只顯示頭 250 個 — 合計件數可能偏少</div>
              )}
              <div>
                {variantData?.data?.live === false
                  ? '⚠️ 攞唔到 Shopify 即時數據 — 顯示每日同步嘅庫存(冇子產品圖)'
                  : '庫存為 Shopify 即時數據 · 撳圖可放大 · 少過 3 件會標橙色'}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 圖片放大 lightbox(z-60:要浮喺子產品彈窗上面) */}
      {lightbox && (
        <div
          className="fixed inset-0 z-[60] bg-black/85 flex items-center justify-center p-6"
          onClick={() => setLightbox(null)}
        >
          <div className="max-w-3xl max-h-full flex flex-col items-center gap-3" onClick={e => e.stopPropagation()}>
            <img
              src={thumbUrl(lightbox.url, 1200)}
              alt={lightbox.title}
              className="max-h-[80vh] max-w-full rounded-lg object-contain bg-white/5"
            />
            <div className="flex items-center gap-3 max-w-full">
              <span className="text-sm text-white/90 truncate">{lightbox.title}</span>
              <button
                onClick={() => setLightbox(null)}
                className="shrink-0 p-1.5 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors"
                title="關閉 (Esc)"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
