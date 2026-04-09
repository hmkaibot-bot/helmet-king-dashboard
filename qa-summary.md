# Helmet King Dashboard v2 - QA Summary

## Date: April 9, 2026

## Pages Tested (all 9 pages)

### 1. Login Page ✅
- Clean dark design with helmet logo
- Password input and login button working
- Bilingual labels (Chinese + English)

### 2. Overview ✅
- KPIs: Shopify Revenue HK$1,238,438, BC CARSHOP HK$0 (no recent data), BC GARAGE HK$298,426, Orders 992, AOV HK$1,248, Marsello Members 1.0K
- Combined Revenue Trend chart (3 lines: Shopify, BC, Total)
- Retail vs Garage donut chart
- Ad Spend vs Revenue dual-axis chart

### 3. Retail Sales ✅
- KPIs with delta % vs prev period: Revenue, Orders, AOV, Items Sold, Discount Rate
- Daily Revenue area chart
- Orders by Hour bar chart
- Revenue by Source donut (pos, app, referral, web, shopify_draft_order) - **FIXED: cleaned up URL source names**
- Top 10 Customers horizontal bar
- Refund/Cancel Rate trend
- Recent Orders table

### 4. Retail Inventory ✅
- KPIs: 21 Active SKUs, 978 Out of Stock, 16 Low Stock, Inventory Value HK$-37,852 (negative = data issue), Avg Days -11
- Stock Status donut (In Stock / Low / Out)
- Value by Brand Top 10 bar chart (AKRAPOVIC highest)
- Sell-Through Rate by brand bar chart

### 5. Retail Customers ✅
- KPIs: 1.0K Total, 1.0K Active 90d, 265 New, 2.6K Avg Pts, 87.1% Subscribed, 12.2% Repeat
- New Members by Month bar chart
- Members by Tier donut
- Loyalty Points Distribution bar chart
- Top 20 by Points table

### 6. Retail Brands ✅
- Brand filter dropdown
- KPIs: 967 Units, HK$724,968 Revenue, HK$750 Avg Price, 1.0K SKU Count, 78 Brands
- Top 15 by Revenue horizontal bar (SHOEI #1)
- Monthly Trend (Top 5) stacked area chart
- Price Band distribution

### 7. Garage Work Orders ✅
- KPIs: HK$298,426 Revenue, 152 Orders, HK$1,963 Avg Invoice, 102 Unique, HK$2,926 Rev/Cust
- Monthly Revenue bar chart
- Daily Trend line chart
- Value Distribution bar chart
- Top 10 Customers horizontal bar
- Monthly Customers line chart

### 8. Garage Services ✅ (FIXED)
- **Initially showed 0 data — fixed by implementing `queryInBatches()` for bc_invoice_lines**
- KPIs: 643 Lines, 4.2 Avg lines/invoice, Most Common: BELRAY EXS, Top Rev: BRIDGESTONE S23
- Top 20 by Revenue horizontal bar
- Top 20 by Frequency horizontal bar
- Top 5 Services Monthly trend
- Salesperson performance
- Service diversity trend
- Service analysis table

### 9. Marketing ✅
- KPIs: HK$1,670 Meta Spend, 70.1K Impressions, 3.3K Clicks, HK$0.51 CPC, 4.7% CTR, 741.53x ROAS
- Daily Spend vs Revenue dual-axis chart
- CTR trend area chart
- CPM/CPC Cost Trends dual-axis

### 10. Finance ✅
- KPIs: CARSHOP HK$0 (no recent data), GARAGE HK$298,426, Purchase HK$0, Margin 0.0%
- Monthly Revenue (CARSHOP vs GARAGE) stacked bar
- Cost vs Revenue Monthly line chart

## Bugs Fixed
1. **Garage Services empty data**: bc_invoice_lines table has 21,835 rows, exceeding the 5,000 row limit of `queryAll`. Fixed by creating `queryInBatches()` that uses Supabase `.in()` operator to fetch only lines matching garage invoice IDs.
2. **Revenue by Source URLs**: Some shopify_orders had image URLs as source_name. Fixed by mapping URLs to 'referral' and numeric IDs to 'app'.

## Known Data Limitations
- BC CARSHOP shows HK$0 in last 30 days — no recent carshop invoices in the data
- Inventory Value is negative (HK$-37,852) — reflects actual data in Shopify inventory
- Avg Days of Stock is -11 — reflects data calculation

## Deployment
- Built with `npm run build`
- Pushed to GitHub: `hmkaibot-bot/helmet-king-dashboard` main branch
- Vercel auto-deploys to: https://helmet-king-dashboard.vercel.app
