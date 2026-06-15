import { useEffect, useState, useMemo, useCallback } from 'react';
import { useRoute, Link } from 'wouter';
import { supabase } from '@/lib/supabase';
import { queryAllPages } from '@/lib/query-helpers';
import { formatCurrency, formatNumber } from '@/lib/format';
import { syncPromoPrices, type SyncItem } from '@/lib/shopify-sync';
import {
  Megaphone,
  RefreshCw,
  AlertCircle,
  ArrowLeft,
  Calendar,
  ChevronDown,
  ChevronRight,
  ArrowUp,
  ArrowDown,
  Download,
  Upload,
  RotateCcw,
} from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { MultiSelectChipFilter } from '@/components/multi-select-chip-filter';
import {
  Promotion,
  PromotionItem,
  Rating,
  RATING_LABEL,
  RATING_COLOR,
  STATUS_LABEL,
  STATUS_COLOR,
  ratingFromLift,
  fetchAllRows,
  daysBetween,
} from '@/lib/promotions-shared';

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

interface BcInvRow {
  number: string;
  unit_cost: number | string | null;
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

interface SkuStat {
  sku: string;
  variant_title: string;
  inventory: number;
  price: number;
  unit_cost: number;
  promo_qty: number;
  promo_revenue: number;
  pre_promo_qty: number;
  pre_promo_daily: number;
  last_sold_at: string | null;
}

interface ProductStat {
  product_id: string;
  product_title: string;
  vendor: string;
  product_type: string;
  total_inventory: number;
  num_skus: number;
  retail_price: number;
  compare_at_price: number;
  unit_cost: number;
  promo_price: number | null;
  promo_qty: number;
  promo_revenue: number;
  pre_promo_qty: number;
  promo_daily_avg: number;
  pre_promo_daily_avg: number;
  lift_ratio: number;
  rating: Rating;
  skus: SkuStat[];
}

export default function PromotionDetailPage() {
  const [, params] = useRoute('/retail/promotions/:id');
  const promoId = params?.id;

  const [promo, setPromo] = useState<Promotion | null>(null);
  const [items, setItems] = useState<PromotionItem[]>([]);
  const [inventory, setInventory] = useState<InventoryRow[]>([]);
  const [orderLines, setOrderLines] = useState<OrderLineRow[]>([]);
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [bcInv, setBcInv] = useState<BcInvRow[]>([]);
  const [priceEdits, setPriceEdits] = useState<Map<string, number | null>>(new Map());
  const [savingId, setSavingId] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedProduct, setExpandedProduct] = useState<string | null>(null);
  type SortKey =
    | 'product_title' | 'total_inventory' | 'compare_at_price' | 'retail_price'
    | 'unit_cost' | 'margin_pct' | 'promo_price' | 'promo_pct' | 'promo_profit'
    | 'promo_qty' | 'promo_revenue';
  const [sortBy, setSortBy] = useState<SortKey>('promo_qty');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(new Set());
  const [selectedVendors, setSelectedVendors] = useState<Set<string>>(new Set());

  const toggleSort = (col: SortKey) => {
    if (sortBy === col) {
      setSortDir(d => (d === 'desc' ? 'asc' : 'desc'));
    } else {
      setSortBy(col);
      // 文字欄首次點擊用 asc,數字欄用 desc
      setSortDir(col === 'product_title' ? 'asc' : 'desc');
    }
  };

