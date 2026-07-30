# 賣車部（26King）駁 API — 交接文件

> 呢份文件寫俾**接手做 26King 賣車部 API 整合**嘅人（同佢個 AI agent）。
> 零售部分已經做完並上咗 production，呢邊只做賣車部。先讀完成篇再落手。

最後更新:2026-07-29

---

## 1. 任務範圍（⚠️ 開工前要老闆確認）

**要駁邊個 API / 系統,呢一格由老闆填:**

```
目標系統:            （例:26King 自己個賣車平台 / 車輛庫存系統 / CRM…）
API 文件:            （URL 或 PDF）
認證方式:            （API key / OAuth / basic auth）
要拉啲咩數據:        （車輛庫存?成交?估價?寄賣狀態?）
要推啲咩上去:        （如果有）
更新頻率:            （即時 webhook / 每日一次就夠）
Dashboard 想睇咩:    （新一頁?定係加落現有頁?）
```

**冇填以上資料唔好開始寫 code** — 問老闆(hmkaibot@gmail.com)。
下面 §2–§6 係無論駁邊個 API 都要知嘅背景同規矩。

---

## 2. 呢個 repo 係咩

頭盔王(Helmet King)嘅生意數據儀表板。React SPA 直連 Supabase,加 Vercel serverless
functions 同 GitHub Actions 每日同步。詳細架構見 `README.md`。

**一個關鍵背景:同一間公司孭三盤生意** —

| 業務 | 內容 | 呢個 dashboard 現狀 |
|---|---|---|
| 零售 | 頭盔/裝備(Shopify + 門市 POS) | ✅ 做齊 |
| **26King 賣車** | 現貨車/回收/寄賣/Trade-in | ⬜ **你負責呢邊** |
| 租車 · 車房 · 自駕團 | Rentalbike / 維修保養 / 旅行團 | ⬜ 未做 |

老闆 2026-07 明確要求營銷分析頁「淨睇零售」,所以已經有一套**業務分流**機制
(見 §4)。你加 26King 嘅嘢**要跟同一套 business 分類**,唔好另起爐灶。

---

## 3. 環境同權限（要老闆開俾你）

| 要嘅嘢 | 點拿 | 備註 |
|---|---|---|
| GitHub repo 權限 | 老闆去 repo → Settings → Collaborators 加你 | 私人 repo |
| Supabase 存取 | 老闆喺 Supabase → Settings → Team 加你 | project ref `myrangmxyjamsupbxbba` |
| `SUPABASE_SERVICE_KEY` | 用密碼管理器/私訊傳,**唔好貼喺 chat 或 commit** | 繞過 RLS,好大權 |
| 新 API 嘅 key | 同上 | 存法見 §5 |

Vercel / n8n 存取通常唔需要 — 除非你要加新 serverless function 嘅環境變數,
到時叫老闆加(或者用 §5 個 `app_config` 做法,唔使碰 Vercel)。

---

## 4. 業務分流機制（你一定要跟）

### 4.1 客服查詢(SleekFlow)

`inquiry_events` table 每行有 `business` 欄:`retail` / `26king` / `garage` /
`rental` / `tour`。判定邏輯喺 `scripts/sleekflow_sync.py`:

1. **同事分隊優先** — SleekFlow 對話嘅 `assignedTeam`(Retail / 26KING / Garage /
   RentalbikeHK / Tour)→ `TEAM_BUSINESS` 對照。同事一直有按內容 triage,所以最準。
2. 冇分隊就**按 channel 線** — `CHANNEL_BUSINESS` 對照(每盤生意有自己嘅 WhatsApp
   號碼 / IG account,`channelIdentityId` 認得出)。

已知線(唔好硬編死喺其他地方,改就改 `sleekflow_sync.py`,或加 `app_config` key
`SLEEKFLOW_CHANNEL_BUSINESS` 做 JSON 覆蓋):

- 26King WhatsApp `85262039357`、IG `@26kinghk`(`17841446002032010` / page `110139034178233`)
- 零售:Main WhatsApp `85263858830`、IG `@helmetking_hk`、FB 頭盔王 page
- 租車:WhatsApp `85259614354`

**90 日實測分佈(對話級)**:26king 96 / tour 16 / garage 13 / retail 12 / rental 6
—— 即係話賣車部係查詢量最大嘅一盤,呢邊做好會有好多料。

### 4.2 Meta 廣告 campaign

- `meta_campaigns.business` = 人手 override(`retail` / `nonretail`),null 就靠
  `client/src/lib/business-filter.ts` 嘅名稱關鍵字自動分類
- 賣車相關關鍵字已經有:`26KING`、`26PACK`、現貨車/二手車/寄賣/回收/Trade-in、
  車款型號(GSX / NMAX / ZX-6R / R3 …)
- `meta_campaign_daily`(campaign × 日)係逐 campaign 分業務加總嘅來源;
  帳戶級 `meta_ad_insights` 撈埋三盤生意,**分唔開,唔好用嚟做單一業務數字**

### 4.3 前端

