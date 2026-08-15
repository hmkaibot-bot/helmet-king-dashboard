import React, { Fragment, useState } from 'react';
import { Store, Globe, Truck, ChevronRight, ChevronDown, X } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatCurrency, formatNumber, formatPercent } from '@/lib/format';
import { calcDelta } from '@/lib/weekly-review-utils';

// ── 週報/月報共用嘅細組件 ────────────────────────────────────

// ─── Modal shell ─────────────────────────────────────────────────────────────
function Modal({
  open, onClose, title, subtitle, children,
}: {
  open: boolean; onClose: () => void; title: string; subtitle?: string;
  children: React.ReactNode;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="bg-card border border-border/40 rounded-xl shadow-2xl w-full max-w-3xl max-h-[85vh] overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-border/40">
          <div>
            <h3 className="text-sm font-semibold">{title}</h3>
            {subtitle && <div className="text-[13px] text-muted-foreground mt-0.5">{subtitle}</div>}
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-accent/50">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-4 overflow-y-auto max-h-[calc(85vh-60px)]">{children}</div>
      </div>
    </div>
  );
}

// ─── Channel icon ────────────────────────────────────────────────────────────
function ChannelIcon({ name }: { name: string }) {
  if (name === '門市 POS') return <Store className="h-4 w-4 text-amber-400" />;
  if (name === '網店 Online') return <Globe className="h-4 w-4 text-sky-400" />;
  return <Truck className="h-4 w-4 text-violet-400" />;
}


// 一分鐘總結入面嘅行內對比:(vs 上期 +12.3%)
function DeltaInline({ cur, prev, label }: { cur: number; prev: number; label: string }) {
  const d = calcDelta(cur, prev);
  if (d == null) return null;
  const color = d > 0 ? 'text-emerald-400' : d < 0 ? 'text-red-400' : 'text-muted-foreground';
  return (
    <span className="text-[13px] text-muted-foreground">
      (vs {label} <span className={`${color} tabular-nums`}>{d > 0 ? '+' : ''}{d.toFixed(1)}%</span>)
    </span>
  );
}

// 表格入面嘅對比 cell:+12.3% / −8.1% / 新
function DeltaCell({ cur, prev }: { cur: number; prev: number }) {
  if (prev === 0 && cur > 0) return <span className="text-[13px] text-sky-400">新</span>;
  const d = calcDelta(cur, prev);
  if (d == null) return <span className="text-muted-foreground/40">—</span>;
  const color = d > 0 ? 'text-emerald-400' : d < 0 ? 'text-red-400' : 'text-muted-foreground';
  return <span className={`${color} tabular-nums text-[13px]`}>{d > 0 ? '+' : ''}{d.toFixed(1)}%</span>;
}

function YoyLine({ label, cur, refValue, fmt }: { label: string; cur: number; refValue: number; fmt: (v: number) => string }) {
  const d = calcDelta(cur, refValue);
  if (d == null) {
    return <div className="px-3">{label}: 去年無數據</div>;
  }
  const color = d > 0 ? 'text-emerald-400' : d < 0 ? 'text-red-400' : 'text-muted-foreground';
  return (
    <div className="px-3">
      {label}: {fmt(refValue)} <span className={color}>({d > 0 ? '+' : ''}{d.toFixed(1)}%)</span>
    </div>
  );
}

