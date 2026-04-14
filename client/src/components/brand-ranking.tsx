import { useState, useMemo } from 'react';
import { formatCurrency, formatNumber } from '@/lib/format';
import { CHART_COLORS, CHART_PALETTE, AXIS_STYLE, GRID_STYLE, TOOLTIP_STYLE } from '@/lib/chart-theme';
import {
  Trophy, ChevronDown, ChevronUp, X, Store, ShoppingCart, Package, TrendingUp,
} from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';

// ── Target Brands ──────────────────────────────────────────
const TARGET_BRANDS = [
  'SCORPION', 'SHOEI', 'ARAI', 'FETURE', 'MODER',
  'KUSHITANI', 'ROUGH AND ROAD', 'FURYGAN', 'FIVE', 'CARDO',
];

// Vendor name normalization
function normalizeBrand(vendor: string): string | null {
  const v = vendor.toUpperCase().trim();
  for (const b of TARGET_BRANDS) {
    if (v === b || v.startsWith(b + ' ') || v.includes(b)) return b;
  }
  // Special cases
  if (v === 'FIVE GLOVES') return 'FIVE';
  if (v === 'SHOEI EUROPE') return 'SHOEI';
  return null;
}

interface BrandData {
  brand: string;
  revenue: number;
  qty: number;
  orderCount: number;
  products: { title: string; sku: string; variant: string; qty: number; revenue: number; source: string }[];
  bySource: { name: string; revenue: number; qty: number }[];
  byProduct: { title: string; qty: number; revenue: number }[];
}

interface Props {
  orderLines: any[];
  orders: any[];
  loading: boolean;
}

// Channel label mapping
function channelLabel(src: string): string {
  if (src === 'pos') return '門市 POS';
  if (src === 'web') return '網店 Online';
  if (src === 'shopify_draft_order') return '手動訂單';
  if (/^\d+$/.test(src)) return 'App';
  return src;
}

