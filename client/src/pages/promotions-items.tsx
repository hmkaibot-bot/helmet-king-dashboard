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

// Bulk-assign sentinel：揀「未分派」= 移除現有推廣分派（用獨立 sentinel,
// 因為 value="" 已經係 placeholder「揀推廣…」）。
const UNASSIGN = '__unassign__';

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
  // assignment status
  assigned_promo: Promotion | null;
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
      const assignedProductIds = new Map<string, string>(); // product_id (string) -> promo_id
      for (const it of activeItems) {
        assignedProductIds.set(String(it.product_id), it.promotion_id);
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
        const assignedPromoId = assignedProductIds.get(productId);
        const assignedPromo = assignedPromoId ? (promoById.get(assignedPromoId) ?? null) : null;

        promotingProducts.push({
          product_id: productId,
          product_title: skus[0].product_title ?? '—',
          vendor: skus[0].vendor ?? '—',
          product_type: skus[0].product_type ?? '—',
          num_skus: skus.length,
          total_inventory: skus.reduce((s, x) => s + (x.inventory_quantity ?? 0), 0),
          previous_manual_status: review?.manual_status ?? null,
          assigned_promo: assignedPromo,
        });
      }

      promotingProducts.sort((a, b) => {
        // unassigned first
        const aU = a.assigned_promo == null;
        const bU = b.assigned_promo == null;
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
    if (filterAssignment === 'assigned') list = list.filter(p => p.assigned_promo);
    else if (filterAssignment === 'unassigned') list = list.filter(p => !p.assigned_promo);
    if (filterPromo) list = list.filter(p => p.assigned_promo?.id === filterPromo);
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

  const assignedCount = products.filter(p => p.assigned_promo).length;
  const unassignedCount = products.length - assignedCount;

  // ── Assign / unassign ────────────────────────────────────────────────────
  const handleAssign = async (productId: string, promoId: string | null) => {
    try {
      const product = products.find(p => p.product_id === productId);
      if (!product) return;

      // product_id 喺 DB 係 bigint, 需要 cast 為 number
      const productIdNum = Number(productId);
      if (!Number.isFinite(productIdNum)) {
        throw new Error(`Invalid product_id: ${productId}`);
      }

      // Step 1: remove existing assignment (if any) for this product
      if (product.assigned_promo) {
        const { error: delErr } = await supabase
          .from('promotion_items')
          .delete()
          .eq('product_id', productIdNum)
          .eq('is_archived', false);
        if (delErr) throw delErr;
      }

      // Step 2: insert new assignment if promoId provided
      if (promoId) {
        const { error: insErr } = await supabase.from('promotion_items').insert({
          promotion_id: promoId,
          product_id: productIdNum,
          previous_manual_status: 'dead',
          is_archived: false,
        });
        if (insErr) throw insErr;
      }
      await load();
    } catch (e) {
      alert(`分派失敗：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handleBulkAssign = async () => {
    if (!bulkPromo || selected.size === 0) return;
    const unassign = bulkPromo === UNASSIGN;

    // 防護:數吓所揀商品有幾多件已經喺「第二個」推廣 —— 呢啲會被搬走 / 移除。
    // (每件商品只可入一個推廣,分派去新推廣 = 由原本嗰個刪走;避免一 click 掃晒)
    const movedFromOther = Array.from(selected).filter(pid => {
      const p = products.find(x => x.product_id === pid);
      if (!p?.assigned_promo) return false;
      return unassign ? true : p.assigned_promo.id !== bulkPromo;
    });

    let msg: string;
    if (unassign) {
      msg = movedFromOther.length > 0
        ? `⚠️ 所揀 ${selected.size} 件入面,有 ${movedFromOther.length} 件目前已分派到推廣。\n繼續會將佢哋全部設為「未分派」(移除現有推廣)。\n\n確定?`
        : `將 ${selected.size} 件商品設為未分派？`;
    } else {
      const targetName = activePromos.find(p => p.id === bulkPromo)?.name ?? '所揀推廣';
      msg = movedFromOther.length > 0
        ? `⚠️ 將 ${selected.size} 件分派到「${targetName}」。\n其中 ${movedFromOther.length} 件目前已經喺第二個推廣 —— 繼續會將呢 ${movedFromOther.length} 件由原本嘅推廣「搬走」(每件商品只可入一個推廣)。\n\n確定?`
        : `將 ${selected.size} 件商品分派到「${targetName}」？`;
    }
    if (!confirm(msg)) return;
    try {
      for (const productId of selected) {
        await handleAssign(productId, unassign ? null : bulkPromo);
      }
      setSelected(new Set());
      setBulkPromo('');
    } catch (e) {
      alert(`批次操作失敗：${e instanceof Error ? e.message : String(e)}`);
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
            <option value={UNASSIGN}>— 未分派 —</option>
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
            {bulkPromo === UNASSIGN ? '批次移除' : '批次分派'} <ArrowRight className="h-3 w-3" />
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
                死貨表
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
                <th className="text-left px-2 py-2 font-normal text-muted-foreground">分派至</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(p => {
                const isSelected = selected.has(p.product_id);
                return (
                  <tr
                    key={p.product_id}
                    className={`border-b border-border/40 hover:bg-accent/30 ${
                      isSelected ? 'bg-primary/5' : ''
                    }`}
                  >
                    <td className="px-2 py-1.5">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleSelect(p.product_id)}
                        className="cursor-pointer"
                      />
                    </td>
                    <td className="px-2 py-1.5 font-medium" title={p.product_title}>
                      {p.product_title}
                    </td>
                    <td className="px-2 py-1.5 text-muted-foreground">{p.vendor}</td>
                    <td className="px-2 py-1.5 text-muted-foreground">{p.product_type}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{p.num_skus}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">
                      {formatNumber(p.total_inventory)}
                    </td>
                    <td className="px-2 py-1.5">
                      <div className="flex items-center gap-1.5">
                        <select
                          value={p.assigned_promo?.id ?? ''}
                          onChange={e => handleAssign(p.product_id, e.target.value || null)}
                          className={`text-xs px-2 py-0.5 rounded-md border bg-background ${
                            p.assigned_promo
                              ? 'border-emerald-500/40'
                              : 'border-amber-500/40 text-amber-300'
                          }`}
                        >
                          <option value="">— 未分派 —</option>
                          {activePromos.map(promo => (
                            <option key={promo.id} value={promo.id}>
                              {promo.name}
                            </option>
                          ))}
                        </select>
                        {p.assigned_promo && (
                          <Link
                            to={`/retail/promotions/${p.assigned_promo.id}`}
                            className="text-[10px] text-primary hover:underline whitespace-nowrap"
                            title="去 promo 詳情"
                          >
                            <span
                              className={`px-1.5 py-0.5 rounded text-[10px] border ${
                                STATUS_COLOR[effectiveStatus(p.assigned_promo)]
                              }`}
                            >
                              {STATUS_LABEL[effectiveStatus(p.assigned_promo)]}
                            </span>
                          </Link>
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

