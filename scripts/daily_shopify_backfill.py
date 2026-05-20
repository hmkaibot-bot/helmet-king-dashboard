#!/usr/bin/env python3
"""
Daily Shopify backfill — 備援 n8n workflow

每天透過 GitHub Actions 自動執行，從 Shopify 抓取最近 7 天的所有訂單
與 line items，upsert 到 Supabase。即使 n8n 失敗也能保證資料完整。

使用環境變數：
  - SHOPIFY_TOKEN
  - SHOPIFY_STORE
  - SUPABASE_URL
  - SUPABASE_SERVICE_KEY
"""
import os, sys, time, json
from datetime import datetime, timezone, timedelta

try:
    import requests
except ImportError:
    print("Installing requests...")
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "--quiet", "requests"])
    import requests


SHOPIFY_TOKEN = os.environ["SHOPIFY_TOKEN"]
SHOPIFY_STORE = os.environ["SHOPIFY_STORE"]
SB_URL = os.environ["SUPABASE_URL"].rstrip("/")
SB_KEY = os.environ["SUPABASE_SERVICE_KEY"]

SB_UPSERT_H = {
    "apikey": SB_KEY,
    "Authorization": f"Bearer {SB_KEY}",
    "Content-Type": "application/json",
    "Prefer": "resolution=merge-duplicates,return=minimal",
}
SB_GET_H = {"apikey": SB_KEY, "Authorization": f"Bearer {SB_KEY}"}


def s(v, n):
    return str(v)[:n] if v is not None else None


def fetch_shopify_orders(since_iso: str, until_iso: str):
    """Paginate through Shopify orders endpoint."""
    orders = []
    url = (
        f"https://{SHOPIFY_STORE}/admin/api/2026-01/orders.json"
        f"?status=any&created_at_min={since_iso}&created_at_max={until_iso}&limit=250"
    )
    while url:
        r = requests.get(url, headers={"X-Shopify-Access-Token": SHOPIFY_TOKEN}, timeout=60)
        r.raise_for_status()
        data = r.json()
        orders.extend(data.get("orders", []))
        url = None
        link = r.headers.get("Link", "")
        if 'rel="next"' in link:
            for part in link.split(","):
                if 'rel="next"' in part:
                    url = part.split("<")[1].split(">")[0]
        time.sleep(0.4)
    return orders


def upsert_batch(table: str, rows: list, batch_size: int = 100):
    if not rows:
        return 0, 0
    ok = err = 0
    endpoint = f"{SB_URL}/rest/v1/{table}?on_conflict=id"
    for i in range(0, len(rows), batch_size):
        batch = rows[i : i + batch_size]
        r = requests.post(endpoint, headers=SB_UPSERT_H, json=batch, timeout=60)
        if r.status_code in (200, 201, 204):
            ok += len(batch)
        else:
            print(f"  Batch ERR {r.status_code}: {r.text[:300]}", flush=True)
            # Fall back to row-by-row to recover what we can
            for row in batch:
                rr = requests.post(endpoint, headers=SB_UPSERT_H, json=row, timeout=30)
                if rr.status_code in (200, 201, 204):
                    ok += 1
                else:
                    err += 1
                    if err <= 5:
                        print(f"     row {row.get('id')}: {rr.status_code} {rr.text[:200]}", flush=True)
    return ok, err


