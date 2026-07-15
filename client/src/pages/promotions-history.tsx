import { useEffect, useState, useMemo, useCallback } from 'react';
import { Link } from 'wouter';
import { formatCurrency, formatNumber } from '@/lib/format';
import {
  History,
  RefreshCw,
  AlertCircle,
  Megaphone,
  Package,
  TrendingUp,
  Award,
  Calendar,
  ExternalLink,
} from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Promotion,
  PromotionItem,
  Rating,
  RATING_LABEL,
  RATING_COLOR,
  fetchAllRows,
  effectiveStatus,
} from '@/lib/promotions-shared';
import { maybeSnapshotEndedPromos } from '@/lib/promo-snapshot';

type SortKey = 'end_date' | 'lift' | 'revenue' | 'qty';
type SortDir = 'asc' | 'desc';

export default function PromotionsHistoryPage() {
  const [promos, setPromos] = useState<Promotion[]>([]);
  const [items, setItems] = useState<PromotionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ratingFilter, setRatingFilter] = useState<Rating | 'all'>('all');
  const [sortKey, setSortKey] = useState<SortKey>('end_date');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [allPromos, allItems] = await Promise.all([
        fetchAllRows<Promotion>('promotions'),
        fetchAllRows<PromotionItem>('promotion_items'),
      ]);
      setPromos(allPromos.filter(p => {
        const st = effectiveStatus(p);
        return st === 'ended' || st === 'cancelled';
      }));
      setItems(allItems);

      // 結束後自動 freeze 成效(自我修復;背景行,計完先補上畫面)
      void maybeSnapshotEndedPromos(allPromos, allItems)
        .then(snaps => {
          if (!snaps) return;
          setPromos(prev => prev.map(p => (snaps.has(p.id) ? { ...p, ...snaps.get(p.id)! } : p)));
        })
        .catch(e => console.warn('推廣快照失敗:', e));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // ── KPI: cross-promo analytics ────────────────────────────────────────
  const kpi = useMemo(() => {
    const endedWithSnapshot = promos.filter(p => effectiveStatus(p) === 'ended' && p.snapshotted_at);
    if (endedWithSnapshot.length === 0) return null;

    const totalRev = endedWithSnapshot.reduce((s, p) => s + (p.final_revenue ?? 0), 0);
    const totalQty = endedWithSnapshot.reduce((s, p) => s + (p.final_qty_sold ?? 0), 0);
    const liftSum = endedWithSnapshot.reduce((s, p) => {
      const lift = p.final_lift_ratio ?? 0;
      return s + (lift === 999 ? 0 : lift); // exclude infinity from avg
    }, 0);
    const liftCount = endedWithSnapshot.filter(
      p => p.final_lift_ratio != null && p.final_lift_ratio !== 999
    ).length;
    const avgLift = liftCount > 0 ? liftSum / liftCount : 0;

    const effectiveCount = endedWithSnapshot.filter(p => p.final_rating === 'effective').length;
    const okCount = endedWithSnapshot.filter(p => p.final_rating === 'ok').length;
    const ineffectiveCount = endedWithSnapshot.filter(p => p.final_rating === 'ineffective').length;

    const best = endedWithSnapshot
      .filter(p => p.final_lift_ratio != null)
      .sort((a, b) => (b.final_lift_ratio ?? 0) - (a.final_lift_ratio ?? 0))[0];

    const worst = endedWithSnapshot
      .filter(p => p.final_lift_ratio != null)
      .sort((a, b) => (a.final_lift_ratio ?? 0) - (b.final_lift_ratio ?? 0))[0];

    return {
      total: endedWithSnapshot.length,
      totalRev,
      totalQty,
      avgLift,
      effectiveCount,
      okCount,
      ineffectiveCount,
      best,
      worst,
    };
  }, [promos]);

  const itemCountByPromo = useMemo(() => {
    const m = new Map<string, number>();
    for (const it of items) {
      m.set(it.promotion_id, (m.get(it.promotion_id) ?? 0) + 1);
    }
    return m;
  }, [items]);

  // Filter + sort
  const filtered = useMemo(() => {
    let list = promos;
    if (ratingFilter !== 'all') list = list.filter(p => p.final_rating === ratingFilter);
    const mul = sortDir === 'asc' ? 1 : -1;
    return [...list].sort((a, b) => {
      switch (sortKey) {
        case 'end_date':
          return a.end_date.localeCompare(b.end_date) * mul;
        case 'lift':
          return ((a.final_lift_ratio ?? 0) - (b.final_lift_ratio ?? 0)) * mul;
        case 'revenue':
          return ((a.final_revenue ?? 0) - (b.final_revenue ?? 0)) * mul;
        case 'qty':
          return ((a.final_qty_sold ?? 0) - (b.final_qty_sold ?? 0)) * mul;
      }
    });
  }, [promos, ratingFilter, sortKey, sortDir]);

  const toggleSort = (k: SortKey) => {
    if (sortKey === k) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(k);
      setSortDir('desc');
    }
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <History className="h-5 w-5 text-primary" />
          <h1 className="text-lg font-semibold">推廣歷史</h1>
          <span className="text-xs text-muted-foreground">
            （已結束 + 已取消 · 共 {promos.length}）
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Link
            to="/retail/promotions"
            className="text-xs px-3 py-1.5 rounded-md border border-border bg-card hover:bg-accent/60 transition-colors inline-flex items-center gap-1"
          >
            <Megaphone className="h-3.5 w-3.5" />
            推廣活動
          </Link>
          <Link
            to="/retail/promotions/items"
            className="text-xs px-3 py-1.5 rounded-md border border-border bg-card hover:bg-accent/60 transition-colors inline-flex items-center gap-1"
          >
            <Package className="h-3.5 w-3.5" />
            商品池
          </Link>
          <button
            onClick={load}
            disabled={loading}
            className="text-xs px-3 py-1.5 rounded-md border border-border bg-card hover:bg-accent/60 transition-colors inline-flex items-center gap-1"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            重新整理
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-rose-500/40 bg-rose-500/10 p-3 text-rose-200 text-sm flex items-center gap-2">
          <AlertCircle className="h-4 w-4" />
          {error}
        </div>
      )}

      {/* KPI strip */}
      {loading ? (
        <Skeleton className="h-24 w-full" />
      ) : kpi ? (
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-2">
          <KpiCard label="歷史推廣" value={formatNumber(kpi.total)} />
          <KpiCard label="總銷量" value={formatNumber(kpi.totalQty)} />
          <KpiCard label="總營收" value={formatCurrency(kpi.totalRev)} />
          <KpiCard
            label="平均 Lift"
            value={kpi.avgLift > 0 ? `${kpi.avgLift.toFixed(2)}×` : '—'}
            icon={<TrendingUp className="h-3 w-3" />}
          />
          {kpi.best && (
            <Link
              to={`/retail/promotions/${kpi.best.id}`}
              className="rounded-md border border-emerald-500/40 bg-emerald-500/10 p-2 hover:bg-emerald-500/15 transition-colors"
            >
              <div className="text-[10px] text-emerald-300 inline-flex items-center gap-1">
                <Award className="h-3 w-3" /> 最佳推廣
              </div>
              <div
                className="text-xs font-semibold truncate mt-0.5 text-emerald-100"
                title={kpi.best.name}
              >
                {kpi.best.name}
              </div>
              <div className="text-[10px] text-emerald-300 tabular-nums">
                {kpi.best.final_lift_ratio === 999
                  ? '∞'
                  : `${(kpi.best.final_lift_ratio ?? 0).toFixed(2)}×`}
              </div>
            </Link>
          )}
          {kpi.worst && (
            <Link
              to={`/retail/promotions/${kpi.worst.id}`}
              className="rounded-md border border-rose-500/40 bg-rose-500/10 p-2 hover:bg-rose-500/15 transition-colors"
            >
              <div className="text-[10px] text-rose-300">最差推廣</div>
              <div
                className="text-xs font-semibold truncate mt-0.5 text-rose-100"
                title={kpi.worst.name}
              >
                {kpi.worst.name}
              </div>
              <div className="text-[10px] text-rose-300 tabular-nums">
                {(kpi.worst.final_lift_ratio ?? 0).toFixed(2)}×
              </div>
            </Link>
          )}
        </div>
      ) : null}

      {/* Rating distribution */}
      {kpi && (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">評級分布：</span>
          <span className="px-2 py-0.5 rounded border bg-emerald-500/10 border-emerald-500/40 text-emerald-300">
            有效 {kpi.effectiveCount}
          </span>
          <span className="px-2 py-0.5 rounded border bg-amber-500/10 border-amber-500/40 text-amber-300">
            一般 {kpi.okCount}
          </span>
          <span className="px-2 py-0.5 rounded border bg-rose-500/10 border-rose-500/40 text-rose-300">
            無效 {kpi.ineffectiveCount}
          </span>
        </div>
      )}

      {/* Filters */}
      <div className="flex items-center gap-1 flex-wrap">
        <span className="text-xs text-muted-foreground mr-1">評級：</span>
        {(['all', 'effective', 'ok', 'ineffective'] as const).map(r => (
          <button
            key={r}
            onClick={() => setRatingFilter(r)}
            className={`text-xs px-2.5 py-1 rounded-md border transition-colors ${
              ratingFilter === r
                ? 'bg-primary/90 text-primary-foreground border-primary'
                : 'border-border bg-card hover:bg-accent/60'
            }`}
          >
            {r === 'all' ? '全部' : RATING_LABEL[r]}
          </button>
        ))}
      </div>

      {/* Table */}
      {loading ? (
        <Skeleton className="h-64 w-full" />
      ) : filtered.length === 0 ? (
        <div className="rounded-md border border-dashed border-border/60 p-12 text-center text-sm text-muted-foreground">
          {promos.length === 0
            ? '尚未有任何已結束嘅推廣。推廣結束後隔日（等訂單同步齊），開呢頁或推廣活動頁會自動 freeze 成效並顯示喺度。'
            : '冇符合條件嘅推廣'}
        </div>
      ) : (
        <div className="rounded-md border border-border/60 bg-card overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-muted/30 border-b border-border/40">
              <tr>
                <th className="text-left px-2 py-2 font-normal text-muted-foreground">推廣名稱</th>
                <th className="text-left px-2 py-2 font-normal text-muted-foreground">
                  <button
                    onClick={() => toggleSort('end_date')}
                    className="inline-flex items-center gap-1 hover:text-foreground"
                  >
                    <Calendar className="h-3 w-3" />
                    結束日期
                    {sortKey === 'end_date' && (sortDir === 'asc' ? '↑' : '↓')}
                  </button>
                </th>
                <th className="text-right px-2 py-2 font-normal text-muted-foreground">商品數</th>
                <th className="text-right px-2 py-2 font-normal text-muted-foreground">
                  <button
                    onClick={() => toggleSort('qty')}
                    className="hover:text-foreground"
                  >
                    銷量 {sortKey === 'qty' && (sortDir === 'asc' ? '↑' : '↓')}
                  </button>
                </th>
                <th className="text-right px-2 py-2 font-normal text-muted-foreground">
                  <button
                    onClick={() => toggleSort('revenue')}
                    className="hover:text-foreground"
                  >
                    營收 {sortKey === 'revenue' && (sortDir === 'asc' ? '↑' : '↓')}
                  </button>
                </th>
                <th className="text-right px-2 py-2 font-normal text-muted-foreground">
                  <button
                    onClick={() => toggleSort('lift')}
                    className="hover:text-foreground"
                  >
                    Lift {sortKey === 'lift' && (sortDir === 'asc' ? '↑' : '↓')}
                  </button>
                </th>
                <th className="text-left px-2 py-2 font-normal text-muted-foreground">評級</th>
                <th className="text-left px-2 py-2 font-normal text-muted-foreground w-8"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(p => {
                const count = itemCountByPromo.get(p.id) ?? 0;
                return (
                  <tr key={p.id} className="border-b border-border/40 hover:bg-accent/30">
                    <td className="px-2 py-1.5">
                      <Link
                        to={`/retail/promotions/${p.id}`}
                        className="font-medium hover:underline"
                      >
                        {p.name}
                      </Link>
                      {p.discount_type && (
                        <span className="ml-2 text-[10px] text-muted-foreground">
                          {p.discount_type}
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-1.5 text-muted-foreground tabular-nums">
                      {p.start_date} → {p.end_date}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{count}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">
                      {p.final_qty_sold != null ? formatNumber(p.final_qty_sold) : '—'}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums">
                      {p.final_revenue != null ? formatCurrency(p.final_revenue) : '—'}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums">
                      {p.final_lift_ratio != null
                        ? p.final_lift_ratio === 999
                          ? '∞'
                          : `${p.final_lift_ratio.toFixed(2)}×`
                        : '—'}
                    </td>
                    <td className="px-2 py-1.5">
                      {p.final_rating ? (
                        <span
                          className={`px-1.5 py-0.5 rounded text-[10px] border ${RATING_COLOR[p.final_rating]}`}
                        >
                          {RATING_LABEL[p.final_rating]}
                        </span>
                      ) : (
                        <span className="text-[10px] text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-2 py-1.5">
                      <Link
                        to={`/retail/promotions/${p.id}`}
                        className="text-primary hover:text-primary/80"
                        title="睇詳情"
                      >
                        <ExternalLink className="h-3 w-3" />
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function KpiCard({
  label,
  value,
  icon,
}: {
  label: string;
  value: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="rounded-md border border-border/60 bg-card p-2">
      <div className="text-[10px] text-muted-foreground inline-flex items-center gap-1">
        {icon}
        {label}
      </div>
      <div className="text-sm font-semibold tabular-nums mt-0.5">{value}</div>
    </div>
  );
}
