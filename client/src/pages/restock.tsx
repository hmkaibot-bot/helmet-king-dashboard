import { useEffect, useState, useMemo } from 'react';
import { supabase } from '@/lib/supabase';
import { queryAll } from '@/lib/query-helpers';
import { KpiCard } from '@/components/kpi-card';
import { ChartCard } from '@/components/chart-card';
import { formatCurrency, formatNumber } from '@/lib/format';
import { CHART_COLORS, AXIS_STYLE, GRID_STYLE, TOOLTIP_STYLE } from '@/lib/chart-theme';
import { AlertTriangle, XCircle, AlertOctagon, PackageCheck, Archive } from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';

type StockStatus = 'OUT_OF_STOCK' | 'CRITICAL' | 'LOW' | 'OK' | 'EXCESS';

interface RestockItem {
  variant_id: string;
  product_id: string;
  product_title: string;
  sku: string;
  price: number;
  inventory_quantity: number;
  vendor: string;
  product_type: string;
  avg_daily_sales: number;
  days_of_stock: number;
  status: StockStatus;
  reorder_qty: number;
}

const STATUS_ORDER: Record<StockStatus, number> = {
  OUT_OF_STOCK: 0,
  CRITICAL: 1,
  LOW: 2,
  OK: 3,
  EXCESS: 4,
};

const STATUS_COLOR: Record<StockStatus, string> = {
  OUT_OF_STOCK: 'bg-red-500/20 text-red-400 border-red-500/30',
  CRITICAL: 'bg-orange-500/20 text-orange-400 border-orange-500/30',
  LOW: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
  OK: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
  EXCESS: 'bg-slate-500/20 text-slate-400 border-slate-500/30',
};

const STATUS_LABEL: Record<StockStatus, string> = {
  OUT_OF_STOCK: '缺貨',
  CRITICAL: '危急',
  LOW: '偏低',
  OK: '正常',
  EXCESS: '過剩',
};

const TABS: { key: string; label: string; sublabel: string }[] = [
  { key: 'all', label: '全部', sublabel: 'All' },
  { key: 'OUT_OF_STOCK', label: '缺貨', sublabel: 'Out of Stock' },
  { key: 'CRITICAL', label: '危急', sublabel: 'Critical' },
  { key: 'LOW', label: '偏低', sublabel: 'Low' },
  { key: 'OK', label: '正常', sublabel: 'OK' },
  { key: 'EXCESS', label: '過剩', sublabel: 'Excess' },
];

