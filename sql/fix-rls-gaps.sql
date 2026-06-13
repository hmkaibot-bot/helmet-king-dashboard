-- ============================================================================
-- RLS / 權限缺口修復 — QA 安全檢查發現 (2026-06-13)
-- ============================================================================
-- 背景: README 安全模型係「anon key 公開,要登入 (authenticated) 先讀到數據」。
-- 但 QA prep 用 Supabase MCP 查 pg_policies / role grants / view reloptions,發現
-- 有缺口 — 用公開 anon key (已喺前端 bundle + git history) 唔使登入就讀到、
-- 部分仲寫到敏感數據。
--
-- 呢個 project 用「手動喺 SQL Editor 跑 sql/ 檔」嘅方式管理 RLS (唔係 supabase
-- CLI migrations),所以呢個 fix 跟返同一 pattern。
-- ============================================================================

-- ── C 類 (已套用 ✅ 2026-06-13 經 Supabase MCP): ─────────────────────────────
-- SECURITY DEFINER views (冇 security_invoker) 俾 anon 公開 SELECT,繞過底層 RLS。
-- 修法: REVOKE 收返 anon 權限 (公開讀洞即時封) + 開 security_invoker
--       (view 跟返查詢者 RLS,同 sql/perf-views.sql 嘅 view 一致)。
--       authenticated / service_role 權限不變 — 唔影響登入用戶同後端。
alter view public.v_recon_bank_full     set (security_invoker = on);
alter view public.v_daily_shopify_sales set (security_invoker = on);
alter view public.v_bc_monthly_sales    set (security_invoker = on);
alter view public.v_bc_top_products     set (security_invoker = on);
alter view public.v_brand_sales_ranking set (security_invoker = on);
alter view public.v_inventory_health    set (security_invoker = on);

revoke all on public.v_recon_bank_full     from anon;
revoke all on public.v_daily_shopify_sales from anon;
revoke all on public.v_bc_monthly_sales    from anon;
revoke all on public.v_bc_top_products     from anon;
revoke all on public.v_brand_sales_ranking from anon;
revoke all on public.v_inventory_health    from anon;

-- ── A 類 (待確認,未套用): Dashboard 自己嘅 table 有殘留 anon_* policy ───────────
-- 違反 README「authenticated 先讀寫」模型 (很可能係加 Auth 之前嘅殘留)。
-- app 係登入用 authenticated,authenticated_full_access 已涵蓋,drop 呢啲 anon
-- policy 對 dashboard 風險低。
-- ⚠️ dead_stock_* 嗰幾條係 anon 可【寫】(INSERT/UPDATE) — drop 前確認冇未登入流程寫入。
-- drop policy if exists "anon_read_bc_purchase_invoices"      on public.bc_purchase_invoices;
-- drop policy if exists "anon_read_bc_purchase_invoice_lines" on public.bc_purchase_invoice_lines;
-- drop policy if exists "anon_read_bc_inventory"              on public.bc_inventory;
-- drop policy if exists "anon_read_dsr"                       on public.dead_stock_reviews;
-- drop policy if exists "anon_insert_dsr"                     on public.dead_stock_reviews;
-- drop policy if exists "anon_update_dsr"                     on public.dead_stock_reviews;
-- drop policy if exists "anon_read_dsal"                      on public.dead_stock_audit_log;
-- drop policy if exists "anon_insert_dsal"                    on public.dead_stock_audit_log;

-- ── B 類 (待確認,未套用): 其他 module 嘅 table RLS 直接關咗 ──────────────────────
-- recon_* / invoice_* / bc_bank_ledger_entries / bc_vendor_ledger_entries /
-- bc_posted_purchase_invoices — anon 全部 SELECT 到 (財務 / PII,例如銀行交易、
-- 信用卡、員工、開支報銷)。
-- ⚠️ 呢啲 table 唔屬呢個 dashboard,係其他 module (recon / finance / invoice) 寄居。
--    開 RLS 前要確認嗰啲 module 點 access:service_role 後端會繞過 RLS 照用;
--    若有 authenticated 前端就要加返 policy,否則會整壞嗰啲 app。
-- 範本 (逐張表):
--   alter table public.<t> enable row level security;
--   create policy "authenticated_full_access" on public.<t>
--     for all to authenticated using (true) with check (true);
