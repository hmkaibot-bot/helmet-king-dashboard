import { useState, useMemo } from 'react';
import { formatNumber, formatPercent } from '@/lib/format';
import { CHART_COLORS, CHART_PALETTE } from '@/lib/chart-theme';
import {
  ShoppingBag, ArrowRight, Info, ChevronDown,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Tooltip as UITooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from '@/components/ui/tooltip';

// ── Types ──────────────────────────────────────────────────────
interface AssocRule {
  itemA: string;          // antecedent
  itemB: string;          // consequent
  supportAB: number;      // P(A∩B)
  supportA: number;       // P(A)
  supportB: number;       // P(B)
  confidence: number;     // P(B|A) = supportAB / supportA
  lift: number;           // confidence / supportB
  cooccurrences: number;  // raw count
}

interface ProductCategory {
  label: string;
  match: (productType: string, title: string) => boolean;
}

const FOCUS_CATEGORIES: ProductCategory[] = [
  {
    label: '頭盔 Helmet',
    match: (pt, title) => pt?.toUpperCase().startsWith('HELMET') || false,
  },
  {
    label: '手套 Gloves',
    match: (pt, title) => pt?.toUpperCase().includes('GLOVES') || title?.toUpperCase().includes('GLOVE') || false,
  },
  {
    label: '清潔用品 Cleaning',
    match: (pt, title) => {
      const t = (title || '').toUpperCase();
      const p = (pt || '').toUpperCase();
      return t.includes('CLEAN') || t.includes('WASH') || t.includes('WAX') ||
             t.includes('POLISH') || t.includes('SHAMPOO') || t.includes('VISOR') ||
             p.includes('CLEAN') || p.includes('CARE') || false;
    },
  },
];

interface Props {
  orderLines: any[];
  orders: any[];
  loading: boolean;
}

// ── Helpers ────────────────────────────────────────────────────
function getProductKey(line: any): string {
  // Group by product title (removing variant specifics for cleaner grouping)
  return line.title || line.sku || 'Unknown';
}

function getProductCategory(line: any): string {
  return line.product_type || 'Unknown';
}

export function BasketAnalysis({ orderLines, orders, loading }: Props) {
  const [activeTab, setActiveTab] = useState('helmet');

  // Build basket data (products per order)
  const analysisData = useMemo(() => {
    if (!orderLines.length || !orders.length) return null;

    // Valid order IDs
    const validOrders = new Set<number>();
    for (const o of orders) {
      if (o.financial_status !== 'refunded' && !o.cancelled_at) {
        validOrders.add(o.id);
      }
    }

    // Build baskets: orderId -> [{ key, productType, title }]
    const baskets = new Map<number, { key: string; productType: string; title: string }[]>();
    for (const line of orderLines) {
      if (!validOrders.has(line.order_id)) continue;
      const key = getProductKey(line);
      const pt = getProductCategory(line);
      if (!baskets.has(line.order_id)) baskets.set(line.order_id, []);
      // Deduplicate within order (same product)
      const existing = baskets.get(line.order_id)!;
      if (!existing.find(p => p.key === key)) {
        existing.push({ key, productType: pt, title: line.title || '' });
      }
    }

    // Only multi-item baskets (for cross-sell analysis)
    const multiBaskets = [...baskets.values()].filter(b => b.length >= 2);
    const totalOrders = validOrders.size;

    // Compute association rules per focus category
    const results: Record<string, AssocRule[]> = {};

    for (const cat of FOCUS_CATEGORIES) {
      // Item frequencies
      const itemFreq = new Map<string, number>();
      const pairFreq = new Map<string, number>();

      for (const basket of multiBaskets) {
        const catItems = basket.filter(p => cat.match(p.productType, p.title));
        const otherItems = basket.filter(p => !cat.match(p.productType, p.title));

        if (catItems.length === 0 || otherItems.length === 0) continue;

        // Count individual items
        for (const item of basket) {
          itemFreq.set(item.key, (itemFreq.get(item.key) || 0) + 1);
        }

        // Count pairs (catItem -> otherItem)
        for (const a of catItems) {
          for (const b of otherItems) {
            const pairKey = `${a.key}|||${b.key}`;
            pairFreq.set(pairKey, (pairFreq.get(pairKey) || 0) + 1);
          }
        }
      }

      // For this category, we want: when customer buys [category], what else do they buy?
      // Aggregate: for each "other" product, how often is it bought with ANY item in this category
      const otherCooccurrence = new Map<string, number>();
      const catOrderCount = new Map<string, Set<number>>();

      // Recalculate at category level (not item level)
      const catOrderIds = new Set<number>();
      for (const [orderId, basket] of baskets) {
        if (!validOrders.has(orderId)) continue;
        const hasCat = basket.some(p => cat.match(p.productType, p.title));
        if (!hasCat) continue;
        catOrderIds.add(orderId);

        const otherProducts = basket.filter(p => !cat.match(p.productType, p.title));
        for (const p of otherProducts) {
          otherCooccurrence.set(p.key, (otherCooccurrence.get(p.key) || 0) + 1);
        }
      }

      const catSupport = catOrderIds.size / totalOrders; // P(category)

      // Build rules: category -> each other product
      const rules: AssocRule[] = [];
      for (const [product, count] of otherCooccurrence) {
        if (count < 3) continue; // Minimum 3 co-occurrences

        const productOrderCount = [...baskets.values()].filter(b =>
          b.some(p => p.key === product)
        ).length;

        const supportAB = count / totalOrders;
        const supportA = catSupport;
        const supportB = productOrderCount / totalOrders;
        const confidence = catOrderIds.size > 0 ? count / catOrderIds.size : 0;
        const lift = supportB > 0 ? confidence / supportB : 0;

        rules.push({
          itemA: cat.label,
          itemB: product,
          supportAB,
          supportA,
          supportB,
          confidence,
          lift,
          cooccurrences: count,
        });
      }

      // Sort by lift (highest first), then by co-occurrences
      rules.sort((a, b) => b.lift - a.lift || b.cooccurrences - a.cooccurrences);
      results[cat.label] = rules.slice(0, 15); // Top 15
    }

    // Per-product top 5 cross-sells
    const productCrossSell = new Map<string, { product: string; count: number; lift: number }[]>();
    // Get top products per category for the "per-product" view
    for (const cat of FOCUS_CATEGORIES) {
      // Find top items in this category
      const catItemCounts = new Map<string, number>();
      for (const basket of multiBaskets) {
        for (const p of basket) {
          if (cat.match(p.productType, p.title)) {
            catItemCounts.set(p.key, (catItemCounts.get(p.key) || 0) + 1);
          }
        }
      }

      const topCatItems = [...catItemCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([key]) => key);

      for (const catItem of topCatItems) {
        const crossSells = new Map<string, number>();
        let itemOrderCount = 0;

        for (const basket of multiBaskets) {
          if (!basket.some(p => p.key === catItem)) continue;
          itemOrderCount++;
          for (const p of basket) {
            if (p.key !== catItem) {
              crossSells.set(p.key, (crossSells.get(p.key) || 0) + 1);
            }
          }
        }

        const itemSupport = itemOrderCount / totalOrders;
        const top5 = [...crossSells.entries()]
          .filter(([_, count]) => count >= 2)
          .map(([product, count]) => {
            const prodOrders = [...baskets.values()].filter(b => b.some(p => p.key === product)).length;
            const prodSupport = prodOrders / totalOrders;
            const confidence = itemOrderCount > 0 ? count / itemOrderCount : 0;
            const lift = prodSupport > 0 ? confidence / prodSupport : 0;
            return { product, count, lift };
          })
          .sort((a, b) => b.lift - a.lift || b.count - a.count)
          .slice(0, 5);

        productCrossSell.set(catItem, top5);
      }
    }

    return { rules: results, productCrossSell, totalOrders, multiBasketCount: multiBaskets.length };
  }, [orderLines, orders]);

  function LiftBadge({ lift }: { lift: number }) {
    if (lift >= 3) return <Badge className="text-[10px] px-1.5 py-0 bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/20">強關聯 {lift.toFixed(1)}x</Badge>;
    if (lift >= 1.5) return <Badge className="text-[10px] px-1.5 py-0 bg-amber-500/20 text-amber-400 hover:bg-amber-500/20">中關聯 {lift.toFixed(1)}x</Badge>;
    if (lift >= 1.0) return <Badge variant="outline" className="text-[10px] px-1.5 py-0 text-muted-foreground">弱 {lift.toFixed(1)}x</Badge>;
    return <Badge variant="outline" className="text-[10px] px-1.5 py-0 text-muted-foreground/50">無 {lift.toFixed(1)}x</Badge>;
  }

  const tabKeys = FOCUS_CATEGORIES.map((c, i) => ['helmet', 'gloves', 'cleaning'][i]);

  return (
    <Card className="border-border/40" data-testid="card-basket-analysis">
      <CardHeader className="pb-2 pt-4 px-4">
        <CardTitle className="text-sm font-medium">
          <div className="flex items-center gap-2">
            <ShoppingBag className="h-4 w-4 text-blue-400" />
            搭單分析
            <span className="text-xs font-normal text-muted-foreground">Cross-Sell / Basket Analysis</span>
            <TooltipProvider>
              <UITooltip>
                <TooltipTrigger>
                  <Info className="h-3 w-3 text-muted-foreground" />
                </TooltipTrigger>
                <TooltipContent side="right" className="max-w-xs text-xs">
                  <p className="font-medium mb-1">關聯分析指標</p>
                  <p><strong>Support</strong>: 商品組合在所有訂單中的出現頻率</p>
                  <p><strong>Confidence</strong>: 買了A的客人也買了B的比例</p>
                  <p><strong>Lift</strong>: 實際關聯強度 vs 隨機組合。Lift &gt; 1 代表正關聯</p>
                </TooltipContent>
              </UITooltip>
            </TooltipProvider>
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-4">
        {loading || !analysisData ? <Skeleton className="h-[350px] w-full" /> : (
          <>
            <div className="flex gap-4 text-[10px] text-muted-foreground mb-3">
              <span>有效訂單: {formatNumber(analysisData.totalOrders)}</span>
              <span>多品項訂單: {formatNumber(analysisData.multiBasketCount)}</span>
            </div>

            <Tabs value={activeTab} onValueChange={setActiveTab}>
              <TabsList className="h-8 mb-3">
                {FOCUS_CATEGORIES.map((cat, i) => (
                  <TabsTrigger key={tabKeys[i]} value={tabKeys[i]} className="text-xs" data-testid={`tab-basket-${tabKeys[i]}`}>
                    {cat.label}
                  </TabsTrigger>
                ))}
              </TabsList>

              {FOCUS_CATEGORIES.map((cat, ci) => (
                <TabsContent key={tabKeys[ci]} value={tabKeys[ci]} className="mt-0">
                  {(() => {
                    const rules = analysisData.rules[cat.label] || [];
                    if (rules.length === 0) {
                      return <p className="text-sm text-muted-foreground py-6 text-center">數據不足以進行分析</p>;
                    }

                    return (
                      <div className="space-y-4">
                        {/* Association Rules Table */}
                        <div>
                          <h4 className="text-[11px] font-medium text-muted-foreground mb-1.5">
                            買{cat.label}時最常搭配的商品 <span className="opacity-60">Top Cross-Sell Items</span>
                          </h4>
                          <div className="overflow-x-auto max-h-[360px] overflow-y-auto">
                            <table className="w-full text-xs">
                              <thead className="sticky top-0 bg-card z-10">
                                <tr className="border-b border-border/50 text-muted-foreground">
                                  <th className="py-1.5 text-left font-medium">搭配商品</th>
                                  <th className="py-1.5 text-right font-medium">搭單次數</th>
                                  <th className="py-1.5 text-right font-medium">
                                    <TooltipProvider>
                                      <UITooltip>
                                        <TooltipTrigger className="underline decoration-dotted">Support</TooltipTrigger>
                                        <TooltipContent className="text-xs">同時出現在所有訂單中的比例</TooltipContent>
                                      </UITooltip>
                                    </TooltipProvider>
                                  </th>
                                  <th className="py-1.5 text-right font-medium">
                                    <TooltipProvider>
                                      <UITooltip>
                                        <TooltipTrigger className="underline decoration-dotted">Confidence</TooltipTrigger>
                                        <TooltipContent className="text-xs">買了{cat.label}後也買此商品的比例</TooltipContent>
                                      </UITooltip>
                                    </TooltipProvider>
                                  </th>
                                  <th className="py-1.5 text-center font-medium">
                                    <TooltipProvider>
                                      <UITooltip>
                                        <TooltipTrigger className="underline decoration-dotted">Lift</TooltipTrigger>
                                        <TooltipContent className="text-xs max-w-[200px]">Lift &gt; 1 表示正關聯（越高越強）。Lift = 1 為隨機，&lt; 1 為負關聯</TooltipContent>
                                      </UITooltip>
                                    </TooltipProvider>
                                  </th>
                                </tr>
                              </thead>
                              <tbody>
                                {rules.map((r, i) => (
                                  <tr key={i} className="border-b border-border/20 hover:bg-accent/30">
                                    <td className="py-1.5 max-w-[250px] truncate">{r.itemB}</td>
                                    <td className="py-1.5 text-right tabular-nums">{r.cooccurrences}</td>
                                    <td className="py-1.5 text-right tabular-nums text-muted-foreground">{(r.supportAB * 100).toFixed(2)}%</td>
                                    <td className="py-1.5 text-right tabular-nums">{(r.confidence * 100).toFixed(1)}%</td>
                                    <td className="py-1.5 text-center"><LiftBadge lift={r.lift} /></td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </div>

                        {/* Per-Product Top 5 */}
                        <div>
                          <h4 className="text-[11px] font-medium text-muted-foreground mb-1.5">
                            各熱門商品最常搭配的前5項 <span className="opacity-60">Per-Product Top 5 Cross-Sells</span>
                          </h4>
                          <div className="space-y-2">
                            {[...analysisData.productCrossSell.entries()]
                              .filter(([key]) => {
                                // Only show products in this category
                                const matchLine = orderLines.find((l: any) => (l.title || l.sku) === key);
                                if (!matchLine) return false;
                                return cat.match(matchLine.product_type || '', matchLine.title || '');
                              })
                              .slice(0, 5)
                              .map(([product, crossSells]) => (
                                <div key={product} className="bg-accent/20 rounded-lg p-2.5">
                                  <p className="text-xs font-medium mb-1.5 truncate">{product}</p>
                                  <div className="space-y-0.5">
                                    {crossSells.map((cs, i) => (
                                      <div key={i} className="flex items-center gap-2 text-[11px]">
                                        <ArrowRight className="h-2.5 w-2.5 text-muted-foreground flex-shrink-0" />
                                        <span className="truncate flex-1">{cs.product}</span>
                                        <span className="text-muted-foreground tabular-nums flex-shrink-0">{cs.count}次</span>
                                        <LiftBadge lift={cs.lift} />
                                      </div>
                                    ))}
                                    {crossSells.length === 0 && (
                                      <p className="text-[10px] text-muted-foreground/50">搭配數據不足</p>
                                    )}
                                  </div>
                                </div>
                              ))}
                          </div>
                        </div>
                      </div>
                    );
                  })()}
                </TabsContent>
              ))}
            </Tabs>
          </>
        )}
      </CardContent>
    </Card>
  );
}
