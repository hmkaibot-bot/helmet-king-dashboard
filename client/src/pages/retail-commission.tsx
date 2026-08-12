import { useEffect, useState, useCallback } from 'react';
import { formatCurrency, formatNumber } from '@/lib/format';
import { Receipt, RefreshCw, AlertCircle, Target, ChevronDown, ChevronRight, Trophy } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import {
  fetchRetailCommission, recentMonths,
  type CommissionResult, type CommissionStaff,
} from '@/lib/retail-commission';

/**
 * 零售佣金 — 門市全職同事(KENNY/DICKY/ZOE/BEAN;VAVA 2026-08 起)月結佣金。
 * 數據源 ShopifyQL(Sales by staff),server 端計。可揀月份,default 當月至今。
 */

const RATE_LABEL = (r: number) => `${(r * 100).toFixed(1)}%`;

function Money({ v, className = '' }: { v: number; className?: string }) {
  return <span className={`tabular-nums ${v > 0 ? '' : 'text-muted-foreground'} ${className}`}>{formatCurrency(v)}</span>;
}

function StaffRow({ s, isSnapshot }: { s: CommissionStaff; isSnapshot?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr className="border-t border-border/40 hover:bg-accent/20">
        <td className="px-3 py-2">
          <button onClick={() => setOpen(o => !o)} className="inline-flex items-center gap-1 font-semibold" data-testid={`staff-${s.code}`}>
            {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            {s.code}
          </button>
        </td>
        {/* ② 代理品牌 */}
        <td className="px-3 py-2 text-right"><Money v={s.agentTotal} /></td>
        <td className="px-3 py-2 text-right text-xs text-muted-foreground tabular-nums">{RATE_LABEL(s.agentRate)}</td>
        <td className="px-3 py-2 text-right"><Money v={s.agentComm} /></td>
        {/* ③ 非代理 */}
        <td className="px-3 py-2 text-right">
          <span className={`tabular-nums ${s.nonAgentTargetHit ? '' : 'text-muted-foreground'}`}>{formatCurrency(s.nonAgentTotal)}</span>
          {!s.nonAgentTargetHit && <span className="text-[10px] text-amber-400/80 ml-1">未達$200k</span>}
        </td>
        <td className="px-3 py-2 text-right"><Money v={s.nonAgentComm} /></td>
        {/* ④ 平均件數 */}
        <td className="px-3 py-2 text-right tabular-nums">
          {s.avgItems.toFixed(1)}
          <span className="text-[10px] text-muted-foreground ml-1">({formatNumber(s.items)}/{formatNumber(s.orders)})</span>
        </td>
        <td className="px-3 py-2 text-right"><Money v={s.avgBonus} /></td>
        {/* ① 目標 */}
        <td className="px-3 py-2 text-right"><Money v={s.targetBonus} /></td>
        {/* 總 */}
        <td className="px-3 py-2 text-right font-semibold text-primary tabular-nums">{formatCurrency(s.total)}</td>
      </tr>
      {open && (
        <tr className="bg-muted/20">
          <td colSpan={10} className="px-3 py-2">
            <div className="text-[11px] text-muted-foreground mb-1">品牌明細(NET,代理品牌以 ● 標示)</div>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {s.brands.length === 0 && <span className="text-xs text-muted-foreground">{isSnapshot ? '快照模式暫無品牌明細（開通 read_reports 後 live 模式先有）' : '冇銷售'}</span>}
              {s.brands.map(b => (
                <span key={b.vendor} className="text-xs tabular-nums">
                  <span className={b.agent ? 'text-primary' : 'text-muted-foreground'}>{b.agent ? '● ' : '○ '}</span>
                  {b.vendor || '(無品牌)'}: {formatCurrency(b.net)}
                </span>
              ))}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

export default function RetailCommissionPage() {
  const months = recentMonths(18);
  const [month, setMonth] = useState(months[0].value);
  const [data, setData] = useState<CommissionResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (m: string) => {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchRetailCommission(m));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(month); }, [load, month]);

  const totalPayout = data ? data.staff.reduce((s, x) => s + x.total, 0) : 0;
  const monthLabel = months.find(m => m.value === month)?.label ?? month;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <Receipt className="h-5 w-5 text-primary" />
          <h1 className="text-lg font-semibold">零售佣金</h1>
          <span className="text-xs text-muted-foreground">門市全職 · KENNY / DICKY / ZOE / BEAN / VAVA</span>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={month}
            onChange={e => setMonth(e.target.value)}
            className="text-xs px-2 py-1.5 rounded-md border border-border bg-background"
            data-testid="month-select"
          >
            {months.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
          <button
            onClick={() => load(month)}
            disabled={loading}
            className="text-xs px-3 py-1.5 rounded-md border border-border bg-card hover:bg-accent/60 transition-colors inline-flex items-center gap-1"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            重新整理
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-rose-500/40 bg-rose-500/10 p-3 text-rose-200 text-sm flex items-start gap-2">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
          <div>
            {error}
            <div className="text-xs text-rose-200/70 mt-1">
              如顯示 read_reports / ACCESS_DENIED,即係 Shopify app 未有 <code>read_reports</code> scope,要喺 app 權限度開返。
            </div>
          </div>
        </div>
      )}

      {data?.isSnapshot && (
        <div className="rounded-md border border-sky-500/40 bg-sky-500/10 p-2.5 text-xs text-sky-200 flex items-start gap-2">
          <span>📸</span>
          <span>
            <b>快照數據</b> —— 每晚 02:50 自動更新(GitHub Actions 用 ShopifyQL 計,規則同即時模式一致)
            {data.computedAt ? `,上次計算:${new Date(data.computedAt).toLocaleString('zh-HK', { dateStyle: 'medium', timeStyle: 'short' })}` : ''}。
            當月數計到上次計算嗰刻;月頭 5 日內會自動執埋上個月嘅數。
          </span>
        </div>
      )}

      {/* 門市目標狀態 */}
      {data && (
        <div className={`rounded-md border p-3 flex items-center gap-3 flex-wrap ${
          data.store.hit ? 'border-emerald-500/40 bg-emerald-500/10' : 'border-amber-500/40 bg-amber-500/10'
        }`}>
          <Target className={`h-5 w-5 ${data.store.hit ? 'text-emerald-400' : 'text-amber-400'}`} />
          <div className="text-sm">
            <span className="font-medium">{monthLabel} 門市零售</span>
            {data.period.isCurrentMonth && <span className="text-xs text-muted-foreground ml-1">(至今累計)</span>}
            <span className="mx-2 tabular-nums font-semibold">{formatCurrency(data.store.total)}</span>
            <span className="text-xs text-muted-foreground">/ 目標 {formatCurrency(data.store.target)}</span>
          </div>
          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
            data.store.hit ? 'bg-emerald-500/20 text-emerald-300' : 'bg-amber-500/20 text-amber-300'
          }`}>
            {data.store.hit ? `✓ 達標 · 每人 +${formatCurrency(data.store.bonus)}` : `未達標 · 差 ${formatCurrency(Math.max(0, data.store.target - data.store.total))}`}
          </span>
          <div className="ml-auto text-sm flex items-center gap-1.5">
            <Trophy className="h-4 w-4 text-primary" />
            <span className="text-xs text-muted-foreground">本月佣金總支出</span>
            <span className="font-semibold text-primary tabular-nums">{formatCurrency(totalPayout)}</span>
          </div>
        </div>
      )}

      {/* 佣金表 */}
      {loading ? (
        <Skeleton className="h-64 w-full" />
      ) : data ? (
        <div className="rounded-md border border-border/60 bg-card overflow-x-auto">
          <table className="w-full text-sm min-w-[900px]">
            <thead>
              <tr className="bg-muted/40 text-[11px] text-muted-foreground uppercase tracking-wide">
                <th className="px-3 py-2 text-left font-medium" rowSpan={2}>同事</th>
                <th className="px-3 py-2 text-center font-medium border-l border-border/40" colSpan={3}>② 代理品牌</th>
                <th className="px-3 py-2 text-center font-medium border-l border-border/40" colSpan={2}>③ 非代理品牌</th>
                <th className="px-3 py-2 text-center font-medium border-l border-border/40" colSpan={2}>④ 平均件數</th>
                <th className="px-3 py-2 text-center font-medium border-l border-border/40" rowSpan={2}>① 達標<br/>獎金</th>
                <th className="px-3 py-2 text-right font-medium border-l border-border/40" rowSpan={2}>總佣金</th>
              </tr>
              <tr className="bg-muted/40 text-[10px] text-muted-foreground">
                <th className="px-3 py-1 text-right font-normal border-l border-border/40">NET 總額</th>
                <th className="px-3 py-1 text-right font-normal">分級</th>
                <th className="px-3 py-1 text-right font-normal">佣金</th>
                <th className="px-3 py-1 text-right font-normal border-l border-border/40">NET 總額</th>
                <th className="px-3 py-1 text-right font-normal">佣金 0.5%</th>
                <th className="px-3 py-1 text-right font-normal border-l border-border/40">平均</th>
                <th className="px-3 py-1 text-right font-normal">獎金</th>
              </tr>
            </thead>
            <tbody>
              {data.staff.map(s => <StaffRow key={s.code} s={s} isSnapshot={data.isSnapshot} />)}
            </tbody>
          </table>
        </div>
      ) : null}

      <p className="text-[11px] text-muted-foreground">
        數據源:Shopify Analytics(Sales by staff)· NET SALES 計 · 門市 = Helmet King Shop · 平均件數已扣走 DRINK / beverages / 膠袋 ·
        有 assisting staff 嘅單計落 assisting。出糧前請自行核對。
      </p>
    </div>
  );
}
