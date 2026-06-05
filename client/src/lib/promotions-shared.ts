// Shared types + helpers for promotion management pages
import { supabase } from './supabase';

// ── Types ────────────────────────────────────────────────────────────────────

export interface Promotion {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
  status: 'active' | 'planned' | 'ended' | 'cancelled';
  discount_type: string | null;
  notes: string | null;
  final_qty_sold: number | null;
  final_revenue: number | null;
  final_lift_ratio: number | null;
  final_rating: 'effective' | 'ok' | 'ineffective' | null;
  final_pre_period_daily_avg: number | null;
  final_promo_period_daily_avg: number | null;
  snapshotted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PromotionItem {
  promotion_id: string;
  // DB type 係 bigint, Supabase JS 可能 return number 或 string 視乎數值大小
  product_id: number | string;
  previous_manual_status: string | null;
  assigned_at: string;
  is_archived: boolean;
}

export type Rating = 'effective' | 'ok' | 'ineffective';

// ── Helpers ──────────────────────────────────────────────────────────────────

export const RATING_LABEL: Record<Rating, string> = {
  effective: '有效',
  ok: '一般',
  ineffective: '無效',
};

export const RATING_COLOR: Record<Rating, string> = {
  effective: 'text-emerald-400 border-emerald-500/40 bg-emerald-500/10',
  ok: 'text-amber-400 border-amber-500/40 bg-amber-500/10',
  ineffective: 'text-rose-400 border-rose-500/40 bg-rose-500/10',
};

export const STATUS_LABEL: Record<Promotion['status'], string> = {
  active: '進行中',
  planned: '計劃中',
  ended: '已結束',
  cancelled: '已取消',
};

export const STATUS_COLOR: Record<Promotion['status'], string> = {
  active: 'text-emerald-400 border-emerald-500/40 bg-emerald-500/10',
  planned: 'text-blue-400 border-blue-500/40 bg-blue-500/10',
  ended: 'text-muted-foreground border-border/60 bg-muted/20',
  cancelled: 'text-rose-400 border-rose-500/40 bg-rose-500/10',
};

export function ratingFromLift(lift: number): Rating {
  if (lift >= 2) return 'effective';
  if (lift >= 1.2) return 'ok';
  return 'ineffective';
}

const dayMs = 86_400_000;
export function daysBetween(a: Date, b: Date): number {
  return Math.max(0, Math.floor((b.getTime() - a.getTime()) / dayMs));
}

// Pagination helper (reused across pages)
export async function fetchAllRows<T>(table: string, columns = '*'): Promise<T[]> {
  const PAGE = 1000;
  let all: T[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase.from(table).select(columns).range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as unknown as T[];
    all = all.concat(rows);
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

// Today as YYYY-MM-DD (HKT — local timezone)
export function todayISO(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Add N days to ISO date string, return new ISO string
export function addDays(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Compute promo status from dates (vs CURRENT_DATE)
export function deriveStatusFromDates(startISO: string, endISO: string): Promotion['status'] {
  const today = todayISO();
  if (endISO < today) return 'ended';
  if (startISO > today) return 'planned';
  return 'active';
}
