import { useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { Card, CardContent } from '@/components/ui/card';
import { formatCurrency, formatNumber } from '@/lib/format';
import { ClipboardList, Camera, X, CheckCircle2, ChevronLeft } from 'lucide-react';
import { StocktakeRoundReport } from '@/components/stocktake-report';

/**
 * 盤點 — 分批開場,多人逐筆入數(ledger 制),完場一次過對數。
 *
 * 逐筆紀錄制(老闆 2026-08-11 拍板方案 A):
 *   每人每次入嘅數係一筆獨立紀錄(stocktake_entries),唔會冚走人哋嗰筆 —
 *   同一款貨阿明鋪面點 3 件、阿華倉點 2 件 = 合計 5。掃碼 +1 亦係插一筆,
 *   兩部手機同時掃都唔會打架。清單每 30 秒自動refresh,互相見到進度。
 *   入錯可以刪自己嗰筆,邊個入過咩有數追。
 * 流程:開場(範圍→SKU 清單+系統數 snapshot)→ 入數(掃碼/掃碼槍/搜尋)
 *   → 完成盤點先出差異報告(對數留喺最後一步),CSV 俾倉務同事去 Shopify 調整。
 */

export interface Session {
  id: string;
  name: string;
  filter_vendor: string | null;
  filter_product_type: string | null;
  filter_keyword: string | null;
  status: string;
  created_at: string;
  finished_at: string | null;
}

export interface Item {
  session_id: string;
  sku: string;
  product_title: string | null;
  variant_title: string | null;
  vendor: string | null;
  product_type: string | null;
  price: number | null;
  unit_cost: number | null;
  system_qty: number;
}

export interface Entry {
  id: string;
  session_id: string;
  sku: string;
  qty: number;
  counted_by: string | null;
  note: string | null;
  created_at: string;
}

const itemName = (i: Item) =>
  `${i.product_title ?? ''}${i.variant_title && i.variant_title !== 'Default Title' ? ` — ${i.variant_title}` : ''}`;

// params 係 wouter Route 塞入嚟嘅,唔使用;staffMode = 同事專用殼(App.tsx)先會傳 true
export default function StocktakePage({ staffMode = false }: { staffMode?: boolean; params?: unknown }) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [progress, setProgress] = useState<Record<string, { total: number; counted: number }>>({});
  const [active, setActive] = useState<Session | null>(null);
  // 結算報告淨係管理層見(staffMode = 同事專用帳號,冇呢個 tab)
  const [view, setView] = useState<'sessions' | 'report'>('sessions');

  const loadSessions = async () => {
    const [{ data }, { data: prog }] = await Promise.all([
      supabase.from('stocktake_sessions').select('*').order('created_at', { ascending: false }),
      supabase.from('stocktake_progress').select('*'),
    ]);
    setSessions((data as Session[]) ?? []);
    const m: Record<string, { total: number; counted: number }> = {};
    for (const p of (prog as any[]) ?? []) m[String(p.session_id)] = { total: Number(p.total), counted: Number(p.counted) };
    setProgress(m);
  };

  useEffect(() => { loadSessions(); }, []);

  return (
    <div className="space-y-4 max-w-5xl mx-auto">
      {active ? (
        <SessionDetail
          session={active}
          onBack={() => { setActive(null); loadSessions(); }}
          onSessionChange={(s) => setActive(s)}
        />
      ) : (
        <>
          {!staffMode && (
            <div className="flex gap-1.5">
              {([['sessions', '盤點場次'], ['report', '結算報告']] as const).map(([v, label]) => (
                <button
                  key={v}
                  onClick={() => setView(v)}
                  className={`px-3 py-1.5 rounded-full border text-xs font-semibold ${view === v ? 'border-primary bg-primary/15 text-primary' : 'border-border text-muted-foreground hover:bg-accent/40'}`}
                  data-testid={`tab-${v}`}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          {!staffMode && view === 'report' ? (
            <StocktakeRoundReport sessions={sessions} progress={progress} />
          ) : (
            <SessionList sessions={sessions} progress={progress} onOpen={setActive} onCreated={loadSessions} />
          )}
        </>
      )}
    </div>
  );
}

// ── 場次列表 + 開新盤點 ─────────────────────────────────────────────────────

function SessionList({ sessions, progress, onOpen, onCreated }: {
  sessions: Session[];
  progress: Record<string, { total: number; counted: number }>;
  onOpen: (s: Session) => void;
  onCreated: () => void;
}) {
  const [showNew, setShowNew] = useState(false);
  const [name, setName] = useState('');
  const [vendor, setVendor] = useState('');
  const [ptype, setPtype] = useState('');
  const [keyword, setKeyword] = useState('');
  const [previewCount, setPreviewCount] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  // 品牌×類別組合(連件數)— 俾 dropdown 揀,唔使盲打
  const [facets, setFacets] = useState<Array<{ vendor: string; product_type: string; items: number }>>([]);

  useEffect(() => {
    if (!showNew || facets.length > 0) return;
    (async () => {
      const all: any[] = [];
      for (let from = 0; ; from += 1000) {
        const { data, error } = await supabase.from('inventory_facets').select('*').range(from, from + 999);
        if (error) { console.error(error); break; }
        all.push(...(data ?? []));
        if (!data || data.length < 1000) break;
      }
      setFacets(all);
    })();
  }, [showNew, facets.length]);

  const vendorOptions = useMemo(() => {
    const m = new Map<string, number>();
    for (const fc of facets) {
      if (!fc.vendor) continue;
      if (ptype && fc.product_type !== ptype) continue; // 揀咗類別就淨顯示有呢類貨嘅品牌
      m.set(fc.vendor, (m.get(fc.vendor) ?? 0) + Number(fc.items));
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [facets, ptype]);

  const typeOptions = useMemo(() => {
    const m = new Map<string, number>();
    for (const fc of facets) {
      if (!fc.product_type) continue;
      if (vendor && fc.vendor !== vendor) continue; // 揀咗品牌就淨顯示佢有嘅類別
      m.set(fc.product_type, (m.get(fc.product_type) ?? 0) + Number(fc.items));
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [facets, vendor]);

  const buildQuery = () => {
    let q = supabase.from('shopify_inventory').select('sku', { count: 'exact', head: true });
    if (vendor) q = q.eq('vendor', vendor);
    if (ptype) q = q.eq('product_type', ptype);
    if (keyword.trim()) q = q.or(`product_title.ilike.%${keyword.trim()}%,sku.ilike.%${keyword.trim()}%`);
    return q;
  };

  // 預覽:個範圍框住幾多行(未去重)
  useEffect(() => {
    if (!showNew) return;
    if (!vendor && !ptype && !keyword.trim()) { setPreviewCount(null); return; }
    const t = setTimeout(async () => {
      const { count } = await buildQuery();
      setPreviewCount(count ?? 0);
    }, 400);
    return () => clearTimeout(t);
  }, [vendor, ptype, keyword, showNew]);

  const create = async () => {
    if (!name.trim()) { alert('俾個名(例:8月手套盤點)'); return; }
    if (!vendor && !ptype && !keyword.trim()) { alert('至少設一個範圍(品牌/類別/關鍵字)— 全店 28,000 SKU 一次過盤會癲'); return; }
    setCreating(true);
    try {
      // 分頁攞晒範圍內貨行,同 SKU 多個 variant 行合併(系統數加埋)
      const rows: any[] = [];
      for (let from = 0; ; from += 1000) {
        let q = supabase.from('shopify_inventory')
          .select('sku,product_id,variant_id,product_title,variant_title,vendor,product_type,price,cost,inventory_quantity')
          .range(from, from + 999);
        if (vendor) q = q.eq('vendor', vendor);
        if (ptype) q = q.eq('product_type', ptype);
        if (keyword.trim()) q = q.or(`product_title.ilike.%${keyword.trim()}%,sku.ilike.%${keyword.trim()}%`);
        const { data, error } = await q;
        if (error) throw error;
        rows.push(...(data ?? []));
        if (!data || data.length < 1000) break;
      }
      const bySku = new Map<string, any>();
      for (const r of rows) {
        const sku = String(r.sku ?? '').trim();
        if (!sku) continue;
        const ex = bySku.get(sku);
        if (ex) ex.system_qty += Number(r.inventory_quantity ?? 0);
        else bySku.set(sku, { ...r, system_qty: Number(r.inventory_quantity ?? 0) });
      }
      if (bySku.size === 0) { alert('呢個範圍搵唔到貨'); return; }
      if (bySku.size > 5000 && !confirm(`呢批有 ${bySku.size} 個 SKU,肯定一批盤咁多?`)) return;

      const { data: sess, error: se } = await supabase.from('stocktake_sessions').insert({
        name: name.trim(),
        filter_vendor: vendor || null,
        filter_product_type: ptype || null,
        filter_keyword: keyword.trim() || null,
      }).select().single();
      if (se) throw se;

      const items = [...bySku.values()].map((r) => ({
        session_id: (sess as any).id,
        sku: String(r.sku).trim(),
        product_id: r.product_id ?? null,
        variant_id: r.variant_id ?? null,
        product_title: r.product_title ?? null,
        variant_title: r.variant_title ?? null,
        vendor: r.vendor ?? null,
        product_type: r.product_type ?? null,
        price: r.price ?? null,
        unit_cost: r.cost ?? null, // 開場 snapshot 成本價(同 price 一樣影低,之後改價唔影響報告)
        system_qty: r.system_qty,
      }));
      for (let i = 0; i < items.length; i += 500) {
        const { error } = await supabase.from('stocktake_items').insert(items.slice(i, i + 500));
        if (error) throw error;
      }
      setShowNew(false); setName(''); setVendor(''); setPtype(''); setKeyword('');
      onCreated();
    } catch (e) {
      alert(`開場失敗:${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setCreating(false);
    }
  };

  return (
    <>
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold flex items-center gap-2"><ClipboardList className="h-5 w-5" /> 盤點 Stocktake</h2>
        <button
          onClick={() => setShowNew(v => !v)}
          className="px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-sm font-semibold"
          data-testid="button-new-session"
        >
          {showNew ? '收起' : '+ 開新盤點'}
        </button>
      </div>

      {showNew && (
        <Card className="border-primary/40">
          <CardContent className="p-4 space-y-3">
            <p className="text-xs text-muted-foreground">分批盤:設範圍生成該批 SKU 清單,開場一刻 snapshot 系統數做對數基準。可以幾個同事同時入數,分幾日慢慢點。</p>
            <div className="grid gap-2 sm:grid-cols-2">
              <input className="h-9 px-3 rounded-md border border-border bg-background text-sm" placeholder="盤點名(例:8月手套盤點)" value={name} onChange={e => setName(e.target.value)} data-testid="input-session-name" />
              <select className="h-9 px-2 rounded-md border border-border bg-background text-sm" value={vendor} onChange={e => setVendor(e.target.value)} data-testid="select-vendor">
                <option value="">全部品牌{facets.length === 0 ? '(載入緊…)' : `(${vendorOptions.length} 個)`}</option>
                {vendorOptions.map(([v, n]) => <option key={v} value={v}>{v}({n} 件)</option>)}
              </select>
              <select className="h-9 px-2 rounded-md border border-border bg-background text-sm" value={ptype} onChange={e => setPtype(e.target.value)} data-testid="select-ptype">
                <option value="">全部類別{facets.length === 0 ? '(載入緊…)' : `(${typeOptions.length} 個)`}</option>
                {typeOptions.map(([v, n]) => <option key={v} value={v}>{v}({n} 件)</option>)}
              </select>
              <input className="h-9 px-3 rounded-md border border-border bg-background text-sm" placeholder="關鍵字(貨名/SKU,可留空)" value={keyword} onChange={e => setKeyword(e.target.value)} />
            </div>
            <div className="flex items-center gap-3">
              <button onClick={create} disabled={creating} className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-semibold disabled:opacity-50" data-testid="button-create-session">
                {creating ? '生成緊清單…' : '開場'}
              </button>
              {previewCount != null && <span className="text-xs text-muted-foreground">範圍內約 {formatNumber(previewCount)} 行貨</span>}
            </div>
          </CardContent>
        </Card>
      )}

      <div className="space-y-2">
        {sessions.length === 0 && <p className="text-sm text-muted-foreground py-8 text-center">未有盤點場次 — 撳「開新盤點」開始</p>}
        {sessions.map(s => {
          const p = progress[s.id] ?? { total: 0, counted: 0 };
          const pct = p.total ? Math.round((p.counted / p.total) * 100) : 0;
          return (
            <Card key={s.id} className="border-border/40 hover:border-border cursor-pointer" onClick={() => onOpen(s)} data-testid={`session-${s.id}`}>
              <CardContent className="p-4 flex items-center gap-4">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold">
                    {s.name}
                    <span className={`ml-2 px-1.5 py-0.5 rounded border text-[10px] ${s.status === 'done' ? 'text-emerald-300 border-emerald-500/40 bg-emerald-500/10' : 'text-amber-300 border-amber-500/40 bg-amber-500/10'}`}>
                      {s.status === 'done' ? '已完成' : '進行中'}
                    </span>
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {[s.filter_vendor && `品牌:${s.filter_vendor}`, s.filter_product_type && `類別:${s.filter_product_type}`, s.filter_keyword && `關鍵字:${s.filter_keyword}`].filter(Boolean).join(' · ') || '全部'}
                    {' · '}{new Date(s.created_at).toLocaleDateString('zh-HK')}
                  </p>
                  <div className="mt-2 h-1.5 rounded-full bg-muted overflow-hidden">
                    <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-lg font-bold tabular-nums">{p.counted}<span className="text-muted-foreground text-sm">/{p.total}</span></p>
                  <p className="text-[10px] text-muted-foreground">已點/總數</p>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </>
  );
}

// ── 場次詳情:入數 / 清單 / 報告 ────────────────────────────────────────────

function SessionDetail({ session, onBack, onSessionChange }: {
  session: Session;
  onBack: () => void;
  onSessionChange: (s: Session) => void;
}) {
  const [items, setItems] = useState<Item[]>([]);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'pending' | 'counted' | 'all'>('pending');
  const [q, setQ] = useState('');
  const [who, setWho] = useState(() => localStorage.getItem('stocktake_who') ?? '');
  const [editSku, setEditSku] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);
  const done = session.status === 'done';

  const loadEntries = async () => {
    const all: Entry[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase.from('stocktake_entries').select('*')
        .eq('session_id', session.id).order('created_at').range(from, from + 999);
      if (error) { console.error(error); break; }
      all.push(...((data as Entry[]) ?? []));
      if (!data || data.length < 1000) break;
    }
    setEntries(all);
  };

  const load = async () => {
    setLoading(true);
    const all: Item[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase.from('stocktake_items')
        .select('session_id,sku,product_title,variant_title,vendor,product_type,price,unit_cost,system_qty')
        .eq('session_id', session.id).order('sku').range(from, from + 999);
      if (error) { alert(error.message); break; }
      all.push(...((data as Item[]) ?? []));
      if (!data || data.length < 1000) break;
    }
    setItems(all);
    await loadEntries();
    setLoading(false);
  };
  useEffect(() => { load(); }, [session.id]);

  // 幾部手機同時盤:每 30 秒 + 返嚟呢個分頁時,自動同步人哋入嘅紀錄
  useEffect(() => {
    if (done) return;
    const iv = setInterval(loadEntries, 30_000);
    const onVis = () => { if (document.visibilityState === 'visible') loadEntries(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(iv); document.removeEventListener('visibilitychange', onVis); };
  }, [session.id, done]);

  useEffect(() => { localStorage.setItem('stocktake_who', who); }, [who]);

  // 每個 SKU:實點數 = 所有紀錄加總
  const totals = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of entries) m.set(e.sku, (m.get(e.sku) ?? 0) + e.qty);
    return m;
  }, [entries]);
  const entriesBySku = useMemo(() => {
    const m = new Map<string, Entry[]>();
    for (const e of entries) {
      const arr = m.get(e.sku) ?? [];
      arr.push(e);
      m.set(e.sku, arr);
    }
    return m;
  }, [entries]);

  const countedSkus = totals.size;
  const pct = items.length ? Math.round((countedSkus / items.length) * 100) : 0;

  const requireWho = (): boolean => {
    if (who.trim()) return true;
    alert('入數之前,喺上面「你個名」填低係邊個點 — 對數先有得追');
    return false;
  };

  const addEntry = async (sku: string, qty: number, note?: string) => {
    const tempId = `tmp-${Date.now()}-${Math.random()}`;
    const entry: Entry = {
      id: tempId, session_id: session.id, sku, qty,
      counted_by: who.trim(), note: note?.trim() || null, created_at: new Date().toISOString(),
    };
    setEntries(prev => [...prev, entry]);
    const { data, error } = await supabase.from('stocktake_entries').insert({
      session_id: session.id, sku, qty, counted_by: who.trim(), note: note?.trim() || null,
    }).select().single();
    if (error) {
      alert(`寫入失敗(${sku}):${error.message}`);
      setEntries(prev => prev.filter(e => e.id !== tempId));
      return false;
    }
    setEntries(prev => prev.map(e => (e.id === tempId ? (data as Entry) : e)));
    return true;
  };

  const deleteEntry = async (entry: Entry) => {
    if (!confirm(`刪除呢筆?${entry.counted_by ?? ''} ${entry.qty} 件`)) return;
    setEntries(prev => prev.filter(e => e.id !== entry.id));
    const { error } = await supabase.from('stocktake_entries').delete().eq('id', entry.id);
    if (error) { alert(`刪除失敗:${error.message}`); loadEntries(); }
  };

  // 掃碼/掃碼槍/手動輸入提交:全中 SKU → 插一筆 +1;唔中就當搜尋字
  const submitCode = async (raw: string) => {
    const code = raw.trim();
    if (!code) return;
    const hit = items.find(i => i.sku.toLowerCase() === code.toLowerCase());
    if (hit) {
      if (!requireWho()) return;
      const ok = await addEntry(hit.sku, 1);
      if (ok) {
        setFlash(`✓ ${itemName(hit)} — 合計 ${(totals.get(hit.sku) ?? 0) + 1} 件`);
        setTimeout(() => setFlash(null), 2500);
      }
      setQ('');
    } else {
      setQ(code); // 當搜尋,俾佢喺清單度揀
      setTab('all');
      setFlash(`搵唔到 SKU「${code}」— 已幫你當關鍵字搜尋`);
      setTimeout(() => setFlash(null), 3000);
    }
    codeRef.current?.focus();
  };

  const filtered = useMemo(() => {
    const kw = q.trim().toLowerCase();
    return items.filter(i => {
      const has = totals.has(i.sku);
      if (tab === 'pending' && has) return false;
      if (tab === 'counted' && !has) return false;
      if (kw && !(`${i.sku} ${i.product_title ?? ''} ${i.variant_title ?? ''}`.toLowerCase().includes(kw))) return false;
      return true;
    });
  }, [items, tab, q, totals]);

  const finish = async () => {
    const missing = items.length - countedSkus;
    if (!confirm(`完成盤點?${missing > 0 ? `仲有 ${missing} 款未點(會當「未點」列入報告)。` : '全部點齊。'}完成後所有人都停止入數。`)) return;
    const { data, error } = await supabase.from('stocktake_sessions')
      .update({ status: 'done', finished_at: new Date().toISOString() })
      .eq('id', session.id).select().single();
    if (error) { alert(error.message); return; }
    onSessionChange(data as Session);
  };

  // 差異報告數據(實點 = 逐筆加總)
  const report = useMemo(() => {
    const countedItems = items.filter(i => totals.has(i.sku));
    const diffs = countedItems
      .map(i => {
        const counted = totals.get(i.sku) ?? 0;
        return { ...i, counted, diff: counted - i.system_qty, diffValue: (counted - i.system_qty) * Number(i.price ?? 0) };
      })
      .filter(i => i.diff !== 0)
      .sort((a, b) => Math.abs(b.diffValue) - Math.abs(a.diffValue));
    const short = diffs.filter(d => d.diff < 0);
    const over = diffs.filter(d => d.diff > 0);
    return {
      diffs,
      shortQty: short.reduce((s, d) => s - d.diff, 0),
      shortValue: short.reduce((s, d) => s - d.diffValue, 0),
      overQty: over.reduce((s, d) => s + d.diff, 0),
      overValue: over.reduce((s, d) => s + d.diffValue, 0),
      matched: countedItems.length - diffs.length,
      uncounted: items.length - countedItems.length,
    };
  }, [items, totals]);

  const exportCsv = () => {
    const esc = (v: any) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [
      ['SKU', '貨名', '款式', '品牌', '類別', '系統數', '實點數', '差異', '單價', '差異金額', '點數人'].map(esc).join(','),
      ...items.map(i => {
        const counted = totals.get(i.sku);
        const diff = counted == null ? '' : counted - i.system_qty;
        const dv = counted == null ? '' : ((counted - i.system_qty) * Number(i.price ?? 0)).toFixed(2);
        const whos = [...new Set((entriesBySku.get(i.sku) ?? []).map(e => e.counted_by).filter(Boolean))].join('+');
        return [i.sku, i.product_title, i.variant_title, i.vendor, i.product_type, i.system_qty, counted ?? '未點', diff, i.price ?? '', dv, whos].map(esc).join(',');
      }),
    ];
    const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `盤點_${session.name}_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const exportEntriesCsv = () => {
    const esc = (v: any) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const bySku = new Map(items.map(i => [i.sku, i]));
    const lines = [
      ['時間', 'SKU', '貨名', '數量', '點數人', '備註'].map(esc).join(','),
      ...entries.map(e => {
        const i = bySku.get(e.sku);
        return [e.created_at, e.sku, i ? itemName(i) : '', e.qty, e.counted_by ?? '', e.note ?? ''].map(esc).join(',');
      }),
    ];
    const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `盤點明細_${session.name}_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <>
      <div className="flex items-center gap-2 flex-wrap">
        <button onClick={onBack} className="h-8 w-8 flex items-center justify-center rounded-md hover:bg-accent" data-testid="button-back"><ChevronLeft className="h-5 w-5" /></button>
        <h2 className="text-lg font-bold">{session.name}</h2>
        <span className={`px-1.5 py-0.5 rounded border text-[10px] ${done ? 'text-emerald-300 border-emerald-500/40 bg-emerald-500/10' : 'text-amber-300 border-amber-500/40 bg-amber-500/10'}`}>{done ? '已完成' : '進行中'}</span>
        <span className="text-xs text-muted-foreground">已點 {countedSkus}/{items.length}({pct}%)</span>
        {!done && (
          <button onClick={finish} className="ml-auto px-3 py-1.5 rounded-md border border-emerald-500/50 text-emerald-300 text-sm font-semibold hover:bg-emerald-500/10 flex items-center gap-1.5" data-testid="button-finish">
            <CheckCircle2 className="h-4 w-4" /> 完成盤點
          </button>
        )}
        {done && (
          <span className="ml-auto flex gap-2">
            <button onClick={exportCsv} className="px-3 py-1.5 rounded-md border border-border text-sm font-semibold hover:bg-accent" data-testid="button-csv">出 CSV(對數)</button>
            <button onClick={exportEntriesCsv} className="px-3 py-1.5 rounded-md border border-border text-sm hover:bg-accent" data-testid="button-csv-entries">逐筆明細</button>
          </span>
        )}
      </div>

      {/* 完場報告 */}
      {done && (
        <Card className="border-border/40">
          <CardContent className="p-4">
            <h3 className="text-sm font-semibold mb-3">差異報告 <span className="text-xs font-normal text-muted-foreground">俾倉務同事去 Shopify 調整用(唔會自動改)</span></h3>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
              <div className="rounded-md border border-border/40 p-3"><p className="text-xs text-muted-foreground">對得上</p><p className="text-xl font-bold tabular-nums">{formatNumber(report.matched)} 款</p></div>
              <div className="rounded-md border border-red-500/40 bg-red-500/10 p-3"><p className="text-xs text-red-300">蝕(少過系統)</p><p className="text-xl font-bold tabular-nums text-red-300">{formatNumber(report.shortQty)} 件 · {formatCurrency(report.shortValue)}</p></div>
              <div className="rounded-md border border-sky-500/40 bg-sky-500/10 p-3"><p className="text-xs text-sky-300">多(多過系統)</p><p className="text-xl font-bold tabular-nums text-sky-300">{formatNumber(report.overQty)} 件 · {formatCurrency(report.overValue)}</p></div>
              <div className="rounded-md border border-border/40 p-3"><p className="text-xs text-muted-foreground">未點</p><p className="text-xl font-bold tabular-nums">{formatNumber(report.uncounted)} 款</p></div>
            </div>
            {report.diffs.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead><tr className="border-b border-border/40 text-muted-foreground">
                    <th className="text-left py-1.5 pr-3">SKU</th><th className="text-left py-1.5 pr-3">貨品</th>
                    <th className="text-right py-1.5 pr-3">系統</th><th className="text-right py-1.5 pr-3">實點</th>
                    <th className="text-right py-1.5 pr-3">差異</th><th className="text-right py-1.5">差異金額</th>
                  </tr></thead>
                  <tbody>
                    {report.diffs.map(d => (
                      <tr key={d.sku} className="border-b border-border/20">
                        <td className="py-1.5 pr-3 font-mono">{d.sku}</td>
                        <td className="py-1.5 pr-3">{itemName(d)}</td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">{d.system_qty}</td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">{d.counted}</td>
                        <td className={`py-1.5 pr-3 text-right tabular-nums font-bold ${d.diff < 0 ? 'text-red-300' : 'text-sky-300'}`}>{d.diff > 0 ? '+' : ''}{d.diff}</td>
                        <td className={`py-1.5 text-right tabular-nums font-bold ${d.diff < 0 ? 'text-red-300' : 'text-sky-300'}`}>{formatCurrency(d.diffValue)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* 入數工具列(進行中先顯示) */}
      {!done && (
        <Card className="border-primary/30">
          <CardContent className="p-3 space-y-2">
            <div className="flex gap-2">
              <input
                ref={codeRef}
                className="h-11 flex-1 px-3 rounded-md border border-border bg-background text-base"
                placeholder="掃碼槍/輸入 SKU 撳 Enter = 幫呢款記低 1 件;打貨名可以搜尋"
                onKeyDown={(e) => { if (e.key === 'Enter') { submitCode((e.target as HTMLInputElement).value); (e.target as HTMLInputElement).value = ''; } }}
                data-testid="input-code"
              />
              <button onClick={() => setScanning(true)} className="h-11 px-3 rounded-md bg-primary text-primary-foreground flex items-center gap-1.5 text-sm font-semibold" data-testid="button-scan">
                <Camera className="h-4 w-4" /> 掃碼
              </button>
            </div>
            <div className="flex gap-2 items-center">
              <input className="h-8 w-40 px-2 rounded-md border border-border bg-background text-xs" placeholder="你個名(記入邊個點)" value={who} onChange={e => setWho(e.target.value)} data-testid="input-who" />
              <span className="text-[10px] text-muted-foreground">每次入數記一筆(似寫紙仔),同款自動加埋總數;30 秒自動同步</span>
              {flash && <span className="text-xs text-emerald-300 font-medium">{flash}</span>}
            </div>
          </CardContent>
        </Card>
      )}

      {/* 清單 */}
      <Card className="border-border/40">
        <CardContent className="p-3">
          <div className="flex gap-2 items-center flex-wrap mb-2">
            {(['pending', 'counted', 'all'] as const).map(t => (
              <button key={t} onClick={() => setTab(t)} className={`px-2.5 py-1 rounded-full border text-xs ${tab === t ? 'border-primary bg-primary/15 text-primary font-semibold' : 'border-border text-muted-foreground'}`}>
                {t === 'pending' ? `未點 ${items.length - countedSkus}` : t === 'counted' ? `已點 ${countedSkus}` : `全部 ${items.length}`}
              </button>
            ))}
            <input className="h-8 flex-1 min-w-[10rem] px-2 rounded-md border border-border bg-background text-xs" placeholder="搜尋 SKU / 貨名" value={q} onChange={e => setQ(e.target.value)} data-testid="input-filter" />
          </div>
          {loading ? (
            <p className="text-sm text-muted-foreground py-8 text-center animate-pulse">載入清單…</p>
          ) : (
            <div className="divide-y divide-border/20 max-h-[60vh] overflow-y-auto">
              {filtered.slice(0, 300).map(i => {
                const counted = totals.get(i.sku);
                const whos = [...new Set((entriesBySku.get(i.sku) ?? []).map(e => e.counted_by).filter(Boolean))];
                return (
                  <div key={i.sku} className="py-2 flex items-center gap-3 cursor-pointer hover:bg-muted/20 px-1 rounded" onClick={() => setEditSku(i.sku)} data-testid={`item-${i.sku}`}>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm truncate">{itemName(i)}</p>
                      <p className="text-[11px] text-muted-foreground font-mono">{i.sku}{i.vendor ? ` · ${i.vendor}` : ''}{whos.length > 0 ? ` · ${whos.join('+')}` : ''}</p>
                    </div>
                    {counted == null ? (
                      <span className="text-xs text-muted-foreground shrink-0">未點</span>
                    ) : (
                      <span className={`text-sm font-bold tabular-nums shrink-0 ${counted === i.system_qty ? 'text-emerald-300' : 'text-red-300'}`}>
                        {counted} 件{counted !== i.system_qty && `(系統 ${i.system_qty})`}
                      </span>
                    )}
                  </div>
                );
              })}
              {filtered.length > 300 && <p className="text-xs text-muted-foreground py-2 text-center">仲有 {filtered.length - 300} 款 — 用搜尋收窄</p>}
              {filtered.length === 0 && <p className="text-sm text-muted-foreground py-6 text-center">冇符合嘅貨</p>}
            </div>
          )}
        </CardContent>
      </Card>

      {editSku && (() => {
        const it = items.find(i => i.sku === editSku);
        if (!it) return null;
        return (
          <EntryModal
            item={it}
            entries={entriesBySku.get(it.sku) ?? []}
            total={totals.get(it.sku) ?? 0}
            readOnly={done}
            onClose={() => setEditSku(null)}
            onAdd={async (qty, note) => { if (!requireWho()) return; await addEntry(it.sku, qty, note); }}
            onDelete={deleteEntry}
          />
        );
      })()}

      {scanning && <ScanModal onCode={(c) => { setScanning(false); submitCode(c); }} onClose={() => setScanning(false)} />}
    </>
  );
}

// ── 逐筆紀錄彈窗:睇明細 + 加一筆 ───────────────────────────────────────────

function EntryModal({ item, entries, total, readOnly, onClose, onAdd, onDelete }: {
  item: Item;
  entries: Entry[];
  total: number;
  readOnly: boolean;
  onClose: () => void;
  onAdd: (qty: number, note?: string) => Promise<void>;
  onDelete: (e: Entry) => void;
}) {
  const [val, setVal] = useState('');
  const [note, setNote] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (!readOnly) ref.current?.focus(); }, [readOnly]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  const add = async () => {
    const n = parseInt(val, 10);
    if (Number.isNaN(n) || n <= 0) { alert('入返個大過 0 嘅數量 — 呢筆會自動加落呢款貨嘅合計度'); return; }
    await onAdd(n, note);
    setVal(''); setNote('');
    ref.current?.focus();
  };

  return (
    <div className="fixed inset-0 z-[100] bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-card border border-border rounded-lg p-4 w-full max-w-sm" onClick={e => e.stopPropagation()}>
        <p className="text-sm font-semibold">{itemName(item)}</p>
        <p className="text-xs text-muted-foreground font-mono mt-0.5">{item.sku}</p>

        {/* 逐筆明細 */}
        <p className="mt-3 text-[10px] text-muted-foreground">點數紀錄 — 每次入數記一筆,唔同人/唔同位置分開記,自動加埋:</p>
        <div className="mt-1 rounded-md border border-border/40 divide-y divide-border/20 max-h-48 overflow-y-auto">
          {entries.length === 0 && <p className="text-xs text-muted-foreground p-3 text-center">未有紀錄</p>}
          {entries.map(e => (
            <div key={e.id} className="px-3 py-1.5 flex items-center gap-2 text-xs">
              <span className="font-bold tabular-nums w-12">{e.qty} 件</span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">
                {e.counted_by ?? '(冇名)'}{e.note ? ` · ${e.note}` : ''} · {new Date(e.created_at).toLocaleString('zh-HK', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
              </span>
              {!readOnly && (
                <button className="text-muted-foreground hover:text-red-300 shrink-0" onClick={() => onDelete(e)} title="刪除呢筆" data-testid={`entry-del-${e.id}`}>
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          ))}
        </div>
        <p className="mt-2 text-center text-sm">
          合計 <span className="text-xl font-bold tabular-nums">{total}</span> 件
          {entries.length > 0 && <span className={`ml-2 text-xs font-semibold ${total === item.system_qty ? 'text-emerald-300' : 'text-red-300'}`}>(系統 {item.system_qty} 件)</span>}
        </p>

        {/* 加一筆 */}
        {!readOnly && (
          <div className="mt-3 space-y-2">
            <div className="flex gap-2">
              <input
                ref={ref}
                type="number" inputMode="numeric" min={1}
                className="h-11 flex-1 px-3 rounded-md border border-border bg-background text-lg font-bold tabular-nums text-center"
                value={val} onChange={e => setVal(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') add(); }}
                placeholder="今次點到幾多件"
                data-testid="input-entry-qty"
              />
              <button onClick={add} className="h-11 px-4 rounded-md bg-primary text-primary-foreground font-semibold" data-testid="button-add-entry">記低</button>
            </div>
            <input
              className="h-8 w-full px-2 rounded-md border border-border bg-background text-xs"
              value={note} onChange={e => setNote(e.target.value)}
              placeholder="備註(例:鋪面/倉,可留空)"
              data-testid="input-entry-note"
            />
          </div>
        )}
        <button onClick={onClose} className="mt-3 h-9 w-full rounded-md border border-border text-sm">閂</button>
      </div>
    </div>
  );
}

// ── 相機掃碼:Android Chrome 用內置 BarcodeDetector(快);iPhone Safari 冇,
//    用 ZXing JS 解碼做後備(dynamic import,唔掃碼唔會載)──

function ScanModal({ onCode, onClose }: { onCode: (code: string) => void; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0;
    let stopped = false;
    let zxingControls: { stop: () => void } | null = null;

    const startNative = async (Det: any) => {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      if (stopped) { stream.getTracks().forEach(t => t.stop()); return; }
      const v = videoRef.current!;
      v.srcObject = stream;
      await v.play();
      const det = new Det({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'qr_code'] });
      const tick = async () => {
        if (stopped) return;
        try {
          const codes = await det.detect(v);
          if (codes.length > 0 && codes[0].rawValue) {
            stopped = true;
            stream?.getTracks().forEach(t => t.stop());
            onCode(String(codes[0].rawValue));
            return;
          }
        } catch { /* 個別 frame 認唔到,照 loop */ }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    };

    const startZxing = async () => {
      const [{ BrowserMultiFormatReader }, { DecodeHintType, BarcodeFormat }] = await Promise.all([
        import('@zxing/browser'),
        import('@zxing/library'),
      ]);
      const hints = new Map();
      hints.set(DecodeHintType.POSSIBLE_FORMATS, [
        BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E,
        BarcodeFormat.CODE_128, BarcodeFormat.CODE_39, BarcodeFormat.QR_CODE,
      ]);
      const reader = new BrowserMultiFormatReader(hints);
      zxingControls = await reader.decodeFromConstraints(
        { video: { facingMode: 'environment' } },
        videoRef.current!,
        (result) => {
          if (result && !stopped) {
            stopped = true;
            zxingControls?.stop();
            onCode(result.getText());
          }
        }
      );
      if (stopped) zxingControls.stop();
    };

    (async () => {
      try {
        const Det = (window as any).BarcodeDetector;
        if (Det) await startNative(Det);
        else await startZxing();
      } catch (e) {
        setErr(`開唔到相機:${e instanceof Error ? e.message : String(e)} — 檢查下瀏覽器有冇俾相機權限`);
      }
    })();

    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach(t => t.stop());
      zxingControls?.stop();
    };
  }, [onCode]);

  return (
    <div className="fixed inset-0 z-[100] bg-black/85 flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="flex items-center justify-between mb-2">
          <p className="text-sm text-white font-semibold">對準貨品條碼</p>
          <button onClick={onClose} className="h-8 w-8 flex items-center justify-center rounded-md bg-white/10 text-white" data-testid="button-scan-close"><X className="h-5 w-5" /></button>
        </div>
        {err ? (
          <p className="text-sm text-amber-300 bg-amber-500/10 border border-amber-500/40 rounded-md p-3">{err}</p>
        ) : (
          <video ref={videoRef} className="w-full rounded-lg border border-white/20" muted playsInline />
        )}
      </div>
    </div>
  );
}
