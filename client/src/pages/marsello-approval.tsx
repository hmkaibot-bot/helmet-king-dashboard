/**
 * Garage → Marsello Points Approval Queue
 *
 * SETUP REQUIRED:
 * 1. Run /hk_dashboard/sql/garage_marsello_queue.sql in Supabase SQL Editor
 * 2. Get Marsello Store API Key from: app.marsello.com → Settings → Integrations → API Keys
 *
 * HOW IT WORKS:
 * - "掃描發票" scans BC Garage invoices and queues them for review (READ ONLY — nothing written to Marsello)
 * - You review each match and click "Approve" or "Reject"
 * - Approved items are synced to Marsello only after you approve them
 */
import { useEffect, useState, useMemo } from 'react';
import { supabase } from '@/lib/supabase';
import { queryAllPages } from '@/lib/query-helpers';
import { formatCurrency, formatNumber } from '@/lib/format';
import {
  CheckCircle2, XCircle, Clock, Zap, AlertTriangle, RefreshCw,
  Users, Search, ChevronDown, ChevronUp, Info, User,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';

// ── Types ─────────────────────────────────────────────────────
type QueueStatus = 'pending' | 'approved' | 'rejected' | 'synced' | 'error';
type MatchType   = 'exact_email' | 'name_match' | 'phone_match' | 'manual' | 'unmatched';

interface QueueItem {
  id: number;
  bc_invoice_id: string;
  bc_invoice_number: string;
  bc_invoice_date: string;
  bc_customer_number: string;
  bc_customer_name: string;
  bc_customer_email: string | null;
  invoice_amount: number;
  marsello_customer_id: string | null;
  marsello_customer_name: string | null;
  marsello_customer_email: string | null;
  marsello_current_points: number | null;
  match_type: MatchType;
  status: QueueStatus;
  notes: string | null;
  approved_at: string | null;
  synced_at: string | null;
  created_at: string;
}

interface MarselloCustomer {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  loyalty_points: number | null;
}

// ── Excluded customer numbers (internal/maintenance accounts) ───
const EXCLUDED_CUSTOMERS = new Set(['C012885', 'C013052']);

// ── Phone normalization ─────────────────────────────────────────
function normalizePhone(raw: string | null | undefined): string {
  if (!raw) return '';
  let p = raw.replace(/[\s\-\(\)]/g, '');
  // Strip HK country code: +852, 852, +
  if (p.startsWith('+852')) p = p.slice(4);
  else if (p.startsWith('852') && p.length > 10) p = p.slice(3);
  else if (p.startsWith('+')) p = p.slice(1);
  return p.replace(/\D/g, '');
}

function StatusBadge({ status }: { status: QueueStatus }) {
  const cfg: Record<QueueStatus, { label: string; cls: string }> = {
    pending:  { label: '待審批', cls: 'bg-amber-500/15 text-amber-400 border-amber-500/30' },
    approved: { label: '已批准', cls: 'bg-green-500/15 text-green-400 border-green-500/30' },
    rejected: { label: '已拒絕', cls: 'bg-red-500/15 text-red-400 border-red-500/30' },
    synced:   { label: '已同步', cls: 'bg-blue-500/15 text-blue-400 border-blue-500/30' },
    error:    { label: '錯誤', cls: 'bg-red-500/20 text-red-300 border-red-500/40' },
  };
  const { label, cls } = cfg[status] || cfg.pending;
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-medium ${cls}`}>
      {label}
    </span>
  );
}

function MatchBadge({ type }: { type: MatchType }) {
  const cfg: Record<MatchType, { label: string; cls: string }> = {
    exact_email: { label: '✅ Email 匹配', cls: 'text-green-400' },
    name_match:  { label: '🔤 姓名匹配',   cls: 'text-amber-400' },
    phone_match: { label: '📱 電話匹配',   cls: 'text-blue-400' },
    manual:      { label: '✋ 手動設定',   cls: 'text-purple-400' },
    unmatched:   { label: '❓ 未找到',     cls: 'text-red-400' },
  };
  const { label, cls } = cfg[type] || cfg.unmatched;
  return <span className={`text-[10px] ${cls}`}>{label}</span>;
}

// ── Main Component ────────────────────────────────────────────
export default function MarselloApprovalPage() {
  const [queue, setQueue]             = useState<QueueItem[]>([]);
  const [loading, setLoading]         = useState(true);
  const [scanning, setScanning]       = useState(false);
  const [actionLoading, setActionLoading] = useState<number | null>(null);
  const [statusFilter, setStatusFilter]   = useState<QueueStatus | 'all'>('pending');
  const [searchText, setSearchText]       = useState('');
  const [tableExists, setTableExists]     = useState<boolean | null>(null);
  const [expandedId, setExpandedId]       = useState<number | null>(null);
  const [marselloApiKey, setMarselloApiKey] = useState('');
  const [showApiKeyInput, setShowApiKeyInput] = useState(false);

  const MARSELLO_STORE_ID = '60e83220c3e76f0fc4e32df2';

  // ── Load queue ──────────────────────────────────────────────
  async function loadQueue() {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('garage_marsello_queue')
        .select('*')
        .order('bc_invoice_date', { ascending: false })
        .limit(200);
      if (error) {
        if (error.message?.includes('does not exist') || error.code === '42P01') {
          setTableExists(false);
        } else {
          console.error('Queue load error:', error);
        }
        setQueue([]);
      } else {
        setTableExists(true);
        setQueue(data || []);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadQueue(); }, []);

  // ── Scan BC Garage invoices → populate queue ───────────────
  async function scanInvoices() {
    setScanning(true);
    try {
      // 1. Get all GARAGE invoices from last 90 days
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - 90);
      const cutoffStr = cutoff.toISOString().slice(0, 10);

      const [invoices, marselloCustomers, bcCustomers, existingIds] = await Promise.all([
        queryAllPages('bc_sales_invoices',
          'id,number,invoice_date,customer_number,customer_name,total_amount_incl_tax',
          [
            { column: 'dimension1_code', op: 'eq', value: 'GARAGE' },
            { column: 'invoice_date', op: 'gte', value: cutoffStr },
          ]
        ),
        queryAllPages('marsello_customers', 'id,email,first_name,last_name,phone,loyalty_points'),
        // BC customer master (for phone numbers)
        queryAllPages('bc_customers', 'number,display_name,phone_number,email'),
        // Already-queued invoice IDs
        (async () => {
          const { data } = await supabase.from('garage_marsello_queue').select('bc_invoice_id');
          return new Set((data || []).map((r: any) => r.bc_invoice_id));
        })(),
      ]);

      // 2. Filter: exclude internal accounts + already-queued
      const newInvoices = (invoices as any[]).filter((inv: any) =>
        !existingIds.has(inv.id) &&
        !EXCLUDED_CUSTOMERS.has(inv.customer_number)
      );
      if (newInvoices.length === 0) {
        alert('沒有新發票需要處理 (No new invoices to process)');
        return;
      }

      // 3. Build lookup maps
      // BC customer_number → phone
      const bcPhoneMap: Record<string, string> = {};
      const bcEmailMap: Record<string, string> = {};
      (bcCustomers as any[]).forEach((c: any) => {
        if (c.phone_number) bcPhoneMap[c.number] = c.phone_number;
        if (c.email)        bcEmailMap[c.number] = c.email;
      });

      // Marsello: normalized phone → customer (for fast lookup)
      const marselloList = marselloCustomers as MarselloCustomer[];
      const marselloByPhone: Record<string, MarselloCustomer> = {};
      const marselloByEmail: Record<string, MarselloCustomer> = {};
      marselloList.forEach(m => {
        const np = normalizePhone(m.phone);
        if (np && np.length >= 8) marselloByPhone[np] = m;
        if (m.email) marselloByEmail[m.email.toLowerCase().trim()] = m;
      });

      // 4. Match: phone first, then email, NO name matching
      const toInsert: any[] = [];
      for (const inv of newInvoices) {
        let matched: MarselloCustomer | null = null;
        let matchType: MatchType = 'unmatched';
        const custNum = inv.customer_number || '';

        // Priority 1: Phone match (with normalization)
        const bcPhone = bcPhoneMap[custNum];
        if (bcPhone) {
          const np = normalizePhone(bcPhone);
          if (np && marselloByPhone[np]) {
            matched = marselloByPhone[np];
            matchType = 'phone_match';
          }
        }

        // Priority 2: Email match (fallback)
        if (!matched) {
          const bcEmail = bcEmailMap[custNum];
          if (bcEmail) {
            const ne = bcEmail.toLowerCase().trim();
            if (marselloByEmail[ne]) {
              matched = marselloByEmail[ne];
              matchType = 'exact_email';
            }
          }
        }

        // No name matching — too many false positives

        toInsert.push({
          bc_invoice_id:         inv.id,
          bc_invoice_number:     inv.number || '',
          bc_invoice_date:       inv.invoice_date,
          bc_customer_number:    custNum,
          bc_customer_name:      inv.customer_name || '',
          bc_customer_email:     bcEmailMap[custNum] || null,
          invoice_amount:        parseFloat(inv.total_amount_incl_tax) || 0,
          marsello_customer_id:   matched?.id || null,
          marsello_customer_name: matched ? `${matched.first_name || ''} ${matched.last_name || ''}`.trim() : null,
          marsello_customer_email: matched?.email || null,
          marsello_current_points: matched?.loyalty_points || null,
          match_type: matchType,
          status: 'pending',
        });
      }

      // 4. Insert into queue (in batches of 50)
      const BATCH = 50;
      for (let i = 0; i < toInsert.length; i += BATCH) {
        const { error } = await supabase
          .from('garage_marsello_queue')
          .upsert(toInsert.slice(i, i + BATCH), { onConflict: 'bc_invoice_id' });
        if (error) console.error('Insert error:', error);
      }

      await loadQueue();
      alert(`已掃描 ${newInvoices.length} 張新發票，加入待審批隊列。\n(${newInvoices.length} new invoices queued for review)`);
    } catch (e) {
      console.error('Scan error:', e);
      alert('掃描失敗，請檢查控制台錯誤');
    } finally {
      setScanning(false);
    }
  }

  // ── Approve action ─────────────────────────────────────────
  async function approveItem(item: QueueItem) {
    if (!item.marsello_customer_id) {
      alert('此發票未找到對應的 Marsello 客戶，請先手動設定客戶匹配。\n(No Marsello customer matched — set manually first)');
      return;
    }
    setActionLoading(item.id);
    try {
      // Mark as approved in queue first
      await supabase.from('garage_marsello_queue').update({
        status: 'approved',
        approved_at: new Date().toISOString(),
      }).eq('id', item.id);

      // If we have the Marsello Store API key, submit the order now
      const apiKey = marselloApiKey || localStorage.getItem('marsello_store_api_key') || '';
      if (apiKey) {
        await syncToMarsello(item, apiKey);
      } else {
        // Approved but not yet synced — will sync when API key is configured
        alert(
          `✅ 已批准 Invoice ${item.bc_invoice_number}\n\n` +
          `要自動加分到 Marsello，請在頁面上方輸入 Marsello Store API Key。\n` +
          `API Key 位置：app.marsello.com → Settings → Integrations → API Keys\n\n` +
          `(Approved! Configure Marsello Store API Key to auto-sync points)`
        );
      }
      await loadQueue();
    } finally {
      setActionLoading(null);
    }
  }

  // ── Sync approved item to Marsello ────────────────────────
  async function syncToMarsello(item: QueueItem, apiKey: string) {
    try {
      const resp = await fetch(
        `https://api.marsello.com/v1/stores/${MARSELLO_STORE_ID}/orders`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            externalOrderId: `BC-GARAGE-${item.bc_invoice_number}`,
            customerId:      item.marsello_customer_id,
            totalPrice:      item.invoice_amount,
            currency:        'HKD',
            createdAt:       item.bc_invoice_date + 'T00:00:00Z',
            source:          'BC-GARAGE',
            lineItems:       [],
          }),
        }
      );

      const responseText = await resp.text();
      await supabase.from('garage_marsello_queue').update({
        status:        resp.ok ? 'synced' : 'error',
        synced_at:     resp.ok ? new Date().toISOString() : null,
        sync_response: responseText.slice(0, 500),
      }).eq('id', item.id);

      if (resp.ok) {
        alert(`✅ 積分已成功同步到 Marsello！\nInvoice: ${item.bc_invoice_number}\nCustomer: ${item.marsello_customer_name}`);
      } else {
        alert(`⚠️ Marsello 同步失敗 (HTTP ${resp.status})\n${responseText.slice(0, 200)}\n\n請檢查 Store API Key 是否正確。`);
      }
    } catch (e: any) {
      await supabase.from('garage_marsello_queue').update({
        status: 'error', sync_response: String(e).slice(0, 200),
      }).eq('id', item.id);
      alert(`同步出錯：${String(e).slice(0, 200)}`);
    }
  }

  // ── Sync all approved (batch) ──────────────────────────────
  async function syncAllApproved() {
    const apiKey = marselloApiKey || localStorage.getItem('marsello_store_api_key') || '';
    if (!apiKey) {
      setShowApiKeyInput(true);
      alert('請先輸入 Marsello Store API Key 才能批量同步。\n(Please configure the API key first)');
      return;
    }
    const approvedItems = queue.filter(q => q.status === 'approved' && q.marsello_customer_id);
    if (approvedItems.length === 0) {
      alert('沒有已批准但待同步的項目。');
      return;
    }
    if (!confirm(`確認同步 ${approvedItems.length} 個已批准項目到 Marsello？`)) return;

    setScanning(true);
    for (const item of approvedItems) {
      await syncToMarsello(item, apiKey);
      await new Promise(r => setTimeout(r, 500)); // rate limit
    }
    await loadQueue();
    setScanning(false);
  }

  // ── Reject action ──────────────────────────────────────────
  async function rejectItem(item: QueueItem) {
    setActionLoading(item.id);
    try {
      await supabase.from('garage_marsello_queue').update({ status: 'rejected' }).eq('id', item.id);
      await loadQueue();
    } finally {
      setActionLoading(null);
    }
  }

  // ── Filtered list ──────────────────────────────────────────
  const filtered = useMemo(() => {
    const sl = searchText.trim().toLowerCase();
    return queue.filter(q => {
      if (statusFilter !== 'all' && q.status !== statusFilter) return false;
      if (sl) {
        const hay = `${q.bc_invoice_number} ${q.bc_customer_name} ${q.marsello_customer_name || ''} ${q.marsello_customer_email || ''}`.toLowerCase();
        if (!hay.includes(sl)) return false;
      }
      return true;
    });
  }, [queue, statusFilter, searchText]);

  // ── Summary counts ─────────────────────────────────────────
  const counts = useMemo(() => ({
    pending:  queue.filter(q => q.status === 'pending').length,
    approved: queue.filter(q => q.status === 'approved').length,
    synced:   queue.filter(q => q.status === 'synced').length,
    rejected: queue.filter(q => q.status === 'rejected').length,
    unmatched: queue.filter(q => q.status === 'pending' && q.match_type === 'unmatched').length,
  }), [queue]);

  // ── Table not created yet ──────────────────────────────────
  if (tableExists === false) {
    return (
      <div className="space-y-4">
        <Card className="border-amber-500/30 bg-amber-500/5">
          <CardContent className="p-6">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-5 w-5 text-amber-400 shrink-0 mt-0.5" />
              <div>
                <h3 className="text-sm font-semibold text-amber-300 mb-2">需要初始化資料庫表格</h3>
                <p className="text-xs text-muted-foreground mb-3">
                  請在 Supabase SQL Editor 執行以下 SQL，然後重新整理頁面：
                </p>
                <p className="text-xs text-muted-foreground mb-3">
                  前往：<span className="font-mono text-amber-300">supabase.com/dashboard → SQL Editor</span>
                </p>
                <p className="text-xs text-muted-foreground">
                  SQL 檔案位置：<span className="font-mono text-primary">hk_dashboard/sql/garage_marsello_queue.sql</span>
                </p>
                <button
                  onClick={() => loadQueue()}
                  className="mt-4 px-3 py-1.5 text-xs bg-amber-500/20 text-amber-300 rounded border border-amber-500/30 hover:bg-amber-500/30 transition-colors"
                >
                  重新檢查 Retry Check
                </button>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-base font-semibold">車房 → Marsello 積分審批</h2>
          <p className="text-xs text-muted-foreground">Garage Invoice → Marsello Points Approval Queue</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowApiKeyInput(v => !v)}
            className="px-3 py-1.5 text-xs bg-accent/50 text-muted-foreground rounded border border-border/40 hover:bg-accent transition-colors flex items-center gap-1.5"
          >
            <Zap className="h-3 w-3" /> API Key 設定
          </button>
          {counts.approved > 0 && (
            <button
              onClick={syncAllApproved}
              disabled={scanning}
              className="px-3 py-1.5 text-xs bg-blue-500/20 text-blue-400 rounded border border-blue-500/30 hover:bg-blue-500/30 transition-colors flex items-center gap-1.5"
            >
              <RefreshCw className={`h-3 w-3 ${scanning ? 'animate-spin' : ''}`} />
              同步 {counts.approved} 個已批准
            </button>
          )}
          <button
            onClick={scanInvoices}
            disabled={scanning}
            className="px-3 py-1.5 text-xs bg-primary/90 text-primary-foreground rounded hover:bg-primary transition-colors flex items-center gap-1.5 font-medium"
          >
            <Search className={`h-3 w-3 ${scanning ? 'animate-spin' : ''}`} />
            {scanning ? '掃描中...' : '掃描新發票'}
          </button>
        </div>
      </div>

      {/* API Key setup panel */}
      {showApiKeyInput && (
        <Card className="border-border/40">
          <CardContent className="p-4">
            <div className="flex items-start gap-2">
              <Info className="h-4 w-4 text-blue-400 shrink-0 mt-0.5" />
              <div className="flex-1">
                <p className="text-xs font-medium mb-1">Marsello Store API Key</p>
                <p className="text-[11px] text-muted-foreground mb-2">
                  前往 <span className="font-mono text-primary">app.marsello.com → Settings → Integrations → API Keys</span> 取得。
                  輸入後系統可自動將批准的發票同步到 Marsello。
                </p>
                <div className="flex gap-2">
                  <input
                    type="password"
                    value={marselloApiKey}
                    onChange={e => setMarselloApiKey(e.target.value)}
                    placeholder="Paste Marsello Store API Key here..."
                    className="flex-1 px-2 py-1.5 text-xs bg-muted border border-border rounded text-foreground placeholder-muted-foreground focus:outline-none focus:border-blue-500"
                  />
                  <button
                    onClick={() => {
                      if (marselloApiKey) {
                        localStorage.setItem('marsello_store_api_key', marselloApiKey);
                        alert('API Key 已儲存到本地。');
                        setShowApiKeyInput(false);
                      }
                    }}
                    className="px-3 py-1.5 text-xs bg-blue-500/20 text-blue-400 rounded border border-blue-500/30 hover:bg-blue-500/30 transition-colors"
                  >
                    儲存
                  </button>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: '待審批', sublabel: 'Pending', value: counts.pending, icon: Clock, color: 'text-amber-400', onClick: () => setStatusFilter('pending') },
          { label: '未匹配', sublabel: 'Unmatched', value: counts.unmatched, icon: AlertTriangle, color: 'text-red-400', onClick: () => setStatusFilter('pending') },
          { label: '已批准未同步', sublabel: 'Approved', value: counts.approved, icon: CheckCircle2, color: 'text-green-400', onClick: () => setStatusFilter('approved') },
          { label: '已同步', sublabel: 'Synced', value: counts.synced, icon: Zap, color: 'text-blue-400', onClick: () => setStatusFilter('synced') },
        ].map(card => (
          <Card
            key={card.label}
            className="border-border/40 cursor-pointer hover:bg-accent/20 transition-colors"
            onClick={card.onClick}
          >
            <CardContent className="p-4 flex items-center gap-3">
              <card.icon className={`h-5 w-5 ${card.color} shrink-0`} />
              <div>
                <p className="text-lg font-bold tabular-nums">{formatNumber(card.value)}</p>
                <p className="text-[11px] text-muted-foreground">{card.label} <span className="opacity-60">{card.sublabel}</span></p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Status filter */}
        <div className="flex items-center gap-1 bg-accent/30 rounded p-0.5">
          {(['all', 'pending', 'approved', 'synced', 'rejected'] as const).map(s => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                statusFilter === s ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {s === 'all' ? '全部' : s === 'pending' ? '待審批' : s === 'approved' ? '已批' : s === 'synced' ? '已同步' : '已拒'}
            </button>
          ))}
        </div>
        {/* Search */}
        <input
          type="text"
          placeholder="搜索發票/客戶..."
          value={searchText}
          onChange={e => setSearchText(e.target.value)}
          className="px-2.5 py-1.5 text-xs bg-muted border border-border rounded text-foreground placeholder-muted-foreground focus:outline-none focus:border-gray-500 w-48"
        />
        <span className="text-xs text-muted-foreground ml-auto">顯示 {filtered.length} / {queue.length} 筆</span>
      </div>

      {/* Table */}
      <Card className="border-border/40">
        <CardContent className="p-0">
          {loading ? (
            <div className="p-4 space-y-2">
              {[1,2,3,4].map(i => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-12 text-center">
              <Users className="h-8 w-8 text-muted-foreground/30 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">
                {queue.length === 0
                  ? '隊列是空的。點擊「掃描新發票」開始。'
                  : '沒有符合篩選條件的項目。'
                }
              </p>
              {queue.length === 0 && (
                <button
                  onClick={scanInvoices}
                  disabled={scanning}
                  className="mt-3 px-4 py-2 text-xs bg-primary/90 text-primary-foreground rounded hover:bg-primary"
                >
                  掃描 BC Garage 發票
                </button>
              )}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border/50 text-muted-foreground bg-muted/20">
                    <th className="py-2.5 px-3 text-left font-medium">發票</th>
                    <th className="py-2.5 px-3 text-left font-medium">BC 客戶</th>
                    <th className="py-2.5 px-3 text-left font-medium">Marsello 匹配</th>
                    <th className="py-2.5 px-3 text-right font-medium">金額</th>
                    <th className="py-2.5 px-3 text-center font-medium">匹配</th>
                    <th className="py-2.5 px-3 text-center font-medium">狀態</th>
                    <th className="py-2.5 px-3 text-right font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(item => {
                    const isExpanded = expandedId === item.id;
                    const isLoading  = actionLoading === item.id;
                    return (
                      <>
                        <tr
                          key={item.id}
                          className={`border-b border-border/20 hover:bg-accent/20 transition-colors cursor-pointer ${
                            item.status === 'pending' && item.match_type === 'unmatched'
                              ? 'bg-red-500/5' : ''
                          }`}
                          onClick={() => setExpandedId(isExpanded ? null : item.id)}
                        >
                          <td className="py-2.5 px-3">
                            <div className="font-mono font-medium">#{item.bc_invoice_number}</div>
                            <div className="text-[10px] text-muted-foreground">{item.bc_invoice_date?.slice(0, 10)}</div>
                          </td>
                          <td className="py-2.5 px-3">
                            <div className="font-medium max-w-[140px] truncate">{item.bc_customer_name}</div>
                            <div className="text-[10px] text-muted-foreground font-mono">{item.bc_customer_number}</div>
                          </td>
                          <td className="py-2.5 px-3">
                            {item.marsello_customer_id ? (
                              <>
                                <div className="max-w-[160px] truncate">{item.marsello_customer_name}</div>
                                <div className="text-[10px] text-muted-foreground truncate max-w-[160px]">{item.marsello_customer_email}</div>
                              </>
                            ) : (
                              <span className="text-[11px] text-red-400">未找到匹配客戶</span>
                            )}
                          </td>
                          <td className="py-2.5 px-3 text-right tabular-nums font-semibold">
                            {formatCurrency(item.invoice_amount)}
                          </td>
                          <td className="py-2.5 px-3 text-center">
                            <MatchBadge type={item.match_type} />
                          </td>
                          <td className="py-2.5 px-3 text-center">
                            <StatusBadge status={item.status} />
                          </td>
                          <td className="py-2.5 px-3 text-right">
                            {item.status === 'pending' && (
                              <div className="flex items-center justify-end gap-1.5" onClick={e => e.stopPropagation()}>
                                <button
                                  onClick={() => approveItem(item)}
                                  disabled={isLoading}
                                  className="flex items-center gap-1 px-2 py-1 text-[11px] bg-green-500/15 text-green-400 border border-green-500/30 rounded hover:bg-green-500/25 transition-colors disabled:opacity-50"
                                >
                                  <CheckCircle2 className="h-3 w-3" /> 批准
                                </button>
                                <button
                                  onClick={() => rejectItem(item)}
                                  disabled={isLoading}
                                  className="flex items-center gap-1 px-2 py-1 text-[11px] bg-red-500/15 text-red-400 border border-red-500/30 rounded hover:bg-red-500/25 transition-colors disabled:opacity-50"
                                >
                                  <XCircle className="h-3 w-3" /> 拒絕
                                </button>
                              </div>
                            )}
                            {item.status === 'approved' && (
                              <div className="flex items-center justify-end gap-1" onClick={e => e.stopPropagation()}>
                                <button
                                  onClick={() => {
                                    const key = marselloApiKey || localStorage.getItem('marsello_store_api_key') || '';
                                    if (key) syncToMarsello(item, key);
                                    else { setShowApiKeyInput(true); }
                                  }}
                                  className="flex items-center gap-1 px-2 py-1 text-[11px] bg-blue-500/15 text-blue-400 border border-blue-500/30 rounded hover:bg-blue-500/25 transition-colors"
                                >
                                  <RefreshCw className="h-3 w-3" /> 同步
                                </button>
                              </div>
                            )}
                            {(item.status === 'synced' || item.status === 'error') && (
                              <span className={`text-[10px] ${item.status === 'error' ? 'text-red-400' : 'text-blue-400'}`}>
                                {item.status === 'synced' ? '✅ Done' : '❌ Error'}
                              </span>
                            )}
                          </td>
                        </tr>

                        {/* Expanded detail row */}
                        {isExpanded && (
                          <tr key={`${item.id}-expand`} className="bg-accent/5 border-b border-border/20">
                            <td colSpan={7} className="px-4 py-3">
                              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-[11px]">
                                <div>
                                  <p className="font-semibold text-muted-foreground mb-1.5">BC 發票詳情</p>
                                  <div className="space-y-0.5">
                                    <p>發票號: <span className="font-mono text-foreground">{item.bc_invoice_number}</span></p>
                                    <p>日期: <span className="text-foreground">{item.bc_invoice_date?.slice(0,10)}</span></p>
                                    <p>客戶號: <span className="font-mono text-foreground">{item.bc_customer_number}</span></p>
                                    <p>客戶名: <span className="text-foreground">{item.bc_customer_name}</span></p>
                                    <p>金額: <span className="font-semibold text-foreground">{formatCurrency(item.invoice_amount)}</span></p>
                                  </div>
                                </div>
                                <div>
                                  <p className="font-semibold text-muted-foreground mb-1.5">Marsello 客戶資料</p>
                                  {item.marsello_customer_id ? (
                                    <div className="space-y-0.5">
                                      <p>姓名: <span className="text-foreground">{item.marsello_customer_name}</span></p>
                                      <p>Email: <span className="text-foreground">{item.marsello_customer_email}</span></p>
                                      <p>現有積分: <span className="font-semibold text-amber-400">{formatNumber(item.marsello_current_points || 0)} 分</span></p>
                                      <p>匹配方式: <MatchBadge type={item.match_type} /></p>
                                    </div>
                                  ) : (
                                    <p className="text-red-400">未找到匹配的 Marsello 客戶</p>
                                  )}
                                </div>
                                <div>
                                  <p className="font-semibold text-muted-foreground mb-1.5">狀態記錄</p>
                                  <div className="space-y-0.5">
                                    <p>加入隊列: <span className="text-foreground">{item.created_at?.slice(0,16).replace('T',' ')}</span></p>
                                    {item.approved_at && <p>批准時間: <span className="text-green-400">{item.approved_at?.slice(0,16).replace('T',' ')}</span></p>}
                                    {item.synced_at && <p>同步時間: <span className="text-blue-400">{item.synced_at?.slice(0,16).replace('T',' ')}</span></p>}
                                    {item.sync_response && (
                                      <p className="text-muted-foreground/60 text-[10px] mt-1 truncate max-w-xs">
                                        Response: {item.sync_response}
                                      </p>
                                    )}
                                  </div>
                                </div>
                              </div>
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
        </CardContent>
      </Card>

      {/* Info card */}
      <Card className="border-border/30 bg-muted/10">
        <CardContent className="p-4">
          <p className="text-[11px] text-muted-foreground flex items-start gap-2">
            <Info className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <span>
              <strong className="text-foreground">操作說明：</strong>
              每次點擊「掃描新發票」，系統會從 BC 讀取最近 90 天的 GARAGE 發票，自動嘗試匹配 Marsello 客戶（姓名匹配），加入審批隊列。
              批准後如已設定 Marsello Store API Key，積分會自動同步；否則請在 app.marsello.com 手動添加。
              API Key 位置：Settings → Integrations → API Keys。
            </span>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
