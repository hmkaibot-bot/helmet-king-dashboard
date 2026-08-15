import React, { useState, useMemo, useCallback } from 'react';
import { formatCurrency } from '@/lib/format';
import {
  ChevronDown, ChevronRight, ArrowUpDown, ArrowUp, ArrowDown,
  Plus, X, Search, BarChart3, ImageOff,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

// ── Default brand list ──────────────────────────────────────
const DEFAULT_BRANDS = [
  'SCORPION', 'SHOEI', 'ARAI', 'FETURE', 'MODER',
  'FURYGAN', 'ROUGH AND ROAD', 'KUSHITANI', 'GAERNE', 'ELEVEIT',
];

const BRANDS_LS_KEY = 'dw-brands';

function loadSelectedBrands(): string[] {
  try {
    const raw = localStorage.getItem(BRANDS_LS_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.every(x => typeof x === 'string')) return arr;
    }
  } catch {}
  return DEFAULT_BRANDS;
}

// ── Normalize vendor name to match selected brands ──────────
function matchBrand(vendor: string, brands: string[]): string | null {
  const v = (vendor || '').toUpperCase().trim();
  if (!v) return null;
  for (const b of brands) {
    if (v === b || v.startsWith(b + ' ') || v.includes(b)) return b;
  }
  // Common aliases
  if (v === 'SHOEI EUROPE' && brands.includes('SHOEI')) return 'SHOEI';
  if (v === 'FIVE GLOVES' && brands.includes('FIVE')) return 'FIVE';
  return null;
}

// ── HK date helpers (same as daily-weekly) ──────────────────
function getHKNow(): Date {
  const now = new Date();
  return new Date(now.getTime() + (now.getTimezoneOffset() + 480) * 60000);
}
function toDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function toHKDateStr(isoStr: string): string {
  const d = new Date(isoStr);
  const hk = new Date(d.getTime() + (d.getTimezoneOffset() + 480) * 60000);
  return toDateStr(hk);
}

type SortField = 'revenue' | 'qty';
type SortDir = 'desc' | 'asc';

interface BrandRow {
  brand: string;
  // 當月 MTD
  revenue: number;
  qty: number;
  profit: number;      // 毛利(淨計有成本價嘅貨)
  coveredRev: number;  // 有成本價嘅營收(毛利率分母)
  // 昨日 / 本週
  yQty: number;
  yRevenue: number;
  wkRevenue: number;
  items: BrandItem[];
}

interface BrandItem {
  title: string;
  productId: string | null;
  skus: Set<string>;
  qty: number;
  revenue: number;
  yQty: number;
  yRevenue: number;
  profit: number;      // 當月毛利(淨計有成本價嘅 lines)
  coveredRev: number;  // 有成本價嘅當月營收
}

interface Props {
  allOrders: any[];
  allOrderLines: any[];
  loading: boolean;
  yOrderIds: Set<string>;    // 昨日 order ids
  weekOrderIds: Set<string>; // 本週 order ids
  costMap: Record<string, number>;         // sku → 成本價(>0 先有)
  velocityMap: Record<string, number>;     // sku → 件/日(60日均)
  imageMap: Record<string, string>;        // product_id → 產品圖
  productStockMap: Record<string, number>; // product_id → 所有 variant 庫存總和
}

