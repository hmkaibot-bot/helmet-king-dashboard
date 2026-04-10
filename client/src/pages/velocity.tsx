import { useEffect, useState, useMemo } from 'react';
import { queryAllPages } from '@/lib/query-helpers';
import { KpiCard } from '@/components/kpi-card';
import { formatNumber } from '@/lib/format';
import { TrendingUp, AlertTriangle, AlertOctagon, XCircle, Search, Filter, ChevronRight, ChevronDown } from 'lucide-react';

// ── Variant Title Parser ────────────────────────────────────
const SIZE_TOKENS = new Set([
  'XXS','XS','S','M','L','XL','XXL','XXXL','2XL','3XL','4XL',
  'SM','MD','LG','O/S','OS','ONE SIZE','FREE SIZE',
  '52','53','54','55','56','57','58','59','60','61','62','63','64',
  '52-53','54-55','56-57','58-59','60-61','62-63',
]);

function parseVariantTitle(vt: string | null | undefined): { color: string; size: string } {
  if (!vt || vt === 'Default Title') return { color: '', size: '' };
  const trimmed = vt.trim();
  if (trimmed.includes(' / ')) {
    const parts = trimmed.split(' / ');
    const last = parts[parts.length - 1].trim().toUpperCase();
    if (SIZE_TOKENS.has(last) || /^\d{1,3}(-\d{1,3})?$/.test(last)) {
      return { color: parts.slice(0, -1).join(' / ').trim(), size: parts[parts.length - 1].trim() };
    }
    return { color: parts[0].trim(), size: parts.slice(1).join(' / ').trim() };
  }
  if (SIZE_TOKENS.has(trimmed.toUpperCase()) || /^\d{1,3}(-\d{1,3})?$/.test(trimmed)) {
    return { color: '', size: trimmed };
  }
  return { color: trimmed, size: '' };
}
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';

// ── Types ──────────────────────────────────────────────────────────────
type RiskLevel = 'critical' | 'warning' | 'ok' | 'none';
type SortKey = 'title' | 'sku' | 'vendor' | 'productType' | 'stock' | 'vel7' | 'vel30' | 'vel60' | 'daysToStockout' | 'risk';
type SortDir = 'asc' | 'desc';
type TabKey = 'all' | 'reorder';

interface VelocityRow {
  key: string;
  title: string;
  sku: string;
  vendor: string;
  productType: string;
  variantTitle: string;
  stock: number;
  vel7: number;
  vel30: number;
  vel60: number;
  daysToStockout: number | null;
  risk: RiskLevel;
}

interface ProductGroup {
  key: string; // product title
  title: string;
  vendor: string;
  productType: string;
  totalStock: number;
  totalVel7: number;
  totalVel30: number;
  totalVel60: number;
  worstRisk: RiskLevel;
  minDaysToStockout: number | null;
  variantCount: number;
  variants: VelocityRow[];
}

// ── Helpers ────────────────────────────────────────────────────────────
function getHKNow(): Date {
  const now = new Date();
  return new Date(now.getTime() + (now.getTimezoneOffset() + 480) * 60000);
}

function getRisk(stock: number, vel60: number): RiskLevel {
  if (vel60 === 0) return 'none';
  if (stock === 0) return 'critical';
  const days = stock / vel60;
  if (days <= 7) return 'critical';
  if (days <= 21) return 'warning';
  return 'ok';
}

function getDaysToStockout(stock: number, vel60: number): number | null {
  if (vel60 === 0) return null;
  if (stock === 0) return 0;
  return stock / vel60;
}

const RISK_ORDER: Record<RiskLevel, number> = { critical: 0, warning: 1, ok: 2, none: 3 };

