# QA 探索性測試 — 執行步驟

新 session（要喺 network policy 允許 `myrangmxyjamsupbxbba.supabase.co` 嘅 environment 度行）：

1. **重設臨時 QA 帳號密碼**（帳號 `qa-test@helmetking.internal` 已存在 auth.users）:
   用 Supabase MCP 對 project `myrangmxyjamsupbxbba` 行:
   ```sql
   update auth.users set encrypted_password = crypt('<新隨機密碼>', gen_salt('bf'))
   where email = 'qa-test@helmetking.internal';
   ```
   然後 `echo '<新隨機密碼>' > /tmp/qa_pw.txt`

2. **裝依賴 + 起 dev server**:
   ```bash
   npm install --no-save playwright@1.56.1
   npx playwright install chromium
   (npm run dev > /tmp/vite-dev.log 2>&1 &)
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

5. **測完清理**:
   ```sql
   delete from auth.identities where user_id = (select id from auth.users where email='qa-test@helmetking.internal');
   delete from auth.users where email = 'qa-test@helmetking.internal';
   ```

輸出格式: 表格 (元件位置/操作/預期/實際/狀態 ✅❌⚠️) + 按嚴重程度排序嘅失敗總結。
