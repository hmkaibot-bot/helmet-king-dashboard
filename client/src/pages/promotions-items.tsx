import { useEffect, useState, useMemo, useCallback } from 'react';
import { Link } from 'wouter';
import { supabase } from '@/lib/supabase';
import { formatCurrency, formatNumber } from '@/lib/format';
import {
  Package,
  RefreshCw,
  AlertCircle,
  Megaphone,
  Search,
  History,
  ArrowRight,
  X,
  Info,
} from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { MultiSelectChipFilter } from '@/components/multi-select-chip-filter';
import {
  Promotion,
  PromotionItem,
  STATUS_LABEL,
  STATUS_COLOR,
  fetchAllRows,
  effectiveStatus,
} from '@/lib/promotions-shared';

// Bulk-assign sentinel：揀「未分派」= 移除該商品所有現有推廣分派（用獨立 sentinel,
// 因為 value="" 已經係 placeholder「揀推廣…」）。
const UNASSIGN = '__unassign__';

// Supabase / PostgrestError 係 plain object（唔係 Error instance）,String(e) 會變
// "[object Object]"。抽返 message/details/hint/code 出嚟,唔好俾錯誤變亂碼。
function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === 'object') {
    const o = e as Record<string, unknown>;
    const parts = [o.message, o.details, o.hint, o.code].filter(Boolean);
    if (parts.length) return parts.join(' · ');
    try {
      return JSON.stringify(o);
    } catch {
      return String(e);
    }
  }
  return String(e);
}

interface InventoryRow {
  sku: string;
  // DB 係 bigint, Supabase 可能 return number/string
  product_id: number | string | null;
  product_title: string | null;
  vendor: string | null;
  product_type: string | null;
  inventory_quantity: number | null;
}

interface ReviewRow {
  sku: string;
  manual_status: string | null;
  is_promoting: boolean | null;
}

interface PromotingProduct {
  product_id: string;
  product_title: string;
  vendor: string;
  product_type: string;
  num_skus: number;
  total_inventory: number;
  previous_manual_status: string | null;
  // 分派狀態 —— 一件商品可入多個推廣活動（DB PK = (promotion_id, product_id) 複合鍵）。
  assigned_promos: Promotion[];
}

