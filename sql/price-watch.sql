-- ─────────────────────────────────────────────────────────────────────────
-- 格價系統 Price Watch — schema (tables + landed-cost views)
-- 對手「到手價」= 標價 − 出口退稅(EU VAT 等) + 去HK運費估算 × 即日匯率 (HK 免關稅)
-- 資料由 scripts/price_watch_fcmoto.py 寫入 (可由 GitHub Actions 排程)
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists fx_rates (
  currency text primary key,
  hkd_per_unit numeric not null,            -- 1 <currency> = ? HKD
  fetched_at timestamptz not null default now()
);

create table if not exists competitor_merchants (
  key text primary key,
  name text not null,
  country text,
  currency text not null,
  export_vat_pct numeric not null default 0,   -- 出口去HK時扣減嘅 VAT/消費稅 %
  ship_to_hk_hkd numeric not null default 0,   -- 去HK運費估算 (HKD)
  free_ship_over_hkd numeric,                  -- 免運門檻 (HKD); null = 冇
  delivery_days_min int,
  delivery_days_max int,
  notes text,
  updated_at timestamptz not null default now()
);

create table if not exists competitor_prices (
  id bigint generated always as identity primary key,
  our_product_id text not null,             -- 我方 shopify product id (或 "MARKET:..." 代表我哋冇賣嘅 hero)
  our_sku text,
  our_title text,
  our_price numeric,                        -- 我方 HKD 價快照 (market-watch 為 null)
  merchant text not null references competitor_merchants(key),
  competitor_title text,
  url text,
  currency text not null,
  listed_price numeric not null,            -- 對手標價 (含佢嘅 VAT)
  in_stock boolean,
  match_confidence text default 'medium',   -- high|medium|low
  match_method text,                        -- gtin|model|ai|manual
  scraped_at timestamptz not null default now()
);
create index if not exists idx_compprices_product on competitor_prices(our_product_id);

-- 每個對手 row 嘅到手價
create or replace view product_price_comparison as
select cp.id, cp.our_product_id, cp.our_title, cp.our_sku, cp.our_price,
  cp.merchant, m.name merchant_name, m.country, cp.currency, cp.listed_price,
  cp.url, cp.in_stock, cp.match_confidence, cp.match_method, cp.scraped_at,
  m.delivery_days_min, m.delivery_days_max,
  round((cp.listed_price/(1+m.export_vat_pct/100.0)) * coalesce(fx.hkd_per_unit,1)) item_hkd,
  case when m.free_ship_over_hkd is not null
        and ((cp.listed_price/(1+m.export_vat_pct/100.0))*coalesce(fx.hkd_per_unit,1)) >= m.free_ship_over_hkd
       then 0 else m.ship_to_hk_hkd end ship_hkd,
  round((cp.listed_price/(1+m.export_vat_pct/100.0)) * coalesce(fx.hkd_per_unit,1))
   + case when m.free_ship_over_hkd is not null
        and ((cp.listed_price/(1+m.export_vat_pct/100.0))*coalesce(fx.hkd_per_unit,1)) >= m.free_ship_over_hkd
       then 0 else m.ship_to_hk_hkd end landed_hkd
from competitor_prices cp
join competitor_merchants m on m.key = cp.merchant
left join fx_rates fx on fx.currency = cp.currency;

-- 每件商品: 我方價 vs 最平對手 + 全對手清單 (前端 price-watch 頁讀呢個)
create or replace view price_watch as
select c.our_product_id,
  max(c.our_title) our_title, max(c.our_sku) our_sku, max(c.our_price) our_price,
  count(*) n, min(c.landed_hkd) cheapest_landed,
  jsonb_agg(jsonb_build_object('merchant',c.merchant_name,'country',c.country,'landed',c.landed_hkd,
     'listed',c.listed_price,'cur',c.currency,'d1',c.delivery_days_min,'d2',c.delivery_days_max,
     'url',c.url,'conf',c.match_confidence) order by c.landed_hkd) competitors,
  max(c.scraped_at) last_scraped
from product_price_comparison c
group by c.our_product_id;
