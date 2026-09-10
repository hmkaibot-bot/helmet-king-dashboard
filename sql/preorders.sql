-- 預訂 Pre-orders(訂金商品模式,飛 PreProduct)
--
-- 機制:每個預訂 campaign = Shopify 一件【預訂】商品(價 = 訂金,
-- variant 庫存 = 每 SIZE limit,inventoryPolicy DENY 自動斷數)。
-- 客人網店照常 checkout 畀訂金;到貨客人到店 POS 補尾數(老闆 2026-09-10 定案)。
--
-- preorder_products — 每個 campaign 一行(Shopify 預訂商品 id 做 PK)
-- preorder_orders   — 每張訂單 × campaign 嘅跟進狀態(冇行 = waiting)
--
-- 已於 2026-09-10 經 execute_sql apply 上 production。

create table if not exists preorder_products (
  preorder_product_id bigint primary key,        -- Shopify 預訂商品 id
  real_product_id bigint,                        -- 對應正貨(可 null)
  title text not null,
  deposit_price numeric not null,                -- 訂金(每件)
  full_price numeric not null,                   -- 總價(補尾數 = full - deposit)
  eta date,                                      -- 預計到貨
  status text not null default 'open',           -- open / arrived / closed / cancelled
  variants jsonb not null default '[]',          -- [{sku,label,limit}]
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists preorder_orders (
  order_id bigint not null,                      -- shopify_orders.id
  preorder_product_id bigint not null references preorder_products(preorder_product_id) on delete cascade,
  status text not null default 'waiting',        -- waiting / notified / completed / refunded
  updated_at timestamptz not null default now(),
  primary key (order_id, preorder_product_id)
);

alter table preorder_products enable row level security;
alter table preorder_orders enable row level security;

-- 同 shopify_inventory 一致:登入用戶全權(dashboard 得管理級用)
drop policy if exists preorder_products_auth on preorder_products;
create policy preorder_products_auth on preorder_products for all to authenticated using (true) with check (true);
drop policy if exists preorder_orders_auth on preorder_orders;
create policy preorder_orders_auth on preorder_orders for all to authenticated using (true) with check (true);