export function BrandMonthlySales({ allOrders, allOrderLines, loading, yOrderIds, weekOrderIds, costMap, velocityMap, imageMap, productStockMap }: Props) {
  // ── State ──────────────────────────────────────────────────
  const [selectedBrands, setSelectedBrandsRaw] = useState<string[]>(loadSelectedBrands);
  const setSelectedBrands = useCallback((updater: string[] | ((prev: string[]) => string[])) => {
    setSelectedBrandsRaw(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      try { localStorage.setItem(BRANDS_LS_KEY, JSON.stringify(next)); } catch {}
      return next;
    });
  }, []);
  const [sortField, setSortField] = useState<SortField>('revenue');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [expandedBrands, setExpandedBrands] = useState<Set<string>>(new Set());
  const [showAllItems, setShowAllItems] = useState<Set<string>>(new Set()); // 撳咗「開晒長尾」嘅品牌
  const [lightbox, setLightbox] = useState<{ url: string; title: string } | null>(null); // 撳大產品圖
  const [showPicker, setShowPicker] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');

  // ── MTD date range ─────────────────────────────────────────
  const mtdRange = useMemo(() => {
    const hkt = getHKNow();
    const firstOfMonth = new Date(hkt.getFullYear(), hkt.getMonth(), 1);
    return { from: toDateStr(firstOfMonth), to: toDateStr(hkt) };
  }, []);

  // ── Compute MTD orders ─────────────────────────────────────
  const mtdOrderIds = useMemo(() => {
    const ids = new Set<string>();
    allOrders.forEach((o: any) => {
      const d = toHKDateStr(o.created_at);
      if (d >= mtdRange.from && d <= mtdRange.to) ids.add(String(o.id));
    });
    return ids;
  }, [allOrders, mtdRange]);

  // ── All unique vendors in MTD data (for the picker) ────────
  const allVendorsInData = useMemo(() => {
    const vSet = new Set<string>();
    allOrderLines.forEach((l: any) => {
      if (mtdOrderIds.has(String(l.order_id)) && l.vendor) {
        vSet.add(l.vendor.toUpperCase().trim());
      }
    });
    return [...vSet].sort();
  }, [allOrderLines, mtdOrderIds]);

  // ── Compute brand data (昨日 / 本週 / 當月MTD + 毛利) ──────
  const brandData = useMemo((): BrandRow[] => {
    const map: Record<string, {
      revenue: number; qty: number; profit: number; coveredRev: number;
      yQty: number; yRevenue: number; wkRevenue: number;
      items: Record<string, BrandItem>;
    }> = {};
    selectedBrands.forEach(b => {
      map[b] = { revenue: 0, qty: 0, profit: 0, coveredRev: 0, yQty: 0, yRevenue: 0, wkRevenue: 0, items: {} };
    });

    allOrderLines.forEach((l: any) => {
      const oid = String(l.order_id);
      const inMtd = mtdOrderIds.has(oid);
      const inY   = yOrderIds.has(oid);
      const inWk  = weekOrderIds.has(oid);
      if (!inMtd && !inY && !inWk) return;

      const brand = matchBrand(l.vendor || '', selectedBrands);
      if (!brand || !map[brand]) return;

      const qty = l.quantity || 0;
      const rev = (parseFloat(l.price) || 0) * qty;

      if (inMtd) {
        map[brand].revenue += rev;
        map[brand].qty += qty;
        const c = l.sku ? costMap[l.sku] : undefined;
        if (c !== undefined) {
          map[brand].profit += rev - c * qty;
          map[brand].coveredRev += rev;
        }
        const title = l.title || 'unknown';
        if (!map[brand].items[title]) map[brand].items[title] = { title, productId: null, skus: new Set(), qty: 0, revenue: 0, yQty: 0, yRevenue: 0, profit: 0, coveredRev: 0 };
        const it = map[brand].items[title];
        it.qty += qty;
        it.revenue += rev;
        if (!it.productId && l.product_id) it.productId = String(l.product_id);
        if (l.sku) it.skus.add(l.sku);
        if (c !== undefined) { it.profit += rev - c * qty; it.coveredRev += rev; }
        if (inY) { it.yQty += qty; it.yRevenue += rev; }
      }
      if (inY)  { map[brand].yQty += qty; map[brand].yRevenue += rev; }
      if (inWk) { map[brand].wkRevenue += rev; }
    });

    return Object.entries(map).map(([brand, d]) => ({
      brand,
      revenue: d.revenue,
      qty: d.qty,
      profit: d.profit,
      coveredRev: d.coveredRev,
      yQty: d.yQty,
      yRevenue: d.yRevenue,
      wkRevenue: d.wkRevenue,
      items: Object.values(d.items).sort((a, b) => b.revenue - a.revenue),
    }));
  }, [allOrderLines, mtdOrderIds, yOrderIds, weekOrderIds, costMap, selectedBrands]);

  // ── Sort ───────────────────────────────────────────────────
  const sorted = useMemo(() => {
    return [...brandData].sort((a, b) => {
      const va = sortField === 'revenue' ? a.revenue : a.qty;
      const vb = sortField === 'revenue' ? b.revenue : b.qty;
      return sortDir === 'desc' ? vb - va : va - vb;
    });
  }, [brandData, sortField, sortDir]);

  // ── Totals ─────────────────────────────────────────────────
  const totals = useMemo(() => sorted.reduce((t, b) => ({
    revenue: t.revenue + b.revenue,
    qty: t.qty + b.qty,
    profit: t.profit + b.profit,
    coveredRev: t.coveredRev + b.coveredRev,
    yQty: t.yQty + b.yQty,
    yRevenue: t.yRevenue + b.yRevenue,
    wkRevenue: t.wkRevenue + b.wkRevenue,
  }), { revenue: 0, qty: 0, profit: 0, coveredRev: 0, yQty: 0, yRevenue: 0, wkRevenue: 0 }), [sorted]);

  // ── Toggle sort ────────────────────────────────────────────
  const toggleSort = useCallback((field: SortField) => {
    if (sortField === field) {
      setSortDir(d => d === 'desc' ? 'asc' : 'desc');
    } else {
      setSortField(field);
      setSortDir('desc');
    }
  }, [sortField]);

  // ── Toggle expand ──────────────────────────────────────────
  const toggleExpand = useCallback((brand: string) => {
    setExpandedBrands(prev => {
      const n = new Set(prev);
      n.has(brand) ? n.delete(brand) : n.add(brand);
      return n;
    });
  }, []);

  // ── Remove / Add brand ─────────────────────────────────────
  const removeBrand = useCallback((brand: string) => {
    setSelectedBrands(prev => prev.filter(b => b !== brand));
    setExpandedBrands(prev => { const n = new Set(prev); n.delete(brand); return n; });
  }, [setSelectedBrands]);

  const addBrand = useCallback((brand: string) => {
    setSelectedBrands(prev => prev.includes(brand) ? prev : [...prev, brand]);
  }, [setSelectedBrands]);

  // ── Sort icon helper ───────────────────────────────────────
  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) return <ArrowUpDown className="h-3 w-3 text-muted-foreground/40" />;
    return sortDir === 'desc'
      ? <ArrowDown className="h-3 w-3 text-primary" />
      : <ArrowUp className="h-3 w-3 text-primary" />;
  };

  // ── Filtered vendors for picker ────────────────────────────
  const filteredVendors = useMemo(() => {
    const term = searchTerm.toUpperCase().trim();
    const available = allVendorsInData.filter(v => !selectedBrands.includes(v));
    if (!term) return available.slice(0, 20);
    return available.filter(v => v.includes(term)).slice(0, 20);
  }, [allVendorsInData, selectedBrands, searchTerm]);

  // ── Month label ────────────────────────────────────────────
  const monthLabel = useMemo(() => {
    const hkt = getHKNow();
    return `${hkt.getFullYear()}年${hkt.getMonth() + 1}月`;
  }, []);

  const marginOf = (profit: number, coveredRev: number) =>
    coveredRev > 0 ? (profit / coveredRev) * 100 : null;
  const totalCoverage = totals.revenue > 0 ? (totals.coveredRev / totals.revenue) * 100 : 0;

  return (
    <Card className="border-border/40">
      <CardHeader className="pb-2 pt-4 px-4">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <BarChart3 className="h-3.5 w-3.5 text-primary shrink-0" />
            品牌銷售
            <span className="text-[13px] font-normal text-muted-foreground">
              昨日 / 本週 / 當月MTD — {monthLabel} ({mtdRange.from} ~ {mtdRange.to})
            </span>
          </CardTitle>
          <button
            onClick={() => { setShowPicker(!showPicker); setSearchTerm(''); }}
            className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium bg-primary/10 text-primary border border-primary/20 hover:bg-primary/20 transition-colors"
          >
            <Plus className="h-3 w-3" />
            管理品牌
          </button>
        </div>
      </CardHeader>

      <CardContent className="px-4 pb-4">
        {/* ── Brand picker panel ─────────────────────────── */}
        {showPicker && (
          <div className="mb-4 p-3 rounded-lg border border-border/50 bg-accent/10">
            {/* Selected brands */}
            <p className="text-[11px] font-semibold text-muted-foreground mb-1.5">已選品牌 Selected ({selectedBrands.length})</p>
            <div className="flex flex-wrap gap-1 mb-3">
              {selectedBrands.map(b => (
                <span key={b} className="inline-flex items-center gap-1 text-xs bg-primary/15 text-primary border border-primary/25 px-2 py-0.5 rounded-full">
                  {b}
                  <button
                    onClick={() => removeBrand(b)}
                    className="hover:text-red-400 transition-colors"
                    title={`移除 ${b}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>

            {/* Search + add */}
            <p className="text-[11px] font-semibold text-muted-foreground mb-1.5">新增品牌 Add Brand</p>
            <div className="flex items-center gap-2 mb-2">
              <div className="relative flex-1">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground/50" />
                <input
                  type="text"
                  value={searchTerm}
                  onChange={e => setSearchTerm(e.target.value)}
                  placeholder="搜尋品牌名稱..."
                  className="w-full pl-7 pr-2 py-1.5 text-[13px] bg-background border border-border rounded text-foreground focus:outline-none focus:border-primary"
                />
              </div>
            </div>
            <div className="flex flex-wrap gap-1 max-h-32 overflow-y-auto">
              {filteredVendors.length === 0 ? (
                <p className="text-[11px] text-muted-foreground/50 py-2.5">
                  {searchTerm ? '找不到匹配品牌' : '所有品牌已選取'}
                </p>
              ) : (
                filteredVendors.map(v => (
                  <button
                    key={v}
                    onClick={() => addBrand(v)}
                    className="text-xs px-2 py-0.5 bg-accent/60 text-muted-foreground border border-border/40 rounded hover:bg-primary/10 hover:text-primary hover:border-primary/30 transition-colors"
                  >
                    + {v}
                  </button>
                ))
              )}
            </div>

            {/* Reset to default */}
            <div className="mt-2 pt-2 border-t border-border/30 flex items-center gap-2">
              <button
                onClick={() => setSelectedBrands(DEFAULT_BRANDS)}
                className="text-[11px] text-muted-foreground/60 hover:text-muted-foreground transition-colors"
              >
                重設為預設品牌 Reset to default
              </button>
              <button
                onClick={() => { setShowPicker(false); setSearchTerm(''); }}
                className="ml-auto text-[11px] px-2 py-0.5 bg-primary/80 text-primary-foreground rounded hover:bg-primary transition-colors"
              >
                完成
              </button>
            </div>
          </div>
        )}

        {/* ── Main table ──────────────────────────────────── */}
        {loading ? (
          <Skeleton className="h-48 w-full" />
        ) : sorted.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">請新增品牌以顯示數據</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]" data-testid="table-brand-mtd">
              <thead>
                <tr className="border-b border-border/50 text-muted-foreground">
                  <th className="py-2.5 text-left font-medium">品牌 Brand</th>
                  <th className="py-2.5 text-right font-medium">昨日</th>
                  <th className="py-2.5 text-right font-medium">本週營收</th>
                  <th className="py-2.5 text-right font-medium">
                    <button
                      onClick={() => toggleSort('qty')}
                      className="inline-flex items-center gap-1 hover:text-foreground transition-colors"
                    >
                      當月件數 <SortIcon field="qty" />
                    </button>
                  </th>
                  <th className="py-2.5 text-right font-medium">
                    <button
                      onClick={() => toggleSort('revenue')}
                      className="inline-flex items-center gap-1 hover:text-foreground transition-colors"
                    >
                      當月營收 <SortIcon field="revenue" />
                    </button>
                  </th>
                  <th className="py-2.5 text-right font-medium">當月毛利</th>
                  <th className="py-2.5 text-right font-medium">占比</th>
                  <th className="py-2.5 text-center font-medium w-8"></th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((b, i) => {
                  const isExpanded = expandedBrands.has(b.brand);
                  const pct = totals.revenue > 0 ? (b.revenue / totals.revenue) * 100 : 0;
                  const margin = marginOf(b.profit, b.coveredRev);
                  return (
                    <React.Fragment key={b.brand}>
                      <tr
                        className={`border-b border-border/20 hover:bg-accent/30 transition-colors cursor-pointer ${
                          i === 0 && b.revenue > 0 ? 'bg-amber-500/5' : ''
                        }`}
                        onClick={() => toggleExpand(b.brand)}
                      >
                        <td className="py-2.5 font-medium">
                          <span className="inline-flex items-center gap-1.5">
                            {isExpanded
                              ? <ChevronDown className="h-3 w-3 text-muted-foreground" />
                              : <ChevronRight className="h-3 w-3 text-muted-foreground" />}
                            {i === 0 && b.revenue > 0 && <span className="text-amber-400">🥇</span>}
                            {i === 1 && b.revenue > 0 && <span>🥈</span>}
                            {i === 2 && b.revenue > 0 && <span className="text-amber-700">🥉</span>}
                            {b.brand}
                          </span>
                        </td>
                        <td className="py-2.5 text-right tabular-nums">
                          {b.yQty > 0
                            ? <span className="font-semibold text-primary">{b.yQty}件 {formatCurrency(b.yRevenue)}</span>
                            : <span className="text-muted-foreground/30">—</span>}
                        </td>
                        <td className="py-2.5 text-right tabular-nums">
                          {b.wkRevenue > 0 ? formatCurrency(b.wkRevenue) : <span className="text-muted-foreground/30">—</span>}
                        </td>
                        <td className="py-2.5 text-right tabular-nums font-bold">
                          {b.qty > 0 ? b.qty : <span className="text-muted-foreground/30">0</span>}
                        </td>
                        <td className="py-2.5 text-right tabular-nums font-semibold">
                          {b.revenue > 0 ? formatCurrency(b.revenue) : <span className="text-muted-foreground/30">—</span>}
                        </td>
                        <td className="py-2.5 text-right tabular-nums">
                          {margin !== null ? (
                            <>
                              <span className={b.profit >= 0 ? 'text-emerald-400' : 'text-red-400'}>{formatCurrency(b.profit)}</span>
                              <span className="text-[11px] text-muted-foreground ml-1">{margin.toFixed(0)}%</span>
                            </>
                          ) : <span className="text-muted-foreground/30">—</span>}
                        </td>
                        <td className="py-2.5 text-right">
                          {pct > 0 ? (
                            <div className="flex items-center justify-end gap-1.5">
                              <div className="w-12 h-1.5 bg-border/40 rounded-full overflow-hidden">
                                <div className="h-full bg-primary/60 rounded-full" style={{ width: `${Math.min(pct, 100)}%` }} />
                              </div>
                              <span className="text-[11px] tabular-nums text-muted-foreground w-8 text-right">{pct.toFixed(1)}%</span>
                            </div>
                          ) : <span className="text-muted-foreground/30">—</span>}
                        </td>
                        <td className="py-2.5 text-center">
                          <button
                            onClick={e => { e.stopPropagation(); removeBrand(b.brand); }}
                            className="text-muted-foreground/30 hover:text-red-400 transition-colors"
                            title={`移除 ${b.brand}`}
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </td>
                      </tr>

                      {/* ── Expanded item details ──────────── */}
                      {/* 老闆撳開想答「昨日郁咗邊啲」→ 昨日售出行先;
                          當月排名 Top 10 直落,長尾摺埋一行。
                          全闊 grid:縮圖(撳大)+ 件數營收 + 毛利 + 庫存 + 預計缺貨 */}
                      {isExpanded && (() => {
                        const yesterdayItems = b.items.filter(it => it.yQty > 0)
                          .sort((x, y) => y.yRevenue - x.yRevenue);
                        const TOP_N = 10;
                        const showAll = showAllItems.has(b.brand);
                        const shown = showAll ? b.items : b.items.slice(0, TOP_N);
                        const rest = b.items.slice(TOP_N);
                        const restRev = rest.reduce((s, it) => s + it.revenue, 0);

                        const GRID = 'grid grid-cols-[44px_minmax(0,1fr)_150px_72px_64px_92px] items-center gap-x-3';

                        const thumb = (item: BrandItem) => {
                          const img = item.productId ? imageMap[item.productId] : undefined;
                          return img ? (
                            <button
                              onClick={e => { e.stopPropagation(); setLightbox({ url: img, title: item.title }); }}
                              className="w-10 h-10 rounded-md overflow-hidden bg-white/90 hover:ring-2 hover:ring-primary/60 transition-all cursor-zoom-in shrink-0"
                              title="撳大睇"
                            >
                              <img src={img} alt={item.title} loading="lazy" className="w-full h-full object-cover" />
                            </button>
                          ) : (
                            <div className="w-10 h-10 rounded-md bg-accent/40 flex items-center justify-center shrink-0">
                              <ImageOff className="h-4 w-4 text-muted-foreground/40" />
                            </div>
                          );
                        };

                        const stockCells = (item: BrandItem) => {
                          const stock = item.productId != null ? productStockMap[item.productId] : undefined;
                          const margin = item.coveredRev > 0 ? (item.profit / item.coveredRev) * 100 : null;
                          const velocity = [...item.skus].reduce((s, k) => s + (velocityMap[k] || 0), 0);
                          const days = stock != null && stock > 0 && velocity > 0 ? stock / velocity : null;
                          const riskBadge = stock == null
                            ? <span className="text-muted-foreground/30">—</span>
                            : stock === 0
                            ? <span className="text-xs font-semibold text-red-400 bg-red-500/15 px-1.5 py-0.5 rounded whitespace-nowrap">🔴 缺貨</span>
                            : days !== null && days <= 7
                            ? <span className="text-xs font-semibold text-red-400 bg-red-500/15 px-1.5 py-0.5 rounded whitespace-nowrap">🔴 {Math.round(days)}日</span>
                            : days !== null && days <= 21
                            ? <span className="text-xs text-yellow-400 bg-yellow-500/15 px-1.5 py-0.5 rounded whitespace-nowrap">🟡 {Math.round(days)}日</span>
                            : <span className="text-xs text-muted-foreground/60 whitespace-nowrap">{days !== null ? `${Math.round(days)}日` : '充足'}</span>;
                          return (
                            <>
                              <span className="text-right tabular-nums text-xs">
                                {margin !== null
                                  ? <span className={item.profit >= 0 ? 'text-emerald-400' : 'text-red-400'}>{margin.toFixed(0)}%</span>
                                  : <span className="text-muted-foreground/30">—</span>}
                              </span>
                              <span className={`text-right tabular-nums text-xs font-semibold ${
                                stock == null ? 'text-muted-foreground/30' : stock === 0 ? 'text-red-400' : stock <= 5 ? 'text-yellow-400' : ''
                              }`}>
                                {stock != null ? stock : '—'}
                              </span>
                              <span className="text-right">{riskBadge}</span>
                            </>
                          );
                        };

                        const itemRow = (item: BrandItem, name: React.ReactNode, qty: number, rev: number, highlight = false) => (
                          <div key={item.title} className={`${GRID} text-[13px] py-1.5 border-b border-border/10 last:border-0 ${highlight ? 'bg-primary/5 -mx-2 px-2 rounded' : ''}`}>
                            {thumb(item)}
                            <div className="flex items-center gap-2 min-w-0">{name}</div>
                            <span className="text-right tabular-nums">
                              <span className="text-muted-foreground">×{qty}</span>
                              <span className="font-medium ml-2">{formatCurrency(rev)}</span>
                            </span>
                            {stockCells(item)}
                          </div>
                        );

                        const headerRow = (qtyLabel: string) => (
                          <div className={`${GRID} text-xs text-muted-foreground/60 pb-1 border-b border-border/20`}>
                            <span />
                            <span>產品</span>
                            <span className="text-right">{qtyLabel}</span>
                            <span className="text-right">毛利率</span>
                            <span className="text-right">庫存</span>
                            <span className="text-right">預計缺貨</span>
                          </div>
                        );

                        return (
                        <tr>
                          <td colSpan={8} className="p-0">
                            <div className="bg-accent/10 px-4 py-3 border-b border-border/20 space-y-4">
                              {b.items.length === 0 && (
                                <p className="text-[13px] text-muted-foreground/50 py-1">本月無銷售記錄</p>
                              )}

                              {/* 昨日售出 — 行先 */}
                              {yesterdayItems.length > 0 && (
                                <div>
                                  <p className="text-[13px] font-semibold text-primary mb-1.5">
                                    昨日售出 · {yesterdayItems.reduce((s, it) => s + it.yQty, 0)}件 {formatCurrency(yesterdayItems.reduce((s, it) => s + it.yRevenue, 0))}
                                  </p>
                                  {headerRow('昨日售出')}
                                  {yesterdayItems.map(item => itemRow(
                                    item,
                                    <span className="truncate font-medium">{item.title}</span>,
                                    item.yQty, item.yRevenue, true,
                                  ))}
                                </div>
                              )}

                              {/* 當月 Top 10(直落) */}
                              {b.items.length > 0 && (
                                <div>
                                  <p className="text-[13px] font-semibold text-muted-foreground mb-1.5">
                                    當月排名{!showAll && b.items.length > TOP_N ? ` Top ${TOP_N}` : ''} · 共 {b.items.length} 款
                                  </p>
                                  {headerRow('當月售出')}
                                  {shown.map((item, ii) => itemRow(
                                    item,
                                    <>
                                      <span className="text-muted-foreground/50 tabular-nums w-5 text-right shrink-0">{ii + 1}</span>
                                      <span className="truncate">{item.title}</span>
                                      {item.yQty > 0 && (
                                        <span className="text-xs bg-primary/15 text-primary px-1 py-0.5 rounded shrink-0">昨日×{item.yQty}</span>
                                      )}
                                    </>,
                                    item.qty, item.revenue,
                                  ))}
                                  {rest.length > 0 && !showAll && (
                                    <button
                                      onClick={e => { e.stopPropagation(); setShowAllItems(prev => new Set(prev).add(b.brand)); }}
                                      className="w-full text-left text-[13px] text-muted-foreground hover:text-foreground py-1.5 transition-colors"
                                    >
                                      ⋯ 仲有 {rest.length} 款 · {formatCurrency(restRev)} — 撳開晒
                                    </button>
                                  )}
                                  {showAll && b.items.length > TOP_N && (
                                    <button
                                      onClick={e => { e.stopPropagation(); setShowAllItems(prev => { const n = new Set(prev); n.delete(b.brand); return n; }); }}
                                      className="w-full text-left text-[13px] text-muted-foreground/60 hover:text-foreground py-1.5 transition-colors"
                                    >
                                      收返埋長尾
                                    </button>
                                  )}
                                </div>
                              )}
                            </div>
                          </td>
                        </tr>
                        );
                      })()}
                    </React.Fragment>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t border-border/40 bg-muted/10">
                  <td className="py-2.5 text-[13px] font-semibold text-muted-foreground">
                    小計 ({sorted.length} 品牌)
                  </td>
                  <td className="py-2.5 text-right tabular-nums text-[13px]">
                    {totals.yQty > 0 ? <>{totals.yQty}件 {formatCurrency(totals.yRevenue)}</> : '—'}
                  </td>
                  <td className="py-2.5 text-right tabular-nums text-[13px]">{totals.wkRevenue > 0 ? formatCurrency(totals.wkRevenue) : '—'}</td>
                  <td className="py-2.5 text-right tabular-nums font-bold text-[13px]">{totals.qty}</td>
                  <td className="py-2.5 text-right tabular-nums font-bold text-[13px]">{formatCurrency(totals.revenue)}</td>
                  <td className="py-2.5 text-right tabular-nums text-[13px]">
                    {totals.coveredRev > 0 ? (
                      <>
                        <span className={totals.profit >= 0 ? 'text-emerald-400' : 'text-red-400'}>{formatCurrency(totals.profit)}</span>
                        <span className="text-[11px] text-muted-foreground ml-1">{((totals.profit / totals.coveredRev) * 100).toFixed(0)}%</span>
                      </>
                    ) : '—'}
                  </td>
                  <td className="py-2.5 text-right text-[11px] text-muted-foreground/60">100%</td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}

        {/* ── Hint ────────────────────────────────────────── */}
        <p className="text-[11px] text-muted-foreground/50 mt-2 flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-primary/40 shrink-0 inline-block" />
          點擊品牌行展開當月明細　|　毛利按有成本價之貨品計{totalCoverage > 0 && totalCoverage < 95 ? `(而家覆蓋 ${totalCoverage.toFixed(0)}% 營收,想準啲去 Shopify 補返 cost)` : ''}　|　「管理品牌」增減品牌
        </p>
      </CardContent>

      {/* ── 產品圖 Lightbox(撳任何地方閂)────────────── */}
      {lightbox && (
        <div
          className="fixed inset-0 z-50 bg-black/85 flex flex-col items-center justify-center p-6 cursor-zoom-out"
          onClick={() => setLightbox(null)}
          data-testid="product-lightbox"
        >
          <img
            src={lightbox.url}
            alt={lightbox.title}
            className="max-w-[85vw] max-h-[78vh] rounded-lg bg-white object-contain shadow-2xl"
          />
          <p className="mt-3 text-sm text-white/90 text-center max-w-[85vw]">{lightbox.title}</p>
          <p className="text-xs text-white/40 mt-1">撳任何地方閂返</p>
        </div>
      )}
    </Card>
  );
}
