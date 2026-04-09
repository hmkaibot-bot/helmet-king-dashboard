import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useDateRange } from '@/lib/date-context';
import { getDateFrom, formatCurrency, formatNumber } from '@/lib/format';
import { ChartCard } from '@/components/chart-card';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, PieChart, Pie, Cell, Legend,
} from 'recharts';
import { CHART_COLORS, DONUT_PALETTE, AXIS_STYLE, GRID_STYLE, TOOLTIP_STYLE } from '@/lib/chart-theme';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';

export default function ProductsPage() {
  const { dateRange } = useDateRange();
  const [loading, setLoading] = useState(true);
  const [topBrands, setTopBrands] = useState<{ vendor: string; revenue: number }[]>([]);
  const [topProducts, setTopProducts] = useState<{ title: string; units: number; revenue: number }[]>([]);
  const [inventoryHealth, setInventoryHealth] = useState<{ name: string; value: number }[]>([]);
  const [categoryBreakdown, setCategoryBreakdown] = useState<{ name: string; value: number }[]>([]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    async function fetchData() {
      const dateFrom = getDateFrom(dateRange);

      // Fetch order lines with order data for filtering
      let linesQuery = supabase
        .from('shopify_order_lines')
        .select('title, vendor, quantity, price, order_id');

      const { data: lines } = await linesQuery;

      // Fetch orders for date filtering and status filtering
      let ordersQuery = supabase
        .from('shopify_orders')
        .select('id, created_at, financial_status');

      if (dateFrom) {
        ordersQuery = ordersQuery.gte('created_at', dateFrom);
      }

      const { data: orders } = await ordersQuery;

      if (cancelled) return;

      const validOrderIds = new Set(
        (orders || [])
          .filter((o: any) => o.financial_status !== 'refunded')
          .map((o: any) => o.id)
      );

      const filteredLines = (lines || []).filter((l: any) => validOrderIds.has(l.order_id));

      // Top 10 brands by revenue
      const brandMap: Record<string, number> = {};
      filteredLines.forEach((l: any) => {
        const v = l.vendor || 'Unknown';
        brandMap[v] = (brandMap[v] || 0) + (Number(l.price) || 0) * (Number(l.quantity) || 1);
      });
      const brands = Object.entries(brandMap)
        .map(([vendor, revenue]) => ({ vendor, revenue: Math.round(revenue) }))
        .sort((a, b) => b.revenue - a.revenue)
        .slice(0, 10);

      // Top 10 products by units
      const productMap: Record<string, { units: number; revenue: number }> = {};
      filteredLines.forEach((l: any) => {
        const t = l.title || 'Unknown';
        if (!productMap[t]) productMap[t] = { units: 0, revenue: 0 };
        productMap[t].units += Number(l.quantity) || 1;
        productMap[t].revenue += (Number(l.price) || 0) * (Number(l.quantity) || 1);
      });
      const products = Object.entries(productMap)
        .map(([title, d]) => ({ title, units: d.units, revenue: Math.round(d.revenue) }))
        .sort((a, b) => b.units - a.units)
        .slice(0, 10);

      // Inventory health
      const { data: inv } = await supabase
        .from('shopify_inventory')
        .select('inventory_quantity');

      const inStock = (inv || []).filter((i: any) => (Number(i.inventory_quantity) || 0) > 0).length;
      const outOfStock = (inv || []).length - inStock;

      // Category breakdown from order lines
      const catMap: Record<string, number> = {};
      filteredLines.forEach((l: any) => {
        // Use vendor as proxy for category since order_lines may not have product_type
        const cat = l.vendor || 'Other';
        catMap[cat] = (catMap[cat] || 0) + (Number(l.quantity) || 1);
      });
      const categories = Object.entries(catMap)
        .map(([name, value]) => ({ name, value }))
        .sort((a, b) => b.value - a.value)
        .slice(0, 8);

      if (!cancelled) {
        setTopBrands(brands);
        setTopProducts(products);
        setInventoryHealth([
          { name: '有庫存 In Stock', value: inStock },
          { name: '缺貨 Out of Stock', value: outOfStock },
        ]);
        setCategoryBreakdown(categories);
        setLoading(false);
      }
    }

    fetchData();
    return () => { cancelled = true; };
  }, [dateRange]);

  return (
    <div className="space-y-4 max-w-[1400px]">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {/* Top brands horizontal bar */}
        <ChartCard title="品牌營收 Top 10" subtitle="Brand Revenue" loading={loading}>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={topBrands} layout="vertical" margin={{ left: 10 }}>
              <CartesianGrid {...GRID_STYLE} horizontal={false} />
              <XAxis type="number" tick={AXIS_STYLE} tickLine={false} axisLine={false} tickFormatter={(v) => `${(v / 1000).toFixed(0)}K`} />
              <YAxis type="category" dataKey="vendor" tick={AXIS_STYLE} tickLine={false} axisLine={false} width={100} />
              <Tooltip {...TOOLTIP_STYLE} formatter={(v: number) => [`HK$${v.toLocaleString()}`, '營收']} />
              <Bar dataKey="revenue" fill={CHART_COLORS.primary} radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        {/* Top products table */}
        <ChartCard title="暢銷產品 Top 10" subtitle="By Units Sold" loading={loading}>
          <div className="max-h-[300px] overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs">產品 Product</TableHead>
                  <TableHead className="text-xs text-right">數量 Units</TableHead>
                  <TableHead className="text-xs text-right">營收 Revenue</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  Array.from({ length: 5 }).map((_, i) => (
                    <TableRow key={i}>
                      <TableCell><Skeleton className="h-4 w-full" /></TableCell>
                      <TableCell><Skeleton className="h-4 w-12 ml-auto" /></TableCell>
                      <TableCell><Skeleton className="h-4 w-16 ml-auto" /></TableCell>
                    </TableRow>
                  ))
                ) : (
                  topProducts.map((p, i) => (
                    <TableRow key={i}>
                      <TableCell className="text-xs font-medium max-w-[200px] truncate">{p.title}</TableCell>
                      <TableCell className="text-xs text-right tabular-nums">{formatNumber(p.units)}</TableCell>
                      <TableCell className="text-xs text-right tabular-nums">{formatCurrency(p.revenue)}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </ChartCard>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {/* Inventory health donut */}
        <ChartCard title="庫存健康" subtitle="Inventory Health" loading={loading}>
          <ResponsiveContainer width="100%" height={240}>
            <PieChart>
              <Pie data={inventoryHealth} cx="50%" cy="50%" innerRadius={55} outerRadius={85} paddingAngle={4} dataKey="value">
                <Cell fill="#10b981" />
                <Cell fill="#ef4444" />
              </Pie>
              <Tooltip {...TOOLTIP_STYLE} />
              <Legend wrapperStyle={{ fontSize: '11px' }} />
            </PieChart>
          </ResponsiveContainer>
        </ChartCard>

        {/* Category breakdown */}
        <ChartCard title="品牌分佈" subtitle="Brand Distribution" loading={loading}>
          <ResponsiveContainer width="100%" height={240}>
            <PieChart>
              <Pie data={categoryBreakdown} cx="50%" cy="50%" outerRadius={85} paddingAngle={2} dataKey="value">
                {categoryBreakdown.map((_, i) => (
                  <Cell key={i} fill={DONUT_PALETTE[i % DONUT_PALETTE.length]} />
                ))}
              </Pie>
              <Tooltip {...TOOLTIP_STYLE} />
              <Legend wrapperStyle={{ fontSize: '10px' }} />
            </PieChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>
    </div>
  );
}
