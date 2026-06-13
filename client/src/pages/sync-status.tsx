/**
 * 同步狀態 Sync Status
 *
 * 逐張 table 顯示最後更新時間 + 行數,一眼睇晒成條數據管道有無斷。
 * 每張 table 有候選 timestamp 欄位列表 (schema 唔統一),逐個試直到有一個查到。
 */
import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  CheckCircle2, AlertTriangle, XCircle, RefreshCw, ExternalLink, Minus,
} from 'lucide-react';

const GITHUB_ACTIONS_URL = 'https://github.com/hmkaibot-bot/helmet-king-dashboard/actions';

interface TableSpec {
  table: string;
  label: string;
  /** Candidate timestamp columns, tried in order until one works */
  tsCols: string[];
  /** daily = 每日排程同步 (遲過 26 小時當失敗); manual = 用戶操作產生, 無排程 */
  cadence: 'daily' | 'manual';
  source: string;
}

const TABLES: TableSpec[] = [
  // Shopify (n8n + GitHub Actions)
  { table: 'shopify_orders',             label: '訂單',        tsCols: ['updated_at', 'created_at'],            cadence: 'daily',  source: 'Shopify' },
  { table: 'shopify_order_lines',        label: '訂單明細',    tsCols: ['created_at'],                          cadence: 'daily',  source: 'Shopify' },
  { table: 'shopify_products',           label: '產品',        tsCols: ['updated_at', 'created_at', 'synced_at'], cadence: 'daily', source: 'Shopify' },
  { table: 'shopify_inventory',          label: '庫存快照',    tsCols: ['synced_at'],                           cadence: 'daily',  source: 'Shopify' },
  // Business Central (GitHub Actions)
  { table: 'bc_inventory',               label: 'BC 庫存',     tsCols: ['updated_at'],                          cadence: 'daily',  source: 'BC' },
  { table: 'bc_sales_invoices',          label: 'BC 銷售單',   tsCols: ['updated_at'],                          cadence: 'daily',  source: 'BC' },
  { table: 'bc_invoice_lines',           label: 'BC 銷售明細', tsCols: ['created_at'],                          cadence: 'daily',  source: 'BC' },
  { table: 'bc_purchase_invoices',       label: 'BC 購貨單',   tsCols: ['updated_at'],                          cadence: 'daily',  source: 'BC' },
  { table: 'bc_purchase_invoice_lines',  label: 'BC 購貨明細', tsCols: ['created_at'],                          cadence: 'daily',  source: 'BC' },
  { table: 'bc_customers',               label: 'BC 客戶',     tsCols: ['synced_at'], cadence: 'daily', source: 'BC' },
  // Marsello / Meta (n8n)
  { table: 'marsello_customers',         label: '會員',        tsCols: ['updated_at', 'synced_at', 'created_at'], cadence: 'daily', source: 'Marsello' },
  { table: 'meta_campaigns',             label: '廣告活動',    tsCols: ['synced_at'],    cadence: 'manual', source: 'Meta' },
  { table: 'meta_ad_insights',           label: '廣告成效',    tsCols: ['synced_at', 'date'],    cadence: 'manual', source: 'Meta' },
  // Dashboard 內部 (用戶操作)
  { table: 'promotions',                 label: '推廣活動',    tsCols: ['updated_at', 'created_at'],            cadence: 'manual', source: '內部' },
  { table: 'promotion_items',            label: '推廣商品',    tsCols: ['assigned_at'],            cadence: 'manual', source: '內部' },
  { table: 'dead_stock_reviews',         label: '死貨審核',    tsCols: ['updated_at', 'created_at'],            cadence: 'manual', source: '內部' },
  { table: 'dead_stock_audit_log',       label: '死貨記錄',    tsCols: ['changed_at'],                          cadence: 'manual', source: '內部' },
  { table: 'garage_marsello_queue',      label: '積分隊列',    tsCols: ['updated_at', 'created_at'],            cadence: 'manual', source: '內部' },
];

type Health = 'fresh' | 'stale' | 'failed' | 'none' | 'error';

interface TableStatus {
  spec: TableSpec;
  loading: boolean;
  lastUpdate: Date | null;
  tsCol: string | null;
  rowCount: number | null;
  health: Health;
  error?: string;
}

