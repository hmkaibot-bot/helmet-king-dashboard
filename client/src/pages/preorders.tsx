import { useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { queryAllPages } from '@/lib/query-helpers';
import { Card, CardContent } from '@/components/ui/card';
import { formatCurrency } from '@/lib/format';
import { CalendarClock, Plus, Search, X } from 'lucide-react';

/**
 * 預訂 Pre-orders — 訂金商品模式(飛 PreProduct,grilling 2026-09-10 定案)。
 *
 * 機制:每個 campaign 喺 Shopify 開一件【預訂】商品(經 /api/shopify-preorder):
 *  - 價 = 訂金($1,000 咁),客人網店照常 checkout 畀訂金
 *  - 每個款式一個 variant,variant 庫存 = 接訂上限 → Shopify 原生斷數
 *  - vendor='PREORDER' + type='PRE-ORDER DEPOSIT' → 品牌/類別統計自動剔走
 * 到貨:客人到店 POS 補尾數(總價 − 訂金);訂唔到貨先退訂金(Shopify admin
 * 人手退,呢度標「已退」)。到貨提客:人手 WhatsApp(名單喺呢頁)。
 *
 * 「訂咗幾多」= 上限 − Shopify 實時剩餘庫存(live API);客人名單由本地
 * shopify_orders/lines 嚟(夜間 sync,即日單要等聽朝 — 頁面有註明)。
 */

interface Campaign {
  preorder_product_id: number;
  real_product_id: number | null;
  title: string;
  deposit_price: number;
  full_price: number;
  eta: string | null;
  status: string; // open / arrived / closed / cancelled
  variants: Array<{ sku: string; label: string; limit: number }>;
  created_at: string;
}

interface InvRow {
  product_id: number;
  variant_id: number;
  product_title: string | null;
  variant_title: string | null;
  sku: string | null;
  price: number | null;
}

interface OrderLine {
  order_id: number;
  sku: string;
  quantity: number;
}

interface OrderInfo {
  id: number;
  order_number: number | null;
  customer_name: string | null;
  created_at: string;
  cancelled_at: string | null;
}

interface LiveVariant { sku: string; title: string; remaining: number; }

const STATUS_CHIP: Record<string, { label: string; cls: string }> = {
  open: { label: '🟢 接緊訂', cls: 'text-emerald-300 border-emerald-500/40 bg-emerald-500/10' },
  arrived: { label: '📦 已到貨 · 跟進中', cls: 'text-amber-300 border-amber-500/40 bg-amber-500/10' },
  closed: { label: '✅ 完成', cls: 'text-muted-foreground border-border bg-card' },
  cancelled: { label: '🚫 已取消', cls: 'text-red-300 border-red-500/40 bg-red-500/10' },
};

const ORDER_STATUS: Record<string, { label: string; cls: string }> = {
  waiting: { label: '等貨', cls: 'text-muted-foreground' },
  notified: { label: '已 WhatsApp', cls: 'text-sky-300' },
  completed: { label: '已付尾數✓', cls: 'text-emerald-300' },
  refunded: { label: '已退訂', cls: 'text-red-300' },
};

interface CreateRow { label: string; sku: string; limit: string; checked: boolean; }

export default function PreordersPage() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [lines, setLines] = useState<OrderLine[]>([]);
  const [orders, setOrders] = useState<Record<number, OrderInfo>>({});
  const [orderStatus, setOrderStatus] = useState<Record<string, string>>({}); // `${orderId}:${pid}` → status
  const [live, setLive] = useState<Record<number, LiveVariant[]>>({});
  const [imgMap, setImgMap] = useState<Record<string, string | null>>({});
  const requestedImgs = useRef(new Set<string>());
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // ── 開新預訂 form ──────────────────────────────────────────
  const [showForm, setShowForm] = useState(false);
  const [inv, setInv] = useState<InvRow[]>([]);
  const [q, setQ] = useState('');
  const [pickedPid, setPickedPid] = useState<number | null>(null);
  const [fTitle, setFTitle] = useState('');
  const [fDeposit, setFDeposit] = useState('1000');
  const [fFull, setFFull] = useState('');
  const [fEta, setFEta] = useState('');
  const [fRows, setFRows] = useState<CreateRow[]>([]);

  const reloadCampaigns = async () => {
    const { data } = await supabase.from('preorder_products').select('*').order('created_at', { ascending: false });
    const cs = ((data as any[]) ?? []).map((c) => ({ ...c, variants: Array.isArray(c.variants) ? c.variants : [] })) as Campaign[];
    setCampaigns(cs);
    return cs;
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cs = await reloadCampaigns();
        if (cancelled) return;
        // 訂單狀態標記
        const { data: st } = await supabase.from('preorder_orders').select('*');
        if (!cancelled && st) {
          const m: Record<string, string> = {};
          for (const r of st as any[]) m[`${r.order_id}:${r.preorder_product_id}`] = r.status;
          setOrderStatus(m);
        }
        // 客人名單:campaign SKU → 本地 order lines(夜間 sync)
        const skus = cs.flatMap((c) => c.variants.map((v) => v.sku)).filter(Boolean);
        if (skus.length > 0) {
          const ls: OrderLine[] = [];
          for (let i = 0; i < skus.length; i += 100) {
            const { data: l } = await supabase
              .from('shopify_order_lines')
              .select('order_id,sku,quantity')
              .in('sku', skus.slice(i, i + 100));
            if (l) ls.push(...(l as any[]));
          }
          if (cancelled) return;
          setLines(ls);
          const oids = [...new Set(ls.map((l) => l.order_id))];
          const om: Record<number, OrderInfo> = {};
          for (let i = 0; i < oids.length; i += 100) {
            const { data: os } = await supabase
              .from('shopify_orders')
              .select('id,order_number,customer_name,created_at,cancelled_at')
              .in('id', oids.slice(i, i + 100));
            for (const o of (os as any[]) ?? []) om[Number(o.id)] = o;
          }
          if (!cancelled) setOrders(om);
        }
      } catch (e) {
        console.error('preorders load error:', e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // 揀正貨用嘅庫存表(開 form 先載)
  useEffect(() => {
    if (!showForm || inv.length > 0) return;
    (async () => {
      try {
        const data = await queryAllPages('shopify_inventory', 'product_id,variant_id,product_title,variant_title,sku,price');
        setInv(data as InvRow[]);
      } catch (e) { console.error(e); }
    })();
  }, [showForm, inv.length]);

  // Shopify 實時剩餘(訂咗 = 上限 − 剩餘)— open/arrived 先問
  useEffect(() => {
    const need = campaigns.filter((c) => (c.status === 'open' || c.status === 'arrived') && !(c.preorder_product_id in live));
    if (need.length === 0) return;
    (async () => {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) return;
      for (const c of need) {
        try {
          const resp = await fetch('/api/shopify-preorder', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ action: 'live', productId: String(c.preorder_product_id) }),
          });
          const j: any = await resp.json().catch(() => null);
          if (resp.ok && j?.ok) setLive((m) => ({ ...m, [c.preorder_product_id]: j.variants ?? [] }));
        } catch { /* 攞唔到實時數就淨顯示本地 */ }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaigns]);

  // 正貨主圖(campaign 卡用)
  useEffect(() => {
    const pids = campaigns
      .map((c) => c.real_product_id)
      .filter((p): p is number => p != null)
      .map(String)
      .filter((id) => !requestedImgs.current.has(id));
    if (pids.length === 0) return;
    pids.forEach((id) => requestedImgs.current.add(id));
    (async () => {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) { pids.forEach((id) => requestedImgs.current.delete(id)); return; }
      try {
        const resp = await fetch('/api/shopify-product', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ action: 'featuredImages', productIds: pids }),
        });
        const j: any = await resp.json().catch(() => null);
        if (resp.ok && j?.images) setImgMap((m) => ({ ...m, ...j.images }));
        else pids.forEach((id) => requestedImgs.current.delete(id));
      } catch { pids.forEach((id) => requestedImgs.current.delete(id)); }
    })();
  }, [campaigns]);

  // ── form:搜正貨 → 剔款式/上限 ──────────────────────────────
  const pickResults = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (needle.length < 2) return [];
    const byPid = new Map<number, InvRow[]>();
    for (const r of inv) {
      const hay = `${r.product_title ?? ''} ${r.sku ?? ''}`.toLowerCase();
      if (!hay.includes(needle)) continue;
      const arr = byPid.get(r.product_id) ?? [];
      arr.push(r);
      byPid.set(r.product_id, arr);
    }
    return [...byPid.entries()].slice(0, 8).map(([pid, vs]) => ({ pid, title: vs[0]?.product_title ?? `#${pid}`, variants: vs }));
  }, [inv, q]);

  const pickProduct = (pid: number, title: string, variants: InvRow[]) => {
    setPickedPid(pid);
    setFTitle(title);
    const maxP = Math.max(0, ...variants.map((v) => v.price ?? 0));
    setFFull(maxP > 0 ? String(maxP) : '');
    setFRows(
      variants
        .sort((a, b) => String(a.sku ?? '').localeCompare(String(b.sku ?? '')))
        .map((v, i) => ({
          label: v.variant_title && v.variant_title !== 'Default Title' ? v.variant_title : (v.sku ?? `款式${i + 1}`),
          sku: `PRE-${v.sku ?? `${pid}-${i + 1}`}`,
          limit: '3',
          checked: true,
        }))
    );
    setQ('');
  };

  const createCampaign = async () => {
    const rows = fRows.filter((r) => r.checked);
    const deposit = Number(fDeposit);
    const full = Number(fFull);
    if (!fTitle.trim()) { setToast('❌ 冇商品名'); return; }
    if (!(deposit > 0)) { setToast('❌ 訂金要大過 0'); return; }
    if (!(full > deposit)) { setToast('❌ 總價要大過訂金'); return; }
    if (rows.length === 0) { setToast('❌ 至少剔一個款式'); return; }
    if (rows.some((r) => !(Number(r.limit) > 0))) { setToast('❌ 每個款式接訂上限要大過 0'); return; }

    setBusy(true);
    setToast(null);
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error('未登入');
      const imageUrl = pickedPid != null ? imgMapForCreate(pickedPid) : null;
      const resp = await fetch('/api/shopify-preorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          action: 'create',
          title: fTitle.trim(),
          imageUrl,
          depositPrice: deposit,
          fullPrice: full,
          eta: fEta || null,
          realProductId: pickedPid,
          variants: rows.map((r) => ({ label: r.label, sku: r.sku, limit: Number(r.limit) })),
        }),
      });
      const j: any = await resp.json().catch(() => null);
      if (!resp.ok || !j?.ok) throw new Error(j?.error || `HTTP ${resp.status}(未 deploy 前用唔到)`);
      const { error } = await supabase.from('preorder_products').insert({
        preorder_product_id: j.productId,
        real_product_id: pickedPid,
        title: fTitle.trim(),
        deposit_price: deposit,
        full_price: full,
        eta: fEta || null,
        status: 'open',
        variants: rows.map((r) => ({ sku: r.sku, label: r.label, limit: Number(r.limit) })),
      });
      if (error) throw new Error(`Shopify 開咗但本地記錄失敗:${error.message}`);
      setToast(`✅ 上架咗【預訂】${fTitle.trim()}${(j.warnings ?? []).length ? ` · ⚠️ ${j.warnings.join(';')}` : ''}`);
      setShowForm(false);
      setPickedPid(null); setFTitle(''); setFDeposit('1000'); setFFull(''); setFEta(''); setFRows([]);
      await reloadCampaigns();
    } catch (e) {
      setToast(`❌ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  // 開 form 嗰陣未必攞咗正貨圖 — 用已有 cache,冇就由 create 流程跳過(唔阻上架)
  const imgMapForCreate = (pid: number) => imgMap[String(pid)] ?? null;

  const setCampaignStatus = async (c: Campaign, status: string, alsoClose: boolean) => {
    setBusy(true);
    setToast(null);
    try {
      if (alsoClose) {
        const { data } = await supabase.auth.getSession();
        const token = data.session?.access_token;
        if (token) {
          const resp = await fetch('/api/shopify-preorder', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ action: 'close', productId: String(c.preorder_product_id) }),
          });
          const j: any = await resp.json().catch(() => null);
          if (!resp.ok || !j?.ok) throw new Error(j?.error || '落架失敗');
        }
      }
      const { error } = await supabase
        .from('preorder_products')
        .update({ status, updated_at: new Date().toISOString() })
        .eq('preorder_product_id', c.preorder_product_id);
      if (error) throw new Error(error.message);
      setCampaigns((cs) => cs.map((x) => (x.preorder_product_id === c.preorder_product_id ? { ...x, status } : x)));
      setToast(`✅ 「${c.title}」→ ${STATUS_CHIP[status]?.label ?? status}${alsoClose ? '(Shopify 已落架)' : ''}`);
    } catch (e) {
      setToast(`❌ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const markOrder = async (orderId: number, pid: number, status: string) => {
    const key = `${orderId}:${pid}`;
    setOrderStatus((m) => ({ ...m, [key]: status }));
    const { error } = await supabase
      .from('preorder_orders')
      .upsert({ order_id: orderId, preorder_product_id: pid, status, updated_at: new Date().toISOString() }, { onConflict: 'order_id,preorder_product_id' });
    if (error) setToast(`❌ 標記失敗:${error.message}`);
  };

  // 每個 campaign 嘅客人行:sku → lines → orders(cancelled 剔走)
  const campaignOrders = (c: Campaign) => {
    const skuSet = new Set(c.variants.map((v) => v.sku));
    const byOrder = new Map<number, { qty: number; labels: string[] }>();
    for (const l of lines) {
      if (!skuSet.has(l.sku)) continue;
      const o = orders[l.order_id];
      if (!o || o.cancelled_at) continue;
      const cur = byOrder.get(l.order_id) ?? { qty: 0, labels: [] };
      cur.qty += l.quantity || 0;
      const label = c.variants.find((v) => v.sku === l.sku)?.label ?? l.sku;
      cur.labels.push(`${label}×${l.quantity || 1}`);
      byOrder.set(l.order_id, cur);
    }
    return [...byOrder.entries()]
      .map(([oid, x]) => ({ order: orders[oid], oid, ...x }))
      .sort((a, b) => String(b.order?.created_at ?? '').localeCompare(String(a.order?.created_at ?? '')));
  };

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between flex-wrap gap-2">
        <h2 className="text-sm font-semibold flex items-center gap-1.5" data-testid="section-preorders">
          <CalendarClock className="h-4 w-4 text-primary" /> 預訂 <span className="text-xs font-normal text-muted-foreground">Pre-orders(訂金制)</span>
        </h2>
        <span className="text-[11px] text-muted-foreground">
          網店收訂金 · 每款式限量(Shopify 庫存自動斷數)· 到貨客人到店補尾數 · 訂金唔會計入品牌統計
        </span>
      </div>

      {toast && <div className="rounded-md border border-border/60 bg-card px-3 py-2 text-sm">{toast}</div>}

      {/* 開新預訂 */}
      {!showForm ? (
        <button
          onClick={() => setShowForm(true)}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-semibold"
          data-testid="preorder-new"
        >
          <Plus className="h-4 w-4" /> 開新預訂
        </button>
      ) : (
        <Card className="border-primary/40">
          <CardContent className="p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">開新預訂</h3>
              <button onClick={() => setShowForm(false)} className="p-1 rounded hover:bg-muted/40"><X className="h-4 w-4" /></button>
            </div>

            {pickedPid == null ? (
              <div className="space-y-2">
                <div className="relative max-w-md">
                  <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                  <input
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder="搜正貨(貨名 / SKU,至少 2 個字)— 預訂商品會照抄佢個名/圖/款式"
                    className="w-full pl-8 pr-3 py-2 rounded-md border border-border bg-card text-sm"
                    data-testid="preorder-search"
                  />
                </div>
                {inv.length === 0 && <p className="text-xs text-muted-foreground animate-pulse">載入緊商品清單…</p>}
                {pickResults.map((p) => (
                  <button
                    key={p.pid}
                    onClick={() => pickProduct(p.pid, p.title, p.variants)}
                    className="w-full text-left px-3 py-2 rounded border border-border/50 hover:bg-muted/20 text-sm"
                  >
                    {p.title} <span className="text-xs text-muted-foreground">· {p.variants.length} 個款式</span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex gap-3 flex-wrap items-end">
                  <label className="text-sm space-y-1">
                    <span className="text-muted-foreground block text-xs">商品名(預訂商品會叫【預訂】呢個名)</span>
                    <input value={fTitle} onChange={(e) => setFTitle(e.target.value)} className="w-96 max-w-full px-2.5 py-1.5 rounded border border-border bg-background" />
                  </label>
                  <label className="text-sm space-y-1">
                    <span className="text-muted-foreground block text-xs">訂金 HK$</span>
                    <input value={fDeposit} onChange={(e) => setFDeposit(e.target.value)} inputMode="decimal" className="w-28 px-2.5 py-1.5 rounded border border-border bg-background text-right tabular-nums" />
                  </label>
                  <label className="text-sm space-y-1">
                    <span className="text-muted-foreground block text-xs">總價 HK$(尾數 = 總價−訂金)</span>
                    <input value={fFull} onChange={(e) => setFFull(e.target.value)} inputMode="decimal" className="w-28 px-2.5 py-1.5 rounded border border-border bg-background text-right tabular-nums" />
                  </label>
                  <label className="text-sm space-y-1">
                    <span className="text-muted-foreground block text-xs">預計到貨</span>
                    <input type="date" value={fEta} onChange={(e) => setFEta(e.target.value)} className="px-2.5 py-1.5 rounded border border-border bg-background" />
                  </label>
                </div>

                <div className="space-y-1.5">
                  <p className="text-xs text-muted-foreground">剔開訂嘅款式 + 每款接訂上限(= Shopify variant 庫存,訂滿自動買唔到):</p>
                  {fRows.map((r, i) => (
                    <div key={i} className="flex items-center gap-3 text-sm">
                      <label className="flex items-center gap-2 min-w-[16rem]">
                        <input type="checkbox" checked={r.checked} onChange={(e) => setFRows((rows) => rows.map((x, j) => (j === i ? { ...x, checked: e.target.checked } : x)))} />
                        {r.label}
                      </label>
                      <span className="text-xs text-muted-foreground tabular-nums">{r.sku}</span>
                      <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        上限
                        <input
                          value={r.limit}
                          onChange={(e) => setFRows((rows) => rows.map((x, j) => (j === i ? { ...x, limit: e.target.value } : x)))}
                          inputMode="numeric"
                          disabled={!r.checked}
                          className="w-16 px-2 py-1 rounded border border-border bg-background text-right tabular-nums text-foreground disabled:opacity-40"
                        />
                        件
                      </label>
                    </div>
                  ))}
                </div>

                <div className="flex gap-2">
                  <button onClick={() => { setPickedPid(null); setFRows([]); }} className="px-3 py-1.5 rounded border border-border text-sm">↩ 揀過第二件</button>
                  <button
                    onClick={createCampaign}
                    disabled={busy}
                    className="px-4 py-1.5 rounded bg-primary text-primary-foreground text-sm font-semibold disabled:opacity-50"
                    data-testid="preorder-create"
                  >
                    {busy ? '上架緊…' : '上架預訂商品'}
                  </button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* campaign 列表 */}
      {loading ? (
        <p className="text-xs text-muted-foreground py-8 text-center animate-pulse">載入緊預訂…</p>
      ) : campaigns.length === 0 ? (
        <p className="text-xs text-muted-foreground py-10 text-center">未有預訂 campaign — 撳「開新預訂」開始</p>
      ) : (
        <div className="space-y-3">
          {campaigns.map((c) => {
            const chip = STATUS_CHIP[c.status] ?? STATUS_CHIP.open;
            const lv = live[c.preorder_product_id];
            const custRows = campaignOrders(c);
            const rest = Math.max(0, c.full_price - c.deposit_price);
            const img = c.real_product_id != null ? imgMap[String(c.real_product_id)] : null;
            return (
              <Card key={c.preorder_product_id} className="border-border/40">
                <CardContent className="p-4 space-y-3">
                  <div className="flex items-start gap-3 flex-wrap">
                    {img ? (
                      <img src={img} alt="" className="w-14 h-14 max-w-none object-cover rounded border border-border/40 bg-white shrink-0" loading="lazy" />
                    ) : (
                      <div className="w-14 h-14 rounded bg-muted/40 border border-border/40 shrink-0" />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold">{c.title}</p>
                      <p className="text-xs text-muted-foreground">
                        訂金 {formatCurrency(c.deposit_price)} · 總價 {formatCurrency(c.full_price)} · 尾數 {formatCurrency(rest)}
                        {c.eta ? ` · 預計到貨 ${c.eta}` : ''}
                      </p>
                    </div>
                    <span className={`px-2 py-0.5 rounded border text-xs whitespace-nowrap ${chip.cls}`}>{chip.label}</span>
                  </div>

                  {/* 每款式進度:訂咗 = 上限 − Shopify 實時剩餘 */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-1.5">
                    {c.variants.map((v) => {
                      const remaining = lv?.find((x) => x.sku === v.sku)?.remaining;
                      const taken = remaining != null ? Math.max(0, v.limit - remaining) : null;
                      return (
                        <div key={v.sku} className="flex items-center gap-2 text-sm">
                          <span className="w-40 truncate" title={v.label}>{v.label}</span>
                          <div className="flex-1 h-3 rounded bg-muted/30 overflow-hidden">
                            <div
                              className={`h-full rounded ${taken != null && taken >= v.limit ? 'bg-amber-500/70' : 'bg-emerald-500/60'}`}
                              style={{ width: `${taken != null ? Math.min(100, (taken / v.limit) * 100) : 0}%` }}
                            />
                          </div>
                          <span className="tabular-nums text-xs w-16 text-right">
                            {taken != null ? `${taken}/${v.limit}` : `?/${v.limit}`}
                          </span>
                        </div>
                      );
                    })}
                  </div>

                  {/* 客人名單(本地夜間 sync — 即日新單聽朝先見) */}
                  {custRows.length > 0 && (
                    <div className="rounded border border-border/40 overflow-hidden">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-border/40 bg-muted/30 text-xs text-muted-foreground">
                            <th className="text-left px-3 py-1.5 font-medium">訂單</th>
                            <th className="text-left px-3 py-1.5 font-medium">客人</th>
                            <th className="text-left px-3 py-1.5 font-medium">款式</th>
                            <th className="text-right px-3 py-1.5 font-medium">應收尾數</th>
                            <th className="text-left px-3 py-1.5 font-medium">狀態</th>
                            {(c.status === 'arrived' || c.status === 'cancelled') && <th className="text-left px-3 py-1.5 font-medium w-64">跟進</th>}
                          </tr>
                        </thead>
                        <tbody>
                          {custRows.map(({ order, oid, qty, labels }) => {
                            const st = orderStatus[`${oid}:${c.preorder_product_id}`] ?? 'waiting';
                            const os = ORDER_STATUS[st] ?? ORDER_STATUS.waiting;
                            return (
                              <tr key={oid} className="border-b border-border/20">
                                <td className="px-3 py-1.5 tabular-nums">#{order?.order_number ?? oid}</td>
                                <td className="px-3 py-1.5">{order?.customer_name ?? '—'}</td>
                                <td className="px-3 py-1.5 text-xs">{labels.join('、')}</td>
                                <td className="px-3 py-1.5 text-right tabular-nums">{formatCurrency(rest * qty)}</td>
                                <td className={`px-3 py-1.5 text-xs ${os.cls}`}>{os.label}</td>
                                {(c.status === 'arrived' || c.status === 'cancelled') && (
                                  <td className="px-3 py-1.5">
                                    <div className="flex gap-1.5 flex-wrap">
                                      {c.status === 'arrived' && (
                                        <>
                                          <button onClick={() => markOrder(oid, c.preorder_product_id, 'notified')} className="px-2 py-0.5 rounded border border-sky-500/40 text-sky-300 text-xs hover:bg-sky-500/10">已 WhatsApp</button>
                                          <button onClick={() => markOrder(oid, c.preorder_product_id, 'completed')} className="px-2 py-0.5 rounded border border-emerald-500/40 text-emerald-300 text-xs hover:bg-emerald-500/10">已付尾數✓</button>
                                        </>
                                      )}
                                      <button onClick={() => markOrder(oid, c.preorder_product_id, 'refunded')} className="px-2 py-0.5 rounded border border-red-500/40 text-red-300 text-xs hover:bg-red-500/10">已退訂</button>
                                    </div>
                                  </td>
                                )}
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                      <p className="px-3 py-1.5 text-[11px] text-muted-foreground border-t border-border/30">
                        名單由每晚同步嘅訂單嚟 — 今日啱啱落嘅訂聽朝先出現;實時「訂咗幾多」睇返上面進度條(Shopify 直數)。退款要喺 Shopify admin 人手退,呢度撳「已退訂」只係記錄。
                      </p>
                    </div>
                  )}

                  {/* campaign 動作 */}
                  <div className="flex gap-2 flex-wrap">
                    {c.status === 'open' && (
                      <>
                        <button
                          onClick={() => setCampaignStatus(c, 'arrived', true)}
                          disabled={busy}
                          className="px-3 py-1.5 rounded bg-primary text-primary-foreground text-sm font-semibold disabled:opacity-50"
                        >
                          📦 到貨喇(自動落架,開始跟進)
                        </button>
                        <button
                          onClick={() => window.confirm(`確定取消「${c.title}」預訂?會落架,同出退款名單。`) && setCampaignStatus(c, 'cancelled', true)}
                          disabled={busy}
                          className="px-3 py-1.5 rounded border border-red-500/40 text-red-300 text-sm disabled:opacity-50"
                        >
                          訂唔到貨,取消
                        </button>
                      </>
                    )}
                    {c.status === 'arrived' && (
                      <button
                        onClick={() => setCampaignStatus(c, 'closed', false)}
                        disabled={busy}
                        className="px-3 py-1.5 rounded border border-border text-sm disabled:opacity-50"
                      >
                        ✅ 全部搞掂,收檔
                      </button>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