export default function RestockPage() {
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<RestockItem[]>([]);
  const [tab, setTab] = useState('all');

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        // 1. Fetch inventory
        const inventory = await queryAll(
          'shopify_inventory',
          'variant_id,product_id,product_title,sku,price,inventory_quantity,vendor,product_type',
          undefined,
          10000
        );
        const filteredInv = inventory.filter((i: any) => parseFloat(i.price) > 0);

        // 2. Fetch order lines and orders from last 90 days
        const ninetyAgo = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
        const todayStr = new Date().toISOString().slice(0, 10);

        const { data: recentOrders } = await supabase
          .from('shopify_orders')
          .select('id,created_at')
          .gte('created_at', ninetyAgo)
          .limit(10000);

        const validOrderIds = new Set(
          (recentOrders || [])
            .filter((o: any) => o.created_at && o.created_at <= todayStr + '\xff')
            .map((o: any) => o.id)
        );

        const orderLines = await queryAll(
          'shopify_order_lines',
          'variant_id,quantity,order_id',
          undefined,
          50000
        );

        // Compute avg daily sales per variant_id
        const salesMap: Record<string, number> = {};
        orderLines.forEach((l: any) => {
          if (validOrderIds.has(l.order_id)) {
            const vid = l.variant_id;
            salesMap[vid] = (salesMap[vid] || 0) + (l.quantity || 0);
          }
        });

        if (cancelled) return;

        // 3. Build restock items
        const result: RestockItem[] = filteredInv.map((inv: any) => {
          const qty = inv.inventory_quantity || 0;
          const totalSold = salesMap[inv.variant_id] || 0;
          const avgDaily = totalSold / 90;
          const daysOfStock = avgDaily > 0 ? qty / avgDaily : Infinity;

          let status: StockStatus;
          if (qty === 0) status = 'OUT_OF_STOCK';
          else if (daysOfStock <= 7) status = 'CRITICAL';
          else if (daysOfStock <= 14) status = 'LOW';
          else if (daysOfStock <= 90) status = 'OK';
          else status = 'EXCESS';

          const reorderQty = Math.max(0, Math.ceil(avgDaily * 30) - qty);

          return {
            variant_id: inv.variant_id,
            product_id: inv.product_id,
            product_title: inv.product_title || '',
            sku: inv.sku || '',
            price: parseFloat(inv.price) || 0,
            inventory_quantity: qty,
            vendor: inv.vendor || '',
            product_type: inv.product_type || '',
            avg_daily_sales: avgDaily,
            days_of_stock: daysOfStock,
            status,
            reorder_qty: reorderQty,
          };
        });

        // Sort by urgency
        result.sort((a, b) => {
          const so = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
          if (so !== 0) return so;
          return a.days_of_stock - b.days_of_stock;
        });

        setItems(result);
      } catch (e) {
        console.error('Restock error:', e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  const counts = useMemo(() => {
    const c = { OUT_OF_STOCK: 0, CRITICAL: 0, LOW: 0, OK: 0, EXCESS: 0 };
    items.forEach((i) => c[i.status]++);
    return c;
  }, [items]);

  const filtered = useMemo(
    () => tab === 'all' ? items : items.filter((i) => i.status === tab),
    [items, tab]
  );

  const oosVendors = useMemo(() => {
    const map: Record<string, number> = {};
    items.filter((i) => i.status === 'OUT_OF_STOCK').forEach((i) => {
      const v = i.vendor || 'Unknown';
      map[v] = (map[v] || 0) + 1;
    });
    return Object.entries(map)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([name, count]) => ({ name, count }));
  }, [items]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard title="缺貨" subtitle="Out of Stock" value={formatNumber(counts.OUT_OF_STOCK)} icon={XCircle} loading={loading} testId="kpi-oos" />
        <KpiCard title="危急 ≤7天" subtitle="Critical" value={formatNumber(counts.CRITICAL)} icon={AlertOctagon} loading={loading} testId="kpi-critical" />
        <KpiCard title="偏低 ≤14天" subtitle="Low Stock" value={formatNumber(counts.LOW)} icon={AlertTriangle} loading={loading} testId="kpi-low" />
        <KpiCard title="過剩 >90天" subtitle="Excess" value={formatNumber(counts.EXCESS)} icon={Archive} loading={loading} testId="kpi-excess" />
      </div>

      <ChartCard title="缺貨 SKU (供應商)" subtitle="Top 15 Vendors by OOS SKUs" loading={loading}>
        <ResponsiveContainer width="100%" height={360}>
          <BarChart data={oosVendors} layout="vertical">
            <CartesianGrid {...GRID_STYLE} />
            <XAxis type="number" tick={AXIS_STYLE} allowDecimals={false} />
            <YAxis type="category" dataKey="name" tick={AXIS_STYLE} width={120} />
            <Tooltip {...TOOLTIP_STYLE} />
            <Bar dataKey="count" name="OOS SKUs" fill={CHART_COLORS.fifth} radius={[0, 3, 3, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      <Card className="border-border/40">
        <CardHeader className="pb-2 pt-4 px-4">
          <CardTitle className="text-sm font-medium">
            補貨清單 <span className="text-xs font-normal text-muted-foreground">Restock List</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4">
          {/* Tabs */}
          <div className="flex gap-1 mb-3 flex-wrap">
            {TABS.map((t) => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`px-3 py-1.5 rounded-md text-xs transition-colors ${
                  tab === t.key
                    ? 'bg-primary/15 text-primary font-medium'
                    : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
                }`}
                data-testid={`tab-${t.key}`}
              >
                {t.label} <span className="opacity-60">{t.sublabel}</span>
                {t.key !== 'all' && (
                  <span className="ml-1 tabular-nums">
                    ({counts[t.key as StockStatus] || 0})
                  </span>
                )}
              </button>
            ))}
          </div>

          {loading ? (
            <Skeleton className="h-[300px] w-full" />
          ) : filtered.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">無數據</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs" data-testid="table-restock">
                <thead>
                  <tr className="border-b border-border/50 text-muted-foreground">
                    <th className="py-2 text-left font-medium">狀態</th>
                    <th className="py-2 text-left font-medium">產品 Title</th>
                    <th className="py-2 text-left font-medium">SKU</th>
                    <th className="py-2 text-left font-medium">供應商 Vendor</th>
                    <th className="py-2 text-right font-medium">庫存 Qty</th>
                    <th className="py-2 text-right font-medium">日均銷量</th>
                    <th className="py-2 text-right font-medium">庫存天數</th>
                    <th className="py-2 text-right font-medium">建議補貨</th>
                    <th className="py-2 text-right font-medium">價格</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.slice(0, 200).map((item, i) => (
                    <tr key={item.variant_id + '-' + i} className="border-b border-border/20 hover:bg-accent/30 transition-colors">
                      <td className="py-2">
                        <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-medium border ${STATUS_COLOR[item.status]}`}>
                          {STATUS_LABEL[item.status]}
                        </span>
                      </td>
                      <td className="py-2 max-w-[220px] truncate">{item.product_title}</td>
                      <td className="py-2 font-mono text-[11px]">{item.sku || '—'}</td>
                      <td className="py-2 text-muted-foreground">{item.vendor || '—'}</td>
                      <td className="py-2 text-right tabular-nums">{item.inventory_quantity}</td>
                      <td className="py-2 text-right tabular-nums">{item.avg_daily_sales.toFixed(2)}</td>
                      <td className="py-2 text-right tabular-nums">
                        {item.days_of_stock === Infinity ? '∞' : item.days_of_stock.toFixed(0)}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {item.reorder_qty > 0 ? (
                          <Badge variant="outline" className="text-[10px] border-primary/40 text-primary">{item.reorder_qty}</Badge>
                        ) : '—'}
                      </td>
                      <td className="py-2 text-right tabular-nums">{formatCurrency(item.price)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {filtered.length > 200 && (
                <p className="text-xs text-muted-foreground text-center py-2">
                  顯示前 200 項，共 {filtered.length} 項
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
