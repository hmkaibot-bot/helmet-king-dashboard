import { useEffect, useState, useMemo } from 'react';
import { queryAllPages } from '@/lib/query-helpers';
import { KpiCard } from '@/components/kpi-card';
import { ChartCard } from '@/components/chart-card';
import { formatCurrency, formatNumber, formatPercent } from '@/lib/format';
import { DONUT_PALETTE, TOOLTIP_STYLE } from '@/lib/chart-theme';
import { Sparkles, TrendingUp, TrendingDown, Package } from 'lucide-react';
import {
  PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

// ── Types ──────────────────────────────────────────────────────────────
type PeriodDays = 30 | 60 | 90;
type SortKey = 'listed' | 'revenue' | 'vel60' | 'performance' | 'qty30' | 'qty60';
type SortDir = 'asc' | 'desc';
type PerfLevel = 'hot' | 'normal' | 'slow' | 'none';

interface NewProductRow {
  productId: string;
  title: string;
  vendor: string;
  productType: string;
  createdAt: string;
  daysAgo: number;
  stock: number;
  qty30: number;
  qty60: number;
  revenue: number;
  vel60: number;
  perf: PerfLevel;
}

// ── Helpers ────────────────────────────────────────────────────────────
function getHKNow(): Date {
  const now = new Date();
  return new Date(now.getTime() + (now.getTimezoneOffset() + 480) * 60000);
}
function daysAgo(days: number): string {
  const d = getHKNow();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}
function calcPerf(vel60: number): PerfLevel {
  if (vel60 === 0) return 'none';
  if (vel60 > 0.3) return 'hot';
  if (vel60 >= 0.05) return 'normal';
  return 'slow';
}

const PERF_BADGE: Record<PerfLevel, { label: string; cls: string }> = {
  hot:    { label: '🔥 Hot',     cls: 'bg-orange-500/20 text-orange-400 border-orange-500/30' },
  normal: { label: '✅ Normal',  cls: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30' },
  slow:   { label: '🐢 Slow',   cls: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30' },
  none:   { label: '❌ No Sales',cls: 'bg-red-500/20 text-red-400 border-red-500/30' },
};

const PERF_ORDER: Record<PerfLevel, number> = { hot: 0, normal: 1, slow: 2, none: 3 };

// ── Page ───────────────────────────────────────────────────────────────
export default function NewProductsPage() {
  const [loading, setLoading]     = useState(true);
  const [allRows, setAllRows]     = useState<NewProductRow[]>([]);
  const [totalRevenue, setTotalRevenue] = useState(0); // revenue of all products (incl old)
  const [period, setPeriod]       = useState<PeriodDays>(90);
  const [sortKey, setSortKey]     = useState<SortKey>('listed');
  const [sortDir, setSortDir]     = useState<SortDir>('desc');

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const ninetyAgoStr = daysAgo(90);
        const sixtyAgoStr  = daysAgo(60);
        const thirtyAgoStr = daysAgo(30);

        const [productsRaw, orderLinesRaw, inventoryRaw] = await Promise.all([
          queryAllPages('shopify_products', 'id,title,product_type,vendor,status,created_at', [
            { column: 'created_at', op: 'gte', value: ninetyAgoStr },
          ]),
          // 新品最多睇 90 日 — server-side filter 慳大量傳輸
          queryAllPages('shopify_order_lines', 'product_id,quantity,price,created_at',
            [{ column: 'created_at', op: 'gte', value: ninetyAgoStr }]),
          queryAllPages('shopify_inventory', 'product_id,sku,inventory_quantity,price,snapshot_date'),
        ]);

        if (cancelled) return;

        // Build inventory map by product_id (latest snapshot)
        const invMap: Record<string, { stock: number; snap: string }> = {};
        for (const inv of inventoryRaw) {
          const pid = String(inv.product_id || '');
          if (!pid) continue;
          if (!invMap[pid] || (inv.snapshot_date || '') > invMap[pid].snap) {
            invMap[pid] = { stock: inv.inventory_quantity ?? 0, snap: inv.snapshot_date || '' };
          }
        }

        // Build sales maps
        const sales60: Record<string, number> = {};
        const sales30: Record<string, number> = {};
        const revenue60: Record<string, number> = {};
        let totalRev = 0;

        for (const line of orderLinesRaw) {
          const pid = String(line.product_id || '');
          const createdAt = line.created_at || '';
          const qty = line.quantity || 0;
          const rev = (parseFloat(line.price) || 0) * qty;
          totalRev += rev; // accumulate all revenue

          if (createdAt >= sixtyAgoStr) {
            sales60[pid] = (sales60[pid] || 0) + qty;
            revenue60[pid] = (revenue60[pid] || 0) + rev;
          }
          if (createdAt >= thirtyAgoStr) {
            sales30[pid] = (sales30[pid] || 0) + qty;
          }
        }

        // Build rows from new products
        const now = getHKNow();
        const rows: NewProductRow[] = [];
        for (const p of productsRaw) {
          if (p.status && p.status !== 'active') continue; // skip draft/archived
          const productId = String(p.id || '');
          const createdAt = p.created_at ? p.created_at.slice(0, 10) : '';
          const daysAgoNum = createdAt
            ? Math.floor((now.getTime() - new Date(createdAt).getTime()) / 86400000)
            : 0;

          const stock = invMap[productId]?.stock ?? 0;
          const qty60 = sales60[productId] || 0;
          const qty30 = sales30[productId] || 0;
          const revenue = revenue60[productId] || 0;
          const vel60 = qty60 / 60;
          const perf = calcPerf(vel60);

          rows.push({
            productId,
            title: p.title || '',
            vendor: p.vendor || '',
            productType: p.product_type || '',
            createdAt,
            daysAgo: daysAgoNum,
            stock,
            qty30,
            qty60,
            revenue,
            vel60,
            perf,
          });
        }

        setAllRows(rows);
        setTotalRevenue(totalRev);
      } catch (e) {
        console.error('NewProducts error:', e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  // Filter by period
  const rows = useMemo(() => {
    return allRows.filter((r) => r.daysAgo <= period);
  }, [allRows, period]);

  // KPIs
  const kpis = useMemo(() => {
    const total = rows.length;
    const noSales = rows.filter((r) => r.vel60 === 0).length;
    const beating = rows.filter((r) => r.vel60 > 0.1).length;
    const avgRev = total > 0 ? rows.reduce((s, r) => s + r.revenue, 0) / total : 0;
    return { total, noSales, beating, avgRev };
  }, [rows]);

  // Donut chart data
  const donutData = useMemo(() => {
    const newRev = rows.reduce((s, r) => s + r.revenue, 0);
    const oldRev = Math.max(0, totalRevenue - newRev);
    return [
      { name: `新品 New (${period}d)`, value: newRev },
      { name: '舊品 Existing', value: oldRev },
    ];
  }, [rows, totalRevenue, period]);

  // Sorted rows
  const sorted = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      switch (sortKey) {
        case 'listed':     return dir * (a.createdAt.localeCompare(b.createdAt));
        case 'revenue':    return dir * (a.revenue - b.revenue);
        case 'vel60':      return dir * (a.vel60 - b.vel60);
        case 'performance':return dir * (PERF_ORDER[a.perf] - PERF_ORDER[b.perf]);
        case 'qty30':      return dir * (a.qty30 - b.qty30);
        case 'qty60':      return dir * (a.qty60 - b.qty60);
        default: return 0;
      }
    });
  }, [rows, sortKey, sortDir]);

  function handleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('desc');
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
      {/* ── Period Toggle ── */}
      <div className="flex gap-1">
        {([30, 60, 90] as PeriodDays[]).map((p) => (
          <button
            key={p}
            onClick={() => setPeriod(p)}
            className={`px-3 py-1.5 rounded-md text-xs transition-colors ${
              period === p
                ? 'bg-primary/15 text-primary font-medium'
                : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
            }`}
          >
            近{p}日 {p}d
          </button>
        ))}
      </div>

      {/* ── KPI Cards ── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard
          title="新品數量"
          subtitle={`New Products (${period}d)`}
          value={formatNumber(kpis.total)}
          icon={Sparkles}
          loading={loading}
          testId="kpi-new-total"
        />
        <KpiCard
          title="零銷售"
          subtitle="No Sales"
          value={formatNumber(kpis.noSales)}
          icon={TrendingDown}
          loading={loading}
          testId="kpi-new-nosales"
        />
        <KpiCard
          title="達標 >0.1/day"
          subtitle="Beating Expectations"
          value={formatNumber(kpis.beating)}
          icon={TrendingUp}
          loading={loading}
          testId="kpi-new-beating"
        />
        <KpiCard
          title="平均營收/新品"
          subtitle="Avg Revenue / New Product"
          value={formatCurrency(kpis.avgRev)}
          icon={Package}
          loading={loading}
          testId="kpi-new-avgrev"
        />
      </div>

      {/* ── Donut Chart ── */}
      <ChartCard title="新品vs舊品 Revenue Split" subtitle="New vs Existing Product Revenue (60d)" loading={loading}>
        <ResponsiveContainer width="100%" height={220}>
          <PieChart>
            <Pie
              data={donutData}
              cx="50%"
              cy="50%"
              innerRadius={55}
              outerRadius={85}
              dataKey="value"
              nameKey="name"
              paddingAngle={3}
            >
              {donutData.map((_, i) => (
                <Cell key={i} fill={DONUT_PALETTE[i % DONUT_PALETTE.length]} />
              ))}
            </Pie>
            <Tooltip {...TOOLTIP_STYLE} formatter={(v: number) => formatCurrency(v)} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
          </PieChart>
        </ResponsiveContainer>
      </ChartCard>

      {/* ── Table ── */}
      <Card className="border-border/40">
        <CardHeader className="pb-2 pt-4 px-4">
          <CardTitle className="text-sm font-medium">
            新品表現 <span className="text-xs font-normal text-muted-foreground">New Product Performance</span>
            {!loading && (
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                {sorted.length} 件新品
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4">
          {loading ? (
            <Skeleton className="h-[400px] w-full" />
          ) : sorted.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">
              近 {period} 天無新品資料
            </p>
          ) : (
            <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
              <table className="w-full text-xs" data-testid="table-new-products">
                <thead className="sticky top-0 bg-card z-10">
                  <tr className="border-b border-border/50 text-muted-foreground">
                    <th className={thCls} onClick={() => handleSort('listed')}>
                      產品 Product <SortIcon col="listed" />
                    </th>
                    <th className={thCls}>品牌 Brand</th>
                    <th className={thCls}>類別 Category</th>
                    <th className={thCls} onClick={() => handleSort('listed')}>
                      上架 Listed <SortIcon col="listed" />
                    </th>
                    <th className={thClsR}>庫存 Stock</th>
                    <th className={thClsR} onClick={() => handleSort('qty30')}>
                      30d 售出 <SortIcon col="qty30" />
                    </th>
                    <th className={thClsR} onClick={() => handleSort('qty60')}>
                      60d 售出 <SortIcon col="qty60" />
                    </th>
                    <th className={thClsR} onClick={() => handleSort('revenue')}>
                      營收 Revenue <SortIcon col="revenue" />
                    </th>
                    <th className={thClsR} onClick={() => handleSort('vel60')}>
                      速率 Vel(60d) <SortIcon col="vel60" />
                    </th>
                    <th className={thCls} onClick={() => handleSort('performance')}>
                      表現 Performance <SortIcon col="performance" />
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((row) => {
                    const pb = PERF_BADGE[row.perf];
                    return (
                      <tr
                        key={row.productId}
                        className="border-b border-border/20 hover:bg-accent/30 transition-colors"
                      >
                        <td className="py-2 max-w-[200px] truncate font-medium">{row.title}</td>
                        <td className="py-2 text-muted-foreground">{row.vendor || '—'}</td>
                        <td className="py-2 text-muted-foreground">{row.productType || '—'}</td>
                        <td className="py-2 text-muted-foreground whitespace-nowrap">
                          {row.createdAt}
                          <span className="ml-1 text-[10px] opacity-60">({row.daysAgo}d ago)</span>
                        </td>
                        <td className="py-2 text-right tabular-nums">
                          <span className={row.stock === 0 ? 'text-red-400 font-semibold' : ''}>
                            {formatNumber(row.stock)}
                          </span>
                        </td>
                        <td className="py-2 text-right tabular-nums">{formatNumber(row.qty30)}</td>
                        <td className="py-2 text-right tabular-nums">{formatNumber(row.qty60)}</td>
                        <td className="py-2 text-right tabular-nums">{formatCurrency(row.revenue)}</td>
                        <td className="py-2 text-right tabular-nums">
                          {row.vel60 === 0 ? '—' : row.vel60.toFixed(3)}
                        </td>
                        <td className="py-2">
                          <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-medium border ${pb.cls}`}>
                            {pb.label}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
