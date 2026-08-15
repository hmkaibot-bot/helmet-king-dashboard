import { useState, useMemo } from 'react';
import { formatCurrency, formatNumber } from '@/lib/format';
import {
  Tag, ChevronDown, ShoppingCart, CalendarDays, Clock, TrendingUp,
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

interface LifetimePromo extends PromoCode {
  firstUsed: string;   // yyyy-MM-dd
  lastUsed: string;    // yyyy-MM-dd
  recent30Orders: number;
  recent30Revenue: number;
  recent30Discount: number;
}

// Marsello loyalty pattern: e.g. A1234567
const MARSELLO_LOYALTY = /^[A-Z]\d{7}$/;
// Marsello reward codes contain parenthesized IDs like (K3651891)
const MARSELLO_REWARD = /\([A-Z0-9]+\)/;

function isMarselloCode(code: string): boolean {
  return MARSELLO_LOYALTY.test(code) || MARSELLO_REWARD.test(code);
}

// ── Helpers ────────────────────────────────────────────────────
function parseDiscountCodes(raw: any): any[] {
  if (!raw) return [];
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }
  return Array.isArray(raw) ? raw : [];
}

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

type Tab = 'yesterday' | 'thirty_days';

export function PromoPerformance({ allOrders, allOrderLines, dateStr, dateLabel, loading }: Props) {
  const [tab, setTab] = useState<Tab>('yesterday');
  const [selectedCode, setSelectedCode] = useState<string | null>(null);
  const [selectedTab, setSelectedTab] = useState<Tab>('yesterday'); // track which tab opened the dialog

  // ── Build order lines lookup (shared) ───────────────────────
  const linesByOrder = useMemo(() => {
    const m = new Map<number, any[]>();
    for (const line of allOrderLines) {
      if (!m.has(line.order_id)) m.set(line.order_id, []);
      m.get(line.order_id)!.push(line);
    }
    return m;
  }, [allOrderLines]);

  // ── Helper to build promo aggregations ─────────────────────
  function buildPromoMap(orders: any[]): Record<string, PromoCode> {
    const promos: Record<string, PromoCode> = {};
    for (const order of orders) {
      const codes = parseDiscountCodes(order.discount_codes);
      if (codes.length === 0) continue;

      for (const dc of codes) {
        const code = dc.code || '';
        if (!code) continue;
        if (isMarselloCode(code)) continue;

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
    return promos;
  }

  // ── Yesterday promo data ──────────────────────────────────
  const yesterdayPromoData = useMemo(() => {
    if (!allOrders.length) return [];
    const dayOrders = allOrders.filter((o: any) => {
      if (o.financial_status === 'refunded' || o.cancelled_at) return false;
      return toHKDateStr(o.created_at) === dateStr;
    });
    const promos = buildPromoMap(dayOrders);
    return Object.values(promos).sort((a, b) => b.totalRevenue - a.totalRevenue);
  }, [allOrders, allOrderLines, dateStr, linesByOrder]);

  // ── 30-day promo codes + lifetime stats ────────────────────
  const thirtyDayPromoData = useMemo<LifetimePromo[]>(() => {
    if (!allOrders.length) return [];

    // Compute 30-day boundary
    const hkt = new Date();
    const hktNow = new Date(hkt.getTime() + (hkt.getTimezoneOffset() + 480) * 60000);
    const thirtyAgo = new Date(hktNow);
    thirtyAgo.setDate(hktNow.getDate() - 30);
    const thirtyStr = thirtyAgo.toISOString().slice(0, 10);

    // Identify all codes used in last 30 days
    const recent30Codes = new Set<string>();
    const validOrders = allOrders.filter((o: any) => o.financial_status !== 'refunded' && !o.cancelled_at);
    
    for (const o of validOrders) {
      const hkDate = toHKDateStr(o.created_at);
      if (hkDate < thirtyStr) continue;
      const codes = parseDiscountCodes(o.discount_codes);
      for (const dc of codes) {
        const code = dc.code || '';
        if (code && !isMarselloCode(code)) {
          recent30Codes.add(code);
        }
      }
    }

    if (recent30Codes.size === 0) return [];

    // For each code found in last 30 days, compute LIFETIME stats
    const lifetimeMap: Record<string, LifetimePromo> = {};

    for (const o of validOrders) {
      const codes = parseDiscountCodes(o.discount_codes);
      if (codes.length === 0) continue;
      const hkDate = toHKDateStr(o.created_at);

      for (const dc of codes) {
        const code = dc.code || '';
        if (!code || !recent30Codes.has(code)) continue;
        if (isMarselloCode(code)) continue;

        if (!lifetimeMap[code]) {
          lifetimeMap[code] = {
            code,
            type: dc.type || 'unknown',
            totalDiscount: 0,
            orderCount: 0,
            totalRevenue: 0,
            totalItems: 0,
            orders: [],
            firstUsed: hkDate,
            lastUsed: hkDate,
            recent30Orders: 0,
            recent30Revenue: 0,
            recent30Discount: 0,
          };
        }

        const discAmt = parseFloat(dc.amount || 0);
        const orderTotal = parseFloat(o.total_price || 0);
        const lines = linesByOrder.get(o.id) || [];
        const itemCount = lines.reduce((s: number, l: any) => s + (l.quantity || 0), 0);

        lifetimeMap[code].totalDiscount += discAmt;
        lifetimeMap[code].orderCount += 1;
        lifetimeMap[code].totalRevenue += orderTotal;
        lifetimeMap[code].totalItems += itemCount;

        if (hkDate < lifetimeMap[code].firstUsed) lifetimeMap[code].firstUsed = hkDate;
        if (hkDate > lifetimeMap[code].lastUsed) lifetimeMap[code].lastUsed = hkDate;

        if (hkDate >= thirtyStr) {
          lifetimeMap[code].recent30Orders += 1;
          lifetimeMap[code].recent30Revenue += orderTotal;
          lifetimeMap[code].recent30Discount += discAmt;
        }

        lifetimeMap[code].orders.push({
          orderNumber: o.order_number,
          createdAt: o.created_at,
          totalPrice: orderTotal,
          discountAmount: discAmt,
          customerName: o.customer_name || '—',
          items: lines.map((l: any) => ({
            title: l.title || '',
            qty: l.quantity || 0,
            price: parseFloat(l.price || 0),
          })),
        });
      }
    }

    // Sort orders within each code by date desc
    Object.values(lifetimeMap).forEach(p => {
      p.orders.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    });

    return Object.values(lifetimeMap).sort((a, b) => b.recent30Revenue - a.recent30Revenue);
  }, [allOrders, allOrderLines, linesByOrder]);

  // ── Current promo data based on tab ────────────────────────
  const currentPromoData = tab === 'yesterday' ? yesterdayPromoData : thirtyDayPromoData;
  const totalPromoRevenue = tab === 'yesterday'
    ? yesterdayPromoData.reduce((s, p) => s + p.totalRevenue, 0)
    : thirtyDayPromoData.reduce((s, p) => s + p.recent30Revenue, 0);
  const totalPromoDiscount = tab === 'yesterday'
    ? yesterdayPromoData.reduce((s, p) => s + p.totalDiscount, 0)
    : thirtyDayPromoData.reduce((s, p) => s + p.recent30Discount, 0);
  const totalPromoOrders = tab === 'yesterday'
    ? yesterdayPromoData.reduce((s, p) => s + p.orderCount, 0)
    : thirtyDayPromoData.reduce((s, p) => s + p.recent30Orders, 0);

  // ── Dialog selected promo ──────────────────────────────────
  const selectedPromo = selectedTab === 'yesterday'
    ? yesterdayPromoData.find(p => p.code === selectedCode)
    : thirtyDayPromoData.find(p => p.code === selectedCode);
  const selectedLifetime = selectedTab === 'thirty_days'
    ? thirtyDayPromoData.find(p => p.code === selectedCode)
    : null;

  function typeLabel(type: string): string {
    if (type === 'percentage') return '百分比折扣';
    if (type === 'fixed_amount') return '定額折扣';
    return type;
  }

  function formatDate(d: string): string {
    return d.replace(/-/g, '/');
  }

  function openDetail(code: string) {
    setSelectedCode(code);
    setSelectedTab(tab);
  }

  return (
    <>
      <Card className="border-border/40" data-testid="card-promo-performance">
        <CardHeader className="pb-2 pt-4 px-4">
          <CardTitle className="text-sm font-medium">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Tag className="h-4 w-4 text-violet-400" />
                Promotion Code 銷售表現
              </div>
              {/* Tab Toggle */}
              <div className="flex gap-1 bg-accent/30 rounded-md p-0.5">
                <button
                  className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${tab === 'yesterday' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                  onClick={() => setTab('yesterday')}
                  data-testid="tab-promo-yesterday"
                >
                  {dateLabel}
                </button>
                <button
                  className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${tab === 'thirty_days' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                  onClick={() => setTab('thirty_days')}
                  data-testid="tab-promo-30days"
                >
                  30日
                </button>
              </div>
            </div>
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4">
          {loading ? <Skeleton className="h-[200px] w-full" /> : currentPromoData.length === 0 ? (
            <div className="text-center py-8">
              <Tag className="h-6 w-6 text-muted-foreground/30 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">
                {tab === 'yesterday' ? `${dateLabel}無使用 Promotion Code 的訂單` : '近30日無使用 Promotion Code 的訂單'}
              </p>
              <p className="text-[11px] text-muted-foreground/60 mt-1">Marsello 忠誠積分碼及獎勵碼已排除</p>
            </div>
          ) : (
            <>
              {/* Summary Row */}
              <div className="grid grid-cols-3 gap-3 mb-3">
                <div className="bg-violet-500/10 rounded-lg p-2.5 text-center">
                  <p className="text-[11px] text-muted-foreground">
                    {tab === 'yesterday' ? '促銷訂單' : '30日促銷訂單'}
                  </p>
                  <p className="text-base font-semibold tabular-nums">{totalPromoOrders}</p>
                </div>
                <div className="bg-violet-500/10 rounded-lg p-2.5 text-center">
                  <p className="text-[11px] text-muted-foreground">
                    {tab === 'yesterday' ? '促銷營收' : '30日促銷營收'}
                  </p>
                  <p className="text-base font-semibold tabular-nums">{formatCurrency(totalPromoRevenue)}</p>
                </div>
                <div className="bg-violet-500/10 rounded-lg p-2.5 text-center">
                  <p className="text-[11px] text-muted-foreground">
                    {tab === 'yesterday' ? '折扣總額' : '30日折扣總額'}
                  </p>
                  <p className="text-base font-semibold tabular-nums text-red-400">-{formatCurrency(totalPromoDiscount)}</p>
                </div>
              </div>

              {/* ── Yesterday Table ──────────────────────────────── */}
              {tab === 'yesterday' && (
                <>
                  <div className="overflow-x-auto">
                    <table className="w-full text-[13px]" data-testid="table-promo-codes-yesterday">
                      <thead>
                        <tr className="border-b border-border/50 text-muted-foreground">
                          <th className="py-2.5 text-left font-medium">Promotion Code</th>
                          <th className="py-2.5 text-left font-medium">類型 Type</th>
                          <th className="py-2.5 text-right font-medium">訂單數</th>
                          <th className="py-2.5 text-right font-medium">件數</th>
                          <th className="py-2.5 text-right font-medium">銷售額</th>
                          <th className="py-2.5 text-right font-medium">折扣額</th>
                          <th className="py-2.5 text-center font-medium">詳情</th>
                        </tr>
                      </thead>
                      <tbody>
                        {yesterdayPromoData.map((p) => (
                          <tr
                            key={p.code}
                            className="border-b border-border/20 hover:bg-accent/30 transition-colors cursor-pointer"
                            onClick={() => openDetail(p.code)}
                            data-testid={`row-promo-y-${p.code.toLowerCase()}`}
                          >
                            <td className="py-2.5">
                              <Badge variant="outline" className="text-xs font-mono px-1.5 py-0">{p.code}</Badge>
                            </td>
                            <td className="py-2.5 text-muted-foreground">{typeLabel(p.type)}</td>
                            <td className="py-2.5 text-right tabular-nums">{p.orderCount}</td>
                            <td className="py-2.5 text-right tabular-nums">{p.totalItems}</td>
                            <td className="py-2.5 text-right tabular-nums font-medium">{formatCurrency(p.totalRevenue)}</td>
                            <td className="py-2.5 text-right tabular-nums text-red-400">-{formatCurrency(p.totalDiscount)}</td>
                            <td className="py-2.5 text-center">
                              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground mx-auto" />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}

              {/* ── 30-Day Table ─────────────────────────────────── */}
              {tab === 'thirty_days' && (
                <>
                  <div className="overflow-x-auto">
                    <table className="w-full text-[13px]" data-testid="table-promo-codes-30days">
                      <thead>
                        <tr className="border-b border-border/50 text-muted-foreground">
                          <th className="py-2.5 text-left font-medium">Promotion Code</th>
                          <th className="py-2.5 text-left font-medium">類型</th>
                          <th className="py-2.5 text-right font-medium">30日訂單</th>
                          <th className="py-2.5 text-right font-medium">30日營收</th>
                          <th className="py-2.5 text-right font-medium">30日折扣</th>
                          <th className="py-2.5 text-right font-medium">生命周期訂單</th>
                          <th className="py-2.5 text-right font-medium">生命周期營收</th>
                          <th className="py-2.5 text-left font-medium">使用期間</th>
                          <th className="py-2.5 text-center font-medium">詳情</th>
                        </tr>
                      </thead>
                      <tbody>
                        {thirtyDayPromoData.map((p) => (
                          <tr
                            key={p.code}
                            className="border-b border-border/20 hover:bg-accent/30 transition-colors cursor-pointer"
                            onClick={() => openDetail(p.code)}
                            data-testid={`row-promo-30d-${p.code.toLowerCase()}`}
                          >
                            <td className="py-2.5">
                              <Badge variant="outline" className="text-xs font-mono px-1.5 py-0">{p.code}</Badge>
                            </td>
                            <td className="py-2.5 text-muted-foreground">{typeLabel(p.type)}</td>
                            <td className="py-2.5 text-right tabular-nums">{p.recent30Orders}</td>
                            <td className="py-2.5 text-right tabular-nums font-medium">{formatCurrency(p.recent30Revenue)}</td>
                            <td className="py-2.5 text-right tabular-nums text-red-400">-{formatCurrency(p.recent30Discount)}</td>
                            <td className="py-2.5 text-right tabular-nums">{p.orderCount}</td>
                            <td className="py-2.5 text-right tabular-nums font-medium">{formatCurrency(p.totalRevenue)}</td>
                            <td className="py-2.5 text-[11px] text-muted-foreground whitespace-nowrap">
                              {formatDate(p.firstUsed)} ~ {formatDate(p.lastUsed)}
                            </td>
                            <td className="py-2.5 text-center">
                              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground mx-auto" />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}

              <p className="text-[11px] text-muted-foreground/60 mt-2">* Marsello 忠誠積分碼（格式: A1234567）及獎勵碼已排除</p>
            </>
          )}
        </CardContent>
      </Card>

      {/* ── Detail Dialog ────────────────────────────────────── */}
      <Dialog open={!!selectedCode} onOpenChange={(open) => { if (!open) setSelectedCode(null); }}>
        <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Tag className="h-4 w-4 text-violet-400" />
              <Badge variant="outline" className="text-sm font-mono px-2">{selectedCode}</Badge>
              {selectedTab === 'yesterday' ? `${dateLabel}銷售詳情` : '生命周期銷售詳情'}
            </DialogTitle>
          </DialogHeader>
          {selectedPromo && (
            <div className="space-y-4">
              {/* ── Lifetime KPI (only for 30-day tab) ────────── */}
              {selectedLifetime && (
                <div className="space-y-2">
                  <h4 className="text-[13px] font-medium text-muted-foreground flex items-center gap-1.5">
                    <TrendingUp className="h-3.5 w-3.5" /> 生命周期表現 Lifetime Performance
                  </h4>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    <div className="bg-violet-500/10 rounded-lg p-2.5 text-center">
                      <p className="text-[11px] text-muted-foreground">總訂單</p>
                      <p className="text-lg font-semibold tabular-nums">{selectedLifetime.orderCount}</p>
                    </div>
                    <div className="bg-violet-500/10 rounded-lg p-2.5 text-center">
                      <p className="text-[11px] text-muted-foreground">總營收</p>
                      <p className="text-lg font-semibold tabular-nums">{formatCurrency(selectedLifetime.totalRevenue)}</p>
                    </div>
                    <div className="bg-violet-500/10 rounded-lg p-2.5 text-center">
                      <p className="text-[11px] text-muted-foreground">總折扣</p>
                      <p className="text-lg font-semibold tabular-nums text-red-400">-{formatCurrency(selectedLifetime.totalDiscount)}</p>
                    </div>
                    <div className="bg-violet-500/10 rounded-lg p-2.5 text-center">
                      <p className="text-[11px] text-muted-foreground">使用期間</p>
                      <p className="text-[13px] font-medium tabular-nums mt-1">
                        {formatDate(selectedLifetime.firstUsed)}
                        <br />~ {formatDate(selectedLifetime.lastUsed)}
                      </p>
                    </div>
                  </div>

                  {/* 30-day vs lifetime comparison */}
                  <div className="grid grid-cols-3 gap-2">
                    <div className="bg-accent/30 rounded-lg p-2 text-center">
                      <p className="text-[11px] text-muted-foreground">30日訂單</p>
                      <p className="text-base font-semibold tabular-nums">{selectedLifetime.recent30Orders}</p>
                      <p className="text-[11px] text-muted-foreground">
                        佔 {selectedLifetime.orderCount > 0 ? ((selectedLifetime.recent30Orders / selectedLifetime.orderCount) * 100).toFixed(0) : 0}%
                      </p>
                    </div>
                    <div className="bg-accent/30 rounded-lg p-2 text-center">
                      <p className="text-[11px] text-muted-foreground">30日營收</p>
                      <p className="text-base font-semibold tabular-nums">{formatCurrency(selectedLifetime.recent30Revenue)}</p>
                      <p className="text-[11px] text-muted-foreground">
                        佔 {selectedLifetime.totalRevenue > 0 ? ((selectedLifetime.recent30Revenue / selectedLifetime.totalRevenue) * 100).toFixed(0) : 0}%
                      </p>
                    </div>
                    <div className="bg-accent/30 rounded-lg p-2 text-center">
                      <p className="text-[11px] text-muted-foreground">30日折扣</p>
                      <p className="text-base font-semibold tabular-nums text-red-400">-{formatCurrency(selectedLifetime.recent30Discount)}</p>
                      <p className="text-[11px] text-muted-foreground">
                        佔 {selectedLifetime.totalDiscount > 0 ? ((selectedLifetime.recent30Discount / selectedLifetime.totalDiscount) * 100).toFixed(0) : 0}%
                      </p>
                    </div>
                  </div>

                  <div className="border-t border-border/30 pt-2">
                    <p className="text-[11px] text-muted-foreground">
                      折扣類型: {typeLabel(selectedLifetime.type)} · 平均訂單金額: {formatCurrency(selectedLifetime.orderCount > 0 ? selectedLifetime.totalRevenue / selectedLifetime.orderCount : 0)}
                    </p>
                  </div>
                </div>
              )}

              {/* ── Yesterday KPI (only for yesterday tab) ─────── */}
              {selectedTab === 'yesterday' && (
                <>
                  <div className="grid grid-cols-4 gap-3">
                    <div className="bg-accent/30 rounded-lg p-3 text-center">
                      <p className="text-[11px] text-muted-foreground uppercase">訂單數</p>
                      <p className="text-lg font-semibold tabular-nums">{selectedPromo.orderCount}</p>
                    </div>
                    <div className="bg-accent/30 rounded-lg p-3 text-center">
                      <p className="text-[11px] text-muted-foreground uppercase">件數</p>
                      <p className="text-lg font-semibold tabular-nums">{selectedPromo.totalItems}</p>
                    </div>
                    <div className="bg-accent/30 rounded-lg p-3 text-center">
                      <p className="text-[11px] text-muted-foreground uppercase">銷售額</p>
                      <p className="text-lg font-semibold tabular-nums">{formatCurrency(selectedPromo.totalRevenue)}</p>
                    </div>
                    <div className="bg-accent/30 rounded-lg p-3 text-center">
                      <p className="text-[11px] text-muted-foreground uppercase">折扣額</p>
                      <p className="text-lg font-semibold tabular-nums text-red-400">-{formatCurrency(selectedPromo.totalDiscount)}</p>
                    </div>
                  </div>
                  <div className="text-[13px] text-muted-foreground">
                    折扣類型: {typeLabel(selectedPromo.type)}
                  </div>
                </>
              )}

              {/* ── Orders List ───────────────────────────────── */}
              <div>
                <h4 className="text-[13px] font-medium text-muted-foreground mb-2 flex items-center gap-1.5">
                  <ShoppingCart className="h-3.5 w-3.5" />
                  {selectedTab === 'yesterday' ? `${dateLabel}訂單明細` : '全部訂單明細'}
                  <span className="text-[11px]">({selectedPromo.orders.length} 筆)</span>
                </h4>
                <div className="space-y-2 max-h-[400px] overflow-y-auto">
                  {(selectedTab === 'thirty_days' ? selectedPromo.orders.slice(0, 50) : selectedPromo.orders).map((order, oi) => (
                    <div key={oi} className="bg-accent/20 rounded-lg p-3">
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <ShoppingCart className="h-3.5 w-3.5 text-muted-foreground" />
                          <span className="text-[13px] font-medium">訂單 #{order.orderNumber}</span>
                          <span className="text-[11px] text-muted-foreground">{order.customerName}</span>
                        </div>
                        <div className="flex items-center gap-3 text-[13px]">
                          <span className="text-[11px] text-muted-foreground">{toHKDateStr(order.createdAt).replace(/-/g, '/')}</span>
                          <span className="tabular-nums font-medium">{formatCurrency(order.totalPrice)}</span>
                          <span className="text-red-400 tabular-nums text-[11px]">折扣 -{formatCurrency(order.discountAmount)}</span>
                        </div>
                      </div>
                      <table className="w-full text-xs">
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
                  {selectedTab === 'thirty_days' && selectedPromo.orders.length > 50 && (
                    <p className="text-[11px] text-center text-muted-foreground py-2.5">
                      顯示最近 50 筆（共 {selectedPromo.orders.length} 筆）
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
