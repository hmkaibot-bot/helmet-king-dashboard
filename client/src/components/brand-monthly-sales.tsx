import React, { useState, useMemo, useCallback } from 'react';
import { formatCurrency } from '@/lib/format';
import {
  ChevronDown, ChevronRight, ArrowUpDown, ArrowUp, ArrowDown,
  Plus, X, Search, BarChart3,
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
  items: { title: string; qty: number; revenue: number; yQty: number }[];
}

interface Props {
  allOrders: any[];
  allOrderLines: any[];
  loading: boolean;
  yOrderIds: Set<string>;    // 昨日 order ids
  weekOrderIds: Set<string>; // 本週 order ids
  costMap: Record<string, number>; // sku → 成本價(>0 先有)
}

export function BrandMonthlySales({ allOrders, allOrderLines, loading, yOrderIds, weekOrderIds, costMap }: Props) {
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
      items: Record<string, { title: string; qty: number; revenue: number; yQty: number }>;
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
        if (!map[brand].items[title]) map[brand].items[title] = { title, qty: 0, revenue: 0, yQty: 0 };
        map[brand].items[title].qty += qty;
        map[brand].items[title].revenue += rev;
        if (inY) map[brand].items[title].yQty += qty;
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
            <span className="text-xs font-normal text-muted-foreground">
              昨日 / 本週 / 當月MTD — {monthLabel} ({mtdRange.from} ~ {mtdRange.to})
            </span>
          </CardTitle>
          <button
            onClick={() => { setShowPicker(!showPicker); setSearchTerm(''); }}
            className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium bg-primary/10 text-primary border border-primary/20 hover:bg-primary/20 transition-colors"
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
            <p className="text-[10px] font-semibold text-muted-foreground mb-1.5">已選品牌 Selected ({selectedBrands.length})</p>
            <div className="flex flex-wrap gap-1 mb-3">
              {selectedBrands.map(b => (
                <span key={b} className="inline-flex items-center gap-1 text-[11px] bg-primary/15 text-primary border border-primary/25 px-2 py-0.5 rounded-full">
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
            <p className="text-[10px] font-semibold text-muted-foreground mb-1.5">新增品牌 Add Brand</p>
            <div className="flex items-center gap-2 mb-2">
              <div className="relative flex-1">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground/50" />
                <input
                  type="text"
                  value={searchTerm}
                  onChange={e => setSearchTerm(e.target.value)}
                  placeholder="搜尋品牌名稱..."
                  className="w-full pl-7 pr-2 py-1.5 text-xs bg-background border border-border rounded text-foreground focus:outline-none focus:border-primary"
                />
              </div>
            </div>
            <div className="flex flex-wrap gap-1 max-h-32 overflow-y-auto">
              {filteredVendors.length === 0 ? (
                <p className="text-[10px] text-muted-foreground/50 py-2">
                  {searchTerm ? '找不到匹配品牌' : '所有品牌已選取'}
                </p>
              ) : (
                filteredVendors.map(v => (
                  <button
                    key={v}
                    onClick={() => addBrand(v)}
                    className="text-[11px] px-2 py-0.5 bg-accent/60 text-muted-foreground border border-border/40 rounded hover:bg-primary/10 hover:text-primary hover:border-primary/30 transition-colors"
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
                className="text-[10px] text-muted-foreground/60 hover:text-muted-foreground transition-colors"
              >
                重設為預設品牌 Reset to default
              </button>
              <button
                onClick={() => { setShowPicker(false); setSearchTerm(''); }}
                className="ml-auto text-[10px] px-2 py-0.5 bg-primary/80 text-primary-foreground rounded hover:bg-primary transition-colors"
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
            <table className="w-full text-xs" data-testid="table-brand-mtd">
              <thead>
                <tr className="border-b border-border/50 text-muted-foreground">
                  <th className="py-2 text-left font-medium">品牌 Brand</th>
                  <th className="py-2 text-right font-medium">昨日</th>
                  <th className="py-2 text-right font-medium">本週營收</th>
                  <th className="py-2 text-right font-medium">
                    <button
                      onClick={() => toggleSort('qty')}
                      className="inline-flex items-center gap-1 hover:text-foreground transition-colors"
                    >
                      當月件數 <SortIcon field="qty" />
                    </button>
                  </th>
                  <th className="py-2 text-right font-medium">
                    <button
                      onClick={() => toggleSort('revenue')}
                      className="inline-flex items-center gap-1 hover:text-foreground transition-colors"
                    >
                      當月營收 <SortIcon field="revenue" />
                    </button>
                  </th>
                  <th className="py-2 text-right font-medium">當月毛利</th>
                  <th className="py-2 text-right font-medium">占比</th>
                  <th className="py-2 text-center font-medium w-8"></th>
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
                        <td className="py-2 font-medium">
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
                        <td className="py-2 text-right tabular-nums">
                          {b.yQty > 0
                            ? <span className="font-semibold text-primary">{b.yQty}件 {formatCurrency(b.yRevenue)}</span>
                            : <span className="text-muted-foreground/30">—</span>}
                        </td>
                        <td className="py-2 text-right tabular-nums">
                          {b.wkRevenue > 0 ? formatCurrency(b.wkRevenue) : <span className="text-muted-foreground/30">—</span>}
                        </td>
                        <td className="py-2 text-right tabular-nums font-bold">
                          {b.qty > 0 ? b.qty : <span className="text-muted-foreground/30">0</span>}
                        </td>
                        <td className="py-2 text-right tabular-nums font-semibold">
                          {b.revenue > 0 ? formatCurrency(b.revenue) : <span className="text-muted-foreground/30">—</span>}
                        </td>
                        <td className="py-2 text-right tabular-nums">
                          {margin !== null ? (
                            <>
                              <span className={b.profit >= 0 ? 'text-emerald-400' : 'text-red-400'}>{formatCurrency(b.profit)}</span>
                              <span className="text-[10px] text-muted-foreground ml-1">{margin.toFixed(0)}%</span>
                            </>
                          ) : <span className="text-muted-foreground/30">—</span>}
                        </td>
                        <td className="py-2 text-right">
                          {pct > 0 ? (
                            <div className="flex items-center justify-end gap-1.5">
                              <div className="w-12 h-1.5 bg-border/40 rounded-full overflow-hidden">
                                <div className="h-full bg-primary/60 rounded-full" style={{ width: `${Math.min(pct, 100)}%` }} />
                              </div>
                              <span className="text-[10px] tabular-nums text-muted-foreground w-8 text-right">{pct.toFixed(1)}%</span>
                            </div>
                          ) : <span className="text-muted-foreground/30">—</span>}
                        </td>
                        <td className="py-2 text-center">
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
                      {isExpanded && (
                        <tr>
                          <td colSpan={8} className="p-0">
                            <div className="bg-accent/10 px-4 py-2 border-b border-border/20">
                              {b.items.length === 0 ? (
                                <p className="text-[10px] text-muted-foreground/50 py-1">本月無銷售記錄</p>
                              ) : (
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6">
                                  {b.items.map((item, ii) => (
                                    <div key={ii} className="flex items-center justify-between text-[11px] py-1 border-b border-border/10 last:border-0">
                                      <div className="flex items-center gap-2 min-w-0">
                                        <span className="text-muted-foreground/50 tabular-nums w-4 text-right shrink-0">{ii + 1}</span>
                                        <span className="truncate">{item.title}</span>
                                        {item.yQty > 0 && (
                                          <span className="text-[9px] bg-primary/15 text-primary px-1 py-0.5 rounded shrink-0">昨日×{item.yQty}</span>
                                        )}
                                      </div>
                                      <span className="tabular-nums text-muted-foreground ml-2 shrink-0">
                                        ×{item.qty} {formatCurrency(item.revenue)}
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t border-border/40 bg-muted/10">
                  <td className="py-2 text-xs font-semibold text-muted-foreground">
                    小計 ({sorted.length} 品牌)
                  </td>
                  <td className="py-2 text-right tabular-nums text-xs">
                    {totals.yQty > 0 ? <>{totals.yQty}件 {formatCurrency(totals.yRevenue)}</> : '—'}
                  </td>
                  <td className="py-2 text-right tabular-nums text-xs">{totals.wkRevenue > 0 ? formatCurrency(totals.wkRevenue) : '—'}</td>
                  <td className="py-2 text-right tabular-nums font-bold text-xs">{totals.qty}</td>
                  <td className="py-2 text-right tabular-nums font-bold text-xs">{formatCurrency(totals.revenue)}</td>
                  <td className="py-2 text-right tabular-nums text-xs">
                    {totals.coveredRev > 0 ? (
                      <>
                        <span className={totals.profit >= 0 ? 'text-emerald-400' : 'text-red-400'}>{formatCurrency(totals.profit)}</span>
                        <span className="text-[10px] text-muted-foreground ml-1">{((totals.profit / totals.coveredRev) * 100).toFixed(0)}%</span>
                      </>
                    ) : '—'}
                  </td>
                  <td className="py-2 text-right text-[10px] text-muted-foreground/60">100%</td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}

        {/* ── Hint ────────────────────────────────────────── */}
        <p className="text-[10px] text-muted-foreground/50 mt-2 flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-primary/40 shrink-0 inline-block" />
          點擊品牌行展開當月明細　|　毛利按有成本價之貨品計{totalCoverage > 0 && totalCoverage < 95 ? `(而家覆蓋 ${totalCoverage.toFixed(0)}% 營收,想準啲去 Shopify 補返 cost)` : ''}　|　「管理品牌」增減品牌
        </p>
      </CardContent>
    </Card>
  );
}
