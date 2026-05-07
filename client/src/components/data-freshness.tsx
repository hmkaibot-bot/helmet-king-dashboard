import { useEffect, useState } from 'react';
import { CheckCircle2, AlertTriangle, RefreshCw, XCircle } from 'lucide-react';
import { supabase } from '@/lib/supabase';

type FreshnessState = {
  loading: boolean;
  lastUpdate: Date | null;
  status: 'fresh' | 'stale' | 'syncing' | 'failed';
  details: string;
};

/**
 * Reads the latest synced_at across the key sales tables to compute a single
 * "last update" timestamp shown across every retail/performance page.
 *
 * Status rules (HKT):
 *  fresh   : last update is today after 02:00 HKT
 *  syncing : last update is between yesterday 23:59 and today 03:00 HKT
 *            (the sync window is running)
 *  stale   : last update is older than today 03:00 HKT but ≤ 24h ago
 *  failed  : last update is > 24h ago
 */
export function useDataFreshness(): FreshnessState {
  const [state, setState] = useState<FreshnessState>({
    loading: true,
    lastUpdate: null,
    status: 'syncing',
    details: '',
  });

  useEffect(() => {
    (async () => {
      try {
        // Take the max(updated_at) across the most-recently-written orders + lines.
        // We avoid hitting low-volume tables (Marsello / BC) so we don't get tripped
        // up by their slower cadence.
        const { data: orderRow } = await supabase
          .from('shopify_orders')
          .select('updated_at')
          .order('updated_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        const last = orderRow?.updated_at ? new Date(orderRow.updated_at) : null;
        if (!last) {
          setState({
            loading: false,
            lastUpdate: null,
            status: 'failed',
            details: '無法讀取最後更新時間',
          });
          return;
        }

        // HKT now & boundary timestamps
        const now = new Date();
        const hktNow = new Date(now.getTime() + (now.getTimezoneOffset() + 480) * 60000);
        const todayMid = new Date(hktNow);
        todayMid.setHours(0, 0, 0, 0);
        const today2am = new Date(todayMid.getTime() + 2 * 3600 * 1000);
        const today3am = new Date(todayMid.getTime() + 3 * 3600 * 1000);
        const ageHours = (hktNow.getTime() - last.getTime()) / 3600000;

        let status: FreshnessState['status'];
        let details = '';
        if (last >= today2am) {
          status = 'fresh';
          details = '已更新';
        } else if (hktNow < today3am && ageHours < 6) {
          status = 'syncing';
          details = '更新中';
        } else if (ageHours <= 24) {
          status = 'stale';
          details = '延遲（過 24h 仍未更新會標示同步失敗）';
        } else {
          status = 'failed';
          details = '同步失敗 — 請檢查 GitHub Actions';
        }

        setState({ loading: false, lastUpdate: last, status, details });
      } catch (err) {
        console.error(err);
        setState({
          loading: false,
          lastUpdate: null,
          status: 'failed',
          details: '讀取狀態時發生錯誤',
        });
      }
    })();
  }, []);

  return state;
}

function fmtHK(d: Date): string {
  // d is UTC instant; show in HKT
  const hk = new Date(d.getTime() + (d.getTimezoneOffset() + 480) * 60000);
  const y = hk.getFullYear();
  const m = String(hk.getMonth() + 1).padStart(2, '0');
  const day = String(hk.getDate()).padStart(2, '0');
  const hh = String(hk.getHours()).padStart(2, '0');
  const mm = String(hk.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${day} ${hh}:${mm} HKT`;
}

export function DataFreshnessBadge() {
  const { loading, lastUpdate, status, details } = useDataFreshness();
  if (loading) {
    return (
      <div className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        <RefreshCw className="h-3.5 w-3.5 animate-spin" />
        <span>讀取狀態…</span>
      </div>
    );
  }

  const cfg =
    status === 'fresh'
      ? { Icon: CheckCircle2, color: 'text-emerald-400', label: '已更新' }
      : status === 'syncing'
      ? { Icon: RefreshCw, color: 'text-sky-400', label: '更新中' }
      : status === 'stale'
      ? { Icon: AlertTriangle, color: 'text-amber-400', label: '延遲' }
      : { Icon: XCircle, color: 'text-red-400', label: '同步失敗' };

  const { Icon, color, label } = cfg;

  return (
    <div
      className="inline-flex items-center gap-1.5 text-xs"
      data-testid="data-freshness"
      title={details}
    >
      <Icon className={`h-3.5 w-3.5 ${color} ${status === 'syncing' ? 'animate-spin' : ''}`} />
      <span className={color}>{label}</span>
      {lastUpdate && (
        <span className="text-muted-foreground">· 最後更新 {fmtHK(lastUpdate)}</span>
      )}
    </div>
  );
}
