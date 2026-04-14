import { useState, useMemo } from 'react';
import { formatCurrency, formatNumber } from '@/lib/format';
import { CHART_COLORS } from '@/lib/chart-theme';
import {
  Tag, ChevronDown, ShoppingCart, Package, DollarSign, ExternalLink,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';

// ── Types ──────────────────────────────────────────────────────
interface PromoCode {
  code: string;
  type: string;         // percentage | fixed_amount
  totalDiscount: number;
  orderCount: number;
  totalRevenue: number;
  totalItems: number;
  orders: {
    orderNumber: number;
    createdAt: string;
    totalPrice: number;
    discountAmount: number;
    customerName: string;
    items: { title: string; qty: number; price: number }[];
  }[];
}

// Marsello loyalty pattern
const MARSELLO_PATTERN = /^[A-Z]\d{7}$/;

interface Props {
  allOrders: any[];
  allOrderLines: any[];
  dateStr: string; // e.g. '2026-04-13'
  dateLabel: string; // e.g. '昨日'
  loading: boolean;
}

function toHKDateStr(isoStr: string): string {
  const d = new Date(isoStr);
  return new Date(d.getTime() + (d.getTimezoneOffset() + 480) * 60000).toISOString().slice(0, 10);
}

export function PromoPerformance({ allOrders, allOrderLines, dateStr, dateLabel, loading }: Props) {
  const [selectedCode, setSelectedCode] = useState<string | null>(null);

  const promoData = useMemo(() => {
    if (!allOrders.length) return [];

    // Filter orders for the target date
    const dayOrders = allOrders.filter((o: any) => {
      if (o.financial_status === 'refunded' || o.cancelled_at) return false;
      return toHKDateStr(o.created_at) === dateStr;
    });

    // Build order lines lookup
    const linesByOrder = new Map<number, any[]>();
    for (const line of allOrderLines) {
      if (!linesByOrder.has(line.order_id)) linesByOrder.set(line.order_id, []);
      linesByOrder.get(line.order_id)!.push(line);
    }

    // Aggregate by promo code
    const promos: Record<string, PromoCode> = {};

    for (const order of dayOrders) {
      const codes = order.discount_codes;
      if (!codes || !Array.isArray(codes) || codes.length === 0) continue;

      for (const dc of codes) {
        const code = dc.code || '';
        if (!code) continue;
        // Skip Marsello loyalty codes
        if (MARSELLO_PATTERN.test(code)) continue;

        if (!promos[code]) {
          promos[code] = {
            code,
            type: dc.type || 'unknown',
            totalDiscount: 0,
            orderCount: 0,
            totalRevenue: 0,
            totalItems: 0,
            orders: [],
          };
        }

        const discAmt = parseFloat(dc.amount || 0);
        const orderTotal = parseFloat(order.total_price || 0);
        const lines = linesByOrder.get(order.id) || [];
        const itemCount = lines.reduce((s: number, l: any) => s + (l.quantity || 0), 0);

        promos[code].totalDiscount += discAmt;
        promos[code].orderCount += 1;
        promos[code].totalRevenue += orderTotal;
        promos[code].totalItems += itemCount;

        promos[code].orders.push({
          orderNumber: order.order_number,
          createdAt: order.created_at,
          totalPrice: orderTotal,
          discountAmount: discAmt,
          customerName: order.customer_name || '—',
          items: lines.map((l: any) => ({
            title: l.title || '',
            qty: l.quantity || 0,
            price: parseFloat(l.price || 0),
          })),
        });
      }
    }

    return Object.values(promos).sort((a, b) => b.totalRevenue - a.totalRevenue);
  }, [allOrders, allOrderLines, dateStr]);

  const selectedPromo = promoData.find(p => p.code === selectedCode);
  const totalPromoRevenue = promoData.reduce((s, p) => s + p.totalRevenue, 0);
  const totalPromoDiscount = promoData.reduce((s, p) => s + p.totalDiscount, 0);
  const totalPromoOrders = promoData.reduce((s, p) => s + p.orderCount, 0);

  function typeLabel(type: string): string {
    if (type === 'percentage') return '百分比折扣';
    if (type === 'fixed_amount') return '定額折扣';
    return type;
  }

  return (
    <>
      <Card className="border-border/40" data-testid="card-promo-performance">
        <CardHeader className="pb-2 pt-4 px-4">
          <CardTitle className="text-sm font-medium">
            <div className="flex items-center gap-2">
              <Tag className="h-4 w-4 text-violet-400" />
              Promotion Code 銷售表現
              <span className="text-xs font-normal text-muted-foreground">{dateLabel} Promo Code Performance</span>
            </div>
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4">
          {loading ? <Skeleton className="h-[200px] w-full" /> : promoData.length === 0 ? (
            <div className="text-center py-8">
              <Tag className="h-6 w-6 text-muted-foreground/30 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">{dateLabel}無使用 Promotion Code 的訂單</p>
              <p className="text-[10px] text-muted-foreground/60 mt-1">Marsello 忠誠積分碼已排除</p>
            </div>
          ) : (
            <>
              {/* Summary Row */}
              <div className="grid grid-cols-3 gap-3 mb-3">
                <div className="bg-violet-500/10 rounded-lg p-2.5 text-center">
                  <p className="text-[10px] text-muted-foreground">促銷訂單</p>
                  <p className="text-base font-semibold tabular-nums">{totalPromoOrders}</p>
                </div>
                <div className="bg-violet-500/10 rounded-lg p-2.5 text-center">
                  <p className="text-[10px] text-muted-foreground">促銷營收</p>
                  <p className="text-base font-semibold tabular-nums">{formatCurrency(totalPromoRevenue)}</p>
                </div>
                <div className="bg-violet-500/10 rounded-lg p-2.5 text-center">
                  <p className="text-[10px] text-muted-foreground">折扣總額</p>
                  <p className="text-base font-semibold tabular-nums text-red-400">-{formatCurrency(totalPromoDiscount)}</p>
                </div>
              </div>

              {/* Promo Code Table */}
              <div className="overflow-x-auto">
                <table className="w-full text-xs" data-testid="table-promo-codes">
                  <thead>
                    <tr className="border-b border-border/50 text-muted-foreground">
                      <th className="py-2 text-left font-medium">Promotion Code</th>
                      <th className="py-2 text-left font-medium">類型 Type</th>
                      <th className="py-2 text-right font-medium">訂單數 Orders</th>
                      <th className="py-2 text-right font-medium">件數 Items</th>
                      <th className="py-2 text-right font-medium">銷售額 Revenue</th>
                      <th className="py-2 text-right font-medium">折扣額 Discount</th>
                      <th className="py-2 text-center font-medium">詳情</th>
                    </tr>
                  </thead>
                  <tbody>
                    {promoData.map((p) => (
                      <tr
                        key={p.code}
                        className="border-b border-border/20 hover:bg-accent/30 transition-colors cursor-pointer"
                        onClick={() => setSelectedCode(p.code)}
                        data-testid={`row-promo-${p.code.toLowerCase()}`}
                      >
                        <td className="py-2">
                          <Badge variant="outline" className="text-[11px] font-mono px-1.5 py-0">{p.code}</Badge>
                        </td>
                        <td className="py-2 text-muted-foreground">{typeLabel(p.type)}</td>
                        <td className="py-2 text-right tabular-nums">{p.orderCount}</td>
                        <td className="py-2 text-right tabular-nums">{p.totalItems}</td>
                        <td className="py-2 text-right tabular-nums font-medium">{formatCurrency(p.totalRevenue)}</td>
                        <td className="py-2 text-right tabular-nums text-red-400">-{formatCurrency(p.totalDiscount)}</td>
                        <td className="py-2 text-center">
                          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground mx-auto" />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-[10px] text-muted-foreground/60 mt-2">* Marsello 忠誠積分碼（格式: A1234567）已排除</p>
            </>
          )}
        </CardContent>
      </Card>

      {/* Promo Detail Dialog */}
      <Dialog open={!!selectedCode} onOpenChange={(open) => { if (!open) setSelectedCode(null); }}>
        <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Tag className="h-4 w-4 text-violet-400" />
              <Badge variant="outline" className="text-sm font-mono px-2">{selectedCode}</Badge>
              銷售詳情
            </DialogTitle>
          </DialogHeader>
          {selectedPromo && (
            <div className="space-y-4">
              {/* KPI Row */}
              <div className="grid grid-cols-4 gap-3">
                <div className="bg-accent/30 rounded-lg p-3 text-center">
                  <p className="text-[10px] text-muted-foreground uppercase">訂單數</p>
                  <p className="text-lg font-semibold tabular-nums">{selectedPromo.orderCount}</p>
                </div>
                <div className="bg-accent/30 rounded-lg p-3 text-center">
                  <p className="text-[10px] text-muted-foreground uppercase">件數</p>
                  <p className="text-lg font-semibold tabular-nums">{selectedPromo.totalItems}</p>
                </div>
                <div className="bg-accent/30 rounded-lg p-3 text-center">
                  <p className="text-[10px] text-muted-foreground uppercase">銷售額</p>
                  <p className="text-lg font-semibold tabular-nums">{formatCurrency(selectedPromo.totalRevenue)}</p>
                </div>
                <div className="bg-accent/30 rounded-lg p-3 text-center">
                  <p className="text-[10px] text-muted-foreground uppercase">折扣額</p>
                  <p className="text-lg font-semibold tabular-nums text-red-400">-{formatCurrency(selectedPromo.totalDiscount)}</p>
                </div>
              </div>

              <div className="text-xs text-muted-foreground">
                折扣類型: {typeLabel(selectedPromo.type)}
              </div>

              {/* Orders */}
              {selectedPromo.orders.map((order, oi) => (
                <div key={oi} className="bg-accent/20 rounded-lg p-3">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <ShoppingCart className="h-3.5 w-3.5 text-muted-foreground" />
                      <span className="text-xs font-medium">訂單 #{order.orderNumber}</span>
                      <span className="text-[10px] text-muted-foreground">{order.customerName}</span>
                    </div>
                    <div className="flex items-center gap-3 text-xs">
                      <span className="tabular-nums font-medium">{formatCurrency(order.totalPrice)}</span>
                      <span className="text-red-400 tabular-nums text-[10px]">折扣 -{formatCurrency(order.discountAmount)}</span>
                    </div>
                  </div>
                  <table className="w-full text-[11px]">
                    <thead>
                      <tr className="border-b border-border/30 text-muted-foreground">
                        <th className="py-1 text-left font-medium">商品 Item</th>
                        <th className="py-1 text-right font-medium">件數</th>
                        <th className="py-1 text-right font-medium">單價</th>
                        <th className="py-1 text-right font-medium">小計</th>
                      </tr>
                    </thead>
                    <tbody>
                      {order.items.map((item, ii) => (
                        <tr key={ii} className="border-b border-border/10">
                          <td className="py-1 max-w-[250px] truncate">{item.title}</td>
                          <td className="py-1 text-right tabular-nums">{item.qty}</td>
                          <td className="py-1 text-right tabular-nums">{formatCurrency(item.price)}</td>
                          <td className="py-1 text-right tabular-nums">{formatCurrency(item.price * item.qty)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
