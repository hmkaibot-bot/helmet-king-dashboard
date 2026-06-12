-- ============================================================================
-- Enable Row Level Security on all dashboard tables
-- ============================================================================
-- 喺 Supabase Dashboard → SQL Editor 跑一次。
--
-- 效果:
--   * anon key 單獨無法讀寫任何數據 (login 頁以外攞唔到嘢)
--   * 登入咗嘅用戶 (Supabase Auth, role = authenticated) 有完整讀寫權
--   * GitHub Actions / n8n 用 service_role key, 自動 BYPASS RLS, 不受影響
--
-- 之後新增 table 記得跟同一個 pattern 開 RLS, 否則嗰張 table 會公開。
-- ============================================================================

do $$
declare
  t text;
begin
  foreach t in array array[
    'bc_customers',
    'bc_inventory',
    'bc_invoice_lines',
    'bc_purchase_invoice_lines',
    'bc_purchase_invoices',
    'bc_sales_invoices',
    'dead_stock_audit_log',
    'dead_stock_reviews',
    'garage_marsello_queue',
    'marsello_customers',
    'meta_ad_insights',
    'meta_campaigns',
    'promotion_items',
    'promotions',
    'shopify_inventory',
    'shopify_order_lines',
    'shopify_orders',
    'shopify_products'
  ] loop
    -- Skip tables that don't exist in this project
    if to_regclass('public.' || quote_ident(t)) is null then
      raise notice 'skip (not found): %', t;
      continue;
    end if;

    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists authenticated_full_access on public.%I', t);
    execute format(
      'create policy authenticated_full_access on public.%I '
      'for all to authenticated using (true) with check (true)', t);
    raise notice 'RLS enabled: %', t;
  end loop;
end $$;

-- 驗證: 列出所有 public tables 嘅 RLS 狀態
select tablename, rowsecurity
from pg_tables
where schemaname = 'public'
order by tablename;