async function fetchTableStatus(spec: TableSpec): Promise<TableStatus> {
  // Row count (head request, no data transfer)
  let rowCount: number | null = null;
  try {
    const { count, error } = await supabase
      .from(spec.table)
      .select('*', { count: 'exact', head: true });
    if (!error) rowCount = count ?? 0;
  } catch { /* keep null */ }

  // Latest timestamp — try candidate columns in order
  let lastUpdate: Date | null = null;
  let tsCol: string | null = null;
  let lastError = '';
  for (const col of spec.tsCols) {
    const { data, error } = await supabase
      .from(spec.table)
      .select(col)
      .not(col, 'is', null)
      .order(col, { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) { lastError = error.message; continue; }
    tsCol = col;
    const raw = (data as Record<string, string> | null)?.[col];
    if (raw) lastUpdate = new Date(raw);
    break;
  }

  let health: Health;
  if (!tsCol && lastError) health = 'error';
  else if (!lastUpdate) health = 'none';
  else if (spec.cadence === 'manual') health = 'fresh';
  else {
    const ageHours = (Date.now() - lastUpdate.getTime()) / 3600000;
    health = ageHours <= 26 ? 'fresh' : ageHours <= 48 ? 'stale' : 'failed';
  }

  return { spec, loading: false, lastUpdate, tsCol, rowCount, health, error: tsCol ? undefined : lastError };
}

function fmtHK(d: Date): string {
  const hk = new Date(d.getTime() + (d.getTimezoneOffset() + 480) * 60000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${hk.getFullYear()}-${p(hk.getMonth() + 1)}-${p(hk.getDate())} ${p(hk.getHours())}:${p(hk.getMinutes())}`;
}

function agoLabel(d: Date): string {
  const mins = Math.floor((Date.now() - d.getTime()) / 60000);
  if (mins < 60) return `${mins} 分鐘前`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours} 小時前`;
  return `${Math.floor(hours / 24)} 日前`;
}

const HEALTH_CFG: Record<Health, { Icon: typeof CheckCircle2; color: string; label: string }> = {
  fresh:  { Icon: CheckCircle2,  color: 'text-emerald-400', label: '正常' },
  stale:  { Icon: AlertTriangle, color: 'text-amber-400',   label: '延遲' },
  failed: { Icon: XCircle,       color: 'text-red-400',     label: '同步失敗' },
  none:   { Icon: Minus,         color: 'text-muted-foreground', label: '無數據' },
  error:  { Icon: XCircle,       color: 'text-red-400',     label: '讀取失敗' },
};

export default function SyncStatusPage() {
  const [statuses, setStatuses] = useState<TableStatus[]>(
    TABLES.map(spec => ({ spec, loading: true, lastUpdate: null, tsCol: null, rowCount: null, health: 'none' as Health })),
  );
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    setStatuses(TABLES.map(spec => ({ spec, loading: true, lastUpdate: null, tsCol: null, rowCount: null, health: 'none' as Health })));
    // 並行查全部 table,每完成一張即時更新
    await Promise.all(
      TABLES.map(async (spec, i) => {
        const st = await fetchTableStatus(spec);
        setStatuses(prev => prev.map((p, j) => (j === i ? st : p)));
      }),
    );
    setRefreshing(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const dailyStatuses = statuses.filter(s => s.spec.cadence === 'daily');
  const problemCount = dailyStatuses.filter(s => !s.loading && (s.health === 'failed' || s.health === 'error')).length;
  const staleCount = dailyStatuses.filter(s => !s.loading && s.health === 'stale').length;
  const allLoaded = statuses.every(s => !s.loading);

  const sources = Array.from(new Set(TABLES.map(t => t.source)));

  return (
    <div className="space-y-4">
      {/* Overall banner */}
      <Card className="border-border/40">
        <CardContent className="p-4 flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-2.5">
            {!allLoaded ? (
              <><RefreshCw className="h-5 w-5 text-sky-400 animate-spin" /><span className="text-sm">檢查中…</span></>
            ) : problemCount > 0 ? (
              <><XCircle className="h-5 w-5 text-red-400" /><span className="text-sm font-medium text-red-400">{problemCount} 張 table 同步失敗 — 請檢查 GitHub Actions / n8n</span></>
            ) : staleCount > 0 ? (
              <><AlertTriangle className="h-5 w-5 text-amber-400" /><span className="text-sm font-medium text-amber-400">{staleCount} 張 table 延遲</span></>
            ) : (
              <><CheckCircle2 className="h-5 w-5 text-emerald-400" /><span className="text-sm font-medium text-emerald-400">數據管道正常</span></>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={load}
              disabled={refreshing}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors disabled:opacity-40"
              data-testid="button-refresh-sync-status"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} /> 重新檢查
            </button>
            <a
              href={GITHUB_ACTIONS_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
            >
              <ExternalLink className="h-3.5 w-3.5" /> GitHub Actions
            </a>
          </div>
        </CardContent>
      </Card>

      {/* Per-source tables */}
      {sources.map(source => (
        <Card key={source} className="border-border/40">
          <CardHeader className="pb-2 pt-4 px-4">
            <CardTitle className="text-sm font-medium">{source}</CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border/50 text-muted-foreground">
                  <th className="py-2 text-left font-medium">Table</th>
                  <th className="py-2 text-left font-medium">狀態</th>
                  <th className="py-2 text-left font-medium">最後更新 (HKT)</th>
                  <th className="py-2 text-right font-medium">行數</th>
                </tr>
              </thead>
              <tbody>
                {statuses.filter(s => s.spec.source === source).map(s => {
                  const cfg = HEALTH_CFG[s.health];
                  return (
                    <tr key={s.spec.table} className="border-b border-border/20">
                      <td className="py-2">
                        <span className="font-medium">{s.spec.label}</span>{' '}
                        <span className="text-muted-foreground font-mono text-[10px]">{s.spec.table}</span>
                      </td>
                      <td className="py-2">
                        {s.loading ? (
                          <Skeleton className="h-4 w-16" />
                        ) : (
                          <span className={`inline-flex items-center gap-1 ${cfg.color}`} title={s.error}>
                            <cfg.Icon className="h-3.5 w-3.5" /> {cfg.label}
                            {s.spec.cadence === 'manual' && s.health === 'fresh' && (
                              <span className="text-muted-foreground font-normal">(手動)</span>
                            )}
                          </span>
                        )}
                      </td>
                      <td className="py-2 tabular-nums">
                        {s.loading ? <Skeleton className="h-4 w-32" /> : s.lastUpdate ? (
                          <>
                            {fmtHK(s.lastUpdate)}{' '}
                            <span className="text-muted-foreground">({agoLabel(s.lastUpdate)})</span>
                          </>
                        ) : '—'}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {s.loading ? <Skeleton className="h-4 w-12 ml-auto" /> : s.rowCount !== null ? s.rowCount.toLocaleString() : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </CardContent>
        </Card>
      ))}

      <p className="text-[11px] text-muted-foreground">
        每日同步 table 超過 26 小時無更新會標示「延遲」,超過 48 小時標示「同步失敗」。
        手動 table 由 dashboard 操作產生,無排程。同步失敗時請去 GitHub Actions 手動重跑對應 workflow。
      </p>
    </div>
  );
}