export function BrandRanking({ orderLines, orders, loading }: Props) {
  const [selectedBrand, setSelectedBrand] = useState<string | null>(null);

  const brandData = useMemo(() => {
    if (!orderLines.length || !orders.length) return [];

    // Build order lookup
    const orderMap = new Map<number, any>();
    for (const o of orders) {
      if (o.financial_status === 'refunded' || o.cancelled_at) continue;
      orderMap.set(o.id, o);
    }

    // Aggregate by brand
    const brands: Record<string, BrandData> = {};
    const orderBrandSet = new Map<string, Set<number>>(); // brand -> order ids

    for (const line of orderLines) {
      const order = orderMap.get(line.order_id);
      if (!order) continue;
      const brand = normalizeBrand(line.vendor || '');
      if (!brand) continue;

      if (!brands[brand]) {
        brands[brand] = { brand, revenue: 0, qty: 0, orderCount: 0, products: [], bySource: [], byProduct: [] };
        orderBrandSet.set(brand, new Set());
      }

      const qty = line.quantity || 0;
      const price = parseFloat(line.price || 0);
      const rev = price * qty;
      const source = order.source_name || 'unknown';

      brands[brand].revenue += rev;
      brands[brand].qty += qty;
      orderBrandSet.get(brand)!.add(order.id);

      brands[brand].products.push({
        title: line.title || '',
        sku: line.sku || '',
        variant: line.variant_title || '',
        qty,
        revenue: rev,
        source: channelLabel(source),
      });
    }

    // Compute order counts and aggregate by source/product
    for (const [brand, data] of Object.entries(brands)) {
      data.orderCount = orderBrandSet.get(brand)?.size || 0;

      // By source
      const srcMap: Record<string, { revenue: number; qty: number }> = {};
      for (const p of data.products) {
        if (!srcMap[p.source]) srcMap[p.source] = { revenue: 0, qty: 0 };
        srcMap[p.source].revenue += p.revenue;
        srcMap[p.source].qty += p.qty;
      }
      data.bySource = Object.entries(srcMap)
        .map(([name, d]) => ({ name, ...d }))
        .sort((a, b) => b.revenue - a.revenue);

      // By product (aggregate by title)
      const prodMap: Record<string, { qty: number; revenue: number }> = {};
      for (const p of data.products) {
        const key = p.title;
        if (!prodMap[key]) prodMap[key] = { qty: 0, revenue: 0 };
        prodMap[key].qty += p.qty;
        prodMap[key].revenue += p.revenue;
      }
      data.byProduct = Object.entries(prodMap)
        .map(([title, d]) => ({ title, ...d }))
        .sort((a, b) => b.revenue - a.revenue);
    }

    return Object.values(brands).sort((a, b) => b.revenue - a.revenue);
  }, [orderLines, orders]);

  const selectedData = brandData.find(b => b.brand === selectedBrand);
  const totalRevenue = brandData.reduce((s, b) => s + b.revenue, 0);

  return (
    <>
      <Card className="border-border/40" data-testid="card-brand-ranking">
        <CardHeader className="pb-2 pt-4 px-4">
          <CardTitle className="text-sm font-medium">
            <div className="flex items-center gap-2">
              <Trophy className="h-4 w-4 text-amber-400" />
              品牌銷售排名
              <span className="text-xs font-normal text-muted-foreground">Brand Sales Ranking (MTD)</span>
            </div>
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4">
          {loading ? <Skeleton className="h-[300px] w-full" /> : brandData.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">數據不足</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs" data-testid="table-brand-ranking">
                <thead>
                  <tr className="border-b border-border/50 text-muted-foreground">
                    <th className="py-2 text-left font-medium w-8">#</th>
                    <th className="py-2 text-left font-medium">品牌 Brand</th>
                    <th className="py-2 text-right font-medium">銷售額 Revenue</th>
                    <th className="py-2 text-right font-medium">佔比 %</th>
                    <th className="py-2 text-right font-medium">件數 Qty</th>
                    <th className="py-2 text-right font-medium">訂單 Orders</th>
                    <th className="py-2 text-right font-medium">均價 AOV</th>
                    <th className="py-2 text-center font-medium">詳情</th>
                  </tr>
                </thead>
                <tbody>
                  {brandData.map((b, i) => {
                    const pct = totalRevenue > 0 ? (b.revenue / totalRevenue) * 100 : 0;
                    const aov = b.qty > 0 ? b.revenue / b.qty : 0;
                    return (
                      <tr
                        key={b.brand}
                        className="border-b border-border/20 hover:bg-accent/30 transition-colors cursor-pointer"
                        onClick={() => setSelectedBrand(b.brand)}
                        data-testid={`row-brand-${b.brand.toLowerCase().replace(/\s+/g, '-')}`}
                      >
                        <td className="py-2 tabular-nums">
                          {i < 3 ? (
                            <span className={`inline-flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-bold ${
                              i === 0 ? 'bg-amber-500/20 text-amber-400' :
                              i === 1 ? 'bg-slate-400/20 text-slate-300' :
                              'bg-orange-700/20 text-orange-400'
                            }`}>{i + 1}</span>
                          ) : (
                            <span className="text-muted-foreground pl-1.5">{i + 1}</span>
                          )}
                        </td>
                        <td className="py-2 font-medium">{b.brand}</td>
                        <td className="py-2 text-right tabular-nums">{formatCurrency(b.revenue)}</td>
                        <td className="py-2 text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            <div className="w-12 bg-muted/40 rounded-full h-1.5 overflow-hidden">
                              <div className="h-1.5 rounded-full bg-amber-500" style={{ width: `${Math.min(100, pct)}%` }} />
                            </div>
                            <span className="tabular-nums text-muted-foreground">{pct.toFixed(1)}%</span>
                          </div>
                        </td>
                        <td className="py-2 text-right tabular-nums">{formatNumber(b.qty)}</td>
                        <td className="py-2 text-right tabular-nums">{b.orderCount}</td>
                        <td className="py-2 text-right tabular-nums">{formatCurrency(aov)}</td>
                        <td className="py-2 text-center">
                          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground mx-auto" />
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

      {/* Brand Detail Dialog */}
      <Dialog open={!!selectedBrand} onOpenChange={(open) => { if (!open) setSelectedBrand(null); }}>
        <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Trophy className="h-4 w-4 text-amber-400" />
              {selectedBrand} 銷售詳情
            </DialogTitle>
          </DialogHeader>
          {selectedData && (
            <div className="space-y-4">
              {/* KPI Row */}
              <div className="grid grid-cols-4 gap-3">
                <div className="bg-accent/30 rounded-lg p-3 text-center">
                  <p className="text-[10px] text-muted-foreground uppercase">銷售額</p>
                  <p className="text-lg font-semibold tabular-nums">{formatCurrency(selectedData.revenue)}</p>
                </div>
                <div className="bg-accent/30 rounded-lg p-3 text-center">
                  <p className="text-[10px] text-muted-foreground uppercase">件數</p>
                  <p className="text-lg font-semibold tabular-nums">{selectedData.qty}</p>
                </div>
                <div className="bg-accent/30 rounded-lg p-3 text-center">
                  <p className="text-[10px] text-muted-foreground uppercase">訂單數</p>
                  <p className="text-lg font-semibold tabular-nums">{selectedData.orderCount}</p>
                </div>
                <div className="bg-accent/30 rounded-lg p-3 text-center">
                  <p className="text-[10px] text-muted-foreground uppercase">均價</p>
                  <p className="text-lg font-semibold tabular-nums">{formatCurrency(selectedData.qty > 0 ? selectedData.revenue / selectedData.qty : 0)}</p>
                </div>
              </div>

              {/* Channel Distribution */}
              <div>
                <h4 className="text-xs font-medium mb-2 text-muted-foreground">渠道分佈 Channel Distribution</h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div className="h-[180px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie data={selectedData.bySource} cx="50%" cy="50%" innerRadius={40} outerRadius={65} dataKey="revenue" nameKey="name" paddingAngle={2}>
                          {selectedData.bySource.map((_, i) => <Cell key={i} fill={CHART_PALETTE[i % CHART_PALETTE.length]} />)}
                        </Pie>
                        <Tooltip {...TOOLTIP_STYLE} formatter={(v: number) => formatCurrency(v)} />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="space-y-1.5">
                    {selectedData.bySource.map((s, i) => (
                      <div key={s.name} className="flex items-center justify-between text-xs">
                        <div className="flex items-center gap-2">
                          <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: CHART_PALETTE[i % CHART_PALETTE.length] }} />
                          <span>{s.name}</span>
                        </div>
                        <div className="flex gap-3 tabular-nums text-muted-foreground">
                          <span>{formatCurrency(s.revenue)}</span>
                          <span>{s.qty}件</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* Product Breakdown */}
              <div>
                <h4 className="text-xs font-medium mb-2 text-muted-foreground">產品/型號明細 Product Breakdown (Top 20)</h4>
                <div className="overflow-x-auto max-h-[300px] overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-background z-10">
                      <tr className="border-b border-border/50 text-muted-foreground">
                        <th className="py-1.5 text-left font-medium">產品 Product</th>
                        <th className="py-1.5 text-right font-medium">件數 Qty</th>
                        <th className="py-1.5 text-right font-medium">銷售額 Revenue</th>
                        <th className="py-1.5 text-right font-medium">佔品牌 %</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selectedData.byProduct.slice(0, 20).map((p, i) => (
                        <tr key={i} className="border-b border-border/20 hover:bg-accent/30">
                          <td className="py-1.5 max-w-[280px] truncate">{p.title}</td>
                          <td className="py-1.5 text-right tabular-nums">{p.qty}</td>
                          <td className="py-1.5 text-right tabular-nums">{formatCurrency(p.revenue)}</td>
                          <td className="py-1.5 text-right tabular-nums text-muted-foreground">
                            {selectedData.revenue > 0 ? ((p.revenue / selectedData.revenue) * 100).toFixed(1) : 0}%
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
