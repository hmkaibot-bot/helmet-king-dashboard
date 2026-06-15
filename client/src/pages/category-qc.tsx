import { useEffect, useMemo, useState, useCallback } from 'react';
import { queryAllPages } from '@/lib/query-helpers';
import { supabase } from '@/lib/supabase';
import { updateProducts, type ProductUpdate } from '@/lib/shopify-update';
import { Tags, RefreshCw, AlertCircle, Upload, Search } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { MultiSelectChipFilter } from '@/components/multi-select-chip-filter';

interface ProductRow {
  id: string;
  title: string;
  product_type: string | null;
  vendor: string | null;
  status: string | null;
}

// 你個分類體系嘅四大類 root
const ROOTS = ['HELMET', 'RIDER GEARS', 'MOTORCYCLE PARTS', 'ACCESSORIES'];

// 標題關鍵字 → 建議分類（高信心）
const KEYWORD_RULES: { re: RegExp; type: string; root: string }[] = [
  { re: /\b(visor|shield)\b|鏡片/i, type: 'HELMET - VISOR', root: 'HELMET' },
  { re: /\bhelmet\b|頭盔/i, type: 'HELMET - FULL FACE', root: 'HELMET' },
  { re: /\bglove|手套/i, type: 'RIDER GEARS - GLOVES', root: 'RIDER GEARS' },
  { re: /\bjacket|外套/i, type: 'RIDER GEARS - JACKETS', root: 'RIDER GEARS' },
  { re: /\b(boot|shoe)s?\b|靴|鞋/i, type: 'RIDER GEARS - BOOTS/SHOES', root: 'RIDER GEARS' },
  { re: /\b(pant|jean)s?\b|褲/i, type: 'RIDER GEARS - PANTS/JEANS', root: 'RIDER GEARS' },
  { re: /\bt-?shirt|\btee\b/i, type: 'RIDER GEARS - CASUAL T-SHIRT', root: 'RIDER GEARS' },
  { re: /\b(bag|luggage|backpack)\b|背囊|袋/i, type: 'ACCESSORIES - LUGGAGE & BAG', root: 'ACCESSORIES' },
];

type IssueKind = 'empty' | 'off_taxonomy' | 'title_mismatch';
const ISSUE_LABEL: Record<IssueKind, string> = {
  empty: '無分類',
  off_taxonomy: '不符體系',
  title_mismatch: '標題疑似不符',
};
const ISSUE_COLOR: Record<IssueKind, string> = {
  empty: 'bg-rose-500/10 border-rose-500/40 text-rose-300',
  off_taxonomy: 'bg-amber-500/10 border-amber-500/40 text-amber-300',
  title_mismatch: 'bg-sky-500/10 border-sky-500/40 text-sky-300',
};

interface Flagged extends ProductRow {
  issue: IssueKind;
  suggested: string | null;
}

function rootOf(pt: string | null): string | null {
  if (!pt) return null;
  const up = pt.toUpperCase();
  return ROOTS.find((r) => up.startsWith(r)) ?? null;
}

