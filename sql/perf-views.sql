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

-- 每個 SKU 嘅銷售統計 (死貨頁 + 庫存頁用) — 取代客戶端拉全部 order lines
-- v2: 加 total_qty (全歷史銷量) + 剔除 refunded 訂單
create or replace view sku_sales_stats
with (security_invoker = on) as
select
  l.sku,
  min(o.created_at)::date                                                          as first_sold_date,
  max(o.created_at)::date                                                          as last_sold_date,
  coalesce(sum(l.quantity), 0)                                                     as total_qty,
  coalesce(sum(l.quantity) filter (where o.created_at >= now() - interval '30 days'), 0) as sold_30d,
  coalesce(sum(l.quantity) filter (where o.created_at >= now() - interval '90 days'), 0) as sold_90d
from shopify_order_lines l
join shopify_orders o on o.id = l.order_id
where o.cancelled_at is null
  and (o.financial_status is null or o.financial_status <> 'refunded')
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

-- 每個 SKU 嘅返貨統計 (死貨頁用) — 取代客戶端拉 bc_purchase_invoices + lines 兩張表
create or replace view sku_receive_stats
with (security_invoker = on) as
select
  btrim(l.item_number)        as sku,
  min(i.posting_date)::date   as first_receive_date,
  max(i.posting_date)::date   as last_receive_date
from bc_purchase_invoice_lines l
join bc_purchase_invoices i on i.id = l.invoice_id
where i.posting_date is not null
  and l.item_number is not null
  and btrim(l.item_number) <> ''
group by btrim(l.item_number);

-- 建議 index (如果未有) — 大表 join 加速
create index if not exists idx_shopify_order_lines_order_id on shopify_order_lines (order_id);
create index if not exists idx_shopify_order_lines_sku       on shopify_order_lines (sku);
create index if not exists idx_shopify_orders_created_at     on shopify_orders (created_at);
create index if not exists idx_bc_pil_invoice_id  on bc_purchase_invoice_lines (invoice_id);
create index if not exists idx_bc_pil_item_number on bc_purchase_invoice_lines (item_number);
create index if not exists idx_dead_stock_audit_sku_changed on dead_stock_audit_log (sku, changed_at desc);

-- PostgREST 單次回傳行數上限 (預設 1000) — 調高到 10000,前端分頁 request 數即減 90%。
-- 前端 queryAllPages 會自動適應實際上限,所以呢句跑唔跑 app 都正確,跑咗就快好多。
alter role authenticator set pgrst.db_max_rows = '10000';
notify pgrst, 'reload config';

-- 驗證
select 'sku_sales_stats' as view, count(*) from sku_sales_stats
union all
select 'variant_sales_90d', count(*) from variant_sales_90d
union all
select 'sku_receive_stats', count(*) from sku_receive_stats;

-- ============================================================================
-- v3 (2026-06-12): receive_count + 進貨明細 lazy view + 月度銷售聚合
-- ============================================================================

-- sku_receive_stats v3: 加 receive_count (distinct invoice 數) — 庫存頁「進貨次數」用
create or replace view sku_receive_stats
with (security_invoker = on) as
select
  btrim(l.item_number)        as sku,
  min(i.posting_date)::date   as first_receive_date,
  max(i.posting_date)::date   as last_receive_date,
  count(distinct i.id)        as receive_count
from bc_purchase_invoice_lines l
join bc_purchase_invoices i on i.id = l.invoice_id
where i.posting_date is not null
  and l.item_number is not null
  and btrim(l.item_number) <> ''
group by btrim(l.item_number);

-- 每個 SKU 嘅進貨明細 (庫存頁展開 row 先 lazy fetch, .eq('sku', ...))
create or replace view sku_receive_events
with (security_invoker = on) as
select
  btrim(l.item_number)                  as sku,
  i.posting_date,
  coalesce(l.invoice_number, i.number)  as invoice_number,
  l.quantity,
  l.unit_cost
from bc_purchase_invoice_lines l
join bc_purchase_invoices i on i.id = l.invoice_id
where l.item_number is not null and btrim(l.item_number) <> '';

-- 每月 x product_type 銷售聚合 (forecast 頁用) — 取代拉 24 個月 order_lines + orders
-- month 用 UTC 月份, revenue 用 line_total (0/null 時 fallback price) — 同舊 client 計法一致
create or replace view monthly_sales_by_type
with (security_invoker = on) as
select
  to_char(o.created_at at time zone 'UTC', 'YYYY-MM')      as month,
  coalesce(l.product_type, 'Unknown')                       as product_type,
  coalesce(sum(l.quantity), 0)                              as qty,
  coalesce(sum(coalesce(nullif(l.line_total, 0), l.price, 0)), 0) as revenue
from shopify_order_lines l
join shopify_orders o on o.id = l.order_id
where o.created_at >= date_trunc('month', now()) - interval '25 months'
group by 1, 2;