const RISK_BADGE: Record<RiskLevel, { label: string; cls: string; dot: string }> = {
  critical: { label: '🔴 Critical', cls: 'bg-red-500/20 text-red-400 border-red-500/30', dot: '' },
  warning:  { label: '🟡 Warning',  cls: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30', dot: '' },
  ok:       { label: '🟢 OK',       cls: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30', dot: '' },
  none:     { label: '—',           cls: 'bg-slate-500/10 text-slate-500 border-slate-500/20', dot: '' },
};

function stockColor(qty: number): string {
  if (qty === 0) return 'text-red-400 font-semibold';
  if (qty <= 5)  return 'text-yellow-400 font-semibold';
  if (qty <= 10) return 'text-amber-400';
  return '';
}

function rowTint(risk: RiskLevel): string {
  if (risk === 'critical') return 'bg-red-500/5';
  if (risk === 'warning')  return 'bg-yellow-500/5';
  return '';
}

function velFmt(v: number): string {
  if (v === 0) return '—';
  return v.toFixed(2);
}

function daysFmt(d: number | null): string {
  if (d === null) return '—';
  if (d === 0) return '0';
  if (d > 365) return '∞';
  return d.toFixed(0);
}

// ── Page ───────────────────────────────────────────────────────────────
export default function VelocityPage() {
  const [loading, setLoading]   = useState(true);
  const [rows, setRows]         = useState<VelocityRow[]>([]);
  const [tab, setTab]           = useState<TabKey>('all');
  const [search, setSearch]     = useState('');
  const [vendorFilter, setVendorFilter]   = useState('');
  const [typeFilter, setTypeFilter]       = useState('');
  const [minVel, setMinVel]               = useState('');
  const [riskFilter, setRiskFilter]       = useState<RiskLevel | 'all'>('all');
  const [sortKey, setSortKey]             = useState<SortKey>('risk');
  const [sortDir, setSortDir]             = useState<SortDir>('asc');
  const [groupByProduct, setGroupByProduct] = useState(true);
  const [expandedProducts, setExpandedProducts] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const now = getHKNow();
        const sixtyAgo  = new Date(now.getTime() - 60  * 86400000);
        const thirtyAgo = new Date(now.getTime() - 30  * 86400000);
        const sevenAgo  = new Date(now.getTime() - 7   * 86400000);

        const sixtyAgoStr  = sixtyAgo.toISOString().slice(0, 10);

        // Paginated fetches in parallel
        const [inventoryRaw, orderLinesRaw] = await Promise.all([
          queryAllPages('shopify_inventory', 'sku,product_title,variant_title,price,inventory_quantity,vendor,product_type,snapshot_date'),
          queryAllPages('shopify_order_lines', 'sku,title,vendor,product_type,quantity,price,created_at'),
        ]);

        if (cancelled) return;

        // Build inventory map: sku → latest snapshot
        // For each SKU keep entry with most recent snapshot_date
        const invMap: Record<string, { stock: number; title: string; vendor: string; productType: string; variantTitle: string; price: number }> = {};
        for (const inv of inventoryRaw) {
          const sku = inv.sku || '';
          if (!sku) continue;
          if (!invMap[sku] || (inv.snapshot_date || '') > (invMap[sku] as any)._snap) {
            invMap[sku] = {
              stock: inv.inventory_quantity ?? 0,
              title: inv.product_title || '',
              vendor: inv.vendor || '',
              productType: inv.product_type || '',
              variantTitle: inv.variant_title || '',
              price: parseFloat(inv.price) || 0,
              _snap: inv.snapshot_date || '',
            } as any;
          }
        }

        // Build per-SKU velocity maps
        const sold60:  Record<string, number> = {};
        const sold30:  Record<string, number> = {};
        const sold7:   Record<string, number> = {};
        // Also track title/vendor/type from order lines for SKUs not in inventory
        const lineMeta: Record<string, { title: string; vendor: string; productType: string }> = {};

        for (const line of orderLinesRaw) {
          const sku = line.sku || '';
          if (!sku) continue;
          const createdAt = line.created_at || '';
          if (!lineMeta[sku]) {
            lineMeta[sku] = {
              title: line.title || '',
              vendor: line.vendor || '',
              productType: line.product_type || '',
            };
          }
          if (createdAt >= sixtyAgoStr) {
            const qty = line.quantity || 0;
            sold60[sku] = (sold60[sku] || 0) + qty;
            if (createdAt >= thirtyAgo.toISOString().slice(0, 10)) {
              sold30[sku] = (sold30[sku] || 0) + qty;
            }
            if (createdAt >= sevenAgo.toISOString().slice(0, 10)) {
              sold7[sku] = (sold7[sku] || 0) + qty;
            }
          }
        }

        // Build rows: union of inventory SKUs with sales + sold SKUs (with 0 stock possibly)
        const allSkus = Array.from(new Set<string>([
          ...Object.keys(invMap),
          ...Object.keys(sold60),
        ]));

        const result: VelocityRow[] = [];
        for (const sku of allSkus) {
          const s60 = sold60[sku] || 0;
          // Only include if has sales in 60d
          if (s60 === 0 && !invMap[sku]) continue;
          if (s60 === 0) {
            // Has inventory but no sales — still include (stock > 0 products)
            // Skip if no velocity (for velocity page)
            continue;
          }

          const inv = invMap[sku];
          const meta = lineMeta[sku] || { title: '', vendor: '', productType: '' };
          const title = inv?.title || meta.title || sku;
          const vendor = inv?.vendor || meta.vendor || '';
          const productType = inv?.productType || meta.productType || '';
          const variantTitle = inv?.variantTitle || '';
          const stock = inv?.stock ?? 0;

          const vel60 = s60 / 60;
          const vel30 = (sold30[sku] || 0) / 30;
          const vel7  = (sold7[sku]  || 0) / 7;

          const risk = getRisk(stock, vel60);
          const daysToStockout = getDaysToStockout(stock, vel60);

          result.push({
            key: sku,
            title,
            sku,
            vendor,
            productType,
            variantTitle,
            stock,
            vel7,
            vel30,
            vel60,
            daysToStockout,
            risk,
          });
        }

        result.sort((a, b) => {
          const rDiff = RISK_ORDER[a.risk] - RISK_ORDER[b.risk];
          if (rDiff !== 0) return rDiff;
          return (b.daysToStockout ?? 9999) - (a.daysToStockout ?? 9999) > 0 ? -1 : 1;
        });

        setRows(result);
      } catch (e) {
        console.error('Velocity error:', e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  // Derived filter options
  const vendors = useMemo(() => {
    const s = new Set(rows.map((r) => r.vendor).filter(Boolean));
    return Array.from(s).sort();
  }, [rows]);

  const types = useMemo(() => {
    const s = new Set(rows.map((r) => r.productType).filter(Boolean));
    return Array.from(s).sort();
  }, [rows]);

  // KPI counts
  const counts = useMemo(() => {
    let critical = 0, warning = 0, zero = 0;
    for (const r of rows) {
      if (r.risk === 'critical') critical++;
      if (r.risk === 'warning')  warning++;
      if (r.stock === 0)         zero++;
    }
    return { total: rows.length, critical, warning, zero };
  }, [rows]);

  // Filtered + sorted rows
  const displayed = useMemo(() => {
    let base = rows;
    if (tab === 'reorder') base = base.filter((r) => r.risk === 'critical' || r.risk === 'warning');
    if (search) {
      const q = search.toLowerCase();
      base = base.filter((r) => r.title.toLowerCase().includes(q) || r.sku.toLowerCase().includes(q));
    }
    if (vendorFilter) base = base.filter((r) => r.vendor === vendorFilter);
    if (typeFilter)   base = base.filter((r) => r.productType === typeFilter);
    if (minVel)       base = base.filter((r) => r.vel60 >= parseFloat(minVel));
    if (riskFilter !== 'all') base = base.filter((r) => r.risk === riskFilter);

    // Sort
    const dir = sortDir === 'asc' ? 1 : -1;
    base = [...base].sort((a, b) => {
      switch (sortKey) {
        case 'title':        return dir * a.title.localeCompare(b.title);
        case 'sku':          return dir * a.sku.localeCompare(b.sku);
        case 'vendor':       return dir * a.vendor.localeCompare(b.vendor);
        case 'productType':  return dir * a.productType.localeCompare(b.productType);
        case 'stock':        return dir * (a.stock - b.stock);
        case 'vel7':         return dir * (a.vel7 - b.vel7);
        case 'vel30':        return dir * (a.vel30 - b.vel30);
        case 'vel60':        return dir * (a.vel60 - b.vel60);
        case 'daysToStockout': {
          const aD = a.daysToStockout ?? 99999;
          const bD = b.daysToStockout ?? 99999;
          return dir * (aD - bD);
        }
        case 'risk':         return dir * (RISK_ORDER[a.risk] - RISK_ORDER[b.risk]);
        default: return 0;
      }
    });
    return base;
  }, [rows, tab, search, vendorFilter, typeFilter, minVel, riskFilter, sortKey, sortDir]);

  // Build product groups from displayed rows
  const productGroups = useMemo((): ProductGroup[] => {
    const groupMap = new Map<string, ProductGroup>();

    for (const row of displayed) {
      const groupKey = `${row.title}|||${row.vendor}`;
      if (!groupMap.has(groupKey)) {
        groupMap.set(groupKey, {
          key: groupKey,
          title: row.title,
          vendor: row.vendor,
          productType: row.productType,
          totalStock: 0,
          totalVel7: 0,
          totalVel30: 0,
          totalVel60: 0,
          worstRisk: 'none',
          minDaysToStockout: null,
          variantCount: 0,
          variants: [],
        });
      }
      const group = groupMap.get(groupKey)!;
      group.totalStock += row.stock;
      group.totalVel7  += row.vel7;
      group.totalVel30 += row.vel30;
      group.totalVel60 += row.vel60;
      group.variantCount += 1;
      group.variants.push(row);

      // Worst risk
      if (RISK_ORDER[row.risk] < RISK_ORDER[group.worstRisk]) {
        group.worstRisk = row.risk;
      }
      // Min days to stockout (treat null as infinity)
      if (row.daysToStockout !== null) {
        if (group.minDaysToStockout === null || row.daysToStockout < group.minDaysToStockout) {
          group.minDaysToStockout = row.daysToStockout;
        }
      }
    }

    // Sort groups by worst risk first, then by minDaysToStockout
    const groups = Array.from(groupMap.values());
    groups.sort((a, b) => {
      const rDiff = RISK_ORDER[a.worstRisk] - RISK_ORDER[b.worstRisk];
      if (rDiff !== 0) return rDiff;
      const aD = a.minDaysToStockout ?? 99999;
      const bD = b.minDaysToStockout ?? 99999;
      return aD - bD;
    });
    return groups;
  }, [displayed]);

  function toggleExpanded(key: string) {
    setExpandedProducts((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  function handleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  }

  function SortIcon({ col }: { col: SortKey }) {
    if (sortKey !== col) return <span className="opacity-20 ml-0.5">↕</span>;
    return <span className="ml-0.5">{sortDir === 'asc' ? '↑' : '↓'}</span>;
  }

  const thCls = 'py-2 text-left font-medium cursor-pointer select-none hover:text-foreground transition-colors';
  const thClsR = 'py-2 text-right font-medium cursor-pointer select-none hover:text-foreground transition-colors';

  return (
    <div className="space-y-4">
      {/* ── KPI Summary ── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard title="追蹤 SKU" subtitle="Total SKUs Tracked" value={formatNumber(counts.total)} icon={TrendingUp} loading={loading} testId="kpi-velocity-total" />
        <KpiCard title="🔴 危急 Critical" subtitle="≤7 days stock" value={formatNumber(counts.critical)} icon={AlertOctagon} loading={loading} testId="kpi-velocity-critical" />
        <KpiCard title="🟡 預警 Warning" subtitle="8–21 days stock" value={formatNumber(counts.warning)} icon={AlertTriangle} loading={loading} testId="kpi-velocity-warning" />
        <KpiCard title="零庫存 Zero Stock" subtitle="Out of stock" value={formatNumber(counts.zero)} icon={XCircle} loading={loading} testId="kpi-velocity-zero" />
      </div>

      {/* ── Tabs ── */}
      <div className="flex gap-1">
        {([
          { key: 'all' as TabKey, label: '所有 All' },
          { key: 'reorder' as TabKey, label: '⚠️ 需補貨 Reorder Needed' },
        ] as const).map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-3 py-1.5 rounded-md text-xs transition-colors ${
              tab === t.key
                ? 'bg-primary/15 text-primary font-medium'
                : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
            }`}
          >
            {t.label}
            {t.key === 'reorder' && (
              <span className="ml-1 tabular-nums">({counts.critical + counts.warning})</span>
            )}
          </button>
        ))}
      </div>

      {/* ── Main Table Card ── */}
      <Card className="border-border/40">
        <CardHeader className="pb-2 pt-4 px-4">
          <CardTitle className="text-sm font-medium">
            銷售速率 <span className="text-xs font-normal text-muted-foreground">Sales Velocity — All Products</span>
            {!loading && (
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                {groupByProduct
                  ? `顯示 ${Math.min(productGroups.length, 500)} 組 / ${productGroups.length} 組，共 ${displayed.length} 項`
                  : `顯示 ${displayed.length} / ${rows.length} 項`}
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4">
          {/* Filter bar */}
          <div className="flex flex-wrap gap-2 mb-3">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <input
                type="text"
                placeholder="搜尋 Search title/SKU..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-7 pr-3 py-1.5 rounded-md bg-accent/40 border border-border/40 text-xs focus:outline-none focus:ring-1 focus:ring-primary/50 w-52"
              />
            </div>
            <select
              value={vendorFilter}
              onChange={(e) => setVendorFilter(e.target.value)}
              className="px-2 py-1.5 rounded-md bg-accent/40 border border-border/40 text-xs focus:outline-none focus:ring-1 focus:ring-primary/50"
            >
              <option value="">所有品牌 All Brands</option>
              {vendors.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
              className="px-2 py-1.5 rounded-md bg-accent/40 border border-border/40 text-xs focus:outline-none focus:ring-1 focus:ring-primary/50"
            >
              <option value="">所有類別 All Types</option>
              {types.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <div className="flex items-center gap-1.5">
              <Filter className="h-3.5 w-3.5 text-muted-foreground" />
              <input
                type="number"
                placeholder="Min velocity"
                value={minVel}
                onChange={(e) => setMinVel(e.target.value)}
                className="px-2 py-1.5 rounded-md bg-accent/40 border border-border/40 text-xs focus:outline-none focus:ring-1 focus:ring-primary/50 w-32"
              />
            </div>
            <select
              value={riskFilter}
              onChange={(e) => setRiskFilter(e.target.value as RiskLevel | 'all')}
              className="px-2 py-1.5 rounded-md bg-accent/40 border border-border/40 text-xs focus:outline-none focus:ring-1 focus:ring-primary/50"
            >
              <option value="all">所有風險 All Risk</option>
              <option value="critical">🔴 Critical</option>
              <option value="warning">🟡 Warning</option>
              <option value="ok">🟢 OK</option>
              <option value="none">— No velocity</option>
            </select>
            {/* Group toggle button */}
            <button
              onClick={() => setGroupByProduct((v) => !v)}
              className={`px-3 py-1.5 rounded-md text-xs border transition-colors ${
                groupByProduct
                  ? 'bg-primary/15 text-primary border-primary/30 font-medium'
                  : 'bg-accent/40 text-muted-foreground border-border/40 hover:text-foreground hover:bg-accent/60'
              }`}
            >
              {groupByProduct ? '按產品群組 Group by Product' : '按SKU Flat View'}
            </button>
          </div>

          {loading ? (
            <Skeleton className="h-[400px] w-full" />
          ) : displayed.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">無符合條件的資料</p>
          ) : (
            <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
              <table className="w-full text-xs" data-testid="table-velocity">
                <thead className="sticky top-0 bg-card z-10">
                  <tr className="border-b border-border/50 text-muted-foreground">
                    {groupByProduct && <th className="py-2 w-6" />}
                    <th className={thCls} onClick={() => handleSort('title')}>
                      產品 Product <SortIcon col="title" />
                    </th>
                    {!groupByProduct && (
                      <th className={thCls} onClick={() => handleSort('sku')}>
                        SKU <SortIcon col="sku" />
                      </th>
                    )}
                    <th className={thCls} onClick={() => handleSort('vendor')}>
                      品牌 Brand <SortIcon col="vendor" />
                    </th>
                    <th className={thCls} onClick={() => handleSort('productType')}>
                      類別 Category <SortIcon col="productType" />
                    </th>
                    <th className={thClsR} onClick={() => handleSort('stock')}>
                      庫存 Stock <SortIcon col="stock" />
                    </th>
                    <th className={thClsR} onClick={() => handleSort('vel7')}>
                      7d 速率 <SortIcon col="vel7" />
                    </th>
                    <th className={thClsR} onClick={() => handleSort('vel30')}>
                      30d 速率 <SortIcon col="vel30" />
                    </th>
                    <th className={thClsR} onClick={() => handleSort('vel60')}>
                      60d 速率 <SortIcon col="vel60" />
                    </th>
                    <th className={thClsR} onClick={() => handleSort('daysToStockout')}>
                      耗盡天數 Days Out <SortIcon col="daysToStockout" />
                    </th>
                    <th className={thCls} onClick={() => handleSort('risk')}>
                      風險 Risk <SortIcon col="risk" />
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {groupByProduct ? (
                    // ── Grouped view ──────────────────────────────────
                    productGroups.slice(0, 500).map((group) => {
                      const isExpanded = expandedProducts.has(group.key);
                      const rb = RISK_BADGE[group.worstRisk];
                      return (
                        <>
                          {/* Group summary row */}
                          <tr
                            key={group.key}
                            className={`border-b border-border/30 hover:bg-accent/30 transition-colors cursor-pointer ${rowTint(group.worstRisk)}`}
                            onClick={() => toggleExpanded(group.key)}
                          >
                            {/* Chevron */}
                            <td className="py-2 pr-1 w-6 text-muted-foreground">
                              {isExpanded
                                ? <ChevronDown className="h-3.5 w-3.5" />
                                : <ChevronRight className="h-3.5 w-3.5" />}
                            </td>
                            {/* Title + variant badge */}
                            <td className="py-2 max-w-[200px] font-semibold">
                              <span className="truncate block">{group.title}</span>
                              <span className="ml-0 mt-0.5 inline-block px-1.5 py-0 rounded text-[10px] bg-primary/10 text-primary border border-primary/20 font-normal">
                                {group.variantCount} variant{group.variantCount !== 1 ? 's' : ''}
                              </span>
                            </td>
                            {/* Vendor */}
                            <td className="py-2 text-muted-foreground">{group.vendor || '—'}</td>
                            {/* Category */}
                            <td className="py-2 text-muted-foreground">{group.productType || '—'}</td>
                            {/* Total stock */}
                            <td className={`py-2 text-right tabular-nums ${stockColor(group.totalStock)}`}>
                              {formatNumber(group.totalStock)}
                            </td>
                            {/* Velocities (sum) */}
                            <td className="py-2 text-right tabular-nums">{velFmt(group.totalVel7)}</td>
                            <td className="py-2 text-right tabular-nums">{velFmt(group.totalVel30)}</td>
                            <td className="py-2 text-right tabular-nums">{velFmt(group.totalVel60)}</td>
                            {/* Min days to stockout */}
                            <td className="py-2 text-right tabular-nums">
                              {group.minDaysToStockout === null ? '—' : (
                                <span className={
                                  group.minDaysToStockout === 0 ? 'text-red-400 font-semibold' :
                                  group.minDaysToStockout <= 7 ? 'text-red-400' :
                                  group.minDaysToStockout <= 21 ? 'text-yellow-400' : ''
                                }>
                                  {daysFmt(group.minDaysToStockout)}
                                </span>
                              )}
                            </td>
                            {/* Worst risk */}
                            <td className="py-2">
                              <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-medium border ${rb.cls}`}>
                                {rb.label}
                              </span>
                            </td>
                          </tr>

                          {/* Variant detail rows (when expanded) */}
                          {isExpanded && group.variants.map((row) => {
                            const vrb = RISK_BADGE[row.risk];
                            const vp = parseVariantTitle(row.variantTitle);
                            return (
                              <tr
                                key={row.key}
                                className={`border-b border-border/10 hover:bg-accent/20 transition-colors ${rowTint(row.risk)}`}
                              >
                                {/* Indent spacer */}
                                <td className="py-1.5 w-6" />
                                {/* SKU + Color/Size */}
                                <td className="py-1.5 pl-4 text-muted-foreground max-w-[200px]">
                                  <span className="font-mono text-[11px]">{row.sku || '—'}</span>
                                </td>
                                {/* Color/Style */}
                                <td className="py-1.5 text-muted-foreground text-[11px]">{vp.color || '—'}</td>
                                {/* Size */}
                                <td className="py-1.5 text-muted-foreground text-[11px]">{vp.size || '—'}</td>
                                {/* Stock */}
                                <td className={`py-1.5 text-right tabular-nums text-[11px] ${stockColor(row.stock)}`}>
                                  {formatNumber(row.stock)}
                                </td>
                                {/* Velocities */}
                                <td className="py-1.5 text-right tabular-nums text-[11px]">{velFmt(row.vel7)}</td>
                                <td className="py-1.5 text-right tabular-nums text-[11px]">{velFmt(row.vel30)}</td>
                                <td className="py-1.5 text-right tabular-nums text-[11px]">{velFmt(row.vel60)}</td>
                                {/* Days to stockout */}
                                <td className="py-1.5 text-right tabular-nums text-[11px]">
                                  {row.daysToStockout === null ? '—' : (
                                    <span className={
                                      row.daysToStockout === 0 ? 'text-red-400 font-semibold' :
                                      row.daysToStockout <= 7 ? 'text-red-400' :
                                      row.daysToStockout <= 21 ? 'text-yellow-400' : ''
                                    }>
                                      {daysFmt(row.daysToStockout)}
                                    </span>
                                  )}
                                </td>
                                {/* Risk */}
                                <td className="py-1.5">
                                  <span className={`inline-block px-1.5 py-0 rounded-full text-[10px] font-medium border ${vrb.cls}`}>
                                    {vrb.label}
                                  </span>
                                </td>
                              </tr>
                            );
                          })}
                        </>
                      );
                    })
                  ) : (
                    // ── Flat view (original) ──────────────────────────
                    displayed.slice(0, 500).map((row) => {
                      const rb = RISK_BADGE[row.risk];
                      return (
                        <tr
                          key={row.key}
                          className={`border-b border-border/20 hover:bg-accent/30 transition-colors ${rowTint(row.risk)}`}
                        >
                          <td className="py-2 max-w-[200px] truncate font-medium">{row.title}</td>
                          <td className="py-2 font-mono text-[11px] text-muted-foreground">{row.sku || '—'}</td>
                          <td className="py-2 text-muted-foreground">{row.vendor || '—'}</td>
                          <td className="py-2 text-muted-foreground">{row.productType || '—'}</td>
                          <td className={`py-2 text-right tabular-nums ${stockColor(row.stock)}`}>
                            {formatNumber(row.stock)}
                          </td>
                          <td className="py-2 text-right tabular-nums">{velFmt(row.vel7)}</td>
                          <td className="py-2 text-right tabular-nums">{velFmt(row.vel30)}</td>
                          <td className="py-2 text-right tabular-nums">{velFmt(row.vel60)}</td>
                          <td className="py-2 text-right tabular-nums">
                            {row.daysToStockout === null ? '—' : (
                              <span className={
                                row.daysToStockout === 0 ? 'text-red-400 font-semibold' :
                                row.daysToStockout <= 7 ? 'text-red-400' :
                                row.daysToStockout <= 21 ? 'text-yellow-400' : ''
                              }>
                                {daysFmt(row.daysToStockout)}
                              </span>
                            )}
                          </td>
                          <td className="py-2">
                            <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-medium border ${rb.cls}`}>
                              {rb.label}
                            </span>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
              {groupByProduct && productGroups.length > 500 && (
                <p className="text-xs text-muted-foreground text-center py-2">
                  顯示前 500 組，共 {productGroups.length} 組。請用篩選縮小範圍。
                </p>
              )}
              {!groupByProduct && displayed.length > 500 && (
                <p className="text-xs text-muted-foreground text-center py-2">
                  顯示前 500 項，共 {displayed.length} 項。請用篩選縮小範圍。
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
