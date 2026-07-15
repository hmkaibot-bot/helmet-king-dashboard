// 推廣結束後自動 freeze 成效 — 補返 promotions.final_* 一直冇 writer 嘅缺口。
//
// 邊個 call:推廣活動頁 + 推廣歷史頁 load 時(自我修復 pattern,同 status 修復一樣)。
// 幾時 freeze:effectiveStatus = ended、未有 snapshotted_at、而且已經過咗結束日
//   起碼一整日(todayISO >= end_date + 2)—— 訂單每日凌晨先同步一次,等最後一日
//   嘅訂單入齊先影快照,唔會凍住唔完整嘅數。
// 計法:同 promotions-detail 逐行一致 ——
//   推廣期 = start 00:00:00 → end 23:59:59(HKT 本地時間)
//   對照期 = 開始前 90 日;排除已取消訂單;營收 = qty × line.price
//   lift = 推廣期日均 ÷ 對照期日均(對照 0 而推廣 >0 → 999 = ∞)
import { supabase } from './supabase';
import { queryAllPages } from './query-helpers';
import {
  Promotion,
  PromotionItem,
  todayISO,
  addDays,
  daysBetween,
  effectiveStatus,
  ratingFromLift,
} from './promotions-shared';

interface OrderRow {
  id: string | number;
  created_at: string;
  cancelled_at: string | null;
}
interface OrderLineRow {
  sku: string | null;
  quantity: number | null;
  price: number | null;
  order_id: string | number | null;
}
interface InvRow {
  sku: string;
  product_id: number | string | null;
}

export type SnapshotFields = Pick<
  Promotion,
  | 'final_qty_sold'
  | 'final_revenue'
  | 'final_lift_ratio'
  | 'final_rating'
  | 'final_pre_period_daily_avg'
  | 'final_promo_period_daily_avg'
  | 'snapshotted_at'
>;

const round2 = (n: number) => Math.round(n * 100) / 100;
const round4 = (n: number) => Math.round(n * 10000) / 10000;

/**
 * 幫所有「已結束 + 未快照 + 訂單已同步齊」嘅推廣影快照寫落 DB。
 * 回傳 promoId → 快照欄位 嘅 map(俾 caller 即場 merge 入 state,唔使重新 load);
 * 冇嘢要做回傳 null。寫入失敗只 console.warn,唔會 throw(唔阻礙頁面)。
 */
export async function maybeSnapshotEndedPromos(
  promos: Promotion[],
  items: PromotionItem[]
): Promise<Map<string, SnapshotFields> | null> {
  const today = todayISO();
  const candidates = promos.filter(
    p => effectiveStatus(p) === 'ended' && !p.snapshotted_at && today >= addDays(p.end_date, 2)
  );
  if (candidates.length === 0) return null;

  // 大表行 queryAllPages(有 IndexedDB/memory cache,同其他頁共用,唔會重複拉)
  const [inv, orders, lines] = await Promise.all([
    queryAllPages('shopify_inventory', 'sku,product_id') as Promise<InvRow[]>,
    queryAllPages('shopify_orders', 'id,created_at,cancelled_at') as Promise<OrderRow[]>,
    queryAllPages('shopify_order_lines', 'sku,quantity,price,order_id') as Promise<OrderLineRow[]>,
  ]);

  const orderById = new Map<string, OrderRow>();
  for (const o of orders) {
    if (o.cancelled_at) continue; // 同 detail 頁一致:已取消訂單唔計
    orderById.set(String(o.id), o);
  }

  // product_id(string) → 佢啲 SKU
  const skusByProduct = new Map<string, string[]>();
  for (const r of inv) {
    if (r.product_id == null) continue;
    const key = String(r.product_id);
    const arr = skusByProduct.get(key) ?? [];
    arr.push(r.sku);
    skusByProduct.set(key, arr);
  }

  const out = new Map<string, SnapshotFields>();

  for (const promo of candidates) {
    try {
      const productIds = new Set(
        items
          .filter(it => it.promotion_id === promo.id && !it.is_archived)
          .map(it => String(it.product_id))
      );
      const skuSet = new Set<string>();
      for (const pid of productIds) {
        for (const sku of skusByProduct.get(pid) ?? []) skuSet.add(sku);
      }

      const startDate = new Date(promo.start_date + 'T00:00:00');
      const endDate = new Date(promo.end_date + 'T23:59:59');
      const preStart = new Date(startDate.getTime() - 90 * 86_400_000);
      const preEnd = new Date(startDate.getTime() - 1);

      let promoQty = 0;
      let promoRev = 0;
      let preQty = 0;
      for (const line of lines) {
        if (!line.sku || !skuSet.has(line.sku)) continue;
        const order = orderById.get(String(line.order_id));
        if (!order) continue;
        const createdAt = new Date(order.created_at);
        const qty = line.quantity ?? 0;
        if (createdAt >= startDate && createdAt <= endDate) {
          promoQty += qty;
          promoRev += qty * (line.price ?? 0);
        } else if (createdAt >= preStart && createdAt <= preEnd) {
          preQty += qty;
        }
      }

      // 已結束 → 期長就係成個推廣期(同 detail 頁 min(today,end) 喺 ended 時等價)
      const promoDays = Math.max(1, daysBetween(startDate, endDate) + 1);
      const promoDaily = promoQty / promoDays;
      const preDaily = preQty / 90;
      const lift = preDaily === 0 ? (promoDaily > 0 ? 999 : 0) : promoDaily / preDaily;
      const rating = lift === 999 ? 'effective' : ratingFromLift(lift);

      const fields: SnapshotFields = {
        final_qty_sold: promoQty,
        final_revenue: round2(promoRev),
        final_lift_ratio: lift === 999 ? 999 : round4(lift),
        final_rating: rating,
        final_pre_period_daily_avg: round4(preDaily),
        final_promo_period_daily_avg: round4(promoDaily),
        snapshotted_at: new Date().toISOString(),
      };

      const { error } = await supabase.from('promotions').update(fields).eq('id', promo.id);
      if (error) {
        console.warn(`推廣快照寫入失敗 (${promo.name}):`, error);
        continue;
      }
      out.set(promo.id, fields);
    } catch (e) {
      console.warn(`推廣快照計算失敗 (${promo.name}):`, e);
    }
  }

  return out.size > 0 ? out : null;
}
