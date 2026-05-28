#!/usr/bin/env python3
"""
Daily inventory snapshot — 補回 n8n 沒有處理的庫存同步。

支援兩個來源（皆為可選，憑環境變數開啟）：
  1. Shopify products + variants  -> shopify_inventory  (price, compare_at_price, qty)
  2. BC Items                     -> bc_inventory       (unit_price, unit_cost)

每天透過 GitHub Actions 排程執行；可獨立跑其一。

環境變數：
  SHOPIFY_TOKEN, SHOPIFY_STORE
  BC_TENANT_ID, BC_CLIENT_ID, BC_CLIENT_SECRET, BC_ENVIRONMENT, BC_COMPANY_ID
  SUPABASE_URL, SUPABASE_SERVICE_KEY
  SYNC_SHOPIFY=1 / SYNC_BC=1 / SYNC_BC_PURCHASE_INVOICES=1  (預設都開，缺認證會自動跳過)
  BC_PI_FULL_BACKFILL=1  (購貨單忽略 lastModifiedDateTime filter，做完整 backfill)
  BC_PI_LOOKBACK_DAYS=7  (增量同步回溯日數，預設 7)
"""
import os, sys, time, json
from datetime import datetime, timezone, timedelta

try:
    import requests
except ImportError:
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "--quiet", "requests"])
    import requests

SB_URL = os.environ["SUPABASE_URL"].rstrip("/")
SB_KEY = os.environ["SUPABASE_SERVICE_KEY"]
SB_UPSERT_H = {
    "apikey": SB_KEY,
    "Authorization": f"Bearer {SB_KEY}",
    "Content-Type": "application/json",
    "Prefer": "resolution=merge-duplicates,return=minimal",
}
SB_GET_H = {"apikey": SB_KEY, "Authorization": f"Bearer {SB_KEY}"}

today_iso = datetime.now(timezone.utc).strftime("%Y-%m-%d")


def s(v, n):
    return str(v)[:n] if v is not None else None


def upsert_batch(table: str, conflict_col: str, rows: list, batch_size: int = 500):
    if not rows:
        return 0, 0
    ok = err = 0
    endpoint = f"{SB_URL}/rest/v1/{table}?on_conflict={conflict_col}"
    for i in range(0, len(rows), batch_size):
        batch = rows[i : i + batch_size]
        r = requests.post(endpoint, headers=SB_UPSERT_H, json=batch, timeout=120)
        if r.status_code in (200, 201, 204):
            ok += len(batch)
        else:
            print(f"  Batch ERR {r.status_code}: {r.text[:300]}", flush=True)
            for row in batch:
                rr = requests.post(endpoint, headers=SB_UPSERT_H, json=row, timeout=30)
                if rr.status_code in (200, 201, 204):
                    ok += 1
                else:
                    err += 1
                    if err <= 5:
                        print(f"     row keys={list(row.keys())[:5]}: {rr.status_code} {rr.text[:200]}", flush=True)
    return ok, err


