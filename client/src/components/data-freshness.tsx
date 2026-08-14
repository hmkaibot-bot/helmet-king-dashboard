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
 * Sync 心跳嚟自 shopify_inventory.synced_at — 夜間 pipeline(02:00-02:50 HKT
 * 一 batch)每晚重寫成張表,max(synced_at) 就係「尋晚有冇跑過」嘅真時間。
 *
 * 以前讀 max(shopify_orders.updated_at) — 嗰個係「最後一張單幾點改動」
 * (business time),收舖後成晚唔郁,搞到日日朝早都誤報「延遲」。
 * 而家張單時間淨係擺入 tooltip 做參考。
 *
 * Status rules(sync 心跳年齡):
 *  fresh   : ≤26h(尋晚跑咗)
 *  syncing : >26h 但而家喺 02:00-03:30 HKT 窗口內(可能跑緊)
 *  stale   : 26-50h(尋晚失咗場;06:00/06:30 HKT 有後備補跑)
 *  failed  : >50h(連後備都冇跑,要查 GitHub Actions)
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
        const [{ data: syncRow }, { data: orderRow }] = await Promise.all([
          supabase
            .from('shopify_inventory')
            .select('synced_at')
            .not('synced_at', 'is', null)
            .order('synced_at', { ascending: false })
            .limit(1)
            .maybeSingle(),
          supabase
            .from('shopify_orders')
            .select('updated_at')
            .order('updated_at', { ascending: false })
            .limit(1)
            .maybeSingle(),
        ]);

        const lastSync  = (syncRow as any)?.synced_at ? new Date((syncRow as any).synced_at) : null;
        const lastOrder = orderRow?.updated_at ? new Date(orderRow.updated_at) : null;
        // synced_at 讀唔到(RLS/舊數據)就 fallback 舊指標,badge 唔好死
        const last = lastSync ?? lastOrder;
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
        const today2am  = new Date(todayMid.getTime() + 2 * 3600 * 1000);
        const today330  = new Date(todayMid.getTime() + 3.5 * 3600 * 1000);
        const ageHours = (hktNow.getTime() - last.getTime()) / 3600000;

        const orderNote = lastOrder ? `（最新訂單 ${fmtHK(lastOrder)}）` : '';
        let status: FreshnessState['status'];
        let details = '';
        if (ageHours <= 26) {
          status = 'fresh';
          details = `尋晚 sync 完成${orderNote}`;
        } else if (hktNow >= today2am && hktNow <= today330) {
          status = 'syncing';
          details = '夜間更新窗口進行中';
        } else if (ageHours <= 50) {
          status = 'stale';
          details = `尋晚 sync 冇跑到,06:00 後備會補${orderNote}`;
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
