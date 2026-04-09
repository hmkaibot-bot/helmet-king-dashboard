import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { KpiCard } from '@/components/kpi-card';
import { ChartCard } from '@/components/chart-card';
import { formatNumber, formatCurrency } from '@/lib/format';
import { Package, AlertTriangle, XCircle, DollarSign } from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell,
} from 'recharts';
import { CHART_COLORS, DONUT_PALETTE, AXIS_STYLE, GRID_STYLE, TOOLTIP_STYLE } from '@/lib/chart-theme';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';

interface InvItem {
  product_title: string;
  sku: string;
  price: number;
  inventory_quantity: number;
  vendor: string;
  product_type: string;
}

// Fetch all rows in pages of 1000
async function fetchAllInventory(): Promise<InvItem[]> {
  const allItems: InvItem[] = [];
  const pageSize = 1000;
  let from = 0;
  let hasMore = true;

  while (hasMore) {
    const { data, error } = await supabase
      .from('shopify_inventory')
      .select('product_title, sku, price, inventory_quantity, vendor, product_type')
      .range(from, from + pageSize - 1);

    if (error || !data || data.length === 0) {
      hasMore = false;
    } else {
      allItems.push(...(data as InvItem[]));
      from += pageSize;
      if (data.length < pageSize) hasMore = false;
    }
  }

  return allItems;
}

export default function InventoryPage() {
  const [loading, setLoading] = useState(true);
  const [totalSkus, setTotalSkus] = useState(0);
  const [outOfStock, setOutOfStock] = useState(0);
  const [lowStock, setLowStock] = useState(0);
  const [totalValue, setTotalValue] = useState(0);
  const [outByBrand, setOutByBrand] = useState<{ vendor: string; count: number }[]>([]);
  const [byType, setByType] = useState<{ type: string; count: number }[]>([]);
  const [lowStockItems, setLowStockItems] = useState<InvItem[]>([]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    async function fetchData() {
      try {
        const items = await fetchAllInventory();

        if (cancelled) return;

        setTotalSkus(items.length);

        const oos = items.filter((i) => (Number(i.inventory_quantity) || 0) <= 0);
        setOutOfStock(oos.length);

        const low = items.filter((i) => {
          const qty = Number(i.inventory_quantity) || 0;
          return qty > 0 && qty <= 2;
        });
        setLowStock(low.length);

        const value = items.reduce(
          (s, i) => s + (Math.max(Number(i.inventory_quantity) || 0, 0) * (Number(i.price) || 0)),
          0
        );
        setTotalValue(value);

        // Out of stock by brand
        const brandMap: Record<string, number> = {};
        oos.forEach((i) => {
          const v = i.vendor || 'Unknown';
          brandMap[v] = (brandMap[v] || 0) + 1;
        });
        setOutByBrand(
          Object.entries(brandMap)
            .map(([vendor, count]) => ({ vendor, count }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 10)
        );

        // Inventory by product type
        const typeMap: Record<string, number> = {};
        items.forEach((i) => {
          const t = i.product_type || 'Other';
          typeMap[t] = (typeMap[t] || 0) + Math.max(Number(i.inventory_quantity) || 0, 0);
        });
        setByType(
          Object.entries(typeMap)
            .map(([type, count]) => ({ type, count }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 12)
        );

        // Low stock items table
        setLowStockItems(
          low
            .sort((a, b) => (Number(a.inventory_quantity) || 0) - (Number(b.inventory_quantity) || 0))
            .slice(0, 20)
        );
      } catch (err) {
        console.error('Inventory fetch error:', err);
      }

      if (!cancelled) setLoading(false);
    }

    fetchData();
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="space-y-4 max-w-[1400px]">
      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard title="總SKU數" subtitle="Total SKUs" value={formatNumber(totalSkus)} icon={Package} loading={loading} testId="kpi-skus" />
        <KpiCard title="缺貨數" subtitle="Out of Stock" value={formatNumber(outOfStock)} icon={XCircle} loading={loading} testId="kpi-oos" />
        <KpiCard title="低庫存" subtitle="Low Stock (≤2)" value={formatNumber(lowStock)} icon={AlertTriangle} loading={loading} testId="kpi-low" />
        <KpiCard title="庫存價值" subtitle="Inventory Value" value={formatCurrency(totalValue)} icon={DollarSign} loading={loading} testId="kpi-inv-value" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {/* Out of stock by brand */}
        <ChartCard title="品牌缺貨數" subtitle="Out of Stock by Brand" loading={loading}>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={outByBrand} layout="vertical" margin={{ left: 10 }}>
              <CartesianGrid {...GRID_STYLE} horizontal={false} />
              <XAxis type="number" tick={AXIS_STYLE} tickLine={false} axisLine={false} />
              <YAxis type="category" dataKey="vendor" tick={AXIS_STYLE} tickLine={false} axisLine={false} width={100} />
              <Tooltip {...TOOLTIP_STYLE} />
              <Bar dataKey="count" fill="#ef4444" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        {/* Inventory by product type */}
        <ChartCard title="產品類型庫存" subtitle="Inventory by Category" loading={loading}>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={byType}>
              <CartesianGrid {...GRID_STYLE} />
              <XAxis dataKey="type" tick={{ ...AXIS_STYLE, fontSize: 9 }} tickLine={false} axisLine={false} angle={-30} textAnchor="end" height={50} />
              <YAxis tick={AXIS_STYLE} tickLine={false} axisLine={false} />
              <Tooltip {...TOOLTIP_STYLE} />
              <Bar dataKey="count" fill={CHART_COLORS.primary} radius={[4, 4, 0, 0]}>
                {byType.map((_, i) => (
                  <Cell key={i} fill={DONUT_PALETTE[i % DONUT_PALETTE.length]} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {/* Low stock table */}
      <ChartCard title="低庫存商品" subtitle="Low Stock Items (≤2 units)" loading={loading}>
        <div className="max-h-[400px] overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs">產品 Product</TableHead>
                <TableHead className="text-xs">SKU</TableHead>
                <TableHead className="text-xs text-right">庫存 Qty</TableHead>
                <TableHead className="text-xs text-right">價格 Price</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <TableRow key={i}>
                    <TableCell><Skeleton className="h-4 w-full" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-16" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-8 ml-auto" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-12 ml-auto" /></TableCell>
                  </TableRow>
                ))
              ) : lowStockItems.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-xs text-muted-foreground py-8">
                    沒有低庫存商品 No low stock items
                  </TableCell>
                </TableRow>
              ) : (
                lowStockItems.map((item, i) => (
                  <TableRow key={i}>
                    <TableCell className="text-xs font-medium max-w-[250px] truncate">{item.product_title}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{item.sku || '—'}</TableCell>
                    <TableCell className="text-xs text-right">
                      <Badge variant={Number(item.inventory_quantity) <= 1 ? 'destructive' : 'secondary'} className="text-[10px] px-1.5 py-0">
                        {item.inventory_quantity}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-right tabular-nums">{formatCurrency(Number(item.price))}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </ChartCard>
    </div>
  );
}