# ---------------------------------------------------------------- Shopify
def sync_shopify_inventory():
    token = os.environ.get("SHOPIFY_TOKEN")
    store = os.environ.get("SHOPIFY_STORE")
    if not token or not store:
        print("[Shopify] skipped — no token/store", flush=True)
        return
    print("=== Shopify inventory snapshot ===", flush=True)
    h = {"X-Shopify-Access-Token": token}

    # 1. Get all products (with variants embedded). Paginated 250/page.
    products = []
    url = f"https://{store}/admin/api/2026-01/products.json?limit=250"
    page = 0
    while url:
        page += 1
        r = requests.get(url, headers=h, timeout=60)
        r.raise_for_status()
        data = r.json()
        products.extend(data.get("products", []))
        url = None
        link = r.headers.get("Link", "")
        if 'rel="next"' in link:
            for part in link.split(","):
                if 'rel="next"' in part:
                    url = part.split("<")[1].split(">")[0]
        time.sleep(0.4)
    print(f"[Shopify] fetched {len(products)} products across {page} pages", flush=True)

    # 2. Build variant list — use variant.inventory_quantity directly (no extra API call)
    variants = []
    for p in products:
        for v in p.get("variants", []) or []:
            variants.append((p, v))
    print(f"[Shopify] {len(variants)} variants", flush=True)

    # 3. Upsert shopify_products and shopify_inventory
    print("[Shopify] upserting shopify_products...", flush=True)
    prod_rows = [{
        "id": p["id"],
        "title": s(p.get("title"), 500),
        "handle": s(p.get("handle"), 255),
        "product_type": s(p.get("product_type"), 255),
        "vendor": s(p.get("vendor"), 255),
        "status": s(p.get("status"), 50),
        "tags": p.get("tags"),
        "created_at": p.get("created_at"),
        "updated_at": p.get("updated_at"),
        "published_at": p.get("published_at"),
        "variants_count": len(p.get("variants") or []),
        "synced_at": datetime.now(timezone.utc).isoformat(),
    } for p in products]
    ok, err = upsert_batch("shopify_products", "id", prod_rows)
    print(f"[Shopify] products: {ok} ok, {err} err", flush=True)

    print("[Shopify] upserting shopify_inventory...", flush=True)
    inv_rows = []
    for p, v in variants:
        qty = v.get("inventory_quantity") or 0
        inv_rows.append({
            "id": v["id"],  # variant_id as primary key
            "product_id": p["id"],
            "variant_id": v["id"],
            "product_title": s(p.get("title"), 500),
            "variant_title": s(v.get("title"), 500),
            "sku": s(v.get("sku"), 99),
            "price": float(v.get("price") or 0),
            "compare_at_price": float(v.get("compare_at_price") or 0) if v.get("compare_at_price") else None,
            "inventory_quantity": qty,
            "vendor": s(p.get("vendor"), 255),
            "product_type": s(p.get("product_type"), 255),
            "snapshot_date": today_iso,
            "synced_at": datetime.now(timezone.utc).isoformat(),
        })
    ok, err = upsert_batch("shopify_inventory", "variant_id", inv_rows)
    print(f"[Shopify] inventory: {ok} ok, {err} err", flush=True)


# ---------------------------------------------------------------- BC
def sync_bc_inventory():
    # GitHub Secrets 可能附帶 \n / 空格，統一 strip
    tenant = (os.environ.get("BC_TENANT_ID") or "").strip()
    client_id = (os.environ.get("BC_CLIENT_ID") or "").strip()
    secret = (os.environ.get("BC_CLIENT_SECRET") or "").strip()
    env = (os.environ.get("BC_ENVIRONMENT") or "Production").strip()
    company = (os.environ.get("BC_COMPANY_ID") or "").strip()
    if not all([tenant, client_id, secret, company]):
        print("[BC] skipped — missing BC_TENANT_ID/BC_CLIENT_ID/BC_CLIENT_SECRET/BC_COMPANY_ID", flush=True)
        return
    print("=== BC inventory snapshot ===", flush=True)
    print(f"[BC] tenant={tenant[:8]}… client_id={client_id[:8]}… company={company[:8]}… env={env} secret_len={len(secret)}", flush=True)

    # 1. OAuth token
    tok = requests.post(
        f"https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token",
        data={
            "grant_type": "client_credentials",
            "client_id": client_id,
            "client_secret": secret,
            "scope": "https://api.businesscentral.dynamics.com/.default",
        },
        timeout=30,
    )
    if tok.status_code != 200:
        # 列出 AAD 返回的 error_description 方便 debug
        print(f"[BC] token request failed [{tok.status_code}]: {tok.text[:600]}", flush=True)
        tok.raise_for_status()
    access = tok.json()["access_token"]
    print("[BC] got access token", flush=True)

    # 2. Fetch all items, paginated
    # 重要：BC API 帶 $top 會關掉 server-side pagination（不會回 @odata.nextLink）
    # 不指定 $top 才會以 20,000 為一頁以 skiptoken 分頁
    base = f"https://api.businesscentral.dynamics.com/v2.0/{tenant}/{env}/api/v2.0/companies({company})/items"
    auth_h = {"Authorization": f"Bearer {access}"}
    items = []
    url = base
    page = 0
    while url:
        r = requests.get(url, headers=auth_h, timeout=180)
        r.raise_for_status()
        data = r.json()
        batch = data.get("value", [])
        items.extend(batch)
        page += 1
        print(f"[BC] page {page}: +{len(batch)} (running total {len(items)})", flush=True)
        url = data.get("@odata.nextLink")
    print(f"[BC] fetched {len(items)} items total", flush=True)

    # 3. Map to bc_inventory rows
    rows = []
    now_iso = datetime.now(timezone.utc).isoformat()
    for it in items:
        rows.append({
            "id": it.get("id"),
            "number": s(it.get("number"), 99),
            "display_name": s(it.get("displayName"), 500),
            "item_category_code": s(it.get("itemCategoryCode") or it.get("itemCategoryId"), 99),
            "unit_price": float(it.get("unitPrice") or 0),
            "unit_cost": float(it.get("unitCost") or 0),
            "inventory": float(it.get("inventory") or 0),
            "base_unit_of_measure": s(it.get("baseUnitOfMeasureCode") or it.get("baseUnitOfMeasure"), 50),
            "vendor_number": s(it.get("vendorNumber"), 99),
            "type": s(it.get("type"), 50),
            "blocked": bool(it.get("blocked")) if it.get("blocked") is not None else False,
            "snapshot_date": today_iso,
            "last_modified": it.get("lastModifiedDateTime"),
            "updated_at": now_iso,
        })
    ok, err = upsert_batch("bc_inventory", "id", rows)
    print(f"[BC] inventory: {ok} ok, {err} err", flush=True)


