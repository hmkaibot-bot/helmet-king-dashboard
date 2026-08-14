import { useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { Card, CardContent } from '@/components/ui/card';
import { formatCurrency, formatNumber } from '@/lib/format';
import { FileSpreadsheet } from 'lucide-react';
import type { Entry, Item, Session } from '@/pages/stocktake';

/**
 * 盤點結算報告 — 管理層視圖(grilling 2026-08-14 拍板:A 總差異 + B 品牌/類別排行 + D Top 蝕貨)。
 * 一輪 = 勾選幾場合埋計(2月/8月各一輪,一輪一星期分幾場盤);測試場唔勾就唔會入數。
 * 金額用開場 snapshot 嘅成本價;冇成本嘅 SKU 用售價頂 + 標「估算」(老闆揀 ii)。
 * 同一 SKU 出現喺多過一場:以最新嗰場為準,唔會重複計。
 */

const itemName = (i: Item) =>
  `${i.product_title ?? ''}${i.variant_title && i.variant_title !== 'Default Title' ? ` — ${i.variant_title}` : ''}`;

interface DiffRow extends Item {
  counted: number;
  diff: number;
  val: number; // 差異 × (成本價 ?? 售價)
  estimated: boolean; // true = 冇成本價,用咗售價
  sid: string;
}

async function loadAllRows<T>(table: string, select: string, sessionId: string, order: string): Promise<T[]> {
  const all: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from(table).select(select)
      .eq('session_id', sessionId).order(order).range(from, from + 999);
    if (error) throw error;
    all.push(...((data as T[]) ?? []));
    if (!data || data.length < 1000) break;
  }
  return all;
}

