import { useEffect, useState, useMemo } from 'react';
import { useDateRange } from '@/lib/date-context';
import { queryWithDateRange, queryAll } from '@/lib/query-helpers';
import { KpiCard } from '@/components/kpi-card';
import { ChartCard } from '@/components/chart-card';
import { formatCurrency, formatNumber, formatPercent } from '@/lib/format';
import { CHART_COLORS, CHART_PALETTE, AXIS_STYLE, GRID_STYLE, TOOLTIP_STYLE } from '@/lib/chart-theme';
import { Package, DollarSign, BarChart3, Tag, Hash } from 'lucide-react';
import { BarChart, Bar, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export default function RetailBrandsPage() {
  const { bounds } = useDateRange();
  const [loading, setLoading] = useState(true);
  const [selectedBrand, setSelectedBrand] = useState<string>('all');
  const [brands, setBrands] = useState<string[]>([]);
  const [orderLines, setOrderLines] = useState<any[]>([]);
  const [inventory, setInventory] = useState<any[]>([]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const [orders, lines, inv] = await Promise.all([
          queryWithDateRange('shopify_orders', 'id,created_at,financial_status,cancelled_at', 'created_at', bounds),
          queryAll('shopify_order_lines', 'order_id,title,vendor,product_type,quantity,price,total_discount'),
          queryAll('shopify_inventory', 'variant_id,product_title,vendor,price,inventory_quantity'),
        ]);
        if (cancelled) return;

        const validIds = new Set(orders.filter((o: any) => o.financial_status !== 'refunded' && !o.cancelled_at).map((o: any) => o.id));
        const orderDateMap: Record<string, string> = {};
        orders.forEach((o: any) => { orderDateMap[o.id] = o.created_at; });
        const validLines = lines.filter((l: any) => validIds.has(l.order_id)).map((l: any) => ({ ...l, date: orderDateMap[l.order_id]?.slice(0, 7) || '' }));
        const brandSet = new Set<string>();
        validLines.forEach((l: any) => { if (l.vendor) brandSet.add(l.vendor); });

        setOrderLines(validLines);
        setInventory(inv);
        setBrands(Array.from(brandSet).sort());
      } catch (e) { console.error('Brands error:', e); } finally { if (!cancelled) setLoading(false); }
    }
    load();
    return () => { cancelled = true; };
  }, [bounds]);

  const filtered = useMemo(() => selectedBrand === 'all' ? orderLines : orderLines.filter((l: any) => l.vendor === selectedBrand), [orderLines, selectedBrand]);
  const filteredInv = useMemo(() => selectedBrand === 'all' ? inventory : inventory.filter((i: any) => i.vendor === selectedBrand), [inventory, selectedBrand]);

  const unitsSold = filtered.reduce((s: number, l: any) => s + (l.quantity || 0), 0);
  const revenue = filtered.reduce((s: number, l: any) => s + (parseFloat(l.price) || 0) * (l.quantity || 0), 0);
  const avgPrice = unitsSold > 0 ? revenue / unitsSold : 0;
  const skuCount = new Set(filteredInv.map((i: any) => i.variant_id)).size;

  const brandRevenue = useMemo(() => {
    const map: Record<string, number> = {};
    orderLines.forEach((l: any) => { const b = l.vendor || 'Unknown'; map[b] = (map[b] || 0) + (parseFloat(l.price) || 0) * (l.quantity || 0); });
    return Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([name, value]) => ({ name, value }));
  }, [orderLines]);

  const top5Brands = useMemo(() => brandRevenue.slice(0, 5).map((b) => b.name), [brandRevenue]);
  const brandTrend = useMemo(() => {
    const monthMap: Record<string, Record<string, number>> = {};
    orderLines.forEach((l: any) => { const m = l.date; const b = l.vendor || 'Unknown'; if (!m || !top5Brands.includes(b)) return; if (!monthMap[m]) monthMap[m] = {}; monthMap[m][b] = (monthMap[m][b] || 0) + (parseFloat(l.price) || 0) * (l.quantity || 0); });
    return Object.entries(monthMap).sort(([a], [b]) => a.localeCompare(b)).map(([month, brands]) => ({ month, ...brands }));
  }, [orderLines, top5Brands]);

  const priceBands = useMemo(() => {
    const bands = [{ label: '<500', min: 0, max: 499 }, { label: '500-1K', min: 500, max: 999 }, { label: '1K-2K', min: 1000, max: 1999 }, { label: '2K+', min: 2000, max: Infinity }];
    return bands.map((b) => ({ name: b.label, units: filtered.filter((l: any) => { const p = parseFloat(l.price) || 0; return p >= b.min && p <= b.max; }).reduce((s: number, l: any) => s + (l.quantity || 0), 0) }));
  }, [filtered]);

  const brandComparison = useMemo(() => {
    const map: Record<string, { skus: Set<string>; units: number; revenue: number; stock: number; stockQty: number }> = {};
    orderLines.forEach((l: any) => { const b = l.vendor || 'Unknown'; if (!map[b]) map[b] = { skus: new Set(), units: 0, revenue: 0, stock: 0, stockQty: 0 }; map[b].units += l.quantity || 0; map[b].revenue += (parseFloat(l.price) || 0) * (l.quantity || 0); });
    inventory.forEach((i: any) => { const b = i.vendor || 'Unknown'; if (!map[b]) map[b] = { skus: new Set(), units: 0, revenue: 0, stock: 0, stockQty: 0 }; map[b].skus.add(i.variant_id); map[b].stock += (parseFloat(i.price) || 0) * (i.inventory_quantity || 0); map[b].stockQty += i.inventory_quantity || 0; });
    return Object.entries(map).map(([brand, d]) => ({ brand, skus: d.skus.size, units: d.units, revenue: d.revenue, avgPrice: d.units > 0 ? d.revenue / d.units : 0, stockValue: d.stock, sellThrough: d.units + d.stockQty > 0 ? (d.units / (d.units + d.stockQty)) * 100 : 0 })).sort((a, b) => b.revenue - a.revenue).slice(0, 25);
  }, [orderLines, inventory]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <span className="text-sm text-muted-foreground">品牌 Brand:</span>
        <Select value={selectedBrand} onValueChange={setSelectedBrand}>
          <SelectTrigger className="w-[200px] h-8 text-xs" data-testid="select-brand"><SelectValue placeholder="全部" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部品牌 All</SelectItem>
            {brands.map((b) => <SelectItem key={b} value={b}>{b}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
        <KpiCard title="售出件數" subtitle="Units" value={formatNumber(unitsSold)} icon={Package} loading={loading} testId="kpi-units" />
        <KpiCard title="營收" subtitle="Revenue" value={formatCurrency(revenue)} icon={DollarSign} loading={loading} testId="kpi-rev" />
        <KpiCard title="均價" subtitle="Avg Price" value={formatCurrency(avgPrice)} icon={BarChart3} loading={loading} testId="kpi-avg" />
        <KpiCard title="SKU" subtitle="Count" value={formatNumber(skuCount)} icon={Hash} loading={loading} testId="kpi-sku" />
        <KpiCard title="品牌數" subtitle="Brands" value={formatNumber(brands.length)} icon={Tag} loading={loading} testId="kpi-brands" />
      </div>

      <ChartCard title="品牌營收排名" subtitle="Top 15 by Revenue" loading={loading}>
        <ResponsiveContainer width="100%" height={380}>
          <BarChart data={brandRevenue} layout="vertical">
            <CartesianGrid {...GRID_STYLE} />
            <XAxis type="number" tick={AXIS_STYLE} tickFormatter={(v) => `${(v / 1000).toFixed(0)}K`} />
            <YAxis type="category" dataKey="name" tick={AXIS_STYLE} width={110} />
            <Tooltip {...TOOLTIP_STYLE} formatter={(v: number) => formatCurrency(v)} />
            <Bar dataKey="value" fill={CHART_COLORS.primary} radius={[0, 3, 3, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ChartCard title="品牌趨勢 (Top 5)" subtitle="Monthly Trend" loading={loading}>
          <ResponsiveContainer width="100%" height={280}>
            <AreaChart data={brandTrend}>
              <CartesianGrid {...GRID_STYLE} />
              <XAxis dataKey="month" tick={AXIS_STYLE} />
              <YAxis tick={AXIS_STYLE} tickFormatter={(v) => `${(v / 1000).toFixed(0)}K`} />
              <Tooltip {...TOOLTIP_STYLE} formatter={(v: number) => formatCurrency(v)} />
              {top5Brands.map((b, i) => <Area key={b} type="monotone" dataKey={b} stackId="1" stroke={CHART_PALETTE[i]} fill={CHART_PALETTE[i]} fillOpacity={0.3} />)}
              <Legend wrapperStyle={{ fontSize: 11 }} />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="價格段分析" subtitle="Price Band" loading={loading}>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={priceBands}>
              <CartesianGrid {...GRID_STYLE} />
              <XAxis dataKey="name" tick={AXIS_STYLE} />
              <YAxis tick={AXIS_STYLE} />
              <Tooltip {...TOOLTIP_STYLE} />
              <Bar dataKey="units" fill={CHART_COLORS.secondary} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      <Card className="border-border/40">
        <CardHeader className="pb-2 pt-4 px-4"><CardTitle className="text-sm font-medium">品牌比較 <span className="text-xs font-normal text-muted-foreground">Comparison</span></CardTitle></CardHeader>
        <CardContent className="px-4 pb-4">
          {loading ? <Skeleton className="h-[300px] w-full" /> : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs" data-testid="table-brands">
                <thead>
                  <tr className="border-b border-border/50 text-muted-foreground">
                    <th className="py-2 text-left font-medium">品牌</th>
                    <th className="py-2 text-right font-medium">SKUs</th>
                    <th className="py-2 text-right font-medium">售出</th>
                    <th className="py-2 text-right font-medium">營收</th>
                    <th className="py-2 text-right font-medium">均價</th>
                    <th className="py-2 text-right font-medium">庫存值</th>
                    <th className="py-2 text-right font-medium">ST%</th>
                  </tr>
                </thead>
                <tbody>
                  {brandComparison.map((b) => (
                    <tr key={b.brand} className="border-b border-border/20 hover:bg-accent/30 transition-colors">
                      <td className="py-2 font-medium">{b.brand}</td>
                      <td className="py-2 text-right tabular-nums">{b.skus}</td>
                      <td className="py-2 text-right tabular-nums">{formatNumber(b.units)}</td>
                      <td className="py-2 text-right tabular-nums">{formatCurrency(b.revenue)}</td>
                      <td className="py-2 text-right tabular-nums">{formatCurrency(b.avgPrice)}</td>
                      <td className="py-2 text-right tabular-nums">{formatCurrency(b.stockValue)}</td>
                      <td className="py-2 text-right tabular-nums">{formatPercent(b.sellThrough)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
