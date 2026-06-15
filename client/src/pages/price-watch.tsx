import { useEffect, useMemo, useState } from 'react';
import { queryAllPages } from '@/lib/query-helpers';
import { supabase } from '@/lib/supabase';
import { formatCurrency } from '@/lib/format';
import { Scale, AlertCircle, ExternalLink, ChevronDown, ChevronRight, Trophy } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';

interface Comp {
  merchant: string;
  country: string;
  landed: number;
  listed: number;
  cur: string;
  d1: number | null;
  d2: number | null;
  url: string | null;
  conf: string;
}
interface Row {
  our_product_id: string;
  our_title: string;
  our_price: number | null;
  n: number;
  cheapest_landed: number;
  competitors: Comp[];
  last_scraped: string;
}

const CONF_COLOR: Record<string, string> = {
  high: 'text-emerald-300',
  medium: 'text-amber-300',
  low: 'text-rose-300',
};

export default function PriceWatchPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [fxAt, setFxAt] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'over' | 'win'>('all');
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setErr(null);
      try {
        const data = await queryAllPages('price_watch', '*');
        if (cancelled) return;
        setRows(data as Row[]);
        const fx = await supabase.from('fx_rates').select('fetched_at').eq('currency', 'EUR').maybeSingle();
        if (!cancelled) setFxAt(fx.data?.fetched_at ?? null);
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const enriched = useMemo(
    () =>
      rows.map((r) => {
        const comps = Array.isArray(r.competitors) ? r.competitors : [];
        const cheapest = comps[0];
        const gap =
          r.our_price != null && r.cheapest_landed
            ? ((r.our_price - r.cheapest_landed) / r.cheapest_landed) * 100
            : null;
        const win = gap != null && gap <= 0;
        return { ...r, comps, cheapest, gap, win };
      }),
    [rows]
  );

  const view = useMemo(() => {
    let l = enriched;
    if (filter === 'over') l = l.filter((r) => r.gap != null && r.gap > 1);
    else if (filter === 'win') l = l.filter((r) => r.win);
    return [...l].sort((a, b) => (b.gap ?? -999) - (a.gap ?? -999));
  }, [enriched, filter]);

  const kpi = useMemo(() => {
    const w = enriched.filter((r) => r.our_price != null && r.cheapest_landed);
    return {
      total: w.length,
      over: w.filter((r) => r.gap != null && r.gap > 1).length,
      win: w.filter((r) => r.win).length,
    };
  }, [enriched]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <Scale className="h-5 w-5 text-primary" />
          <h1 className="text-lg font-semibold">格價系統</h1>
          <span className="text-xs text-muted-foreground">Price Watch · HK 到手價對比</span>
        </div>
        <div className="text-[11px] text-muted-foreground">
          匯率更新：{fxAt ? new Date(fxAt).toLocaleString('zh-HK') : '—'}
        </div>
      </div>

      {err && (
        <div className="rounded-md border border-rose-500/40 bg-rose-500/10 p-3 text-rose-200 text-sm flex items-center gap-2">
          <AlertCircle className="h-4 w-4" />
          {err}
        </div>
      )}

      <div className="rounded-md border border-border/40 bg-muted/20 p-2.5 text-[11px] text-muted-foreground leading-relaxed">
        對手「到手價」= 標價 − 出口退稅(EU VAT 等) + 去 HK 運費估算 × 即日匯率（HK 免關稅）。
        運費/退稅為估算、配對由型號自動比對（<span className="text-amber-300">medium</span>/<span className="text-rose-300">low</span> 信心需人手核實，色款可能略有出入）。目前對手：FC-Moto（德）。
      </div>

      {/* KPI */}
      <div className="grid grid-cols-3 gap-2">
        <div className="rounded-md border border-border/60 bg-card p-2">
          <div className="text-[10px] text-muted-foreground">已格價商品</div>
          <div className="text-sm font-semibold tabular-nums mt-0.5">{kpi.total}</div>
        </div>
        <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 p-2">
          <div className="text-[10px] text-muted-foreground">🏆 全網最平</div>
          <div className="text-sm font-semibold tabular-nums mt-0.5 text-emerald-200">{kpi.win}</div>
        </div>
        <div className="rounded-md border border-rose-500/40 bg-rose-500/10 p-2">
          <div className="text-[10px] text-muted-foreground">⚠️ 我哋貴過人</div>
          <div className="text-sm font-semibold tabular-nums mt-0.5 text-rose-200">{kpi.over}</div>
        </div>
      </div>

      {/* Filter */}
      <div className="flex items-center gap-1.5 text-xs">
        {(['all', 'over', 'win'] as const).map((k) => (
          <button
            key={k}
            onClick={() => setFilter(k)}
            className={`px-2.5 py-1 rounded-md border transition-colors ${
              filter === k ? 'bg-primary/90 text-primary-foreground border-primary' : 'border-border bg-card hover:bg-accent/60'
            }`}
          >
            {k === 'all' ? `全部 ${kpi.total}` : k === 'over' ? `我哋貴 ${kpi.over}` : `最平 ${kpi.win}`}
          </button>
        ))}
      </div>

      {loading ? (
        <Skeleton className="h-64 w-full" />
      ) : view.length === 0 ? (
        <div className="rounded-md border border-dashed border-border/60 p-12 text-center text-sm text-muted-foreground">
          尚未有格價數據（或此條件下冇商品）。
        </div>
      ) : (
        <div className="rounded-md border border-border/60 bg-card overflow-x-auto">
          <table className="w-full text-xs" data-testid="price-watch-table">
            <thead className="bg-muted/30 border-b border-border/40">
              <tr>
                <th className="w-6"></th>
                <th className="text-left px-2 py-2 font-normal text-muted-foreground">產品</th>
                <th className="text-right px-2 py-2 font-normal text-muted-foreground">頭盔王價</th>
                <th className="text-right px-2 py-2 font-normal text-muted-foreground">最平對手到手價</th>
                <th className="text-left px-2 py-2 font-normal text-muted-foreground">對手</th>
                <th className="text-right px-2 py-2 font-normal text-muted-foreground">差距</th>
                <th className="text-left px-2 py-2 font-normal text-muted-foreground">結論</th>
              </tr>
            </thead>
            <tbody>
              {view.map((r) => {
                const isExp = expanded === r.our_product_id;
                return (
                  <>
                    <tr
                      key={r.our_product_id}
                      className="border-b border-border/40 hover:bg-accent/30 cursor-pointer"
                      onClick={() => setExpanded(isExp ? null : r.our_product_id)}
                    >
                      <td className="px-1.5 py-1.5">
                        {isExp ? <ChevronDown className="h-3 w-3 text-muted-foreground" /> : <ChevronRight className="h-3 w-3 text-muted-foreground" />}
                      </td>
                      <td className="px-2 py-1.5 font-medium max-w-[300px]">
                        <span className="truncate block" title={r.our_title}>{r.our_title}</span>
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{r.our_price != null ? formatCurrency(r.our_price) : <span className="text-muted-foreground">冇賣</span>}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums font-medium">{formatCurrency(r.cheapest_landed)}</td>
                      <td className="px-2 py-1.5 text-muted-foreground">
                        {r.cheapest ? (
                          <span>
                            {r.cheapest.merchant} <span className="text-[10px]">({r.cheapest.country})</span>
                            {r.cheapest.d2 != null && <span className="text-[10px] text-muted-foreground"> · {r.cheapest.d1}-{r.cheapest.d2}日</span>}
                            <span className={`text-[10px] ml-1 ${CONF_COLOR[r.cheapest.conf] || ''}`}>●</span>
                          </span>
                        ) : '—'}
                      </td>
                      <td className={`px-2 py-1.5 text-right tabular-nums font-semibold ${r.gap == null ? 'text-muted-foreground' : r.gap > 0 ? 'text-rose-300' : 'text-emerald-300'}`}>
                        {r.gap == null ? '—' : `${r.gap > 0 ? '+' : ''}${r.gap.toFixed(0)}%`}
                      </td>
                      <td className="px-2 py-1.5">
                        {r.gap == null ? (
                          <span className="text-muted-foreground">—</span>
                        ) : r.win ? (
                          <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border bg-emerald-500/10 border-emerald-500/40 text-emerald-300">
                            <Trophy className="h-3 w-3" /> 全網最平
                          </span>
                        ) : (
                          <span className="text-[10px] px-1.5 py-0.5 rounded border bg-rose-500/10 border-rose-500/40 text-rose-300">
                            貴 {r.gap.toFixed(0)}%
                          </span>
                        )}
                      </td>
                    </tr>
                    {isExp && (
                      <tr key={`${r.our_product_id}-d`} className="bg-muted/20 border-b border-border/40">
                        <td colSpan={7} className="px-4 py-2">
                          <div className="text-[10px] text-muted-foreground mb-1">所有對手（由平到貴）：</div>
                          <table className="w-full text-[11px]">
                            <thead className="text-muted-foreground">
                              <tr>
                                <th className="text-left py-1 font-normal">商戶</th>
                                <th className="text-left py-1 font-normal">國家</th>
                                <th className="text-right py-1 font-normal">標價</th>
                                <th className="text-right py-1 font-normal">到手價 HKD</th>
                                <th className="text-left py-1 font-normal">日數</th>
                                <th className="text-left py-1 font-normal">信心</th>
                                <th className="text-left py-1 font-normal">連結</th>
                              </tr>
                            </thead>
                            <tbody>
                              {r.comps.map((c, i) => (
                                <tr key={i} className="border-t border-border/20">
                                  <td className="py-1">{c.merchant}</td>
                                  <td className="py-1">{c.country}</td>
                                  <td className="py-1 text-right tabular-nums">{c.cur} {c.listed?.toFixed(0)}</td>
                                  <td className="py-1 text-right tabular-nums font-medium">{formatCurrency(c.landed)}</td>
                                  <td className="py-1">{c.d2 != null ? `${c.d1}-${c.d2}日` : '—'}</td>
                                  <td className={`py-1 ${CONF_COLOR[c.conf] || ''}`}>{c.conf}</td>
                                  <td className="py-1">
                                    {c.url && <a href={c.url} target="_blank" rel="noreferrer" className="text-primary hover:underline inline-flex items-center gap-0.5">睇 <ExternalLink className="h-2.5 w-2.5" /></a>}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