export function StocktakeRoundReport({ sessions, progress }: {
  sessions: Session[];
  progress: Record<string, { total: number; counted: number }>;
}) {
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [data, setData] = useState<Record<string, { items: Item[]; entries: Entry[] }>>({});
  const [rankBy, setRankBy] = useState<'vendor' | 'product_type'>('vendor');
  const touched = useRef(false);
  const pending = useRef(new Set<string>());

  // 預設勾晒已完成嘅場次(用戶未郁過先自動)
  useEffect(() => {
    if (touched.current || sel.size > 0) return;
    const done = sessions.filter(s => s.status === 'done');
    if (done.length) setSel(new Set(done.map(s => s.id)));
  }, [sessions]); // eslint-disable-line react-hooks/exhaustive-deps

  // 載入已勾但未有 data 嘅場次
  useEffect(() => {
    const missing = [...sel].filter(id => !data[id] && !pending.current.has(id));
    if (missing.length === 0) return;
    missing.forEach(id => pending.current.add(id));
    (async () => {
      for (const id of missing) {
        try {
          const [items, entries] = await Promise.all([
            loadAllRows<Item>('stocktake_items', 'session_id,sku,product_title,variant_title,vendor,product_type,price,unit_cost,system_qty', id, 'sku'),
            loadAllRows<Entry>('stocktake_entries', '*', id, 'created_at'),
          ]);
          setData(prev => ({ ...prev, [id]: { items, entries } }));
        } catch (e) {
          console.error(e);
          alert(`載入場次數據失敗:${e instanceof Error ? e.message : String(e)}`);
        } finally {
          pending.current.delete(id);
        }
      }
    })();
  }, [sel, data]);

  const toggle = (id: string) => {
    touched.current = true;
    setSel(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const loadingCount = [...sel].filter(id => !data[id]).length;

  const rpt = useMemo(() => {
    const chosen = sessions
      .filter(s => sel.has(s.id) && data[s.id])
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    // 同一 SKU 幾場都有 → 後開嗰場冚前面(最新為準),唔會計兩次
    const bySku = new Map<string, { it: Item; sid: string }>();
    const seen = new Map<string, number>();
    for (const s of chosen) {
      for (const it of data[s.id].items) {
        bySku.set(it.sku, { it, sid: s.id });
        seen.set(it.sku, (seen.get(it.sku) ?? 0) + 1);
      }
    }
    const totals = new Map<string, Map<string, number>>();
    for (const s of chosen) {
      const m = new Map<string, number>();
      for (const e of data[s.id].entries) m.set(e.sku, (m.get(e.sku) ?? 0) + e.qty);
      totals.set(s.id, m);
    }
    let matched = 0, uncounted = 0;
    let shortQty = 0, shortVal = 0, overQty = 0, overVal = 0, estVal = 0, estSkus = 0;
    const diffs: DiffRow[] = [];
    for (const { it, sid } of bySku.values()) {
      const counted = totals.get(sid)?.get(it.sku);
      if (counted == null) { uncounted++; continue; }
      const diff = counted - it.system_qty;
      if (diff === 0) { matched++; continue; }
      const estimated = it.unit_cost == null;
      const unit = Number(it.unit_cost ?? it.price ?? 0);
      const val = diff * unit;
      if (diff < 0) { shortQty -= diff; shortVal -= val; } else { overQty += diff; overVal += val; }
      if (estimated) { estVal += Math.abs(val); estSkus++; }
      diffs.push({ ...it, counted, diff, val, estimated, sid });
    }
    diffs.sort((a, b) => Math.abs(b.val) - Math.abs(a.val));
    const countedSkus = matched + diffs.length;
    const overlap = [...seen.values()].filter(n => n > 1).length;

    // 品牌/類別 LOSS 排行(淨計蝕嗰邊)
    const lossByKey = new Map<string, { qty: number; val: number }>();
    for (const d of diffs) {
      if (d.diff >= 0) continue;
      const key = (rankBy === 'vendor' ? d.vendor : d.product_type) || '(未分類)';
      const cur = lossByKey.get(key) ?? { qty: 0, val: 0 };
      cur.qty -= d.diff;
      cur.val -= d.val;
      lossByKey.set(key, cur);
    }
    const ranking = [...lossByKey.entries()].sort((a, b) => b[1].val - a[1].val).slice(0, 10);
    const grossVal = shortVal + overVal;

    return {
      chosen, diffs, matched, uncounted, countedSkus, overlap,
      shortQty, shortVal, overQty, overVal, netVal: overVal - shortVal,
      estVal, estSkus, estPct: grossVal > 0 ? Math.round((estVal / grossVal) * 100) : 0,
      ranking, maxLoss: ranking.length ? ranking[0][1].val : 0,
      topLoss: diffs.filter(d => d.diff < 0).slice(0, 20),
      total: bySku.size,
    };
  }, [sessions, sel, data, rankBy]);

  const exportCsv = () => {
    const sname = new Map(sessions.map(s => [s.id, s.name]));
    const esc = (v: any) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [
      ['SKU', '貨名', '款式', '品牌', '類別', '場次', '系統數', '實點數', '差異', '成本單價', '差異成本值', '估算(用售價)'].map(esc).join(','),
      ...rpt.diffs.map(d => [
        d.sku, d.product_title, d.variant_title, d.vendor, d.product_type, sname.get(d.sid),
        d.system_qty, d.counted, d.diff,
        (d.unit_cost ?? d.price ?? 0), d.val.toFixed(2), d.estimated ? '是' : '',
      ].map(esc).join(',')),
    ];
    const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `盤點結算_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="space-y-4">
      {/* 場次揀選 */}
      <Card className="border-border/40">
        <CardContent className="p-4">
          <h3 className="text-sm font-semibold">結算報告 <span className="text-xs font-normal text-muted-foreground">勾選要合埋計嘅場次(一輪盤幾場就勾晒嗰幾場;測試場唔勾)</span></h3>
          {sessions.length === 0 && <p className="text-sm text-muted-foreground py-4 text-center">未有盤點場次</p>}
          <div className="mt-2 divide-y divide-border/20">
            {sessions.map(s => {
              const p = progress[s.id] ?? { total: 0, counted: 0 };
              return (
                <label key={s.id} className="flex items-center gap-3 py-2 cursor-pointer hover:bg-muted/20 px-1 rounded">
                  <input type="checkbox" className="h-4 w-4 accent-[hsl(var(--primary))]" checked={sel.has(s.id)} onChange={() => toggle(s.id)} data-testid={`report-sel-${s.id}`} />
                  <span className="min-w-0 flex-1 text-sm truncate">
                    {s.name}
                    <span className={`ml-2 px-1.5 py-0.5 rounded border text-[10px] ${s.status === 'done' ? 'text-emerald-300 border-emerald-500/40 bg-emerald-500/10' : 'text-amber-300 border-amber-500/40 bg-amber-500/10'}`}>
                      {s.status === 'done' ? '已完成' : '進行中'}
                    </span>
                  </span>
                  <span className="text-xs text-muted-foreground tabular-nums shrink-0">
                    已點 {p.counted}/{p.total} · {new Date(s.created_at).toLocaleDateString('zh-HK')}
                  </span>
                </label>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {sel.size === 0 ? (
        <p className="text-sm text-muted-foreground py-6 text-center">上面勾返要計嘅場次</p>
      ) : loadingCount > 0 ? (
        <p className="text-sm text-muted-foreground py-6 text-center animate-pulse">載入緊 {loadingCount} 個場次嘅數據…</p>
      ) : (
        <>
          {/* ① 總差異 */}
          <Card className="border-border/40">
            <CardContent className="p-4">
              <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
                <h3 className="text-sm font-semibold">① 總差異 <span className="text-xs font-normal text-muted-foreground">成本價計</span></h3>
                <button onClick={exportCsv} className="px-3 py-1.5 rounded-md border border-border text-xs font-semibold hover:bg-accent flex items-center gap-1.5" data-testid="button-report-csv">
                  <FileSpreadsheet className="h-3.5 w-3.5" /> 出 CSV(入帳用)
                </button>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="rounded-md border border-red-500/40 bg-red-500/10 p-3">
                  <p className="text-xs text-red-300">蝕(少過系統)</p>
                  <p className="text-xl font-bold tabular-nums text-red-300">{formatCurrency(rpt.shortVal)}</p>
                  <p className="text-[11px] text-red-300/80 tabular-nums">{formatNumber(rpt.shortQty)} 件</p>
                </div>
                <div className="rounded-md border border-sky-500/40 bg-sky-500/10 p-3">
                  <p className="text-xs text-sky-300">多(多過系統)</p>
                  <p className="text-xl font-bold tabular-nums text-sky-300">{formatCurrency(rpt.overVal)}</p>
                  <p className="text-[11px] text-sky-300/80 tabular-nums">{formatNumber(rpt.overQty)} 件</p>
                </div>
                <div className="rounded-md border border-border/40 p-3">
                  <p className="text-xs text-muted-foreground">淨差異</p>
                  <p className={`text-xl font-bold tabular-nums ${rpt.netVal < 0 ? 'text-red-300' : ''}`}>{formatCurrency(rpt.netVal)}</p>
                  <p className="text-[11px] text-muted-foreground">會計埋數用</p>
                </div>
                <div className="rounded-md border border-border/40 p-3">
                  <p className="text-xs text-muted-foreground">準確率</p>
                  <p className="text-xl font-bold tabular-nums">{rpt.countedSkus > 0 ? Math.round((rpt.matched / rpt.countedSkus) * 100) : 0}%</p>
                  <p className="text-[11px] text-muted-foreground tabular-nums">{formatNumber(rpt.matched)}/{formatNumber(rpt.countedSkus)} 款對得上</p>
                </div>
              </div>
              <p className="mt-2 text-[11px] text-muted-foreground">
                覆蓋:已點 {formatNumber(rpt.countedSkus)}/{formatNumber(rpt.total)} 款,未點 {formatNumber(rpt.uncounted)} 款(未點唔當蝕)。
                {rpt.overlap > 0 && ` ${formatNumber(rpt.overlap)} 個 SKU 喺多過一場出現 — 以最新嗰場為準。`}
              </p>
              {rpt.estVal > 0 && (
                <p className="mt-1 text-[11px] text-amber-300">
                  ⚠️ 其中 {formatCurrency(rpt.estVal)}({rpt.estPct}%)嚟自 {formatNumber(rpt.estSkus)} 個未入成本價嘅 SKU,用咗售價估算 — 想準啲就去 Shopify 補返 cost。
                </p>
              )}
              {rpt.countedSkus === 0 && <p className="mt-2 text-xs text-muted-foreground">揀咗嘅場次未有點數紀錄 — 盤咗先有report。</p>}
            </CardContent>
          </Card>

          {/* ② 品牌/類別 LOSS 排行 */}
          <Card className="border-border/40">
            <CardContent className="p-4">
              <div className="flex items-center gap-2 flex-wrap mb-3">
                <h3 className="text-sm font-semibold">② LOSS 排行 <span className="text-xs font-normal text-muted-foreground">邊邊蝕得多(成本價)</span></h3>
                <span className="ml-auto flex gap-1.5">
                  {([['vendor', '品牌'], ['product_type', '類別']] as const).map(([v, label]) => (
                    <button key={v} onClick={() => setRankBy(v)} className={`px-2.5 py-1 rounded-full border text-xs ${rankBy === v ? 'border-primary bg-primary/15 text-primary font-semibold' : 'border-border text-muted-foreground'}`} data-testid={`rank-${v}`}>
                      {label}
                    </button>
                  ))}
                </span>
              </div>
              {rpt.ranking.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4 text-center">冇蝕貨紀錄 🎉</p>
              ) : (
                <div className="space-y-2">
                  {rpt.ranking.map(([key, v], idx) => (
                    <div key={key} className="flex items-center gap-3" data-testid={`rank-row-${idx}`}>
                      <span className="w-40 sm:w-56 text-xs truncate shrink-0" title={key}>{idx + 1}. {key}</span>
                      <div className="flex-1 h-3 rounded-full bg-muted overflow-hidden">
                        <div className="h-full bg-red-500/70" style={{ width: `${rpt.maxLoss > 0 ? Math.max(2, (v.val / rpt.maxLoss) * 100) : 0}%` }} />
                      </div>
                      <span className="text-xs tabular-nums text-red-300 font-semibold shrink-0 w-32 text-right">{formatCurrency(v.val)} · {formatNumber(v.qty)} 件</span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* ③ Top 蝕貨 SKU */}
          <Card className="border-border/40">
            <CardContent className="p-4">
              <h3 className="text-sm font-semibold mb-3">③ Top 蝕貨 SKU <span className="text-xs font-normal text-muted-foreground">查案用,最多 20 款</span></h3>
              {rpt.topLoss.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4 text-center">冇蝕貨紀錄 🎉</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead><tr className="border-b border-border/40 text-muted-foreground">
                      <th className="text-left py-1.5 pr-3">SKU</th><th className="text-left py-1.5 pr-3">貨品</th>
                      <th className="text-left py-1.5 pr-3">品牌</th>
                      <th className="text-right py-1.5 pr-3">系統</th><th className="text-right py-1.5 pr-3">實點</th>
                      <th className="text-right py-1.5 pr-3">差異</th><th className="text-right py-1.5">成本值</th>
                    </tr></thead>
                    <tbody>
                      {rpt.topLoss.map(d => (
                        <tr key={d.sku} className="border-b border-border/20">
                          <td className="py-1.5 pr-3 font-mono">{d.sku}</td>
                          <td className="py-1.5 pr-3">{itemName(d)}</td>
                          <td className="py-1.5 pr-3">{d.vendor ?? ''}</td>
                          <td className="py-1.5 pr-3 text-right tabular-nums">{d.system_qty}</td>
                          <td className="py-1.5 pr-3 text-right tabular-nums">{d.counted}</td>
                          <td className="py-1.5 pr-3 text-right tabular-nums font-bold text-red-300">{d.diff}</td>
                          <td className="py-1.5 text-right tabular-nums font-bold text-red-300">
                            {formatCurrency(d.val)}{d.estimated && <span className="ml-1 text-[10px] text-amber-300 font-normal">估</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