# ---------------------------------------------------------------- BC Purchase Invoices
def sync_bc_purchase_invoices():
    """同步 BC 採購發票（含 lines）到 bc_purchase_invoices / bc_purchase_invoice_lines。

    預設 incremental：只抓 lastModifiedDateTime ≥ today - BC_PI_LOOKBACK_DAYS（預設 7 日）
    BC_PI_FULL_BACKFILL=1 → 抓全部（首次或修補用）
    與 sales 同步不同，這裡 *不* 過濾 dimension（CARSHOP/TRAVEL AGENCY 用量極少）。
    """
    tenant = (os.environ.get("BC_TENANT_ID") or "").strip()
    client_id = (os.environ.get("BC_CLIENT_ID") or "").strip()
    secret = (os.environ.get("BC_CLIENT_SECRET") or "").strip()
    env = (os.environ.get("BC_ENVIRONMENT") or "Production").strip()
    company = (os.environ.get("BC_COMPANY_ID") or "").strip()
    if not all([tenant, client_id, secret, company]):
        print("[BC-PI] skipped — missing BC_TENANT_ID/BC_CLIENT_ID/BC_CLIENT_SECRET/BC_COMPANY_ID", flush=True)
        return
    print("=== BC purchase invoices sync ===", flush=True)

    full_backfill = os.environ.get("BC_PI_FULL_BACKFILL", "0") == "1"
    lookback_days = int(os.environ.get("BC_PI_LOOKBACK_DAYS", "7") or "7")
    if full_backfill:
        since = None
        print(f"[BC-PI] mode=FULL_BACKFILL (no $filter)", flush=True)
    else:
        since_dt = datetime.now(timezone.utc) - timedelta(days=lookback_days)
        since = since_dt.strftime("%Y-%m-%dT00:00:00Z")
        print(f"[BC-PI] mode=incremental since={since} (lookback={lookback_days}d)", flush=True)

    # 1. OAuth token (same pattern as sync_bc_inventory)
    tok = requests.post(
        f"https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token",
        data={
            "grant_type": "client_credentials",
            "client_id": client_id,
            "client_secret": secret,
            "scope": "https://api.businesscentral.dynamics.com/.default",
        },
        timeout=30,
    )
    if tok.status_code != 200:
        print(f"[BC-PI] token request failed [{tok.status_code}]: {tok.text[:600]}", flush=True)
        tok.raise_for_status()
    access = tok.json()["access_token"]
    print("[BC-PI] got access token", flush=True)

    # 2. Fetch purchase invoices with expanded lines, paginated via @odata.nextLink
    base = f"https://api.businesscentral.dynamics.com/v2.0/{tenant}/{env}/api/v2.0/companies({company})/purchaseInvoices"
    params = ["$expand=purchaseInvoiceLines"]
    if since:
        # OData $filter 需要 URL-encode 空格為 %20；requests 會在 url 直接 GET 時自動處理，這裡用 + 拼字串就 OK
        params.append(f"$filter=lastModifiedDateTime ge {since}")
    url = base + "?" + "&".join(params)
    auth_h = {"Authorization": f"Bearer {access}"}

    invoices = []
    page = 0
    while url:
        r = requests.get(url, headers=auth_h, timeout=180)
        if r.status_code != 200:
            print(f"[BC-PI] fetch failed [{r.status_code}]: {r.text[:500]}", flush=True)
            r.raise_for_status()
        data = r.json()
        batch = data.get("value", [])
        invoices.extend(batch)
        page += 1
        print(f"[BC-PI] page {page}: +{len(batch)} (running total {len(invoices)})", flush=True)
        url = data.get("@odata.nextLink")
    print(f"[BC-PI] fetched {len(invoices)} purchase invoices total", flush=True)

    # 3. Map invoices + lines
    now_iso = datetime.now(timezone.utc).isoformat()
    inv_rows = []
    line_rows = []
    for inv in invoices:
        inv_id = inv.get("id")
        inv_number = inv.get("number")
        inv_rows.append({
            "id": inv_id,
            "number": s(inv_number, 99),
            "posting_date": inv.get("postingDate") or None,
            "invoice_date": inv.get("invoiceDate") or None,
            "due_date": inv.get("dueDate") or None,
            "vendor_number": s(inv.get("vendorNumber"), 99),
            "vendor_name": s(inv.get("vendorName"), 500),
            "vendor_invoice_number": s(inv.get("vendorInvoiceNumber"), 99),
            "status": s(inv.get("status"), 50),
            "total_amount_excl_tax": float(inv.get("totalAmountExcludingTax") or 0),
            "total_amount_incl_tax": float(inv.get("totalAmountIncludingTax") or 0),
            "currency_code": s(inv.get("currencyCode"), 10),
            "dimension1_code": s(inv.get("shortcutDimension1Code"), 50),
            "dimension2_code": s(inv.get("shortcutDimension2Code"), 50),
            "purchaser": s(inv.get("purchaser"), 99),
            "last_modified_datetime": inv.get("lastModifiedDateTime"),
            "updated_at": now_iso,
        })
        for ln in (inv.get("purchaseInvoiceLines") or []):
            line_rows.append({
                "id": ln.get("id"),
                "invoice_id": ln.get("documentId") or inv_id,
                "invoice_number": s(inv_number, 99),
                "sequence": ln.get("sequence"),
                "item_number": s(ln.get("lineObjectNumber"), 99),
                "description": s(ln.get("description"), 500),
                "unit_of_measure": s(ln.get("unitOfMeasureCode"), 50),
                "quantity": float(ln.get("quantity") or 0),
                "unit_cost": float(ln.get("unitCost") or 0),
                "discount_percent": float(ln.get("discountPercent") or 0),
                "amount_excl_tax": float(ln.get("amountExcludingTax") or 0),
                "amount_incl_tax": float(ln.get("amountIncludingTax") or 0),
                "expected_receipt_date": ln.get("expectedReceiptDate") or None,
            })

    print(f"[BC-PI] upserting {len(inv_rows)} invoices + {len(line_rows)} lines", flush=True)
    ok, err = upsert_batch("bc_purchase_invoices", "id", inv_rows)
    print(f"[BC-PI] invoices: {ok} ok, {err} err", flush=True)
    ok, err = upsert_batch("bc_purchase_invoice_lines", "id", line_rows)
    print(f"[BC-PI] lines: {ok} ok, {err} err", flush=True)


