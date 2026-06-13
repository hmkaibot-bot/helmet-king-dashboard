/**
 * QA 探索性測試 — 逐頁掃描 + 互動測試
 * 用法: node qa-explore.mjs
 * 結果: /tmp/qa-results.json + /tmp/qa-shots/*.png
 */
import { chromium } from 'playwright';
import fs from 'fs';

const BASE = 'http://localhost:5173';
const EMAIL = 'qa-test@helmetking.internal';
const PASSWORD = fs.readFileSync('/tmp/qa_pw.txt', 'utf8').trim();
const SHOTS = '/tmp/qa-shots';
fs.mkdirSync(SHOTS, { recursive: true });

const ROUTES = [
  ['/', '總覽 Overview'],
  ['/retail/sales', '零售/銷售'],
  ['/retail/inventory', '零售/庫存'],
  ['/retail/customers', '零售/客戶'],
  ['/retail/brands', '零售/品牌分析'],
  ['/retail/restock', '補貨管理'],
  ['/retail/dead-stock', '死貨管理'],
  ['/retail/promotions', '推廣活動'],
  ['/retail/promotions/items', '推廣商品池'],
  ['/retail/promotions/history', '推廣歷史'],
  ['/retail/returns', '退貨'],
  ['/garage/orders', '車房/工單'],
  ['/garage/services', '車房/服務分析'],
  ['/procurement/vendors', '供應商'],
  ['/performance/daily', '昨日/本週'],
  ['/performance/weekly-review', '週報'],
  ['/performance/velocity', '銷售速率'],
  ['/performance/new-products', '新品表現'],
  ['/performance/product-analytics', '商品分析'],
  ['/performance/forecast', '需求預測'],
  ['/crm/marsello-approval', 'Marsello 積分'],
  ['/marketing', '營銷'],
  ['/finance', '財務'],
  ['/system/sync-status', '同步狀態'],
];

const results = [];
function log(entry) {
  results.push(entry);
  const icon = entry.status === 'PASS' ? '✅' : entry.status === 'FAIL' ? '❌' : '⚠️';
  console.log(`${icon} [${entry.where}] ${entry.action} → ${entry.actual}`);
}

const consoleErrors = [];
const failedRequests = [];

function attachCollectors(page) {
  page.on('console', msg => {
    if (msg.type() === 'error') consoleErrors.push({ at: currentRoute, text: msg.text().slice(0, 300) });
  });
  page.on('pageerror', err => consoleErrors.push({ at: currentRoute, text: 'PAGEERROR: ' + String(err).slice(0, 300) }));
  page.on('requestfailed', req => {
    // ignore aborted (navigation cancels)
    if (req.failure()?.errorText?.includes('ERR_ABORTED')) return;
    failedRequests.push({ at: currentRoute, url: req.url().slice(0, 160), err: req.failure()?.errorText });
  });
  page.on('response', res => {
    if (res.status() >= 400 && !res.url().includes('favicon')) {
      failedRequests.push({ at: currentRoute, url: res.url().slice(0, 160), err: 'HTTP ' + res.status() });
    }
  });
}

let currentRoute = '(init)';

async function waitLoaded(page, ms = 45000) {
  // 等 skeleton 消失 + network 安靜
  const start = Date.now();
  try { await page.waitForLoadState('networkidle', { timeout: ms }); } catch {}
  // skeleton class from shadcn: animate-pulse
  try {
    await page.waitForFunction(
      () => document.querySelectorAll('.animate-pulse').length === 0,
      { timeout: Math.max(1000, ms - (Date.now() - start)) }
    );
  } catch {}
  await page.waitForTimeout(400);
}

async function bodyText(page) {
  return (await page.evaluate(() => document.body.innerText)).trim();
}

