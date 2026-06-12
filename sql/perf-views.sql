-- ============================================================================
-- Server-side aggregation views — 提速用
-- ============================================================================
-- 喺 Supabase Dashboard → SQL Editor 跑一次 (跑完 enable-rls.sql 之後跑都得)。
--
-- 背景: dashboard 而家喺瀏覽器拉幾十萬行 shopify_order_lines + shopify_orders
-- 再喺 JS 計每個 SKU 嘅銷售統計。呢啲 view 將計算搬落 Postgres,
-- 一個 request 攞 result,慳 99% 傳輸量。
--
-- 前端有 fallback: view 未建立時自動行返舊路徑,所以幾時跑都唔會壞嘢。
--
-- security_invoker = on 令 view 跟返查詢者嘅 RLS 權限 (登入用戶先讀到)。
-- ============================================================================

-- 每個 SKU 嘅銷售統計 (死貨頁用) — 取代客戶端拉全部 order lines
create or replace view sku_sales_stats
with (security_invoker = on) as
select
  l.sku,
  min(o.created_at)::date                                                          as first_sold_date,
  max(o.created_at)::date                                                          as last_sold_date,
  coalesce(sum(l.quantity) filter (where o.created_at >= now() - interval '30 days'), 0) as sold_30d,
  coalesce(sum(l.quantity) filter (where o.created_at >= now() - interval '90 days'), 0) as sold_90d
from shopify_order_lines l
join shopify_orders o on o.id = l.order_id
where o.cancelled_at is null
  and l.sku is not null
group by l.sku;

-- 每個 variant 近 90 日銷量 (補貨頁用)
create or replace view variant_sales_90d
with (security_invoker = on) as
select
  l.variant_id,
  coalesce(sum(l.quantity), 0) as qty_90d
from shopify_order_lines l
join shopify_orders o on o.id = l.order_id
where o.cancelled_at is null
  and l.variant_id is not null
  and o.created_at >= now() - interval '90 days'
group by l.variant_id;

-- 建議 index (如果未有) — 大表 join 加速
create index if not exists idx_shopify_order_lines_order_id on shopify_order_lines (order_id);
create index if not exists idx_shopify_order_lines_sku       on shopify_order_lines (sku);
create index if not exists idx_shopify_orders_created_at     on shopify_orders (created_at);

-- 驗證
select 'sku_sales_stats' as view, count(*) from sku_sales_stats
union all
select 'variant_sales_90d', count(*) from variant_sales_90d;
