import { useEffect, useState, useMemo, useCallback } from 'react';
import { Link } from 'wouter';
import { supabase } from '@/lib/supabase';
import { formatCurrency, formatNumber } from '@/lib/format';
import {
  Megaphone,
  RefreshCw,
  AlertCircle,
  Plus,
  Edit3,
  Trash2,
  Calendar,
  Package,
  TrendingUp,
  ExternalLink,
  X,
  History,
} from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Promotion,
  PromotionItem,
  STATUS_LABEL,
  STATUS_COLOR,
  RATING_LABEL,
  RATING_COLOR,
  fetchAllRows,
  todayISO,
  addDays,
  deriveStatusFromDates,
  effectiveStatus,
} from '@/lib/promotions-shared';
import { maybeSnapshotEndedPromos } from '@/lib/promo-snapshot';

// ── Page ─────────────────────────────────────────────────────────────────────

export default function PromotionsListPage() {
  const [promotions, setPromotions] = useState<Promotion[]>([]);
  const [items, setItems] = useState<PromotionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [editingPromo, setEditingPromo] = useState<Promotion | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [promos, pItems] = await Promise.all([
        fetchAllRows<Promotion>('promotions'),
        fetchAllRows<PromotionItem>('promotion_items'),
      ]);
      // 自我修復:日子過咗但 DB status 未跟上(planned→active / active→ended)就寫返落去。
      // 顯示唔等呢步 — 畫面一律用 effectiveStatus 即場計,呢度純粹令 DB 同畫面一致。
      const stale = promos.filter(p => effectiveStatus(p) !== p.status);
      if (stale.length > 0) {
        void Promise.allSettled(
          stale.map(p =>
            supabase.from('promotions').update({ status: effectiveStatus(p) }).eq('id', p.id)
          )
        );
      }
      setPromotions(promos);
      setItems(pItems);

      // 結束後自動 freeze 成效(同樣係自我修復;背景行 — 要拉訂單大表,
      // 唔擋首次 render,計完先補上畫面)
      void maybeSnapshotEndedPromos(promos, pItems)
        .then(snaps => {
          if (!snaps) return;
          setPromotions(prev =>
            prev.map(p => (snaps.has(p.id) ? { ...p, ...snaps.get(p.id)! } : p))
          );
        })
        .catch(e => console.warn('推廣快照失敗:', e));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // ── 進行中/計劃中 一組;已結束/已取消 一組(留返喺呢頁,唔再收埋淨係得歷史頁有)
  const activePromos = useMemo(() => {
    return promotions
      .filter(p => {
        const st = effectiveStatus(p);
        return st === 'active' || st === 'planned';
      })
      .sort((a, b) => a.start_date.localeCompare(b.start_date));
  }, [promotions]);

  const endedPromos = useMemo(() => {
    return promotions
      .filter(p => {
        const st = effectiveStatus(p);
        return st === 'ended' || st === 'cancelled';
      })
      .sort((a, b) => b.end_date.localeCompare(a.end_date)); // 最近結束排先
  }, [promotions]);

  // Header 顯示實際分項(唔好靜態寫死「進行中 + 計劃中」,冇計劃中都咁寫會誤導)
  const headerLabel = useMemo(() => {
    const active = activePromos.filter(p => effectiveStatus(p) === 'active').length;
    const planned = activePromos.length - active;
    const parts: string[] = [];
    if (active > 0) parts.push(`進行中 ${active}`);
    if (planned > 0) parts.push(`計劃中 ${planned}`);
    if (endedPromos.length > 0) parts.push(`已結束 ${endedPromos.length}`);
    return parts.length > 0 ? parts.join(' · ') : '0 個';
  }, [activePromos, endedPromos]);

  const itemCountByPromo = useMemo(() => {
    const m = new Map<string, number>();
    for (const it of items) {
      if (it.is_archived) continue;
      m.set(it.promotion_id, (m.get(it.promotion_id) ?? 0) + 1);
    }
    return m;
  }, [items]);

  // 每個推廣仲有幾多件推廣價未清 — 未清 = 好可能推咗上 Shopify 但未還原原價。
  // (還原原價成功會自動清 promo_price,所以呢個數 > 0 就提老闆去詳情頁撳「還原原價」)
  const unclearedPriceByPromo = useMemo(() => {
    const m = new Map<string, number>();
    for (const it of items) {
      if (it.is_archived || it.promo_price == null) continue;
      m.set(it.promotion_id, (m.get(it.promotion_id) ?? 0) + 1);
    }
    return m;
  }, [items]);

  const handleSave = async (data: PromoFormData) => {
    try {
      if (editingPromo) {
        const newStatus = editingPromo.status === 'cancelled'
          ? 'cancelled'
          : deriveStatusFromDates(data.start_date, data.end_date);
        // 改日期令已 freeze 嘅活動「復活」(ended → active/planned)→ 重置快照,
        // 令佢喺新結束日之後重新 freeze;唔清就會永遠釘住舊數。
        const resetSnapshot = editingPromo.snapshotted_at != null && newStatus !== 'ended'
          ? {
              snapshotted_at: null,
              final_qty_sold: null,
              final_revenue: null,
              final_lift_ratio: null,
              final_rating: null,
              final_pre_period_daily_avg: null,
              final_promo_period_daily_avg: null,
            }
          : {};
        const { error } = await supabase
          .from('promotions')
          .update({
            name: data.name,
            start_date: data.start_date,
            end_date: data.end_date,
            // cancelled 係手動狀態,編輯(改名/改備註/改日期)唔應該令佢自動復活
            // (其餘全套 code 都用 effectiveStatus 保留 cancelled,唯獨呢度以前會蓋走)
            status: newStatus,
            discount_type: data.discount_type || null,
            notes: data.notes || null,
            ...resetSnapshot,
          })
          .eq('id', editingPromo.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from('promotions').insert({
          name: data.name,
          start_date: data.start_date,
          end_date: data.end_date,
          status: deriveStatusFromDates(data.start_date, data.end_date),
          discount_type: data.discount_type || null,
          notes: data.notes || null,
        });
        if (error) throw error;
      }
      setShowModal(false);
      setEditingPromo(null);
      await load();
    } catch (e) {
      alert(`儲存失敗：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handleDelete = async (promo: Promotion) => {
    if (!confirm(`確認刪除推廣「${promo.name}」？\n所有分派將被取消（不會自動還原狀態）。`)) return;
    try {
      const { error } = await supabase.from('promotions').delete().eq('id', promo.id);
      if (error) throw error;
      await load();
    } catch (e) {
      alert(`刪除失敗：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <Megaphone className="h-5 w-5 text-primary" />
          <h1 className="text-lg font-semibold">推廣活動</h1>
          <span className="text-xs text-muted-foreground">
            （{headerLabel}）
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Link
            to="/retail/promotions/items"
            className="text-xs px-3 py-1.5 rounded-md border border-border bg-card hover:bg-accent/60 transition-colors inline-flex items-center gap-1"
          >
            <Package className="h-3.5 w-3.5" />
            推廣商品池
          </Link>
          <Link
            to="/retail/promotions/history"
            className="text-xs px-3 py-1.5 rounded-md border border-border bg-card hover:bg-accent/60 transition-colors inline-flex items-center gap-1"
          >
            <History className="h-3.5 w-3.5" />
            推廣歷史
          </Link>
          <button
            onClick={load}
            className="text-xs px-3 py-1.5 rounded-md border border-border bg-card hover:bg-accent/60 transition-colors inline-flex items-center gap-1"
            disabled={loading}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            重新整理
          </button>
          <button
            onClick={() => {
              setEditingPromo(null);
              setShowModal(true);
            }}
            className="text-xs px-3 py-1.5 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors inline-flex items-center gap-1"
          >
            <Plus className="h-3.5 w-3.5" />
            新增推廣
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-rose-500/40 bg-rose-500/10 p-3 text-rose-200 text-sm flex items-center gap-2">
          <AlertCircle className="h-4 w-4" />
          {error}
        </div>
      )}

      {/* List */}
      {loading ? (
        <div className="space-y-2">
          {[...Array(3)].map((_, i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      ) : (
        <>
          {activePromos.length === 0 ? (
            <div className="rounded-md border border-dashed border-border/60 p-12 text-center">
              <Megaphone className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
              <p className="text-sm text-muted-foreground mb-3">未有進行中或計劃中嘅推廣</p>
              <button
                onClick={() => {
                  setEditingPromo(null);
                  setShowModal(true);
                }}
                className="text-xs px-3 py-1.5 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors inline-flex items-center gap-1"
              >
                <Plus className="h-3.5 w-3.5" />
                {promotions.length === 0 ? '新增第一個推廣' : '新增推廣'}
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {activePromos.map(promo => (
                <PromoCard
                  key={promo.id}
                  promo={promo}
                  itemCount={itemCountByPromo.get(promo.id) ?? 0}
                  unclearedCount={unclearedPriceByPromo.get(promo.id) ?? 0}
                  onEdit={() => {
                    setEditingPromo(promo);
                    setShowModal(true);
                  }}
                  onDelete={() => handleDelete(promo)}
                />
              ))}
            </div>
          )}

          {/* 已結束/已取消 — 保留喺呢頁(成效已 freeze;推廣價未還原會有提示) */}
          {endedPromos.length > 0 && (
            <>
              <div className="flex items-center gap-2 pt-2">
                <History className="h-4 w-4 text-muted-foreground" />
                <h2 className="text-sm font-semibold text-muted-foreground">
                  已結束 / 已取消（{endedPromos.length}）
                </h2>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                {endedPromos.map(promo => (
                  <PromoCard
                    key={promo.id}
                    promo={promo}
                    itemCount={itemCountByPromo.get(promo.id) ?? 0}
                    unclearedCount={unclearedPriceByPromo.get(promo.id) ?? 0}
                    onEdit={() => {
                      setEditingPromo(promo);
                      setShowModal(true);
                    }}
                    onDelete={() => handleDelete(promo)}
                  />
                ))}
              </div>
            </>
          )}
        </>
      )}

      {/* Modal */}
      {showModal && (
        <PromoModal
          initial={editingPromo}
          onClose={() => {
            setShowModal(false);
            setEditingPromo(null);
          }}
          onSave={handleSave}
        />
      )}
    </div>
  );
}

// ── Card ─────────────────────────────────────────────────────────────────────
// 進行中/計劃中/已結束/已取消 共用。已結束 + 已 freeze 會顯示凍結咗嘅成效
// (銷量/營收/Lift/評級 — 只計活動期間,唔會再變);推廣價未還原會出提示。

function PromoCard({
  promo,
  itemCount,
  unclearedCount,
  onEdit,
  onDelete,
}: {
  promo: Promotion;
  itemCount: number;
  unclearedCount: number;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const st = effectiveStatus(promo);
  const isTerminal = st === 'ended' || st === 'cancelled';
  const days = Math.max(
    1,
    Math.ceil(
      (new Date(promo.end_date + 'T23:59:59').getTime() -
        new Date(promo.start_date + 'T00:00:00').getTime()) /
        86_400_000
    )
  );
  return (
    <div
      className={`rounded-md border border-border/60 bg-card p-4 hover:border-border transition-colors ${
        isTerminal ? 'opacity-90' : ''
      }`}
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex-1 min-w-0">
          <Link
            to={`/retail/promotions/${promo.id}`}
            className="text-sm font-semibold hover:underline truncate block"
          >
            {promo.name}
          </Link>
          <div className="flex items-center gap-1.5 mt-1">
            <span
              className={`px-1.5 py-0.5 rounded text-[10px] border ${STATUS_COLOR[st]}`}
            >
              {STATUS_LABEL[st]}
            </span>
            {st === 'ended' && promo.snapshotted_at && promo.final_rating && (
              <span
                className={`px-1.5 py-0.5 rounded text-[10px] border ${RATING_COLOR[promo.final_rating]}`}
              >
                {RATING_LABEL[promo.final_rating]}
              </span>
            )}
            {promo.discount_type && (
              <span className="text-[10px] text-muted-foreground">
                {promo.discount_type}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={onEdit}
            className="p-1 rounded hover:bg-accent/60 transition-colors text-muted-foreground hover:text-foreground"
            title="編輯"
          >
            <Edit3 className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={onDelete}
            className="p-1 rounded hover:bg-rose-500/20 transition-colors text-muted-foreground hover:text-rose-400"
            title="刪除"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="space-y-1 text-xs">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground inline-flex items-center gap-1">
            <Calendar className="h-3 w-3" /> 期間
          </span>
          <span className="tabular-nums">
            {promo.start_date} → {promo.end_date}{' '}
            <span className="text-muted-foreground">({days}天)</span>
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground inline-flex items-center gap-1">
            <Package className="h-3 w-3" /> 推廣商品
          </span>
          <span className="tabular-nums font-medium">
            {formatNumber(itemCount)} 個
          </span>
        </div>
      </div>

      {/* 已結束:凍結成效(只計活動期間) / 未 freeze 就講明等緊 */}
      {st === 'ended' &&
        (promo.snapshotted_at ? (
          <div className="mt-2 pt-2 border-t border-border/40 grid grid-cols-3 gap-1 text-[11px] tabular-nums">
            <div>
              <div className="text-[10px] text-muted-foreground">銷量</div>
              <div className="font-medium">{formatNumber(promo.final_qty_sold ?? 0)}</div>
            </div>
            <div>
              <div className="text-[10px] text-muted-foreground">營收</div>
              <div className="font-medium">{formatCurrency(promo.final_revenue ?? 0)}</div>
            </div>
            <div>
              <div className="text-[10px] text-muted-foreground inline-flex items-center gap-0.5">
                <TrendingUp className="h-2.5 w-2.5" /> Lift
              </div>
              <div className="font-medium">
                {promo.final_lift_ratio == null
                  ? '—'
                  : promo.final_lift_ratio === 999
                    ? '∞'
                    : `${promo.final_lift_ratio.toFixed(2)}×`}
              </div>
            </div>
          </div>
        ) : (
          <div className="mt-2 pt-2 border-t border-border/40 text-[10px] text-muted-foreground">
            成效 freeze 中 — 結束後隔日等訂單同步齊,會自動凍結活動期間嘅銷量/營收/Lift
          </div>
        ))}

      {/* 推廣價未還原提示(還原原價成功會自動清 promo_price,所以有數 = 未還原) */}
      {isTerminal && unclearedCount > 0 && (
        <Link
          to={`/retail/promotions/${promo.id}`}
          className="mt-2 flex items-center gap-1 text-[10px] px-2 py-1 rounded border border-amber-500/40 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20 transition-colors"
        >
          <AlertCircle className="h-3 w-3 shrink-0" />
          {unclearedCount} 款推廣價未還原 — 入去撳「還原原價」
        </Link>
      )}

      {promo.notes && (
        <div className="mt-2 pt-2 border-t border-border/40 text-[10px] text-muted-foreground line-clamp-2">
          {promo.notes}
        </div>
      )}

      <Link
        to={`/retail/promotions/${promo.id}`}
        className="mt-3 inline-flex items-center gap-1 text-[10px] text-primary hover:underline"
      >
        睇成效分析 <ExternalLink className="h-2.5 w-2.5" />
      </Link>
    </div>
  );
}

// ── Modal ────────────────────────────────────────────────────────────────────

interface PromoFormData {
  name: string;
  start_date: string;
  end_date: string;
  discount_type: string;
  notes: string;
}

function PromoModal({
  initial,
  onClose,
  onSave,
}: {
  initial: Promotion | null;
  onClose: () => void;
  onSave: (data: PromoFormData) => Promise<void>;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [startDate, setStartDate] = useState(initial?.start_date ?? todayISO());
  const [endDate, setEndDate] = useState(initial?.end_date ?? addDays(todayISO(), 14));
  const [discountType, setDiscountType] = useState(initial?.discount_type ?? '');
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [saving, setSaving] = useState(false);

  const valid = name.trim().length > 0 && startDate <= endDate;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-card border border-border rounded-lg shadow-xl w-full max-w-md p-5"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold">
            {initial ? '編輯推廣' : '新增推廣'}
          </h2>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-accent/60 transition-colors text-muted-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="text-xs text-muted-foreground block mb-1">名稱 *</label>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="例：6 月雨季 Bundle"
              className="w-full px-3 py-2 text-sm rounded-md border border-border bg-background"
              autoFocus
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-muted-foreground block mb-1">開始日期</label>
              <input
                type="date"
                value={startDate}
                onChange={e => setStartDate(e.target.value)}
                className="w-full px-3 py-2 text-sm rounded-md border border-border bg-background tabular-nums"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">結束日期</label>
              <input
                type="date"
                value={endDate}
                onChange={e => setEndDate(e.target.value)}
                className="w-full px-3 py-2 text-sm rounded-md border border-border bg-background tabular-nums"
              />
            </div>
          </div>

          {startDate > endDate && (
            <p className="text-[10px] text-rose-400">結束日期必須 ≥ 開始日期</p>
          )}

          <div>
            <label className="text-xs text-muted-foreground block mb-1">折扣類型（可選）</label>
            <input
              value={discountType}
              onChange={e => setDiscountType(e.target.value)}
              placeholder="例：85折、Bundle、買 2 送 1"
              className="w-full px-3 py-2 text-sm rounded-md border border-border bg-background"
            />
          </div>

          <div>
            <label className="text-xs text-muted-foreground block mb-1">備註（可選）</label>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              rows={3}
              placeholder="目標、策略、宣傳渠道…"
              className="w-full px-3 py-2 text-sm rounded-md border border-border bg-background resize-none"
            />
          </div>
        </div>

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="text-xs px-3 py-1.5 rounded-md border border-border hover:bg-accent/60 transition-colors"
            disabled={saving}
          >
            取消
          </button>
          <button
            onClick={async () => {
              if (!valid) return;
              setSaving(true);
              await onSave({
                name: name.trim(),
                start_date: startDate,
                end_date: endDate,
                discount_type: discountType.trim(),
                notes: notes.trim(),
              });
              setSaving(false);
            }}
            disabled={!valid || saving}
            className="text-xs px-3 py-1.5 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 inline-flex items-center gap-1"
          >
            {saving && <RefreshCw className="h-3.5 w-3.5 animate-spin" />}
            {initial ? '儲存' : '建立'}
          </button>
        </div>
      </div>
    </div>
  );
}