const run = async () => {
  const browser = await chromium.launch();
  // ignoreHTTPSErrors: 環境 egress proxy 做 TLS 攔截,presents 自簽 CA。
  // 系統 trust 咗(curl 通),但 Playwright Chromium 唔 trust → 唔加呢個全部 https request 會 ERR_CERT_AUTHORITY_INVALID。
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 }, ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  attachCollectors(page);

  // ── 1. 登入頁表單測試 ──────────────────────────────────────────
  currentRoute = '/login';
  await page.goto(BASE + '/#/');
  await page.waitForTimeout(2500);
  const emailBox = page.locator('[data-testid="input-email"]');
  const pwBox = page.locator('[data-testid="input-password"]');
  const loginBtn = page.locator('[data-testid="button-login"]');
  const hasLogin = await emailBox.count();
  if (hasLogin) {
    // 1a. 空白表單 → 登入掣應 disabled (login.tsx: disabled={loading || !password || !email})
    //     ⚠️ 唔好 click 一個 disabled 嘅掣 — Playwright 會等佢 enable 直到 timeout (30s) 而 abort 成個掃描。
    const disabledWhenEmpty = await loginBtn.isDisabled();
    log({ where: '登入頁', action: '空白表單', expected: '登入掣 disabled,阻止空白提交', actual: disabledWhenEmpty ? '登入掣 disabled (正確阻止)' : '登入掣可點擊 (應為 disabled)', status: disabledWhenEmpty ? 'PASS' : 'FAIL' });

    // 1b. 錯誤密碼 → 顯示錯誤訊息
    await emailBox.fill(EMAIL);
    await pwBox.fill('wrong-password-123');
    await loginBtn.click();
    await page.waitForTimeout(4000);
    const errText = (await page.locator('[data-testid="text-error"]').count())
      ? await page.locator('[data-testid="text-error"]').innerText() : '';
    log({ where: '登入頁', action: '錯誤密碼', expected: '顯示錯誤訊息', actual: errText ? `錯誤訊息: ${errText.slice(0, 80)}` : '無錯誤訊息顯示', status: errText ? 'PASS' : 'FAIL' });

    // 1c. 超長/特殊字元 email → 不崩潰 (掣可能因格式驗證而 disabled,所以先檢查再 click)
    await emailBox.fill("x'\"<script>@".padEnd(80, 'a') + '.com');
    await pwBox.fill('x');
    if (await loginBtn.isEnabled()) await loginBtn.click().catch(() => {});
    await page.waitForTimeout(1800);
    const crashed = (await bodyText(page)).length < 20;
    log({ where: '登入頁', action: '特殊字元 email', expected: '正常顯示驗證/錯誤,不崩潰', actual: crashed ? '頁面空白/崩潰' : '正常處理', status: crashed ? 'FAIL' : 'PASS' });

    // 1d. 正確登入
    await emailBox.fill(EMAIL);
    await pwBox.fill(PASSWORD);
    await loginBtn.click();
    await page.waitForTimeout(5000);
    const loggedIn = (await emailBox.count()) === 0;
    log({ where: '登入頁', action: '正確帳密登入', expected: '進入 dashboard', actual: loggedIn ? '成功進入' : '登入失敗', status: loggedIn ? 'PASS' : 'FAIL' });
    if (!loggedIn) { await page.screenshot({ path: `${SHOTS}/login-fail.png` }); throw new Error('login failed — abort'); }
  } else {
    log({ where: '登入頁', action: '檢查登入牆', expected: '未登入應見登入表單', actual: '無登入表單(直接入到?)', status: 'WARN' });
  }

  // ── 2. 逐頁掃描 ────────────────────────────────────────────────
  for (const [route, name] of ROUTES) {
    currentRoute = route;
    const errBefore = consoleErrors.length;
    const failBefore = failedRequests.length;
    const t0 = Date.now();
    try {
      await page.goto(`${BASE}/#${route}`);
      await waitLoaded(page);
    } catch (e) {
      log({ where: name, action: '開啟頁面', expected: '正常載入', actual: 'NAVIGATION ERROR: ' + String(e).slice(0, 100), status: 'FAIL' });
      continue;
    }
    const loadMs = Date.now() - t0;
    const text = await bodyText(page);
    const newErrs = consoleErrors.length - errBefore;
    const newFails = failedRequests.length - failBefore;
    const blank = text.length < 100;
    const snap = route.replace(/\//g, '_') || 'home';
    await page.screenshot({ path: `${SHOTS}/${snap}.png` });
    const status = blank ? 'FAIL' : (newErrs > 0 || newFails > 0) ? 'WARN' : 'PASS';
    log({
      where: name, action: `開啟 ${route}`, expected: '載入有內容,無 console error,無失敗 request',
      actual: `${loadMs}ms, 內容 ${text.length} 字, console errors +${newErrs}, 失敗 requests +${newFails}${blank ? ' [空白頁]' : ''}`,
      status,
    });
  }

  fs.writeFileSync('/tmp/qa-results.json', JSON.stringify({ results, consoleErrors, failedRequests }, null, 2));
  console.log('\n=== sweep done ===');
  console.log('console errors:', consoleErrors.length, '| failed requests:', failedRequests.length);
  await browser.close();
};

run().catch(e => { console.error('FATAL', e); fs.writeFileSync('/tmp/qa-results.json', JSON.stringify({ results, consoleErrors, failedRequests, fatal: String(e) }, null, 2)); process.exit(1); });