def main():
    days_back = int(os.environ.get("DAYS_BACK", "7"))
    until = datetime.now(timezone.utc)
    since = until - timedelta(days=days_back)
    since_iso = since.strftime("%Y-%m-%dT%H:%M:%SZ")
    until_iso = until.strftime("%Y-%m-%dT%H:%M:%SZ")

    print(f"=== Shopify daily backfill (last {days_back} days) ===", flush=True)
    print(f"Range UTC: {since_iso} -> {until_iso}", flush=True)

    orders = fetch_shopify_orders(since_iso, until_iso)
    total_lines = sum(len(o.get("line_items") or []) for o in orders)
    print(f"Fetched {len(orders)} orders, {total_lines} line items from Shopify", flush=True)

    if not orders:
        print("No orders fetched. Done.", flush=True)
        return

    # Build a product_id -> product_type map by pulling shopify_products from
    # Supabase. Shopify Orders API does NOT return product_type on line items;
    # dashboard needs it, so we backfill here.
    print("\n=== Fetching product_type map from Supabase ===", flush=True)
    product_type_map = {}
    pt_url = f"{SB_URL}/rest/v1/shopify_products?select=id,product_type"
    pt_offset = 0
    while True:
        r = requests.get(
            pt_url + f"&limit=1000&offset={pt_offset}",
            headers={**SB_GET_H, "Range-Unit": "items", "Range": f"{pt_offset}-{pt_offset+999}"},
            timeout=60,
        )
        if not r.ok:
            print(f"  Product fetch ERR {r.status_code}: {r.text[:200]}", flush=True)
            break
        batch = r.json()
        if not batch:
            break
        for p in batch:
            if p.get("id") is not None and p.get("product_type"):
                product_type_map[str(p["id"])] = p["product_type"]
        if len(batch) < 1000:
            break
        pt_offset += 1000
    print(f"Loaded {len(product_type_map)} product_type entries", flush=True)

    # Build order rows
    order_rows = []
    for o in orders:
        c = o.get("customer") or {}
        order_rows.append({
            "id": o["id"],
            "order_number": s(o.get("order_number"), 49),
            "name": s(o.get("name"), 49),
            "created_at": o.get("created_at"),
            "updated_at": o.get("updated_at"),
            "financial_status": s(o.get("financial_status"), 49),
            "fulfillment_status": s(o.get("fulfillment_status"), 49),
            "currency": s(o.get("currency") or "HKD", 9),
            "subtotal_price": float(o.get("subtotal_price") or 0),
            "total_discounts": float(o.get("total_discounts") or 0),
            "total_tax": float(o.get("total_tax") or 0),
            "total_price": float(o.get("total_price") or 0),
            "customer_id": c.get("id"),
            "user_id": o.get("user_id"),
            "customer_email": s(c.get("email"), 254),
            "customer_name": s(((c.get("first_name") or "") + " " + (c.get("last_name") or "")).strip(), 254),
            "tags": o.get("tags"),
            "source_name": s(o.get("source_name"), 99),
            "cancel_reason": s(o.get("cancel_reason"), 99),
            "cancelled_at": o.get("cancelled_at"),
            "gateway": s(o.get("gateway"), 99),
            "discount_codes": json.dumps(o.get("discount_codes")) if o.get("discount_codes") else None,
        })

    print("\n=== Upserting orders ===", flush=True)
    ok, err = upsert_batch("shopify_orders", order_rows, batch_size=50)
    print(f"Orders: {ok} ok, {err} err", flush=True)

    # Build line rows
    line_rows = []
    for o in orders:
        for li in o.get("line_items") or []:
            line_rows.append({
                "id": li["id"],
                "order_id": o["id"],
                "product_id": li.get("product_id"),
                "variant_id": li.get("variant_id"),
                "title": s(li.get("title"), 255),
                "variant_title": s(li.get("variant_title"), 255),
                "sku": s(li.get("sku"), 99),
                "quantity": li.get("quantity") or 0,
                "price": float(li.get("price") or 0),
                "total_discount": float(li.get("total_discount") or 0),
                "line_total": float(li.get("price") or 0) * (li.get("quantity") or 0),
                "vendor": s(li.get("vendor"), 255),
                "product_type": s(product_type_map.get(str(li.get("product_id") or "")), 255),
                "requires_shipping": li.get("requires_shipping") is not False,
                "fulfillment_status": li.get("fulfillment_status"),
            })

    print("\n=== Upserting lines ===", flush=True)
    ok, err = upsert_batch("shopify_order_lines", line_rows, batch_size=100)
    print(f"Lines: {ok} ok, {err} err", flush=True)

    # Verification (last 5 days)
    print("\n=== Verification (last 5 days HKT) ===", flush=True)
    import urllib.parse
    now_hkt = datetime.now(timezone(timedelta(hours=8)))
    for delta in range(5, -1, -1):
        d = (now_hkt - timedelta(days=delta)).strftime("%Y-%m-%d")
        s_ = urllib.parse.quote(f"{d}T00:00:00+08:00")
        e_ = urllib.parse.quote(f"{d}T23:59:59+08:00")
        r = requests.get(
            f"{SB_URL}/rest/v1/shopify_orders?created_at=gte.{s_}&created_at=lte.{e_}&select=id",
            headers=SB_GET_H, timeout=30,
        )
        ids = [x["id"] for x in r.json()] if r.ok else []
        if ids:
            idstr = ",".join(str(i) for i in ids)
            r2 = requests.get(
                f"{SB_URL}/rest/v1/shopify_order_lines?order_id=in.({idstr})&select=id",
                headers=SB_GET_H, timeout=30,
            )
            lc = len(r2.json()) if r2.ok else 0
        else:
            lc = 0
        print(f"  {d}: orders={len(ids)}, lines={lc}", flush=True)

    print("\nDone.", flush=True)


if __name__ == "__main__":
    main()