export default function PromotionsItemsPage() {
  const [products, setProducts] = useState<PromotingProduct[]>([]);
  const [activePromos, setActivePromos] = useState<Promotion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [filterAssignment, setFilterAssignment] = useState<'all' | 'assigned' | 'unassigned'>('all');
  const [filterPromo, setFilterPromo] = useState<string>(''); // '' = 全部活動;否則 promo id
  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(new Set());
  const [selectedVendors, setSelectedVendors] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkPromo, setBulkPromo] = useState<string>('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // 1. All inventory + reviews
      const [inv, reviews, promos, items] = await Promise.all([
        fetchAllRows<InventoryRow>(
          'shopify_inventory',
          'sku,product_id,product_title,vendor,product_type,inventory_quantity'
        ),
        fetchAllRows<ReviewRow>('dead_stock_reviews', 'sku,manual_status,is_promoting'),
        fetchAllRows<Promotion>('promotions'),
        fetchAllRows<PromotionItem>('promotion_items'),
      ]);

      // 2. Build product → SKUs map, find products with is_promoting=true on any child SKU
      // (parent-level promoting decision; aggregate on product_id)
      // Note: is_promoting 是獨立 checkbox — 同 manual_status 完全分開，
      // 由 dead-stock 頁 「推廣中」 column 勾選設定。
      const reviewBySku = new Map<string, ReviewRow>();
      for (const r of reviews) reviewBySku.set(r.sku, r);

      // 用 String(product_id) 作 key 避免 number/string 雙模 hash 衝突
      const byProduct = new Map<string, InventoryRow[]>();
      for (const i of inv) {
        if (i.product_id == null) continue;
        const key = String(i.product_id);
        const arr = byProduct.get(key) ?? [];
        arr.push(i);
        byProduct.set(key, arr);
      }

      // Determine if a product is "promoting" — ANY child SKU with is_promoting=true
      // (dead-stock V2 parent 勾選會 propagate 到所有 child SKU，但 individual SKU 亦可各自勾)
      const activeItems = items.filter(it => !it.is_archived);
      // product_id (string) -> promo_id[]（一件商品可分派多個活動 → 收集成 array）
      const assignedByProduct = new Map<string, string[]>();
      for (const it of activeItems) {
        const key = String(it.product_id);
        const arr = assignedByProduct.get(key) ?? [];
        arr.push(it.promotion_id);
        assignedByProduct.set(key, arr);
      }
      const promoById = new Map<string, Promotion>(promos.map(p => [p.id, p]));

      const promotingProducts: PromotingProduct[] = [];
      for (const [productId, skus] of byProduct.entries()) {
        // Check if any SKU has is_promoting=true
        const promotingSku = skus.find(s => {
          const r = reviewBySku.get(s.sku);
          return r?.is_promoting === true;
        });
        if (!promotingSku) continue;

        const review = reviewBySku.get(promotingSku.sku);
        // 解析所有已分派活動（去重、隔走搵唔到嘅 promo）
        const assignedPromoIds = Array.from(new Set(assignedByProduct.get(productId) ?? []));
        const assignedPromos = assignedPromoIds
          .map(id => promoById.get(id))
          .filter((p): p is Promotion => p != null)
          .sort((a, b) => a.start_date.localeCompare(b.start_date));

        promotingProducts.push({
          product_id: productId,
          product_title: skus[0].product_title ?? '—',
          vendor: skus[0].vendor ?? '—',
          product_type: skus[0].product_type ?? '—',
          num_skus: skus.length,
          total_inventory: skus.reduce((s, x) => s + (x.inventory_quantity ?? 0), 0),
          previous_manual_status: review?.manual_status ?? null,
          assigned_promos: assignedPromos,
        });
      }

      promotingProducts.sort((a, b) => {
        // unassigned first
        const aU = a.assigned_promos.length === 0;
        const bU = b.assigned_promos.length === 0;
        if (aU !== bU) return aU ? -1 : 1;
        return a.product_title.localeCompare(b.product_title);
      });

      setProducts(promotingProducts);
      setActivePromos(
        promos
          .filter(p => {
            const st = effectiveStatus(p);
            return st === 'active' || st === 'planned';
          })
          .sort((a, b) => a.start_date.localeCompare(b.start_date))
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = useMemo(() => {
    let list = products;
    if (filterAssignment === 'assigned') list = list.filter(p => p.assigned_promos.length > 0);
    else if (filterAssignment === 'unassigned') list = list.filter(p => p.assigned_promos.length === 0);
    if (filterPromo) list = list.filter(p => p.assigned_promos.some(x => x.id === filterPromo));
    if (selectedTypes.size > 0) {
      list = list.filter(p => selectedTypes.has(p.product_type || '(未分類)'));
    }
    if (selectedVendors.size > 0) {
      list = list.filter(p => selectedVendors.has(p.vendor || '(未分類)'));
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(
        p =>
          p.product_title.toLowerCase().includes(q) ||
          p.vendor.toLowerCase().includes(q) ||
          p.product_id.toLowerCase().includes(q)
      );
    }
    return list;
  }, [products, filterAssignment, filterPromo, search, selectedTypes, selectedVendors]);

  // Filter options —按推廣商品數量降序
  const typeOptions = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of products) {
      const k = p.product_type || '(未分類)';
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return Array.from(m.entries()).sort((a, b) => b[1] - a[1]).map(([k]) => k);
  }, [products]);

  const vendorOptions = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of products) {
      const k = p.vendor || '(未分類)';
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return Array.from(m.entries()).sort((a, b) => b[1] - a[1]).map(([k]) => k);
  }, [products]);

  const assignedCount = products.filter(p => p.assigned_promos.length > 0).length;
  const unassignedCount = products.length - assignedCount;

  // ── 低階 DB 操作（無 confirm、無 reload；俾單行同批次共用）──────────────────
  const insertAssignment = async (productIdNum: number, promoId: string) => {
    // upsert + ignoreDuplicates：若該 (活動,商品) 已存在就當無事,唔會撞 PK error
    const { error: insErr } = await supabase.from('promotion_items').upsert(
      {
        promotion_id: promoId,
        product_id: productIdNum,
        previous_manual_status: 'dead',
        is_archived: false,
      },
      { onConflict: 'promotion_id,product_id', ignoreDuplicates: true }
    );
    if (insErr) throw insErr;
  };

  const deleteAssignment = async (productIdNum: number, promoId: string) => {
    const { error: delErr } = await supabase
      .from('promotion_items')
      .delete()
      .eq('product_id', productIdNum)
      .eq('promotion_id', promoId)
      .eq('is_archived', false);
    if (delErr) throw delErr;
  };

  const toProductIdNum = (productId: string): number => {
    const n = Number(productId);
    if (!Number.isFinite(n)) throw new Error(`Invalid product_id: ${productId}`);
    return n;
  };

  // ── 單行：加入 / 移除一個活動 ─────────────────────────────────────────────
  const addPromo = async (productId: string, promoId: string) => {
    try {
      const product = products.find(p => p.product_id === productId);
      const newPromo = activePromos.find(p => p.id === promoId);
      if (!product || !newPromo) return;
      if (product.assigned_promos.some(x => x.id === promoId)) return; // 已加,無事

      // 只有當新活動係「進行中」而該商品已經喺另一個「進行中」活動時先提示
      // （疊住同期活動 = 兩邊營收報表各自計同一張單;跨時段唔撞就唔煩）
      if (effectiveStatus(newPromo) === 'active') {
        const otherActive = product.assigned_promos.filter(
          x => x.id !== promoId && effectiveStatus(x) === 'active'
        );
        if (otherActive.length > 0) {
          const names = otherActive.map(x => x.name).join('、');
          const ok = confirm(
            `「${product.product_title}」已經喺 ${otherActive.length} 個進行中活動（${names}）。\n\n` +
              `再加入「${newPromo.name}」= 同一時間喺多個進行中活動,兩邊嘅營收報表會各自把同一張訂單計一次(合計會重複)。\n\n` +
              `確定要加?`
          );
          if (!ok) return;
        }
      }

      await insertAssignment(toProductIdNum(productId), promoId);
      await load();
    } catch (e) {
      alert(`加入活動失敗：${errMsg(e)}`);
    }
  };

  const removePromo = async (productId: string, promoId: string) => {
    try {
      await deleteAssignment(toProductIdNum(productId), promoId);
      await load();
    } catch (e) {
      alert(`移除活動失敗：${errMsg(e)}`);
    }
  };

  // ── 批次：加入活動（保留現有分派）/ 清空全部分派 ──────────────────────────
  const handleBulkAssign = async () => {
    if (!bulkPromo || selected.size === 0) return;
    const unassign = bulkPromo === UNASSIGN;

    let msg: string;
    if (unassign) {
      msg = `將所揀 ${selected.size} 件商品設為未分派（移除佢哋所有活動分派）？`;
    } else {
      const targetPromo = activePromos.find(p => p.id === bulkPromo);
      const targetName = targetPromo?.name ?? '所揀推廣';
      // 加入後會同時喺多個「進行中」活動嘅件數 → 提示可能重複計營收
      const willOverlap =
        targetPromo && effectiveStatus(targetPromo) === 'active'
          ? Array.from(selected).filter(pid => {
              const p = products.find(x => x.product_id === pid);
              return p?.assigned_promos.some(x => x.id !== bulkPromo && effectiveStatus(x) === 'active');
            })
          : [];
      msg =
        `將 ${selected.size} 件商品加入「${targetName}」（保留現有分派,唔會搬走）。` +
        (willOverlap.length > 0
          ? `\n\n⚠️ 其中 ${willOverlap.length} 件會同時喺多個進行中活動 —— 呢啲件嘅營收喺唔同活動報表會各自計一次。`
          : '') +
        `\n\n確定?`;
    }
    if (!confirm(msg)) return;

    try {
      for (const productId of selected) {
        const pidNum = toProductIdNum(productId);
        if (unassign) {
          const p = products.find(x => x.product_id === productId);
          for (const promo of p?.assigned_promos ?? []) {
            await deleteAssignment(pidNum, promo.id);
          }
        } else {
          await insertAssignment(pidNum, bulkPromo);
        }
      }
      setSelected(new Set());
      setBulkPromo('');
      await load();
    } catch (e) {
      alert(`批次操作失敗：${errMsg(e)}`);
    }
  };

  const toggleSelect = (productId: string) => {
    setSelected(s => {
      const next = new Set(s);
      if (next.has(productId)) next.delete(productId);
      else next.add(productId);
      return next;
    });
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <Package className="h-5 w-5 text-primary" />
          <h1 className="text-lg font-semibold">推廣商品池</h1>
          <span className="text-xs text-muted-foreground">
            （推廣中勾選 · 共 {products.length}）
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Link
            to="/retail/promotions"
            className="text-xs px-3 py-1.5 rounded-md border border-border bg-card hover:bg-accent/60 transition-colors inline-flex items-center gap-1"
          >
            <Megaphone className="h-3.5 w-3.5" />
            推廣活動
          </Link>
          <Link
            to="/retail/promotions/history"
            className="text-xs px-3 py-1.5 rounded-md border border-border bg-card hover:bg-accent/60 transition-colors inline-flex items-center gap-1"
          >
            <History className="h-3.5 w-3.5" />
            歷史
          </Link>
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

      {/* KPI */}
      <div className="grid grid-cols-3 gap-2">
        <div className="rounded-md border border-border/60 bg-card p-2">
          <div className="text-[10px] text-muted-foreground">總推廣商品</div>
          <div className="text-sm font-semibold tabular-nums mt-0.5">{products.length}</div>
        </div>
        <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 p-2">
          <div className="text-[10px] text-muted-foreground">已分派</div>
          <div className="text-sm font-semibold tabular-nums mt-0.5 text-emerald-200">
            {assignedCount}
          </div>
        </div>
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2">
          <div className="text-[10px] text-muted-foreground">未分派</div>
          <div className="text-sm font-semibold tabular-nums mt-0.5 text-amber-200">
            {unassignedCount}
          </div>
        </div>
      </div>

      {/* 一件多活動說明 */}
      <div className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
        <Info className="h-3.5 w-3.5 mt-px shrink-0" />
        <span>
          一件商品可分派俾多個推廣活動。若同時分派去多個「進行中」活動,該商品嘅營收喺唔同活動嘅報表會各自計算(合計時會重複)。
        </span>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-md">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="搜尋產品名稱、品牌、product ID…"
            className="w-full pl-8 pr-3 py-1.5 text-xs rounded-md border border-border bg-background"
          />
        </div>
        <div className="flex items-center gap-1">
          {(['all', 'assigned', 'unassigned'] as const).map(opt => (
            <button
              key={opt}
              onClick={() => setFilterAssignment(opt)}
              className={`text-xs px-2.5 py-1 rounded-md border transition-colors ${
                filterAssignment === opt
                  ? 'bg-primary/90 text-primary-foreground border-primary'
                  : 'border-border bg-card hover:bg-accent/60'
              }`}
            >
              {opt === 'all' ? '全部' : opt === 'assigned' ? '已分派' : '未分派'}
            </button>
          ))}
        </div>
        <select
          value={filterPromo}
          onChange={e => setFilterPromo(e.target.value)}
          className="text-xs px-2 py-1 rounded-md border border-border bg-card"
          title="按推廣活動篩選"
          data-testid="filter-promo"
        >
          <option value="">全部活動</option>
          {activePromos.map(p => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </div>

      {/* Chip filter：分類 + 品牌 (死貨頁同款「+ 加」搜尋彈窗,唔再全部攤開) */}
      {!loading && products.length > 0 && (
        <div className="rounded-md border border-border/60 bg-card p-2 space-y-1.5">
          <MultiSelectChipFilter
            label="分類"
            options={typeOptions}
            selected={Array.from(selectedTypes)}
            onChange={(next) => setSelectedTypes(new Set(next))}
            placeholder="搜尋分類…"
          />
          <MultiSelectChipFilter
            label="品牌"
            options={vendorOptions}
            selected={Array.from(selectedVendors)}
            onChange={(next) => setSelectedVendors(new Set(next))}
            placeholder="搜尋品牌…"
          />
        </div>
      )}

      {/* Bulk assign bar */}
      {selected.size > 0 && (
        <div className="rounded-md border border-primary/40 bg-primary/5 p-3 flex items-center gap-2 flex-wrap">
          <span className="text-xs">已選 {selected.size} 個</span>
          <span className="text-xs text-muted-foreground">→</span>
          <select
            value={bulkPromo}
            onChange={e => setBulkPromo(e.target.value)}
            className="text-xs px-2 py-1 rounded-md border border-border bg-background"
          >
            <option value="">揀推廣…</option>
            <option value={UNASSIGN}>— 全部設為未分派 —</option>
            {activePromos.map(p => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.start_date} → {p.end_date})
              </option>
            ))}
          </select>
          <button
            onClick={handleBulkAssign}
            disabled={!bulkPromo}
            className="text-xs px-3 py-1 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 inline-flex items-center gap-1"
          >
            {bulkPromo === UNASSIGN ? '批次清空分派' : '批次加入活動'} <ArrowRight className="h-3 w-3" />
          </button>
          <button
            onClick={() => setSelected(new Set())}
            className="text-xs px-2 py-1 rounded-md border border-border hover:bg-accent/60 transition-colors ml-auto"
          >
            清空選擇
          </button>
        </div>
      )}

      {/* Table */}
      {loading ? (
        <Skeleton className="h-64 w-full" />
      ) : filtered.length === 0 ? (
        <div className="rounded-md border border-dashed border-border/60 p-12 text-center text-sm text-muted-foreground">
          {products.length === 0 ? (
            <>
              尚未有任何商品標記為「推廣中」。去
              <Link to="/retail/dead-stock" className="text-primary hover:underline mx-1">
                庫存管理
              </Link>
              勾選「推廣中」checkbox以加入推廣商品池。
            </>
          ) : (
            '冇符合條件嘅商品'
          )}
        </div>
      ) : (
        <div className="rounded-md border border-border/60 bg-card overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-muted/30 border-b border-border/40">
              <tr>
                <th className="text-left px-2 py-2 font-normal text-muted-foreground w-8">
                  <input
                    type="checkbox"
                    checked={selected.size > 0 && selected.size === filtered.length}
                    onChange={e => {
                      if (e.target.checked) setSelected(new Set(filtered.map(p => p.product_id)));
                      else setSelected(new Set());
                    }}
                    className="cursor-pointer"
                  />
                </th>
                <th className="text-left px-2 py-2 font-normal text-muted-foreground">產品名稱</th>
                <th className="text-left px-2 py-2 font-normal text-muted-foreground">品牌</th>
                <th className="text-left px-2 py-2 font-normal text-muted-foreground">分類</th>
                <th className="text-right px-2 py-2 font-normal text-muted-foreground">SKU</th>
                <th className="text-right px-2 py-2 font-normal text-muted-foreground">現庫存</th>
                <th className="text-left px-2 py-2 font-normal text-muted-foreground">分派至（可多個）</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(p => {
                const isSelected = selected.has(p.product_id);
                // 尚未加入嘅活動（用嚟「＋ 加活動」下拉）
                const addable = activePromos.filter(
                  ap => !p.assigned_promos.some(x => x.id === ap.id)
                );
                return (
                  <tr
                    key={p.product_id}
                    className={`border-b border-border/40 hover:bg-accent/30 ${
                      isSelected ? 'bg-primary/5' : ''
                    }`}
                  >
                    <td className="px-2 py-1.5 align-top">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleSelect(p.product_id)}
                        className="cursor-pointer"
                      />
                    </td>
                    <td className="px-2 py-1.5 font-medium align-top" title={p.product_title}>
                      {p.product_title}
                    </td>
                    <td className="px-2 py-1.5 text-muted-foreground align-top">{p.vendor}</td>
                    <td className="px-2 py-1.5 text-muted-foreground align-top">{p.product_type}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums align-top">{p.num_skus}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums align-top">
                      {formatNumber(p.total_inventory)}
                    </td>
                    <td className="px-2 py-1.5">
                      <div className="flex flex-wrap items-center gap-1">
                        {/* 已分派活動 chips —— 每個可 × 移除、可 click 去 promo 詳情 */}
                        {p.assigned_promos.map(promo => (
                          <span
                            key={promo.id}
                            className={`inline-flex items-center gap-1 pl-1.5 pr-1 py-0.5 rounded border text-[10px] ${
                              STATUS_COLOR[effectiveStatus(promo)]
                            }`}
                          >
                            <Link
                              to={`/retail/promotions/${promo.id}`}
                              className="hover:underline whitespace-nowrap"
                              title={`${STATUS_LABEL[effectiveStatus(promo)]} · 去 promo 詳情`}
                            >
                              {promo.name}
                            </Link>
                            <button
                              onClick={() => removePromo(p.product_id, promo.id)}
                              className="rounded hover:bg-black/20 p-0.5"
                              title="移除此活動分派"
                            >
                              <X className="h-2.5 w-2.5" />
                            </button>
                          </span>
                        ))}

                        {/* ＋ 加活動 下拉（只列出未加嘅） */}
                        {addable.length > 0 ? (
                          <select
                            value=""
                            onChange={e => {
                              const v = e.target.value;
                              e.currentTarget.value = '';
                              if (v) addPromo(p.product_id, v);
                            }}
                            className={`text-[11px] px-1.5 py-0.5 rounded-md border bg-background ${
                              p.assigned_promos.length === 0
                                ? 'border-amber-500/40 text-amber-300'
                                : 'border-border'
                            }`}
                            title="加入推廣活動"
                          >
                            <option value="">
                              {p.assigned_promos.length === 0 ? '— 未分派 · 加活動 —' : '＋ 加活動'}
                            </option>
                            {addable.map(promo => (
                              <option key={promo.id} value={promo.id}>
                                {promo.name}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <span className="text-[10px] text-muted-foreground">全部活動已加</span>
                        )}
                      </div>
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

void formatCurrency;