function TopList({ rows, prevMap }: {
  rows: { name: string; revenue: number; qty: number }[];
  prevMap?: Record<string, { revenue: number; qty: number }>;
}) {
  if (rows.length === 0) return <div className="text-sm text-muted-foreground">本期暫無資料</div>;
  const max = Math.max(...rows.map(r => r.revenue));
  return (
    <div className="space-y-2">
      {rows.map((r, i) => (
        <div key={r.name + i} className="flex items-center gap-3 text-sm">
          <span className="text-muted-foreground w-5 text-[13px]">#{i + 1}</span>
          <div className="flex-1">
            <div className="flex items-baseline justify-between">
              <span className="font-medium truncate">{r.name}</span>
              <span className="text-foreground tabular-nums ml-3">
                {formatCurrency(r.revenue)}
                {prevMap && <> <DeltaCell cur={r.revenue} prev={prevMap[r.name]?.revenue || 0} /></>}
              </span>
            </div>
            <div className="h-1.5 bg-accent/30 rounded mt-1 overflow-hidden">
              <div
                className="h-full bg-primary"
                style={{ width: max > 0 ? `${(r.revenue / max) * 100}%` : 0 }}
              />
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">{formatNumber(r.qty)} 件</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function PerformanceTable({
  title, rows, prevMap, onClick,
}: {
  title: string;
  rows: { name: string; revenue: number; qty: number }[];
  prevMap?: Record<string, { revenue: number; qty: number }>;
  onClick: (name: string) => void;
}) {
  return (
    <Card className="border-border/40">
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <div className="text-sm text-muted-foreground">本期暫無資料</div>
        ) : (
          <div className="overflow-x-auto max-h-[420px]">
            <table className="w-full text-sm">
              <thead className="text-[13px] text-muted-foreground border-b border-border/40 sticky top-0 bg-card">
                <tr>
                  <th className="text-left py-2.5 px-2">名稱</th>
                  <th className="text-right py-2.5 px-2">銷售額</th>
                  <th className="text-right py-2.5 px-2">vs 上期</th>
                  <th className="text-right py-2.5 px-2">件數</th>
                  <th className="text-right py-2.5 px-2">AOV</th>
                  <th className="w-6"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr
                    key={r.name}
                    onClick={() => onClick(r.name)}
                    className="border-b border-border/20 hover:bg-accent/30 cursor-pointer"
                  >
                    <td className="py-2.5 px-2 font-medium">{r.name}</td>
                    <td className="py-2.5 px-2 text-right">{formatCurrency(r.revenue)}</td>
                    <td className="py-2.5 px-2 text-right">
                      <DeltaCell cur={r.revenue} prev={prevMap?.[r.name]?.revenue || 0} />
                    </td>
                    <td className="py-2.5 px-2 text-right">{formatNumber(r.qty)}</td>
                    <td className="py-2.5 px-2 text-right">
                      {r.qty > 0 ? formatCurrency(r.revenue / r.qty) : '—'}
                    </td>
                    <td className="px-2"><ChevronRight className="h-3.5 w-3.5 text-muted-foreground" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}


function DrillTable({
  variants, parent,
}: {
  variants: { title: string; qty: number; revenue: number; skus: Record<string, { sku: string; title: string; qty: number; revenue: number }> }[];
  parent: string;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const totalRev = variants.reduce((s, v) => s + v.revenue, 0);

  return (
    <table className="w-full text-sm">
      <thead className="text-[13px] text-muted-foreground border-b border-border/40">
        <tr>
          <th className="text-left py-2.5 px-2">產品 (Variant)</th>
          <th className="text-right py-2.5 px-2">件數</th>
          <th className="text-right py-2.5 px-2">銷售額</th>
          <th className="text-right py-2.5 px-2">平均單價</th>
          <th className="text-right py-2.5 px-2">佔比</th>
        </tr>
      </thead>
      <tbody>
        {variants.map(v => {
          const open = expanded.has(v.title);
          const skuList = Object.values(v.skus).sort((a, b) => b.revenue - a.revenue);
          return (
            <Fragment key={v.title}>
              <tr
                onClick={() => {
                  setExpanded(s => {
                    const n = new Set(s);
                    if (n.has(v.title)) n.delete(v.title); else n.add(v.title);
                    return n;
                  });
                }}
                className="border-b border-border/20 hover:bg-accent/30 cursor-pointer"
              >
                <td className="py-2.5 px-2 font-medium">
                  <span className="inline-flex items-center gap-1">
                    {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                    {v.title}
                  </span>
                </td>
                <td className="py-2.5 px-2 text-right">{formatNumber(v.qty)}</td>
                <td className="py-2.5 px-2 text-right">{formatCurrency(v.revenue)}</td>
                <td className="py-2.5 px-2 text-right">
                  {v.qty > 0 ? formatCurrency(v.revenue / v.qty) : '—'}
                </td>
                <td className="py-2.5 px-2 text-right text-[13px] text-muted-foreground">
                  {totalRev > 0 ? formatPercent((v.revenue / totalRev) * 100) : '—'}
                </td>
              </tr>
              {open && skuList.map(s => (
                <tr key={v.title + s.sku} className="bg-muted/10 border-b border-border/10">
                  <td className="py-1.5 pl-10 pr-2 text-[13px] text-muted-foreground">
                    SKU: {s.sku}
                  </td>
                  <td className="py-1.5 px-2 text-right text-[13px]">{formatNumber(s.qty)}</td>
                  <td className="py-1.5 px-2 text-right text-[13px]">{formatCurrency(s.revenue)}</td>
                  <td className="py-1.5 px-2 text-right text-[13px]">
                    {s.qty > 0 ? formatCurrency(s.revenue / s.qty) : '—'}
                  </td>
                  <td></td>
                </tr>
              ))}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

export { Modal, ChannelIcon, DeltaInline, DeltaCell, YoyLine, TopList, PerformanceTable, DrillTable };

