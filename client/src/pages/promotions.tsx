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
  fetchAllRows,
  todayISO,
  addDays,
  deriveStatusFromDates,
} from '@/lib/promotions-shared';

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
      setPromotions(promos);
      setItems(pItems);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // ── Filter: only show active + planned (not ended) ───────────────────────
  const activePromos = useMemo(() => {
    return promotions
      .filter(p => p.status === 'active' || p.status === 'planned')
      .sort((a, b) => a.start_date.localeCompare(b.start_date));
  }, [promotions]);

  const itemCountByPromo = useMemo(() => {
    const m = new Map<string, number>();
    for (const it of items) {
      if (it.is_archived) continue;
      m.set(it.promotion_id, (m.get(it.promotion_id) ?? 0) + 1);
    }
    return m;
  }, [items]);

  const handleSave = async (data: PromoFormData) => {
    try {
      if (editingPromo) {
        const { error } = await supabase
          .from('promotions')
          .update({
            name: data.name,
            start_date: data.start_date,
            end_date: data.end_date,
            status: deriveStatusFromDates(data.start_date, data.end_date),
            discount_type: data.discount_type || null,
            notes: data.notes || null,
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
            （進行中 + 計劃中 · 共 {activePromos.length}）
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
      ) : activePromos.length === 0 ? (
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
            新增第一個推廣
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {activePromos.map(promo => {
            const itemCount = itemCountByPromo.get(promo.id) ?? 0;
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
                key={promo.id}
                className="rounded-md border border-border/60 bg-card p-4 hover:border-border transition-colors"
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
                        className={`px-1.5 py-0.5 rounded text-[10px] border ${STATUS_COLOR[promo.status]}`}
                      >
                        {STATUS_LABEL[promo.status]}
                      </span>
                      {promo.discount_type && (
                        <span className="text-[10px] text-muted-foreground">
                          {promo.discount_type}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => {
                        setEditingPromo(promo);
                        setShowModal(true);
                      }}
                      className="p-1 rounded hover:bg-accent/60 transition-colors text-muted-foreground hover:text-foreground"
                      title="編輯"
                    >
                      <Edit3 className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={() => handleDelete(promo)}
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
          })}
        </div>
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

// Suppress unused warnings for icons we may use later
void TrendingUp;
void formatCurrency;
