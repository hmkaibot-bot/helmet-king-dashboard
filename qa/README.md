# QA 探索性測試 — 執行步驟

新 session 執行前置 — **network egress 必須允許以下 host**（喺 environment 嘅 network 設定加；參考 <https://code.claude.com/docs/en/claude-code-on-the-web>）：

| Host | 用途 | 一定要? |
|---|---|---|
| `myrangmxyjamsupbxbba.supabase.co` | App 登入 (Auth) + 數據 (PostgREST) — browser 連唔到就過唔到登入頁 | ✅ 必須 |
| `cdn.playwright.dev` | 下載 Chromium — **只喺容器未預載 Chromium 時先需要** | ⚠️ 多數唔使 |

> ⚠️ **egress 政策喺 session（容器）開始嗰刻就鎖定,唔會 hot-reload。** 改完 allowlist 一定要**開一個新 session** 先生效 — 喺運行緊嘅 session 度改設定係冇用嘅（照樣 `403 host_not_allowed`，唔代表你設定錯）。
>
> 💡 Chromium 通常已**預載**喺 `/opt/pw-browsers`（playwright 1.56.1 → `chromium-1194`）。`npx playwright install chromium` 秒回、冇下載輸出 = 已有,毋須開 `cdn.playwright.dev`。
>
> Supabase **MCP** 係另一條通道（唔行 egress proxy），所以就算 browser 連唔到 Supabase，reset 密碼 / 清理嗰啲 SQL 一樣行得到。
>
> 🔐 **就算 host 已 allow,headless browser 仍可能 `net::ERR_CERT_AUTHORITY_INVALID`** — 環境 egress proxy 做 TLS 攔截、出自簽 CA。系統 trust 咗(所以 `curl` 拎到 401),但 Playwright 自帶 Chromium 唔 trust,於是 browser 所有 https request fail、登入直接 abort 掃描。`qa-explore.mjs` 已喺 `newContext({ ignoreHTTPSErrors: true })` 處理。**呢個唔係 egress allowlist 設定錯,加 host 都解決唔到。**

1. **重設 / 建立臨時 QA 帳號**（帳號 `qa-test@helmetking.internal`;若上次 step 5 已刪,以下會自動重建,即刻可登入）:
   用 Supabase MCP 對 project `myrangmxyjamsupbxbba` 行:
   ```sql
   do $$
   declare uid uuid;
   begin
     select id into uid from auth.users where email = 'qa-test@helmetking.internal';
     if uid is null then
       -- 重新建立:email provider + email_confirmed,即刻可以密碼登入
       uid := gen_random_uuid();
       insert into auth.users
         (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
          created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
       values
         (uid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          'qa-test@helmetking.internal', crypt('<新隨機密碼>', gen_salt('bf')), now(),
          now(), now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb);
       insert into auth.identities
         (user_id, provider_id, provider, identity_data, created_at, updated_at, last_sign_in_at)
       values
         (uid, uid::text, 'email',
          jsonb_build_object('sub', uid::text, 'email', 'qa-test@helmetking.internal'),
          now(), now(), now());
     else
       update auth.users
         set encrypted_password = crypt('<新隨機密碼>', gen_salt('bf')),
             email_confirmed_at = coalesce(email_confirmed_at, now())
       where id = uid;
     end if;
   end $$;
   ```
   然後 `echo '<新隨機密碼>' > /tmp/qa_pw.txt`

2. **裝依賴 + 起 dev server**（dev server 預設 `localhost:5173`，同 `qa-explore.mjs` 一致）:
   ```bash
   npm install                                  # 主依賴
   npm install --no-save playwright@1.56.1       # playwright 唔喺 package.json,要另裝 (npm registry 通)
   npx playwright install chromium               # 秒回=已預載 /opt/pw-browsers;有下載=需 cdn.playwright.dev
   (npm run dev > /tmp/vite-dev.log 2>&1 &)
   # 等 Vite 真係 listen 咗先好跑掃描，否則第一個 page.goto 會掉 error
   until curl -sf http://localhost:5173 >/dev/null 2>&1; do sleep 1; done
   ```

3. **跑掃描** (`node qa/qa-explore.mjs`):
   - 登入表單 3 種輸入測試 (空白/錯密碼/特殊字元) + 正式登入
   - 24 個 nav 路由逐頁掃描: console errors / 失敗 requests / 空白頁 / 載入時間
   - 結果: /tmp/qa-results.json + /tmp/qa-shots/*.png

4. **第二輪互動測試** (掃描通過後逐頁做):
   - Header: 主題切換 / 刷新數據掣 / date range select (轉 range 後 KPI 應更新)
   - 庫存頁: 8 個 tabs 全點;車件/人身部品 tab expand row → 進貨明細 lazy load;斷碼 tab chips + expand
   - 死貨頁: 系統狀態/狀態核實/推廣中 filters、分類品牌 chip filter popover、
     搜尋框 (正常/超長/特殊字元)、expand product → SKU 詳情表單 (⚠️ 唔好撳儲存 — 會寫入生產 DB)
   - 推廣詳情: 11 個欄 header 排序、chip filter popover (⚠️ 唔好掂推廣價 input — onBlur 即寫 DB)
   - 週報: 5 個 preset 掣 + 自訂日期
   - 品牌分析: drill down 品牌 → 產品 → 返回
   - 關聯性: 死貨頁改「推廣中」checkbox ↔ 推廣商品池會唔會出現 (⚠️ 寫 DB,要還原)

5. **測完清理**（刪除臨時帳號 — 下次跑 step 1 會自動重建,所以可以安心清走）:
   ```sql
   delete from auth.identities where user_id = (select id from auth.users where email='qa-test@helmetking.internal');
   delete from auth.users where email = 'qa-test@helmetking.internal';
   ```

輸出格式: 表格 (元件位置/操作/預期/實際/狀態 ✅❌⚠️) + 按嚴重程度排序嘅失敗總結。