def verify():
    print("\n=== Verification ===", flush=True)
    for t, col in [
        ("shopify_inventory", "synced_at"),
        ("bc_inventory", "updated_at"),
        ("bc_purchase_invoices", "updated_at"),
        ("bc_purchase_invoice_lines", "created_at"),
    ]:
        r = requests.get(
            f"{SB_URL}/rest/v1/{t}?select={col}&order={col}.desc&limit=1",
            headers=SB_GET_H, timeout=30,
        )
        rows = r.json() if r.ok else []
        print(f"  {t}: latest {col} = {rows[0][col] if rows else 'N/A'}", flush=True)
        # row count
        r2 = requests.get(f"{SB_URL}/rest/v1/{t}?select=id&limit=1",
                          headers={**SB_GET_H, "Prefer": "count=exact", "Range": "0-0"}, timeout=30)
        cr = r2.headers.get("content-range", "").split("/")[-1]
        print(f"  {t}: total rows = {cr}", flush=True)


def main():
    if os.environ.get("SYNC_SHOPIFY", "1") != "0":
        try:
            sync_shopify_inventory()
        except Exception as e:
            print(f"[Shopify] ERROR: {e}", flush=True)
    if os.environ.get("SYNC_BC", "1") != "0":
        try:
            sync_bc_inventory()
        except Exception as e:
            print(f"[BC] ERROR: {e}", flush=True)
    if os.environ.get("SYNC_BC_PURCHASE_INVOICES", "1") != "0":
        try:
            sync_bc_purchase_invoices()
        except Exception as e:
            print(f"[BC-PI] ERROR: {e}", flush=True)
    verify()
    print("\nDone.", flush=True)


if __name__ == "__main__":
    main()
