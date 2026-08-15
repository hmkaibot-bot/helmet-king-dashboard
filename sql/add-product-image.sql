-- 品牌明細產品縮圖用:shopify_products 加 image_url 欄
-- 喺 Supabase Studio > SQL Editor 貼呢句跑一次;
-- 之後夜間 inventory snapshot(02:30 HKT)會自動補圖,
-- 想即刻有圖可以去 GitHub Actions 手動 Run「Daily Inventory Snapshot」。
ALTER TABLE public.shopify_products ADD COLUMN IF NOT EXISTS image_url text;
