import { useEffect, useMemo, useState } from 'react';
import { queryAllPages } from '@/lib/query-helpers';
import { supabase } from '@/lib/supabase';
import { formatCurrency } from '@/lib/format';
import { Scale, AlertCircle, ExternalLink, ChevronDown, ChevronRight, Trophy, RefreshCw, TrendingDown, Layers } from 'lucide-react';
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
interface CrossRow {
  our_product_id: string;
  vendor: string;
  title: string;
  our_price: number;
  seg_type: string;
  is_carbon: boolean;
  cheapest_landed: number | null;
}

const CONF_COLOR: Record<string, string> = {
  high: 'text-emerald-300',
  medium: 'text-amber-300',
  low: 'text-rose-300',
};

// 價格層 (用本店零售價分段)
const TIERS = [
  { key: '旗艦', min: 6000, max: Infinity },
  { key: '高階', min: 3000, max: 6000 },
  { key: '中階', min: 1500, max: 3000 },
  { key: '入門', min: 300, max: 1500 },
];
const SEGS = ['全面', '揭面', '半面', '越野/ADV'];

type Tab = 'compare' | 'reprice' | 'cross';

export default function PriceWatchPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [cross, setCross] = useState<CrossRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [fxAt, setFxAt] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('compare');
  const [filter, setFilter] = useState<'all' | 'over' | 'win'>('all');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [premium, setPremium] = useState(15);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setErr(null);
      try {
        const [data, cb] = await Promise.all([
          queryAllPages('price_watch', '*'),
          queryAllPages('helmet_cross_brand', '*'),
        ]);
        if (cancelled) return;
        setRows(data as Row[]);
        setCross(cb as CrossRow[]);
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

  // ── 建議調價: 我哋貴過「對手到手價 × (1+本地溢價)」嘅商品 ──
  const reprice = useMemo(() => {
    const f = 1 + premium / 100;
    return enriched
      .filter((r) => r.our_price != null && r.cheapest_landed && r.our_price > r.cheapest_landed * f)
      .map((r) => {
        const suggested = Math.round((r.cheapest_landed * f) / 10) * 10;
        const cutHkd = (r.our_price as number) - suggested;
        const cutPct = (cutHkd / (r.our_price as number)) * 100;
        return { ...r, suggested, cutHkd, cutPct };
      })
      .sort((a, b) => b.cutHkd - a.cutHkd);
  }, [enriched, premium]);

  // ── 跨品牌類近: 段(類型) × 層(價格) → 各品牌階梯 ──
  const segments = useMemo(() => {
    const landedById = new Map(enriched.map((r) => [r.our_product_id, r.cheapest_landed]));
    return SEGS.map((seg) => {
      const tiers = TIERS.map((t) => {
        const inTier = cross.filter(
          (c) => c.seg_type === seg && c.our_price >= t.min && c.our_price < t.max
        );
        const byBrand = new Map<string, { count: number; lo: number; hi: number; landed: number | null; carbon: boolean }>();
        for (const c of inTier) {
          const b = byBrand.get(c.vendor) ?? { count: 0, lo: Infinity, hi: 0, landed: null, carbon: false };
          b.count += 1;
          b.lo = Math.min(b.lo, c.our_price);
          b.hi = Math.max(b.hi, c.our_price);
          b.carbon = b.carbon || c.is_carbon;
          const landed = c.cheapest_landed ?? landedById.get(c.our_product_id) ?? null;
          if (landed != null) b.landed = b.landed == null ? landed : Math.min(b.landed, landed);
          byBrand.set(c.vendor, b);
        }
        const brands = [...byBrand.entries()]
          .map(([vendor, v]) => ({ vendor, ...v }))
          .sort((a, b) => a.lo - b.lo);
        return { tier: t.key, brands, total: inTier.length };
      }).filter((t) => t.brands.length > 0);
      return { seg, tiers, total: tiers.reduce((s, t) => s + t.total, 0) };
    }).filter((s) => s.total > 0);
  }, [cross, enriched]);

  const handleRefresh = async () => {
    setRefreshing(true);
    setRefreshMsg(null);
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error('未登入');
      const r = await fetch('/api/refresh-prices', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
      const j = await r.json().catch(() => null);
      if (!r.ok || j?.ok === false) throw new Error(j?.error || `HTTP ${r.status}`);
      setRefreshMsg('已觸發更新 ✓ 抓取約 5-10 分鐘，完成後重新整理頁面即見新數。');
    } catch (e) {
      setRefreshMsg(`觸發失敗：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRefreshing(false);
    }
  };

  const TabBtn = ({ id, label, icon }: { id: Tab; label: string; icon: React.ReactNode }) => (
    <button
      onClick={() => setTab(id)}
      className={`px-3 py-1.5 rounded-md border text-xs inline-flex items-center gap-1.5 transition-colors ${
        tab === id ? 'bg-primary/90 text-primary-foreground border-primary' : 'border-border bg-card hover:bg-accent/60'
      }`}
    >
      {icon}
      {label}
    </button>
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <Scale className="h-5 w-5 text-primary" />
          <h1 className="text-lg font-semibold">格價系統</h1>
          <span className="text-xs text-muted-foreground">Price Watch · HK 到手價對比</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground">匯率：{fxAt ? new Date(fxAt).toLocaleDateString('zh-HK') : '—'}</span>
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            title="觸發 GitHub Actions 重抓所有對手價（約 5-10 分鐘）"
            className="text-xs px-3 py-1.5 rounded-md border border-primary/50 bg-primary/10 text-primary hover:bg-primary/20 transition-colors inline-flex items-center gap-1 disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            更新數據
          </button>
        </div>
      </div>
      {refreshMsg && (
        <div className="rounded-md border border-primary/40 bg-primary/10 p-2 text-xs text-primary">{refreshMsg}</div>
      )}

      {err && (
        <div className="rounded-md border border-rose-500/40 bg-rose-500/10 p-3 text-rose-200 text-sm flex items-center gap-2">
          <AlertCircle className="h-4 w-4" />
          {err}
        </div>
      )}

      <div className="rounded-md border border-border/40 bg-muted/20 p-2.5 text-[11px] text-muted-foreground leading-relaxed">
        對手「到手價」= 標價 − 出口退稅(EU VAT 等) + 去 HK 運費估算 × 即日匯率（HK 免關稅）。
        運費/退稅為估算、配對由 AI 逐件核對型號（<span className="text-emerald-300">high</span> 為主，色款可能略有出入）。
        對手：FC-Moto（德）· Motardinn/Tradeinn（歐/國際）· 利力（港）· 車迷城（港·會員9折）· Google Shopping（美旗艦參考）。
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <TabBtn id="compare" label="格價對比" icon={<Scale className="h-3.5 w-3.5" />} />
        <TabBtn id="reprice" label={`建議調價 ${reprice.length ? `(${reprice.length})` : ''}`} icon={<TrendingDown className="h-3.5 w-3.5" />} />
        <TabBtn id="cross" label="跨品牌類近" icon={<Layers className="h-3.5 w-3.5" />} />
      </div>

      {loading ? (
        <Skeleton className="h-64 w-full" />
      ) : tab === 'compare' ? (
        <>
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
          <div className="flex items-center gap-1.5 text-xs mt-3">
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

          {view.length === 0 ? (
            <div className="rounded-md border border-dashed border-border/60 p-12 text-center text-sm text-muted-foreground mt-3">
              尚未有格價數據（或此條件下冇商品）。
            </div>
          ) : (
            <div className="rounded-md border border-border/60 bg-card overflow-x-auto mt-3">
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
        </>
      ) : tab === 'reprice' ? (
        <>
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="text-[11px] text-muted-foreground leading-relaxed max-w-[60%]">
              「建議參考價」= 最平對手到手價 ×（1 + 本地溢價）。本地溢價反映即買即取、行貨保養、可試戴、售後等價值。
              只列出<span className="text-rose-300">高過此參考價</span>嘅商品（即減價空間最大）。最終定價由你決定。
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] text-muted-foreground">本地溢價</span>
              {[0, 10, 15, 20].map((p) => (
                <button
                  key={p}
                  onClick={() => setPremium(p)}
                  className={`px-2 py-1 rounded-md border text-xs tabular-nums transition-colors ${
                    premium === p ? 'bg-primary/90 text-primary-foreground border-primary' : 'border-border bg-card hover:bg-accent/60'
                  }`}
                >
                  +{p}%
                </button>
              ))}
            </div>
          </div>

          {reprice.length === 0 ? (
            <div className="rounded-md border border-dashed border-emerald-500/40 bg-emerald-500/5 p-12 text-center text-sm text-emerald-200">
              👍 此溢價下，冇商品高過參考價 — 定價有競爭力。
            </div>
          ) : (
            <div className="rounded-md border border-border/60 bg-card overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-muted/30 border-b border-border/40">
                  <tr>
                    <th className="text-left px-2 py-2 font-normal text-muted-foreground">產品</th>
                    <th className="text-right px-2 py-2 font-normal text-muted-foreground">現價</th>
                    <th className="text-right px-2 py-2 font-normal text-muted-foreground">對手最平到手</th>
                    <th className="text-right px-2 py-2 font-normal text-muted-foreground">建議參考價</th>
                    <th className="text-right px-2 py-2 font-normal text-muted-foreground">減幅</th>
                    <th className="text-left px-2 py-2 font-normal text-muted-foreground">最平對手</th>
                  </tr>
                </thead>
                <tbody>
                  {reprice.map((r) => (
                    <tr key={r.our_product_id} className="border-b border-border/40 hover:bg-accent/30">
                      <td className="px-2 py-1.5 font-medium max-w-[280px]">
                        <span className="truncate block" title={r.our_title}>{r.our_title}</span>
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{formatCurrency(r.our_price as number)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">{formatCurrency(r.cheapest_landed)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums font-semibold text-amber-200">{formatCurrency(r.suggested)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-rose-300">
                        −{formatCurrency(r.cutHkd)} <span className="text-[10px]">({r.cutPct.toFixed(0)}%)</span>
                      </td>
                      <td className="px-2 py-1.5 text-muted-foreground">
                        {r.cheapest ? `${r.cheapest.merchant} (${r.cheapest.country})` : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : (
        // ── 跨品牌類近 ──
        <>
          <div className="text-[11px] text-muted-foreground leading-relaxed">
            同一「類型 × 價格層」內，本店各品牌嘅價格階梯（同最平水貨到手價）。睇下喺每個檔次，買家會喺邊個牌子之間揀、我哋邊個牌子最有競爭力。
          </div>
          {segments.length === 0 ? (
            <div className="rounded-md border border-dashed border-border/60 p-12 text-center text-sm text-muted-foreground">冇數據。</div>
          ) : (
            <div className="space-y-4">
              {segments.map((s) => (
                <div key={s.seg} className="rounded-md border border-border/60 bg-card overflow-hidden">
                  <div className="bg-muted/40 px-3 py-1.5 text-sm font-semibold flex items-center gap-2">
                    <Layers className="h-4 w-4 text-primary" /> {s.seg}
                    <span className="text-[11px] font-normal text-muted-foreground">{s.total} 款</span>
                  </div>
                  <div className="divide-y divide-border/30">
                    {s.tiers.map((t) => (
                      <div key={t.tier} className="px-3 py-2">
                        <div className="text-[11px] text-muted-foreground mb-1.5">
                          {t.tier} 檔（{t.brands.length} 個品牌 · {t.total} 款）
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1.5">
                          {t.brands.map((b) => (
                            <div key={b.vendor} className="rounded border border-border/50 bg-muted/10 px-2 py-1.5 text-[11px]">
                              <div className="flex items-center justify-between">
                                <span className="font-semibold">{b.vendor}</span>
                                {b.carbon && <span className="text-[9px] px-1 rounded bg-zinc-700/60 text-zinc-300">Carbon</span>}
                              </div>
                              <div className="tabular-nums text-muted-foreground mt-0.5">
                                {b.count} 款 · {b.lo === b.hi ? formatCurrency(b.lo) : `${formatCurrency(b.lo)}–${formatCurrency(b.hi)}`}
                              </div>
                              <div className="tabular-nums mt-0.5">
                                {b.landed != null ? (
                                  <span className={b.landed < b.lo ? 'text-rose-300' : 'text-emerald-300'}>
                                    最平水貨 {formatCurrency(b.landed)}
                                  </span>
                                ) : (
                                  <span className="text-muted-foreground/60">水貨：—</span>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