export default function CategoryQcPage() {
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [edits, setEdits] = useState<Map<string, string>>(new Map());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkType, setBulkType] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [issueFilter, setIssueFilter] = useState<IssueKind | 'all'>('all');
  const [selectedVendors, setSelectedVendors] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [resolved, setResolved] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await queryAllPages('shopify_products', 'id,title,product_type,vendor,status');
      setProducts(rows as ProductRow[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  // 跟體系嘅 distinct product_type（落下拉）
  const canonicalTypes = useMemo(() => {
    const s = new Set<string>();
    for (const p of products) {
      const pt = (p.product_type || '').trim();
      if (pt && rootOf(pt)) s.add(pt);
    }
    return Array.from(s).sort();
  }, [products]);

  const flagged = useMemo<Flagged[]>(() => {
    const out: Flagged[] = [];
    for (const p of products) {
      if (p.status && p.status.toLowerCase() === 'archived') continue;
      const pt = (p.product_type || '').trim();
      if (!pt) {
        out.push({ ...p, issue: 'empty', suggested: null });
        continue;
      }
      if (!rootOf(pt)) {
        out.push({ ...p, issue: 'off_taxonomy', suggested: null });
        continue;
      }
      const title = p.title || '';
      for (const rule of KEYWORD_RULES) {
        if (rule.re.test(title) && rootOf(pt) !== rule.root) {
          out.push({ ...p, issue: 'title_mismatch', suggested: canonicalTypes.includes(rule.type) ? rule.type : null });
          break;
        }
      }
    }
    return out;
  }, [products, canonicalTypes]);

  const view = useMemo(() => {
    let list = flagged.filter((f) => !resolved.has(f.id));
    if (issueFilter !== 'all') list = list.filter((f) => f.issue === issueFilter);
    if (selectedVendors.size > 0) list = list.filter((f) => selectedVendors.has(f.vendor || '(未知)'));
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter((f) => f.title.toLowerCase().includes(q) || (f.product_type || '').toLowerCase().includes(q));
    }
    return list;
  }, [flagged, resolved, issueFilter, selectedVendors, search]);

  const vendorOptions = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of flagged) {
      if (resolved.has(f.id)) continue;
      const k = f.vendor || '(未知)';
      m.set(k, (m.get(k) || 0) + 1);
    }
    return Array.from(m.entries()).sort((a, b) => b[1] - a[1]).map(([k]) => k);
  }, [flagged, resolved]);

  const counts = useMemo(() => {
    const c = { empty: 0, off_taxonomy: 0, title_mismatch: 0 };
    for (const f of flagged) if (!resolved.has(f.id)) c[f.issue]++;
    return c;
  }, [flagged, resolved]);

  const pendingCount = useMemo(() => {
    const map = new Map(products.map((p) => [p.id, p]));
    let n = 0;
    for (const [id, t] of edits.entries()) {
      const c = map.get(id);
      if (c && t && t !== (c.product_type || '')) n++;
    }
    return n;
  }, [edits, products]);

  const setEdit = (id: string, type: string) =>
    setEdits((prev) => {
      const n = new Map(prev);
      if (type) n.set(id, type);
      else n.delete(id);
      return n;
    });
  const toggle = (id: string) =>
    setSelected((prev) => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  const applyBulk = () => {
    if (!bulkType || selected.size === 0) return;
    setEdits((prev) => {
      const n = new Map(prev);
      for (const id of selected) n.set(id, bulkType);
      return n;
    });
  };

  const handleSync = useCallback(async () => {
    const map = new Map(products.map((p) => [p.id, p]));
    const items: ProductUpdate[] = [];
    for (const [id, newType] of edits.entries()) {
      const cur = map.get(id);
      if (cur && newType && newType !== (cur.product_type || '')) items.push({ productId: id, productType: newType });
    }
    if (items.length === 0) {
      alert('未有任何改動可套用（先喺「新分類」揀好正確分類）。');
      return;
    }
    if (!confirm(`確定將 ${items.length} 件商品嘅分類改返 Shopify？\n\n⚠️ 會即時改 Shopify 商品嘅 Product type。`)) return;
    setSyncing(true);
    setSyncMsg(`套用中 0/${items.length}…`);
    try {
      const r = await updateProducts(items, (d, t) => setSyncMsg(`套用中 ${d}/${t}…`));
      const okIds = new Set(r.results.filter((x) => x.ok).map((x) => x.productId));
      // optimistic: 同步寫返 Supabase（best-effort，失敗由每日 sync 補返）
      await Promise.allSettled(
        items
          .filter((it) => okIds.has(it.productId))
          .map((it) => supabase.from('shopify_products').update({ product_type: it.productType }).eq('id', it.productId))
      );
      setProducts((prev) => prev.map((p) => (okIds.has(p.id) ? { ...p, product_type: edits.get(p.id) || p.product_type } : p)));
      setResolved((prev) => {
        const n = new Set(prev);
        okIds.forEach((id) => n.add(id));
        return n;
      });
      setEdits((prev) => {
        const n = new Map(prev);
        okIds.forEach((id) => n.delete(id));
        return n;
      });
      setSelected(new Set());
      const fails = r.results.filter((x) => !x.ok).slice(0, 5).map((x) => `· ${x.productId}: ${x.error}`);
      alert(`完成：成功 ${r.ok} · 失敗 ${r.failed}（共 ${r.total}）${fails.length ? '\n\n失敗例子：\n' + fails.join('\n') : ''}`);
    } catch (e) {
      alert(`套用失敗：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSyncing(false);
      setSyncMsg(null);
    }
  }, [edits, products]);

  const allSelected = view.length > 0 && view.every((f) => selected.has(f.id));

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <Tags className="h-5 w-5 text-primary" />
          <h1 className="text-lg font-semibold">商品分類清理</h1>
          <span className="text-xs text-muted-foreground">Category QC · 疑似 {flagged.length - resolved.size}</span>
        </div>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          <button
            onClick={handleSync}
            disabled={loading || syncing || pendingCount === 0}
            title="將已揀好嘅新分類一次過改返 Shopify"
            className="text-xs px-3 py-1.5 rounded-md border border-primary/50 bg-primary/10 text-primary hover:bg-primary/20 transition-colors inline-flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Upload className={`h-3.5 w-3.5 ${syncing ? 'animate-pulse' : ''}`} />
            套用去 Shopify{pendingCount > 0 ? ` (${pendingCount})` : ''}
          </button>
          <button
            onClick={load}
            disabled={loading}
            className="text-xs px-3 py-1.5 rounded-md border border-border bg-card hover:bg-accent/60 transition-colors inline-flex items-center gap-1"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            重新整理
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-rose-500/40 bg-rose-500/10 p-3 text-rose-200 text-sm flex items-center gap-2">
          <AlertCircle className="h-4 w-4" />
          {error}
        </div>
      )}
      {syncMsg && (
        <div className="rounded-md border border-primary/40 bg-primary/10 p-2 text-xs text-primary inline-flex items-center gap-2">
          <Upload className="h-3.5 w-3.5 animate-pulse" />
          {syncMsg}
        </div>
      )}

      {/* Issue tabs */}
      <div className="flex items-center gap-1.5 flex-wrap text-xs">
        {(['all', 'empty', 'off_taxonomy', 'title_mismatch'] as const).map((k) => (
          <button
            key={k}
            onClick={() => setIssueFilter(k)}
            className={`px-2.5 py-1 rounded-md border transition-colors ${
              issueFilter === k ? 'bg-primary/90 text-primary-foreground border-primary' : 'border-border bg-card hover:bg-accent/60'
            }`}
          >
            {k === 'all' ? `全部 ${flagged.length - resolved.size}` : `${ISSUE_LABEL[k]} ${counts[k]}`}
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-md">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜尋產品名稱、現分類…"
            className="w-full pl-8 pr-3 py-1.5 text-xs rounded-md border border-border bg-background"
          />
        </div>
      </div>
      {!loading && vendorOptions.length > 0 && (
        <div className="rounded-md border border-border/60 bg-card p-2">
          <MultiSelectChipFilter
            label="品牌"
            options={vendorOptions}
            selected={Array.from(selectedVendors)}
            onChange={(next) => setSelectedVendors(new Set(next))}
            placeholder="搜尋品牌…"
          />
        </div>
      )}

      {/* Bulk bar */}
      {selected.size > 0 && (
        <div className="rounded-md border border-primary/40 bg-primary/5 p-3 flex items-center gap-2 flex-wrap">
          <span className="text-xs">已選 {selected.size} 件</span>
          <span className="text-xs text-muted-foreground">→ 設為</span>
          <select
            value={bulkType}
            onChange={(e) => setBulkType(e.target.value)}
            className="text-xs px-2 py-1 rounded-md border border-border bg-background max-w-[260px]"
          >
            <option value="">揀分類…</option>
            {canonicalTypes.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <button
            onClick={applyBulk}
            disabled={!bulkType}
            className="text-xs px-3 py-1 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            套用到所選
          </button>
          <button onClick={() => setSelected(new Set())} className="text-xs px-2 py-1 rounded-md border border-border hover:bg-accent/60 transition-colors ml-auto">
            清空選擇
          </button>
        </div>
      )}

      {/* Table */}
      {loading ? (
        <Skeleton className="h-64 w-full" />
      ) : view.length === 0 ? (
        <div className="rounded-md border border-dashed border-border/60 p-12 text-center text-sm text-muted-foreground">
          {flagged.length === 0 ? '冇偵測到疑似錯分類 🎉' : '此條件下冇商品（或已全部處理）'}
        </div>
      ) : (
        <div className="rounded-md border border-border/60 bg-card overflow-x-auto">
          <table className="w-full text-xs" data-testid="category-qc-table">
            <thead className="bg-muted/30 border-b border-border/40">
              <tr>
                <th className="text-left px-2 py-2 font-normal text-muted-foreground w-8">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={(e) => setSelected(e.target.checked ? new Set(view.map((f) => f.id)) : new Set())}
                    className="cursor-pointer"
                  />
                </th>
                <th className="text-left px-2 py-2 font-normal text-muted-foreground">產品名稱</th>
                <th className="text-left px-2 py-2 font-normal text-muted-foreground">品牌</th>
                <th className="text-left px-2 py-2 font-normal text-muted-foreground">現分類</th>
                <th className="text-left px-2 py-2 font-normal text-muted-foreground">問題</th>
                <th className="text-left px-2 py-2 font-normal text-muted-foreground">建議</th>
                <th className="text-left px-2 py-2 font-normal text-muted-foreground">新分類 → Shopify</th>
              </tr>
            </thead>
            <tbody>
              {view.map((f) => {
                const isSel = selected.has(f.id);
                const editVal = edits.get(f.id) || '';
                return (
                  <tr key={f.id} className={`border-b border-border/40 hover:bg-accent/30 ${isSel ? 'bg-primary/5' : ''}`}>
                    <td className="px-2 py-1.5">
                      <input type="checkbox" checked={isSel} onChange={() => toggle(f.id)} className="cursor-pointer" />
                    </td>
                    <td className="px-2 py-1.5 font-medium max-w-[280px]">
                      <span className="truncate block" title={f.title}>
                        {f.title}
                      </span>
                    </td>
                    <td className="px-2 py-1.5 text-muted-foreground">{f.vendor || '—'}</td>
                    <td className="px-2 py-1.5 text-muted-foreground">{f.product_type || <span className="text-rose-300">（空）</span>}</td>
                    <td className="px-2 py-1.5">
                      <span className={`px-1.5 py-0.5 rounded text-[10px] border ${ISSUE_COLOR[f.issue]}`}>{ISSUE_LABEL[f.issue]}</span>
                    </td>
                    <td className="px-2 py-1.5">
                      {f.suggested ? (
                        <button
                          onClick={() => setEdit(f.id, f.suggested as string)}
                          className="text-[11px] text-primary hover:underline text-left"
                          title="採用此建議"
                        >
                          {f.suggested}
                        </button>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-2 py-1.5">
                      <select
                        value={editVal}
                        onChange={(e) => setEdit(f.id, e.target.value)}
                        className={`text-xs px-2 py-0.5 rounded-md border bg-background max-w-[240px] ${
                          editVal ? 'border-primary/50 text-primary' : 'border-border'
                        }`}
                      >
                        <option value="">— 唔改 —</option>
                        {canonicalTypes.map((t) => (
                          <option key={t} value={t}>
                            {t}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