  const load = useCallback(async () => {
    if (!promoId) return;
    setLoading(true);
    setError(null);
    try {
      // 1. Promo + items
      const { data: promoData, error: pErr } = await supabase
        .from('promotions')
        .select('*')
        .eq('id', promoId)
        .single();
      if (pErr) throw pErr;
      setPromo(promoData as Promotion);

      const pItems = await fetchAllRows<PromotionItem>('promotion_items');
      const myItems = pItems.filter(i => i.promotion_id === promoId);
      setItems(myItems);

      // 統一用 string 作為比對 key、避免 number/string 兩邊不一致
      const productIds = new Set(myItems.map(i => String(i.product_id)));

      // 2. Inventory (all SKUs belonging to these products) — include compare_at_price for 建議零售價
      const inv = await fetchAllRows<InventoryRow>(
        'shopify_inventory',
        'sku,product_id,product_title,variant_title,vendor,product_type,inventory_quantity,price,compare_at_price'
      );
      const filteredInv = inv.filter(
        i => i.product_id != null && productIds.has(String(i.product_id))
      );
      setInventory(filteredInv);

      const skuSet = new Set(filteredInv.map(i => i.sku));

      // 3. Orders / order_lines / BC cost (full set — we filter client-side)
      const [ol, os, bc] = await Promise.all([
        queryAllPages('shopify_order_lines', 'sku,quantity,price,order_id'),
        queryAllPages('shopify_orders', 'id,created_at,cancelled_at'),
        queryAllPages('bc_inventory', 'number,unit_cost'),
      ]);
      setOrderLines((ol as OrderLineRow[]).filter(l => l.sku && skuSet.has(l.sku)));
      setOrders(os as OrderRow[]);
      setBcInv((bc as BcInvRow[]).filter(b => b.number && skuSet.has(b.number)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [promoId]);

  useEffect(() => {
    load();
  }, [load]);

  // ── Compute metrics ──────────────────────────────────────────────────────
  // cost / promo_price lookups
  const costBySku = useMemo(() => {
    const m = new Map<string, number>();
    for (const b of bcInv) m.set(b.number, Number(b.unit_cost ?? 0));
    return m;
  }, [bcInv]);

  const promoPriceByProduct = useMemo(() => {
    const m = new Map<string, number | null>();
    for (const it of items) {
      m.set(String(it.product_id), it.promo_price != null ? Number(it.promo_price) : null);
    }
    return m;
  }, [items]);

  const stats = useMemo<ProductStat[]>(() => {
    if (!promo || items.length === 0 || inventory.length === 0) return [];

    const startDate = new Date(promo.start_date + 'T00:00:00');
    const endDate = new Date(promo.end_date + 'T23:59:59');
    const preStart = new Date(startDate.getTime() - 90 * 86_400_000);
    const preEnd = new Date(startDate.getTime() - 1);

    const orderById = new Map<string, OrderRow>();
    for (const o of orders) {
      if (o.cancelled_at) continue;
      orderById.set(String(o.id), o);
    }

    // For each SKU, scan order_lines and bucket into promo vs pre-promo
    const skuPromoQty = new Map<string, number>();
    const skuPromoRev = new Map<string, number>();
    const skuPreQty = new Map<string, number>();
    const skuLastSold = new Map<string, string>();

    for (const line of orderLines) {
      const sku = line.sku;
      if (!sku) continue;
      const order = orderById.get(String(line.order_id));
      if (!order) continue;
      const createdAt = new Date(order.created_at);
      const qty = line.quantity ?? 0;
      const price = line.price ?? 0;

      if (createdAt >= startDate && createdAt <= endDate) {
        skuPromoQty.set(sku, (skuPromoQty.get(sku) ?? 0) + qty);
        skuPromoRev.set(sku, (skuPromoRev.get(sku) ?? 0) + qty * price);
      } else if (createdAt >= preStart && createdAt <= preEnd) {
        skuPreQty.set(sku, (skuPreQty.get(sku) ?? 0) + qty);
      }
      // Track last sold (any time)
      const lastStr = skuLastSold.get(sku);
      if (!lastStr || order.created_at > lastStr) {
        skuLastSold.set(sku, order.created_at);
      }
    }

    // Group by product_id (同一用 String key)
    const byProduct = new Map<string, InventoryRow[]>();
    for (const inv of inventory) {
      if (inv.product_id == null) continue;
      const key = String(inv.product_id);
      const arr = byProduct.get(key) ?? [];
      arr.push(inv);
      byProduct.set(key, arr);
    }

    const today = new Date();
    const promoDays = Math.max(1, daysBetween(startDate, today < endDate ? today : endDate) + 1);
    const preDays = 90;

    const results: ProductStat[] = [];
    for (const [productId, skuRows] of byProduct.entries()) {
      const skuStats: SkuStat[] = skuRows.map(s => {
        const promoQty = skuPromoQty.get(s.sku) ?? 0;
        const promoRev = skuPromoRev.get(s.sku) ?? 0;
        const preQty = skuPreQty.get(s.sku) ?? 0;
        return {
          sku: s.sku,
          variant_title: s.variant_title ?? '',
          inventory: s.inventory_quantity ?? 0,
          price: Number(s.price ?? 0),
          unit_cost: costBySku.get(s.sku) ?? 0,
          promo_qty: promoQty,
          promo_revenue: promoRev,
          pre_promo_qty: preQty,
          pre_promo_daily: preQty / preDays,
          last_sold_at: skuLastSold.get(s.sku) ?? null,
        };
      });

      // 代表價：取 first SKU 有值者（強制 cast 為 number，避免 Supabase numeric 返 string）
      const repPrice = skuStats.find(s => s.price > 0)?.price ?? 0;
      const repCompare =
        skuRows.map(s => Number(s.compare_at_price ?? 0)).find(v => v > 0) ?? 0;
      const repCost = skuStats.find(s => s.unit_cost > 0)?.unit_cost ?? 0;

      const promoQty = skuStats.reduce((s, x) => s + x.promo_qty, 0);
      const promoRev = skuStats.reduce((s, x) => s + x.promo_revenue, 0);
      const preQty = skuStats.reduce((s, x) => s + x.pre_promo_qty, 0);
      const promoDaily = promoQty / promoDays;
      const preDaily = preQty / preDays;
      const lift = preDaily === 0 ? (promoDaily > 0 ? 999 : 0) : promoDaily / preDaily;
      const rating: Rating = lift === 999 ? 'effective' : ratingFromLift(lift);

      results.push({
        product_id: productId,
        product_title: skuRows[0].product_title ?? '—',
        vendor: skuRows[0].vendor ?? '—',
        product_type: skuRows[0].product_type ?? '—',
        total_inventory: skuStats.reduce((s, x) => s + x.inventory, 0),
        num_skus: skuStats.length,
        retail_price: repPrice,
        compare_at_price: repCompare,
        unit_cost: repCost,
        promo_price: promoPriceByProduct.get(productId) ?? null,
        promo_qty: promoQty,
        promo_revenue: promoRev,
        pre_promo_qty: preQty,
        promo_daily_avg: promoDaily,
        pre_promo_daily_avg: preDaily,
        lift_ratio: lift,
        rating,
        skus: skuStats,
      });
    }

    return results;
  }, [promo, items, inventory, orderLines, orders, costBySku, promoPriceByProduct]);

  // Save promo_price
  const savePromoPrice = useCallback(
    async (productId: string, newPrice: number | null) => {
      if (!promoId) return;
      setSavingId(productId);
      try {
        const productIdNum = Number(productId);
        const { error: upErr } = await supabase
          .from('promotion_items')
          .update({ promo_price: newPrice })
          .eq('promotion_id', promoId)
          .eq('product_id', productIdNum)
          .eq('is_archived', false);
        if (upErr) throw upErr;
        setItems(prev =>
          prev.map(it =>
            String(it.product_id) === productId ? { ...it, promo_price: newPrice } : it
          )
        );
      } catch (e) {
        alert(`儲存推廣價失敗：${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setSavingId(null);
      }
    },
    [promoId]
  );

  const getEditValue = (productId: string, fallback: number | null): number | null => {
    if (priceEdits.has(productId)) return priceEdits.get(productId) ?? null;
    return fallback;
  };
  const setEditValue = (productId: string, val: number | null) => {
    setPriceEdits(prev => {
      const next = new Map(prev);
      next.set(productId, val);
      return next;
    });
  };
  const clearEdit = (productId: string) => {
    setPriceEdits(prev => {
      if (!prev.has(productId)) return prev;
      const next = new Map(prev);
      next.delete(productId);
      return next;
    });
  };

  // Filter options (聚合 distinct types/vendors,按推廣期銷量降序)
  const typeOptions = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of stats) {
      const k = s.product_type || '(未分類)';
      m.set(k, (m.get(k) ?? 0) + s.promo_qty);
    }
    return Array.from(m.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([label]) => label);
  }, [stats]);

  const vendorOptions = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of stats) {
      const k = s.vendor || '(未分類)';
      m.set(k, (m.get(k) ?? 0) + s.promo_qty);
    }
    return Array.from(m.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([label]) => label);
  }, [stats]);

  // Filtered + sorted view (default: promo_qty desc)
  const sortedStats = useMemo(() => {
    const arr = stats.filter(s => {
      const t = s.product_type || '(未分類)';
      const v = s.vendor || '(未分類)';
      if (selectedTypes.size > 0 && !selectedTypes.has(t)) return false;
      if (selectedVendors.size > 0 && !selectedVendors.has(v)) return false;
      return true;
    });
    // 排序值 — 計算欄 (利潤% / 推廣% / 推廣後利潤金額) 同 PriceCells 顯示用同一公式;
    // null (冇數據) 一律排最尾,唔受 asc/desc 影響
    const sortValue = (s: ProductStat): number | string | null => {
      switch (sortBy) {
        case 'product_title':
          return s.product_title || '';
        case 'margin_pct':
          return s.retail_price > 0 && s.unit_cost > 0
            ? ((s.retail_price - s.unit_cost) / s.retail_price) * 100
            : null;
        case 'promo_pct': {
          const baseline = s.compare_at_price > 0 ? s.compare_at_price : s.retail_price;
          return s.promo_price != null && baseline > 0
            ? ((baseline - s.promo_price) / baseline) * 100
            : null;
        }
        case 'promo_profit': {
          if (s.promo_price == null || s.unit_cost <= 0) return null;
          const unit = s.promo_price - s.unit_cost;
          return s.promo_qty > 0 ? unit * s.promo_qty : unit;
        }
        case 'compare_at_price':
          return s.compare_at_price > 0 ? s.compare_at_price : null;
        case 'unit_cost':
          return s.unit_cost > 0 ? s.unit_cost : null;
        case 'promo_price':
          return s.promo_price;
        default:
          return (s as any)[sortBy] ?? null;
      }
    };
    arr.sort((a, b) => {
      const av = sortValue(a);
      const bv = sortValue(b);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      const cmp = typeof av === 'string' || typeof bv === 'string'
        ? String(av).localeCompare(String(bv), 'en', { sensitivity: 'base' })
        : (av as number) - (bv as number);
      return sortDir === 'desc' ? -cmp : cmp;
    });
    return arr;
  }, [stats, sortBy, sortDir, selectedTypes, selectedVendors]);

  // ── KPI roll-up (用 filtered view) ──────────────────────────────────────
  const kpi = useMemo(() => {
    if (!promo || sortedStats.length === 0) {
      return null;
    }
    const totalQty = sortedStats.reduce((s, p) => s + p.promo_qty, 0);
    const totalRev = sortedStats.reduce((s, p) => s + p.promo_revenue, 0);
    const totalPreQty = sortedStats.reduce((s, p) => s + p.pre_promo_qty, 0);

    const startDate = new Date(promo.start_date + 'T00:00:00');
    const endDate = new Date(promo.end_date + 'T23:59:59');
    const today = new Date();
    const promoDays = Math.max(1, daysBetween(startDate, today < endDate ? today : endDate) + 1);

    const promoDaily = totalQty / promoDays;
    const preDaily = totalPreQty / 90;
    const lift = preDaily === 0 ? (promoDaily > 0 ? 999 : 0) : promoDaily / preDaily;
    const aggRating: Rating = lift === 999 ? 'effective' : ratingFromLift(lift);

    const effectiveCount = sortedStats.filter(s => s.rating === 'effective').length;
    const okCount = sortedStats.filter(s => s.rating === 'ok').length;
    const ineffectiveCount = sortedStats.filter(s => s.rating === 'ineffective').length;

    return {
      totalProducts: sortedStats.length,
      totalSkus: sortedStats.reduce((s, p) => s + p.num_skus, 0),
      totalQty,
      totalRev,
      promoDays,
      lift,
      aggRating,
      effectiveCount,
      okCount,
      ineffectiveCount,
    };
  }, [promo, sortedStats]);

  // ── Use snapshot for ended promos ────────────────────────────────────────
  const isEnded = promo?.status === 'ended';

  // ── CSV 匯出 (匯出目前篩選 / 排序後嘅商品列表,欄位同畫面一致) ──────────────
  const exportCsv = useCallback(() => {
    if (sortedStats.length === 0) return;
    const cell = (v: string | number | null | undefined) => {
      const s = v == null ? '' : String(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const round = (n: number, d = 0) => {
      const f = Math.pow(10, d);
      return Math.round(n * f) / f;
    };
    const headers = [
      '產品名稱', '品牌', 'SKU數', '現庫存', '建議零售價', '零售價', '單件成本',
      '利潤%', '推廣價', '推廣%', '推廣後利潤金額', '推廣期銷量', '推廣期營收',
      '推廣前90d銷量', '日均比較', '評級',
    ];
    const rows = sortedStats.map((g) => {
      const baseline = g.compare_at_price > 0 ? g.compare_at_price : g.retail_price;
      const marginPct = g.retail_price > 0 && g.unit_cost > 0
        ? round(((g.retail_price - g.unit_cost) / g.retail_price) * 100, 1) : '';
      const promoPct = g.promo_price != null && baseline > 0
        ? round(((baseline - g.promo_price) / baseline) * 100, 1) : '';
      const unitProfit = g.promo_price != null && g.unit_cost > 0 ? g.promo_price - g.unit_cost : null;
      const promoProfit = unitProfit != null
        ? round(g.promo_qty > 0 ? unitProfit * g.promo_qty : unitProfit, 0) : '';
      const lift = g.lift_ratio === 999 ? '∞' : g.lift_ratio === 0 ? '' : round(g.lift_ratio, 2);
      return [
        g.product_title,
        g.vendor,
        g.num_skus,
        g.total_inventory,
        g.compare_at_price > 0 ? round(g.compare_at_price, 0) : '',
        g.retail_price > 0 ? round(g.retail_price, 0) : '',
        g.unit_cost > 0 ? round(g.unit_cost, 0) : '',
        marginPct,
        g.promo_price != null ? round(g.promo_price, 0) : '',
        promoPct,
        promoProfit,
        g.promo_qty,
        round(g.promo_revenue, 0),
        g.pre_promo_qty,
        lift,
        RATING_LABEL[g.rating],
      ];
    });
    const csv = '﻿' + [headers, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const safeName = (promo?.name ?? 'promotion').replace(/[\\/:*?"<>|]+/g, '_');
    const a = document.createElement('a');
    a.href = url;
    a.download = `${safeName}_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [sortedStats, promo]);

  // ── 同步推廣價去 Shopify (經 serverless function,Shopify token 留 server) ──
  const handleShopifySync = useCallback(async (action: 'apply' | 'restore') => {
    const items: SyncItem[] = sortedStats
      .filter((g) => g.promo_price != null && g.promo_price > 0)
      .map((g) => ({ productId: g.product_id, promoPrice: g.promo_price as number }));
    if (items.length === 0) {
      alert('目前列表冇設定推廣價嘅商品可以同步。');
      return;
    }
    const msg = action === 'apply'
      ? `確定將 ${items.length} 件商品嘅推廣價推上 Shopify？\n\n⚠️ 會即時改你網店嘅實際售價（客人睇到）。原價會存做 compare-at（劃線價）。`
      : `確定將 ${items.length} 件商品還原 Shopify 原價？\n\n（促銷結束用 — 售價由 compare-at 還原並清走劃線價。）`;
    if (!confirm(msg)) return;
    setSyncing(true);
    setSyncMsg(`同步中 0/${items.length}…`);
    try {
      const r = await syncPromoPrices(items, action, (done, total) =>
        setSyncMsg(`同步中 ${done}/${total}…`)
      );
      const fails = r.results
        .filter((x) => !x.ok)
        .slice(0, 6)
        .map((x) => `· ${x.productId}: ${x.error}`);
      alert(
        `完成：成功 ${r.ok} · 失敗 ${r.failed}（共 ${r.total}）` +
          (fails.length ? `\n\n失敗例子：\n${fails.join('\n')}` : '')
      );
    } catch (e) {
      alert(`同步失敗：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSyncing(false);
      setSyncMsg(null);
    }
  }, [sortedStats]);

  if (!promoId) return null;

  return (
    <div className="space-y-4">
      {/* Back link */}
      <div className="flex items-center gap-2 text-xs">
        <Link
          to="/retail/promotions"
          className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          推廣活動
        </Link>
        <span className="text-muted-foreground">/</span>
        <Link
          to="/retail/promotions/history"
          className="text-muted-foreground hover:text-foreground transition-colors"
        >
          推廣歷史
        </Link>
      </div>

      {/* Header */}
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <Megaphone className="h-5 w-5 text-primary shrink-0" />
            <h1 className="text-lg font-semibold truncate">{promo?.name ?? '...'}</h1>
            {promo && (
              <span
                className={`px-1.5 py-0.5 rounded text-[10px] border ${STATUS_COLOR[promo.status]}`}
              >
                {STATUS_LABEL[promo.status]}
              </span>
            )}
            {isEnded && promo?.snapshotted_at && (
              <span className="text-[10px] text-muted-foreground">
                · 已 freeze 於 {new Date(promo.snapshotted_at).toLocaleString('zh-HK')}
              </span>
            )}
          </div>
          {promo && (
            <div className="text-xs text-muted-foreground mt-1 inline-flex items-center gap-1">
              <Calendar className="h-3 w-3" />
              {promo.start_date} → {promo.end_date}
              {promo.discount_type && <span className="ml-2">· {promo.discount_type}</span>}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap justify-end shrink-0">
          <button
            onClick={() => handleShopifySync('apply')}
            disabled={loading || syncing || sortedStats.length === 0}
            title="將推廣價推上 Shopify（會改網店實際售價）"
            className="text-xs px-3 py-1.5 rounded-md border border-primary/50 bg-primary/10 text-primary hover:bg-primary/20 transition-colors inline-flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Upload className={`h-3.5 w-3.5 ${syncing ? 'animate-pulse' : ''}`} />
            同步去 Shopify
          </button>
          <button
            onClick={() => handleShopifySync('restore')}
            disabled={loading || syncing || sortedStats.length === 0}
            title="還原 Shopify 原價（促銷完用）"
            className="text-xs px-3 py-1.5 rounded-md border border-border bg-card hover:bg-accent/60 transition-colors inline-flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            還原原價
          </button>
          <span className="w-px h-5 bg-border/60" />
          <button
            onClick={exportCsv}
            disabled={loading || sortedStats.length === 0}
            title="匯出目前篩選後嘅商品列表做 CSV"
            className="text-xs px-3 py-1.5 rounded-md border border-border bg-card hover:bg-accent/60 transition-colors inline-flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Download className="h-3.5 w-3.5" />
            輸出 CSV
          </button>
          <button
            onClick={load}
            disabled={loading}
            className="text-xs px-3 py-1.5 rounded-md border border-border bg-card hover:bg-accent/60 transition-colors inline-flex items-center gap-1"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            重新整理
          </button>
        </div>
      </div>

      {promo?.notes && (
        <div className="rounded-md border border-border/40 bg-muted/20 p-3 text-xs text-muted-foreground whitespace-pre-wrap">
          {promo.notes}
        </div>
      )}

      {error && (
        <div className="rounded-md border border-rose-500/40 bg-rose-500/10 p-3 text-rose-200 text-sm flex items-center gap-2">
          <AlertCircle className="h-4 w-4" />
          {error}
        </div>
      )}

      {syncMsg && (
        <div className="rounded-md border border-primary/40 bg-primary/10 p-2 text-xs text-primary inline-flex items-center gap-2">
          <Upload className="h-3.5 w-3.5 animate-pulse" />
          {syncMsg}
        </div>
      )}

      {/* KPI strip */}
      {loading ? (
        <Skeleton className="h-20 w-full" />
      ) : kpi ? (
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-2">
          <KpiCard label="推廣商品" value={formatNumber(kpi.totalProducts)} />
          <KpiCard label="SKU 數" value={formatNumber(kpi.totalSkus)} />
          <KpiCard label="推廣日數" value={`${kpi.promoDays} 天`} />
          <KpiCard label="推廣期銷量" value={formatNumber(kpi.totalQty)} />
          <KpiCard label="推廣期營收" value={formatCurrency(kpi.totalRev)} />
          <KpiCard
            label="整體日均比較"
            value={
              kpi.lift === 999
                ? '∞'
                : kpi.lift === 0
                  ? '—'
                  : `${kpi.lift.toFixed(2)}×`
            }
            color={RATING_COLOR[kpi.aggRating]}
          />
          <div className="rounded-md border border-border/60 bg-card p-2 flex flex-col">
            <span className="text-[10px] text-muted-foreground">商品成效分布</span>
            <div className="flex items-center gap-1 mt-1">
              <span className="text-[10px] px-1.5 py-0.5 rounded border bg-emerald-500/10 border-emerald-500/40 text-emerald-300">
                有效 {kpi.effectiveCount}
              </span>
              <span className="text-[10px] px-1.5 py-0.5 rounded border bg-amber-500/10 border-amber-500/40 text-amber-300">
                一般 {kpi.okCount}
              </span>
              <span className="text-[10px] px-1.5 py-0.5 rounded border bg-rose-500/10 border-rose-500/40 text-rose-300">
                無效 {kpi.ineffectiveCount}
              </span>
            </div>
          </div>
        </div>
      ) : null}

      {/* Filter chips: 分類 + 品牌 (死貨頁同款「+ 加」搜尋彈窗,唔再全部攤開) */}
      {!loading && stats.length > 0 && (
        <div className="rounded-md border border-border/60 bg-card p-2 space-y-1.5">
          <MultiSelectChipFilter
            label="分類"
            options={typeOptions}
            selected={Array.from(selectedTypes)}
            onChange={(next) => setSelectedTypes(new Set(next))}
            placeholder="搜尋分類…"
          />
          <MultiSelectChipFilter
            label="品牌"
            options={vendorOptions}
            selected={Array.from(selectedVendors)}
            onChange={(next) => setSelectedVendors(new Set(next))}
            placeholder="搜尋品牌…"
          />
        </div>
      )}

      {/* Snapshot indicator for ended */}
      {isEnded && promo?.final_qty_sold != null && (
        <div className="rounded-md border border-border/40 bg-muted/20 p-3 text-xs">
          <span className="text-muted-foreground">⚡ 結束 Snapshot：</span>{' '}
          銷量 <span className="font-medium tabular-nums">{formatNumber(promo.final_qty_sold)}</span> ·
          營收 <span className="font-medium tabular-nums">{formatCurrency(promo.final_revenue ?? 0)}</span> ·
          整體 Lift <span className="font-medium tabular-nums">
            {promo.final_lift_ratio === 999 ? '∞' : `${(promo.final_lift_ratio ?? 0).toFixed(2)}×`}
          </span> ·
          評級{' '}
          <span
            className={`px-1.5 py-0.5 rounded text-[10px] border ${
              promo.final_rating ? RATING_COLOR[promo.final_rating] : ''
            }`}
          >
            {promo.final_rating ? RATING_LABEL[promo.final_rating] : '—'}
          </span>
        </div>
      )}

      {/* Table */}
      {loading ? (
        <Skeleton className="h-64 w-full" />
      ) : stats.length === 0 ? (
        <div className="rounded-md border border-dashed border-border/60 p-12 text-center text-sm text-muted-foreground">
          此推廣尚未分派任何商品。去
          <Link to="/retail/promotions/items" className="text-primary hover:underline mx-1">
            推廣商品池
          </Link>
          分派。
        </div>
      ) : (
        <div className="rounded-md border border-border/60 bg-card overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-muted/30 border-b border-border/40">
              <tr>
                <th className="text-left px-2 py-2 font-normal text-muted-foreground w-6"></th>
                <SortableTh col="product_title" label="產品名稱" align="left" sortBy={sortBy} sortDir={sortDir} onSort={toggleSort} />
                <th className="text-left px-2 py-2 font-normal text-muted-foreground">品牌</th>
                <th className="text-right px-2 py-2 font-normal text-muted-foreground">SKU</th>
                <SortableTh col="total_inventory" label="現庫存" sortBy={sortBy} sortDir={sortDir} onSort={toggleSort} />
                <SortableTh col="compare_at_price" label="建議零售價" sortBy={sortBy} sortDir={sortDir} onSort={toggleSort} />
                <SortableTh col="retail_price" label="零售價" sortBy={sortBy} sortDir={sortDir} onSort={toggleSort} />
                <SortableTh col="unit_cost" label="單件成本" sortBy={sortBy} sortDir={sortDir} onSort={toggleSort} />
                <SortableTh col="margin_pct" label="利潤%" sortBy={sortBy} sortDir={sortDir} onSort={toggleSort} />
                <SortableTh col="promo_price" label="推廣價" className="w-24" sortBy={sortBy} sortDir={sortDir} onSort={toggleSort} />
                <SortableTh col="promo_pct" label="推廣%" className="w-20" sortBy={sortBy} sortDir={sortDir} onSort={toggleSort} />
                <SortableTh col="promo_profit" label="推廣後利潤金額" sortBy={sortBy} sortDir={sortDir} onSort={toggleSort} />
                <SortableTh col="promo_qty" label="推廣期銷量" sortBy={sortBy} sortDir={sortDir} onSort={toggleSort} />
                <SortableTh col="promo_revenue" label="推廣期營收" sortBy={sortBy} sortDir={sortDir} onSort={toggleSort} />
                <th className="text-right px-2 py-2 font-normal text-muted-foreground">推廣前 90d 銷量</th>
                <th className="text-right px-2 py-2 font-normal text-muted-foreground">日均比較</th>
                <th className="text-left px-2 py-2 font-normal text-muted-foreground">評級</th>
              </tr>
            </thead>
            <tbody>
              {sortedStats.map(g => {
                const isExpanded = expandedProduct === g.product_id;
                return (
                  <>
                    <tr
                      key={g.product_id}
                      className="border-b border-border/40 hover:bg-accent/30 cursor-pointer"
                      onClick={() =>
                        setExpandedProduct(isExpanded ? null : g.product_id)
                      }
                    >
                      <td className="px-2 py-1.5">
                        {isExpanded ? (
                          <ChevronDown className="h-3 w-3 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="h-3 w-3 text-muted-foreground" />
                        )}
                      </td>
                      <td className="px-2 py-1.5 font-medium" title={g.product_title}>
                        {g.product_title}
                      </td>
                      <td className="px-2 py-1.5 text-muted-foreground">{g.vendor}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{g.num_skus}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{formatNumber(g.total_inventory)}</td>
                      {/* 價格 5 列 + 推廣價 + 推廣% + 推廣後利潤金額 */}
                      <PriceCells
                        row={g}
                        editValue={getEditValue(g.product_id, g.promo_price)}
                        saving={savingId === g.product_id}
                        onChangePrice={(val) => setEditValue(g.product_id, val)}
                        onChangePct={(pct) => {
                          // 推廣% baseline = 建議零售價 (compare_at_price)，未設則 fallback retail_price
                          const baseline = g.compare_at_price > 0 ? g.compare_at_price : g.retail_price;
                          if (pct == null || baseline <= 0) {
                            setEditValue(g.product_id, null);
                          } else {
                            const newPrice = Math.round(baseline * (1 - pct / 100) * 100) / 100;
                            setEditValue(g.product_id, newPrice);
                          }
                        }}
                        onCommit={async (val) => {
                          await savePromoPrice(g.product_id, val);
                          clearEdit(g.product_id);
                        }}
                      />
                      <td className="px-2 py-1.5 text-right tabular-nums font-medium">
                        {formatNumber(g.promo_qty)}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums font-medium">
                        {formatCurrency(g.promo_revenue)}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">
                        {formatNumber(g.pre_promo_qty)}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums">
                        {g.lift_ratio === 999
                          ? '∞'
                          : g.lift_ratio === 0
                            ? '—'
                            : `${g.lift_ratio.toFixed(2)}×`}
                      </td>
                      <td className="px-2 py-1.5">
                        <span
                          className={`px-1.5 py-0.5 rounded text-[10px] border ${RATING_COLOR[g.rating]}`}
                        >
                          {RATING_LABEL[g.rating]}
                        </span>
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr key={`${g.product_id}-detail`} className="bg-muted/20 border-b border-border/40">
                        <td colSpan={17} className="px-3 py-2">
                          <div className="text-[10px] text-muted-foreground mb-1.5">
                            身下 SKU 明細：
                          </div>
                          <div className="overflow-x-auto">
                            <table className="w-full text-[10px]">
                              <thead className="text-muted-foreground">
                                <tr>
                                  <th className="text-left py-1 font-normal">SKU</th>
                                  <th className="text-left py-1 font-normal">Variant</th>
                                  <th className="text-right py-1 font-normal">庫存</th>
                                  <th className="text-right py-1 font-normal">售價</th>
                                  <th className="text-right py-1 font-normal">推廣銷量</th>
                                  <th className="text-right py-1 font-normal">推廣營收</th>
                                  <th className="text-right py-1 font-normal">推廣前 90d 日均</th>
                                  <th className="text-left py-1 font-normal">最後銷售</th>
                                </tr>
                              </thead>
                              <tbody>
                                {g.skus.map(s => (
                                  <tr key={s.sku} className="border-t border-border/20">
                                    <td className="py-1 font-mono">{s.sku}</td>
                                    <td className="py-1">{s.variant_title || '—'}</td>
                                    <td className="py-1 text-right tabular-nums">{formatNumber(s.inventory)}</td>
                                    <td className="py-1 text-right tabular-nums">{formatCurrency(s.price)}</td>
                                    <td className="py-1 text-right tabular-nums">{formatNumber(s.promo_qty)}</td>
                                    <td className="py-1 text-right tabular-nums">{formatCurrency(s.promo_revenue)}</td>
                                    <td className="py-1 text-right tabular-nums">{s.pre_promo_daily.toFixed(2)}</td>
                                    <td className="py-1 text-muted-foreground">
                                      {s.last_sold_at ? new Date(s.last_sold_at).toLocaleDateString('zh-HK') : '—'}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function KpiCard({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <div className={`rounded-md border bg-card p-2 ${color ?? 'border-border/60'}`}>
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className="text-sm font-semibold tabular-nums mt-0.5">{value}</div>
    </div>
  );
}

// ── Sortable table header cell ───────────────────────────────────────────────
function SortableTh({
  col, label, align = 'right', className = '', sortBy, sortDir, onSort,
}: {
  col: string;
  label: string;
  align?: 'left' | 'right';
  className?: string;
  sortBy: string;
  sortDir: 'asc' | 'desc';
  onSort: (col: any) => void;
}) {
  const active = sortBy === col;
  return (
    <th
      className={`${align === 'left' ? 'text-left' : 'text-right'} px-2 py-2 font-normal cursor-pointer select-none hover:text-foreground ${
        active ? 'text-foreground' : 'text-muted-foreground'
      } ${className}`}
      onClick={() => onSort(col)}
    >
      <span className="inline-flex items-center gap-0.5">
        {label}
        {active && (sortDir === 'desc' ? <ArrowDown className="h-3 w-3" /> : <ArrowUp className="h-3 w-3" />)}
      </span>
    </th>
  );
}

function PriceCells({
  row,
  editValue,
  saving,
  onChangePrice,
  onChangePct,
  onCommit,
}: {
  row: ProductStat;
  editValue: number | null;
  saving: boolean;
  onChangePrice: (val: number | null) => void;
  onChangePct: (pct: number | null) => void;
  onCommit: (val: number | null) => void | Promise<void>;
}) {
  // 利潤% = (零售價 - 成本) / 零售價
  const marginPct =
    row.retail_price > 0 ? ((row.retail_price - row.unit_cost) / row.retail_price) * 100 : 0;

  // 推廣% baseline = 建議零售價 (compare_at_price)，未設則 fallback retail_price
  const promoBaseline = row.compare_at_price > 0 ? row.compare_at_price : row.retail_price;
  const effectivePromoPrice = editValue;
  const promoPct =
    effectivePromoPrice != null && promoBaseline > 0
      ? ((promoBaseline - effectivePromoPrice) / promoBaseline) * 100
      : null;

  // 推廣後利潤金額：
  //   有 promo_qty → (推廣價 - cost) × promo_qty (總額)
  //   未有銷售 → (推廣價 - cost) (每件利潤，加灰色字 /件)
  const hasPromoSales = row.promo_qty > 0;
  const promoUnitProfit =
    effectivePromoPrice != null && row.unit_cost > 0
      ? effectivePromoPrice - row.unit_cost
      : null;
  const promoProfit =
    promoUnitProfit != null
      ? hasPromoSales
        ? promoUnitProfit * row.promo_qty
        : promoUnitProfit
      : null;

  const fmtCurrency = (n: number) =>
    new Intl.NumberFormat('en-HK', { style: 'currency', currency: 'HKD', maximumFractionDigits: 0 }).format(n);
  const fmtPlain = (n: number) => (n > 0 ? n.toFixed(0) : '—');

  return (
    <>
      <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">
        {row.compare_at_price > 0 ? fmtPlain(row.compare_at_price) : '—'}
      </td>
      <td className="px-2 py-1.5 text-right tabular-nums">{fmtPlain(row.retail_price)}</td>
      <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">
        {row.unit_cost > 0 ? fmtPlain(row.unit_cost) : '—'}
      </td>
      <td className="px-2 py-1.5 text-right tabular-nums">
        <span className={marginPct < 20 ? 'text-rose-300' : marginPct < 40 ? 'text-amber-300' : 'text-emerald-300'}>
          {row.retail_price > 0 && row.unit_cost > 0 ? `${marginPct.toFixed(0)}%` : '—'}
        </span>
      </td>
      {/* 推廣價 input */}
      <td className="px-2 py-1.5 text-right" onClick={e => e.stopPropagation()}>
        <input
          type="number"
          step="1"
          min="0"
          value={effectivePromoPrice ?? ''}
          onChange={e => {
            const v = e.target.value.trim();
            onChangePrice(v === '' ? null : Number(v));
          }}
          onBlur={() => onCommit(effectivePromoPrice)}
          onKeyDown={e => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
          disabled={saving}
          placeholder="—"
          className="w-20 text-right tabular-nums text-xs px-1.5 py-0.5 rounded border border-border/60 bg-background focus:border-primary focus:outline-none"
        />
      </td>
      {/* 推廣% input */}
      <td className="px-2 py-1.5 text-right" onClick={e => e.stopPropagation()}>
        <input
          type="number"
          step="1"
          min="0"
          max="100"
          value={promoPct != null ? Math.round(promoPct * 10) / 10 : ''}
          onChange={e => {
            const v = e.target.value.trim();
            onChangePct(v === '' ? null : Number(v));
          }}
          onBlur={() => onCommit(effectivePromoPrice)}
          onKeyDown={e => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
          disabled={saving || promoBaseline <= 0}
          placeholder="—"
          className="w-16 text-right tabular-nums text-xs px-1.5 py-0.5 rounded border border-border/60 bg-background focus:border-primary focus:outline-none"
        />
      </td>
      {/* 推廣後利潤金額 */}
      <td className="px-2 py-1.5 text-right tabular-nums">
        {promoProfit != null ? (
          <span className={promoProfit < 0 ? 'text-rose-300' : 'text-emerald-300'}>
            {fmtCurrency(promoProfit)}
            {!hasPromoSales && <span className="text-[9px] text-muted-foreground ml-0.5">/件</span>}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
    </>
  );
}

