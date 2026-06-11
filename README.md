# 頭盔王 Helmet King Dashboard

零售 + 車房業務數據儀表板。React SPA 直連 Supabase（PostgREST），數據由 n8n 同 GitHub Actions 每日同步。

## 架構

```
Shopify ─┐                                   ┌─> Vercel (static SPA)
BC ──────┼─> n8n / GitHub Actions ─> Supabase ┤
Marsello ┘    (service_role key)   (Postgres) └─> Edge Functions
                                                  (foorir-proxy, marsello-proxy)
Foorir 客流 ──────────────────────────────────────> 前端直連 (CAPTCHA 登入)
```

- **前端**：`client/` — React 18 + Vite + Tailwind + shadcn/ui + TanStack Query + Recharts，hash routing（wouter）
- **數據層**：`client/src/lib/query-helpers.ts` 統一查 Supabase（分頁、cache、de-dup）
- **同步**：`scripts/*.py` 由 `.github/workflows/` 每日排程跑（Shopify/BC → Supabase）
- **`server/`**：只係本地開發用嘅 Vite dev server wrapper，production 唔會部署

## 安全模型（重要）

| 元件 | Key | 權限 |
|---|---|---|
| 前端 | anon key（公開，設計如此） | 靠 RLS：要登入（authenticated）先讀寫到數據 |
| GitHub Actions / n8n | service_role key（secret） | 繞過 RLS，完整權限 |

- 登入用 **Supabase Auth**（email + password），用戶喺 Supabase Dashboard → Authentication → Users 管理
- RLS policies 喺 `sql/enable-rls.sql` — **新增 table 一定要照跟 pattern 開 RLS**，否則該 table 公開
- **service_role key 永遠唔可以出現喺 `client/` 或任何 `VITE_` 環境變數**

### 初始設定（一次性）

1. **Rotate service_role key**：Supabase Dashboard → Settings → API → service_role → reset（舊 key 曾經洩露喺前端 bundle 同 git history）
2. 更新 GitHub repo secrets（`SUPABASE_SERVICE_KEY`）同 n8n 用新 key
3. **建立登入用戶**：Supabase Dashboard → Authentication → Users → Add user（建議 Auto Confirm）
4. **開 RLS**：SQL Editor 跑 `sql/enable-rls.sql`
5. （可選）Vercel 環境變數設 `VITE_FOORIR_USERNAME` / `VITE_FOORIR_PASSWORD`（客流功能）

## 環境變數

見 `.env.example`。本地開發 copy 做 `.env`；production 喺 Vercel project settings 設定。

## 開發

```bash
npm install
npm run dev      # localhost:5000 (Express + Vite middleware)
npm run check    # TypeScript typecheck
vite build       # production build → dist/public
```

## 部署

Vercel 自動 build（`vercel.json`：`vite build` → `dist/public`）。`dist/` 唔再 commit 入 git。

## 數據管道

| 來源 | 工具 | 目標 tables | 排程 |
|---|---|---|---|
| Shopify orders | `scripts/daily_shopify_backfill.py` | shopify_orders, shopify_order_lines | 每日 HKT 02:00 |
| Shopify products | `scripts/daily_inventory_snapshot.py` | shopify_inventory | 每日 HKT 02:30 |
| BC items / invoices | 同上 | bc_inventory, bc_purchase_*, bc_sales_invoices | 每日 HKT 02:30 |
| 其餘 | n8n | shopify_products, bc_invoice_lines, marsello_customers 等 | n8n 排程 |

手動補數：GitHub Actions → 揀 workflow → Run workflow（有 full backfill / lookback days 開關）。