`client/src/pages/marketing.tsx` 有個 🪖 淨睇零售 / 全部業務 toggle。
如果你要做「淨睇賣車」嘅視角,**照抄同一個 pattern**(`business-filter.ts` 加
helper,唔好喺 page 內散落硬編條件)。

---

## 5. Secret 存放法（zero-config pattern）

呢個 project 有個慣例:**新 API key 存 Supabase `app_config` table**,唔使逐個
地方(Vercel env / GitHub secret)設定。

```
app_config (key text primary key, value text)
RLS: authenticated 可 SELECT;寫入只限 service_role
```

- **GitHub Actions / python script**:用 `SUPABASE_SERVICE_KEY` 讀 `app_config`
  (見 `scripts/meta_campaigns_sync.py` 嘅 `meta_token()`、
  `scripts/sleekflow_sync.py` 嘅 `sleekflow_key()` — 都係 env 優先、fallback DB)
- **Vercel serverless function**:用**呼叫者嘅 Supabase JWT** 讀(見
  `api/meta-campaign.ts` 嘅 `getMetaToken()`,有 module-level cache)
- 現有 key:`META_ACCESS_TOKEN`、`SLEEKFLOW_API_KEY`、`SLEEKFLOW_WEBHOOK_SECRET`

**鐵規**:service_role key 或任何 secret 永遠唔可以出現喺 `client/`、任何
`VITE_` 變數、commit message、或者 PR 描述。

---

## 6. 落手前必讀嘅坑

1. **ESM extension** — `api/*.ts` 係 ESM(`"type": "module"`),relative import
   **一定要帶 `.js`**(`from './helper.js'`),唔係 Vercel 會 runtime 501
   FUNCTION_INVOCATION_FAILED,但本地 build 唔會報錯。
2. **`shopify_orders.processed_at` 死咗**(2026-04-22 之後全部 NULL)—— 一律用
   `created_at`。
3. **新 table 一定要開 RLS**,跟 `sql/enable-rls.sql` 個 authenticated pattern,
   唔係嗰個 table 就公開曝光。
4. **睇唔見嘅 partial unique index** — 曾經有個 `WHERE is_archived = false` 嘅
   partial index 令 insert 靜靜咁失敗,`pg_constraint` 查唔到。撞到怪 constraint
   error 記得查 `pg_indexes`。
5. **私隱原則** — `inquiry_events` 只存「認到商品」嘅訊息原文(截 200 字),
   其餘唔存。加新數據源時跟同一標準,唔好將整個聊天記錄搬入 DB。
6. **兩個 Claude session 同時做嘢** — 零售邊個 session 用 branch
   `claude/funny-bardeen-t9d3e5`。**你用另一個 branch 名**,唔好推同一條,
   免得互相 force-push 蓋走對方。

---

## 7. 開發流程

```bash
git checkout -B <你自己嘅 branch> origin/main
# 改嘢…
npx tsc                        # typecheck(CI 會行)
npm run build                  # vite build(CI 會行)
python3 -m py_compile scripts/你嘅script.py
git push -u origin <你嘅 branch>
# 開 PR → 等 CI(build + Typecheck)綠 → squash merge
```

- CI:`.github/workflows/ci.yml`(pull_request 觸發)
- Vercel 會自動 deploy preview;merge 落 main 就上 production
- 每日同步 job 加喺 `.github/workflows/`,參考 `sleekflow-sync.yml`
  (cron 用 UTC — HKT 減 8 個鐘;錯開 02:00–02:30 之間唔好撞 n8n Daily ETL)

---

## 8. 現有代碼參考（照抄最快）

| 你要做 | 睇邊個檔 |
|---|---|
| 每日 API → Supabase 同步 script | `scripts/sleekflow_sync.py`(分頁、對賬、字典對照都有) |
| Serverless function 攞外部 API(token 留 server) | `api/meta-campaign.ts` |
| Webhook 收 inbound(唔用 service key) | `api/sleekflow-inquiry.ts` + `ingest_sleekflow_inquiry` DB function |
| GitHub Actions 排程 | `.github/workflows/sleekflow-sync.yml` |
| 前端查 Supabase(分頁 / cache / 日期範圍) | `client/src/lib/query-helpers.ts` |
| 業務分類 helper | `client/src/lib/business-filter.ts` |
| 彈窗 drill-down UI | `client/src/pages/marketing.tsx` 嘅 `CampaignDetailModal` / `InquiryChatModal` |

---

## 9. 有咩已經整定,唔使重做

- ✅ 26King 嘅查詢已經自動標 `business='26king'`(90 日回填做完)—— 你要做賣車
  dashboard,查詢數據**即刻有得用**
- ✅ 賣車廣告 campaign 已經自動分類到 `nonretail`,`meta_campaign_daily` 有
  campaign × 日 成效(2025-12-30 起)
- ✅ `app_config` secret 機制、RLS pattern、CI、每日 job 骨架

即係話:賣車部嘅「客服查詢」同「廣告成效」兩條數已經通,你主要要駁嘅係
**賣車業務本身嘅系統數據**(庫存 / 成交 / 寄賣進度之類 —— 等老闆填 §1)。
