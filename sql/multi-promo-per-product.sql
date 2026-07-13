-- ============================================================================
-- 支援「一件商品分派俾多個推廣活動」
-- ============================================================================
-- 喺 Supabase Dashboard → SQL Editor 跑一次（已經透過 migration
-- drop_uniq_promotion_items_active_product 套用落 production）。
--
-- 背景:
--   promotion_items 原本有個 partial unique index —
--       CREATE UNIQUE INDEX uniq_promotion_items_active_product
--         ON promotion_items (product_id) WHERE (is_archived = false)
--   佢喺 DB 層強制「一件貨同一時間只可以一個未封存分派」,即係阻止
--   一件商品同時分派俾多個推廣活動。
--
-- 效果:
--   * 移除後,一件貨可以分派俾多個活動。
--   * PRIMARY KEY (promotion_id, product_id) 仍然保留 —— 同一個活動唔可以
--     重複加同一件貨。
--   * 同期疊活動嘅營收「各自計一次」問題,由分派頁 UI 提示處理
--     (加入第二個進行中活動時彈確認)。
-- ============================================================================

DROP INDEX IF EXISTS public.uniq_promotion_items_active_product;

-- 驗證:應該淨返 pkey / promotion_id / product_id 三個 index,冇 uniq_*_active_product
select indexname, indexdef
from pg_indexes
where schemaname = 'public' and tablename = 'promotion_items'
order by indexname;
