import { useEffect, useState } from 'react';
import { useDateRange } from '@/lib/date-context';
import { queryAll, queryWithDateRange } from '@/lib/query-helpers';
import { KpiCard } from '@/components/kpi-card';
import { ChartCard } from '@/components/chart-card';
import { formatCurrency, formatNumber, formatPercent } from '@/lib/format';
import { CHART_COLORS, AXIS_STYLE, GRID_STYLE, TOOLTIP_STYLE, DONUT_PALETTE } from '@/lib/chart-theme';
import { Package, AlertTriangle, XCircle, DollarSign, Clock } from 'lucide-react';
import {
  PieChart, Pie, Cell, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';

export default function RetailInventoryPage() {
  const { bounds } = useDateRange();
  const [loading, setLoading] = useState(true);
  const [activeSku, setActiveSku] = useState(0);
  const [outOfStock, setOutOfStock] = useState(0);
  const [lowStock, setLowStock] = useState(0);
  const [totalValue, setTotalValue] = useState(0);
  const [avgDaysOfStock, setAvgDaysOfStock] = useState(0);
  const [stockStatus, setStockStatus] = useState<any[]>([]);
  const [brandValue, setBrandValue] = useState<any[]>([]);
  const [sellThrough, setSellThrough] = useState<any[]>([]);
  const [restockAlerts, setRestockAlerts] = useState<any[]>([]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const ninetyAgo = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
        const [inventory, orderLines, recentOrders] = await Promise.all([
          queryAll('shopify_inventory', 'variant_id,product_title,sku,price,inventory_quantity,vendor,product_type'),
          queryAll('shopify_order_lines', 'order_id,vendor,quantity'),
          queryWithDateRange('shopify_orders', 'id,financial_status,cancelled_at', 'created_at', { from: ninetyAgo, to: new Date().toISOString().slice(0, 10) }),
        ]);

        if (cancelled) return;

        const active = inventory.filter((i: any) => (i.inventory_quantity || 0) > 0);
        const oos = inventory.filter((i: any) => (i.inventory_quantity || 0) === 0);
        const low = inventory.filter((i: any) => (i.inventory_quantity || 0) > 0 && (i.inventory_quantity || 0) <= 2);
        const value = inventory.reduce((s: number, i: any) => s + (parseFloat(i.price) || 0) * (i.inventory_quantity || 0), 0);

        const validOrderIds = new Set(recentOrders.filter((o: any) => o.financial_status !== 'refunded' && !o.cancelled_at).map((o: any) => o.id));
        const recentLines = orderLines.filter((l: any) => validOrderIds.has(l.order_id));
        const totalSold90d = recentLines.reduce((s: number, l: any) => s + (l.quantity || 0), 0);
        const dailySalesRate = totalSold90d / 90;
        const totalInv = inventory.reduce((s: number, i: any) => s + (i.inventory_quantity || 0), 0);

        setActiveSku(active.length);
        setOutOfStock(oos.length);
        setLowStock(low.length);
        setTotalValue(value);
        setAvgDaysOfStock(dailySalesRate > 0 ? totalInv / dailySalesRate : 0);

        setStockStatus([
          { name: '有貨 In Stock', value: active.length - low.length },
          { name: '低庫存 Low', value: low.length },
          { name: '缺貨 Out', value: oos.length },
        ]);

        // Brand value top 10
        const brandMap: Record<string, number> = {};
        inventory.forEach((i: any) => { const b = i.vendor || 'Unknown'; brandMap[b] = (brandMap[b] || 0) + (parseFloat(i.price) || 0) * (i.inventory_quantity || 0); });
        setBrandValue(Object.entries(brandMap).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, value]) => ({ name, value })));

        // Sell-through by brand
        const soldByBrand: Record<string, number> = {};
        recentLines.forEach((l: any) => { const b = l.vendor || 'Unknown'; soldByBrand[b] = (soldByBrand[b] || 0) + (l.quantity || 0); });
        const stockByBrand: Record<string, number> = {};
        inventory.forEach((i: any) => { const b = i.vendor || 'Unknown'; stockByBrand[b] = (stockByBrand[b] || 0) + (i.inventory_quantity || 0); });
        const allBrands = new Set([...Object.keys(soldByBrand), ...Object.keys(stockByBrand)]);
        setSellThrough(Array.from(allBrands).map((brand) => {
          const sold = soldByBrand[brand] || 0;
          const stock = stockByBrand[brand] || 0;
          return { name: brand, rate: sold + stock > 0 ? (sold / (sold + stock)) * 100 : 0 };
        }).sort((a, b) => b.rate - a.rate).slice(0, 15));

        // Restock alerts
        setRestockAlerts(inventory.filter((i: any) => (i.inventory_quantity || 0) > 0 && (i.inventory_quantity || 0) <= 2).sort((a: any, b: any) => a.inventory_quantity - b.inventory_quantity).slice(0, 30));
      } catch (e) {
        console.error('Inventory error:', e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [bounds]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
        <KpiCard title="有效 SKU" subtitle="Active SKUs" value={formatNumber(activeSku)} icon={Package} loading={loading} testId="kpi-active-sku" />
        <KpiCard title="缺貨" subtitle="Out of Stock" value={formatNumber(outOfStock)} icon={XCircle} loading={loading} testId="kpi-oos" />
        <KpiCard title="低庫存 ≤2" subtitle="Low Stock" value={formatNumber(lowStock)} icon={AlertTriangle} loading={loading} testId="kpi-low" />
        <KpiCard title="庫存總值" subtitle="Inventory Value" value={formatCurrency(totalValue)} icon={DollarSign} loading={loading} testId="kpi-inv-value" />
        <KpiCard title="平均庫存天數" subtitle="Avg Days of Stock" value={`${avgDaysOfStock.toFixed(0)} days`} icon={Clock} loading={loading} testId="kpi-days" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ChartCard title="庫存狀態" subtitle="Stock Status" loading={loading}>
          <ResponsiveContainer width="100%" height={240}>
            <PieChart>
              <Pie data={stockStatus} cx="50%" cy="50%" innerRadius={55} outerRadius={85} dataKey="value" nameKey="name" paddingAngle={2}>
                <Cell fill={CHART_COLORS.tertiary} />
                <Cell fill={CHART_COLORS.primary} />
                <Cell fill={CHART_COLORS.fifth} />
              </Pie>
              <Tooltip {...TOOLTIP_STYLE} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
            </PieChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="庫存價值 (品牌)" subtitle="Value by Brand Top 10" loading={loading}>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={brandValue} layout="vertical">
              <CartesianGrid {...GRID_STYLE} />
              <XAxis type="number" tick={AXIS_STYLE} tickFormatter={(v) => `${(v / 1000).toFixed(0)}K`} />
              <YAxis type="category" dataKey="name" tick={AXIS_STYLE} width={90} />
              <Tooltip {...TOOLTIP_STYLE} formatter={(v: number) => formatCurrency(v)} />
              <Bar dataKey="value" fill={CHART_COLORS.secondary} radius={[0, 3, 3, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      <ChartCard title="銷售穿透率 (品牌)" subtitle="Sell-Through Rate" loading={loading}>
        <ResponsiveContainer width="100%" height={320}>
          <BarChart data={sellThrough}>
            <CartesianGrid {...GRID_STYLE} />
            <XAxis dataKey="name" tick={AXIS_STYLE} angle={-45} textAnchor="end" height={80} />
            <YAxis tick={AXIS_STYLE} tickFormatter={(v) => `${v.toFixed(0)}%`} />
            <Tooltip {...TOOLTIP_STYLE} formatter={(v: number) => `${v.toFixed(1)}%`} />
            <Bar dataKey="rate" fill={CHART_COLORS.tertiary} radius={[3, 3, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      <Card className="border-border/40">
        <CardHeader className="pb-2 pt-4 px-4">
          <CardTitle className="text-sm font-medium">補貨提醒 <span className="text-xs font-normal text-muted-foreground">Restock Alerts (qty ≤ 2)</span></CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4">
          {loading ? <Skeleton className="h-[200px] w-full" /> : restockAlerts.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">数据不足</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs" data-testid="table-restock">
                <thead>
                  <tr className="border-b border-border/50 text-muted-foreground">
                    <th className="py-2 text-left font-medium">SKU</th>
                    <th className="py-2 text-left font-medium">產品 Title</th>
                    <th className="py-2 text-left font-medium">品牌 Vendor</th>
                    <th className="py-2 text-right font-medium">庫存 Qty</th>
                    <th className="py-2 text-right font-medium">價格 Price</th>
                  </tr>
                </thead>
                <tbody>
                  {restockAlerts.map((item: any, i: number) => (
                    <tr key={i} className="border-b border-border/20 hover:bg-accent/30 transition-colors">
                      <td className="py-2 font-mono text-[11px]">{item.sku || '—'}</td>
                      <td className="py-2 max-w-[200px] truncate">{item.product_title}</td>
                      <td className="py-2 text-muted-foreground">{item.vendor || '—'}</td>
                      <td className="py-2 text-right tabular-nums"><Badge variant="destructive" className="text-[10px]">{item.inventory_quantity}</Badge></td>
                      <td className="py-2 text-right tabular-nums">{formatCurrency(parseFloat(item.price))}</td>
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
