"""
查詢→轉換 每日對數 — 零售 SleekFlow 查詢客 vs Shopify 購買紀錄。

流程:
1. inquiry_events(零售口徑、有電話)→ 每個電話一行:首次/最後查詢、
   查詢時認到嘅品牌/商品、係咪經廣告(CTWA)+ 邊啲 ad 帶入嚟(ctwa_ad_id)
   零售口徑 = 經零售 WhatsApp 線入嚟 或 business=retail。淨用 business 唔得:
   同事 triage 分隊會改寫 business(客問完貨問埋維修 → 轉 garage 隊),
   零售廣告帶入嚟嘅客會喺零售版面蒸發 — 實測 29 個 CTWA 電話蒸發咗 26 個。
2. 電話 → Shopify customer(GraphQL customers search,batch OR;需 read_customers)
   ⚠️ token 冇呢個 scope 嘅話呢步會跳過,保留舊 mapping — 唔會成個 job 死
3. customer 嘅訂單由 Supabase shopify_orders/lines 攞(每日已同步),計:
   查詢前 60 日內有冇單(售後)、查詢後首單、14 日內消費/到店(POS)、
   有冇買返查詢嗰個品牌/商品
4. classification:converted / aftersales / pending / no_purchase / unmatched
5. upsert inquiry_conversions(on contact_phone)

env: SHOPIFY_TOKEN, SHOPIFY_STORE(例 helmetking-0001.myshopify.com)
     SUPABASE_URL, SUPABASE_SERVICE_KEY
     CONVERT_WINDOW_DAYS(預設 14)
"""

import json
import os
import sys
from datetime import date, datetime, timedelta, timezone

import requests

SHOPIFY_TOKEN = os.environ.get("SHOPIFY_TOKEN", "")
SHOPIFY_STORE = os.environ.get("SHOPIFY_STORE", "")
SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
WINDOW = int(os.environ.get("CONVERT_WINDOW_DAYS", "14"))
PRIOR_DAYS = 60  # 查詢前幾多日內有單 = 售後查詢
API_VERSION = "2026-07"

# 零售 WhatsApp 線(entry 口徑)— 同 scripts/sleekflow_sync.py CHANNEL_BUSINESS 一致。
# IG/FB 冇電話,天然入唔到呢個 cohort,唔使列。
RETAIL_LINES = ("85263858830",)


def fail(msg: str) -> None:
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(1)


def sb_headers() -> dict:
    return {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
    }


def sb_get_all(table: str, params: dict) -> list:
    rows, offset = [], 0
    while True:
        r = requests.get(
            f"{SUPABASE_URL}/rest/v1/{table}",
            params={**params, "limit": "1000", "offset": str(offset)},
            headers=sb_headers(),
            timeout=60,
        )
        if r.status_code != 200:
            fail(f"Supabase GET {table} HTTP {r.status_code}: {r.text[:200]}")
        page = r.json()
        rows.extend(page)
        if len(page) < 1000:
            return rows
        offset += 1000


# ── 1. 查詢客(零售口徑 = 零售線入口 或 business=retail;有電話)──────────────
def has_column(table: str, col: str) -> bool:
    """DB 加咗新欄未(sql/inquiry-ctwa-ad-id.sql 要手動 apply)— 未加就退化。"""
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/{table}",
        params={"select": col, "limit": "1"},
        headers=sb_headers(),
        timeout=30,
    )
    return r.status_code == 200


def load_contacts(with_ad_id: bool) -> dict:
    select = "contact_phone,business,occurred_at,conversation_id,matched_brand,matched_product_id,source"
    if with_ad_id:
        select += ",ctwa_ad_id"
    rows = sb_get_all(
        "inquiry_events",
        {
            "select": select,
            "or": f"(business.eq.retail,channel_identity_id.in.({','.join(RETAIL_LINES)}))",
            "contact_phone": "not.is.null",
        },
    )
    contacts: dict = {}
    for r in rows:
        ph = str(r["contact_phone"]).strip()
        if not ph:
            continue
        c = contacts.setdefault(
            ph,
            {"first": None, "last": None, "convs": set(), "brands": set(), "pids": set(), "via_ad": False, "ad_ids": set()},
        )
        d = str(r["occurred_at"])[:10]
        c["first"] = d if c["first"] is None or d < c["first"] else c["first"]
        c["last"] = d if c["last"] is None or d > c["last"] else c["last"]
        if r.get("conversation_id"):
            c["convs"].add(str(r["conversation_id"]))
        if r.get("matched_brand"):
            c["brands"].add(str(r["matched_brand"]).upper())
        if r.get("matched_product_id"):
            c["pids"].add(str(r["matched_product_id"]))
        if r.get("source") == "ctwa" or r.get("ctwa_ad_id"):
            c["via_ad"] = True
        if r.get("ctwa_ad_id"):
            c["ad_ids"].add(str(r["ctwa_ad_id"]))
    print(f"零售查詢客(有電話):{len(contacts)}(當中經廣告 {sum(1 for c in contacts.values() if c['via_ad'])})")
    return contacts


# ── 2. 電話 → Shopify customer ──────────────────────────────────────────────
def resolve_customers(phones: list) -> dict:
    """回 {phone: {id, name, orders, spent}};冇 scope / 失敗 → 空 dict(唔炒 job)。"""
    if not (SHOPIFY_TOKEN and SHOPIFY_STORE):
        print("WARN: 冇 SHOPIFY_TOKEN/STORE — 跳過電話對 customer,沿用 DB 現有 mapping")
        return {}
    out: dict = {}
    gql = """query($q: String!) { customers(first: 50, query: $q) {
      edges { node { id phone displayName numberOfOrders amountSpent { amount } } } } }"""
    for i in range(0, len(phones), 15):
        batch = phones[i : i + 15]
        q = " OR ".join(f"phone:+{p}" for p in batch)
        r = requests.post(
            f"https://{SHOPIFY_STORE}/admin/api/{API_VERSION}/graphql.json",
            headers={"X-Shopify-Access-Token": SHOPIFY_TOKEN, "Content-Type": "application/json"},
            json={"query": gql, "variables": {"q": q}},
            timeout=60,
        )
        j = r.json() if r.status_code == 200 else {}
        if j.get("errors"):
            print(f"WARN: customers search 失敗(多數係 token 冇 read_customers scope):{str(j['errors'])[:200]}")
            return out
        for e in (j.get("data", {}).get("customers", {}) or {}).get("edges", []):
            n = e["node"]
            ph = str(n.get("phone") or "").lstrip("+")
            if not ph:
                continue
            out[ph] = {
                "id": int(str(n["id"]).rsplit("/", 1)[-1]),
                "name": n.get("displayName"),
                "orders": int(n.get("numberOfOrders") or 0),
                "spent": float((n.get("amountSpent") or {}).get("amount") or 0),
            }
    print(f"Shopify 對到 customer:{len(out)}")
    return out


def main() -> None:
    if not SUPABASE_URL or not SUPABASE_KEY:
        fail("SUPABASE_URL / SUPABASE_SERVICE_KEY 未設定")
    today = datetime.now(timezone.utc).date()

    ev_has_ad = has_column("inquiry_events", "ctwa_ad_id")
    conv_has_ad = has_column("inquiry_conversions", "ctwa_ad_ids")
    if not (ev_has_ad and conv_has_ad):
        print("WARN: ctwa ad id 欄未加齊(要 apply sql/inquiry-ctwa-ad-id.sql)— 廣告歸因暫時得 boolean")

    contacts = load_contacts(ev_has_ad)
    if not contacts:
        print("冇嘢做")
        return

    resolved = resolve_customers(sorted(contacts.keys()))

    # 沿用 DB 已有 mapping(resolve 失敗/唔齊時唔好倒退做 unmatched)
    existing = sb_get_all(
        "inquiry_conversions",
        {"select": "contact_phone,customer_id,customer_name,lifetime_orders,lifetime_spent"},
    )
    for e in existing:
        ph = str(e["contact_phone"])
        if ph not in resolved and e.get("customer_id"):
            resolved[ph] = {
                "id": int(e["customer_id"]),
                "name": e.get("customer_name"),
                "orders": int(e.get("lifetime_orders") or 0),
                "spent": float(e.get("lifetime_spent") or 0),
            }

    # ── 3. 訂單(Supabase,batch in.()) ─────────────────────────────────────
    cust_ids = sorted({v["id"] for v in resolved.values()})
    orders: list = []
    for i in range(0, len(cust_ids), 50):
        ids = ",".join(str(x) for x in cust_ids[i : i + 50])
        orders += sb_get_all(
            "shopify_orders",
            {
                "select": "id,customer_id,created_at,total_price,source_name,financial_status,cancelled_at",
                "customer_id": f"in.({ids})",
            },
        )
    orders = [
        o for o in orders
        if o.get("financial_status") != "refunded" and not o.get("cancelled_at")
    ]
    by_cust: dict = {}
    for o in orders:
        by_cust.setdefault(int(o["customer_id"]), []).append(o)
    print(f"訂單:{len(orders)} 張(覆蓋 {len(by_cust)} 個 customer)")

    # 查詢後訂單嘅 line vendors/product(對「買返查詢嗰件」)
    after_order_ids = []
    phone_first = {ph: c["first"] for ph, c in contacts.items()}
    for ph, cust in resolved.items():
        fi = phone_first.get(ph)
        if not fi:
            continue
        for o in by_cust.get(cust["id"], []):
            if str(o["created_at"])[:10] >= fi:
                after_order_ids.append(o["id"])
    lines: list = []
    for i in range(0, len(after_order_ids), 50):
        ids = ",".join(str(x) for x in after_order_ids[i : i + 50])
        lines += sb_get_all(
            "shopify_order_lines",
            {"select": "order_id,vendor,product_id", "order_id": f"in.({ids})"},
        )
    lines_by_order: dict = {}
    for l in lines:
        lines_by_order.setdefault(int(l["order_id"]), []).append(l)

    # ── 4. 計 + upsert ─────────────────────────────────────────────────────
    out_rows = []
    for ph, c in contacts.items():
        fi = date.fromisoformat(c["first"])
        cust = resolved.get(ph)
        row = {
            "contact_phone": ph,
            "business": "retail",
            "first_inquiry": c["first"],
            "last_inquiry": c["last"],
            "conversations": max(len(c["convs"]), 1),
            "inquired_brands": ",".join(sorted(c["brands"])) or None,
            "inquired_product_ids": ",".join(sorted(c["pids"])) or None,
            "via_ad": c["via_ad"],
            "customer_id": None,
            "customer_name": None,
            "lifetime_orders": None,
            "lifetime_spent": None,
            "prior_order_at": None,
            "first_order_after": None,
            "days_to_purchase": None,
            "bought_matched_brand": None,
            "after_spend_14d": 0,
            "after_orders_14d": 0,
            "after_pos_orders_14d": 0,
            "classification": "unmatched",
            "synced_at": datetime.now(timezone.utc).isoformat(),
        }
        if conv_has_ad:
            row["ctwa_ad_ids"] = ",".join(sorted(c["ad_ids"])) or None
        if cust:
            row.update(
                customer_id=cust["id"],
                customer_name=cust["name"],
                lifetime_orders=cust["orders"],
                lifetime_spent=cust["spent"],
            )
            olist = sorted(by_cust.get(cust["id"], []), key=lambda o: str(o["created_at"]))
            prior = [o for o in olist if fi - timedelta(days=PRIOR_DAYS) <= date.fromisoformat(str(o["created_at"])[:10]) < fi]
            after = [o for o in olist if date.fromisoformat(str(o["created_at"])[:10]) >= fi]
            if prior:
                row["prior_order_at"] = str(prior[-1]["created_at"])[:10]
            if after:
                first_after = date.fromisoformat(str(after[0]["created_at"])[:10])
                row["first_order_after"] = first_after.isoformat()
                row["days_to_purchase"] = (first_after - fi).days
                win = [o for o in after if (date.fromisoformat(str(o["created_at"])[:10]) - fi).days <= WINDOW]
                row["after_spend_14d"] = round(sum(float(o["total_price"] or 0) for o in win), 2)
                row["after_orders_14d"] = len(win)
                row["after_pos_orders_14d"] = sum(1 for o in win if str(o.get("source_name")) == "pos")
                matched = False
                for o in after:
                    for l in lines_by_order.get(int(o["id"]), []):
                        if (l.get("vendor") and str(l["vendor"]).upper() in c["brands"]) or (
                            l.get("product_id") and str(l["product_id"]) in c["pids"]
                        ):
                            matched = True
                row["bought_matched_brand"] = matched

            if row["days_to_purchase"] is not None and row["days_to_purchase"] <= WINDOW:
                row["classification"] = "converted"
            elif prior:
                row["classification"] = "aftersales"
            elif (today - fi).days <= WINDOW:
                row["classification"] = "pending"
            else:
                row["classification"] = "no_purchase"
        else:
            # 對唔到 customer;查詢仲喺窗口內就當 pending(可能遲啲先開戶買嘢)
            if (today - fi).days <= WINDOW:
                row["classification"] = "pending"
        out_rows.append(row)

    for i in range(0, len(out_rows), 200):
        r = requests.post(
            f"{SUPABASE_URL}/rest/v1/inquiry_conversions",
            params={"on_conflict": "contact_phone"},
            headers={**sb_headers(), "Prefer": "resolution=merge-duplicates,return=minimal"},
            data=json.dumps(out_rows[i : i + 200]),
            timeout=120,
        )
        if r.status_code not in (200, 201):
            fail(f"upsert HTTP {r.status_code}: {r.text[:300]}")

    # 清 stale:口徑變咗之後唔再屬零售 cohort 嘅電話,upsert 唔會再掂佢哋,
    # 舊行嘅 via_ad/分類會永遠僵喺度 — 直接剷,聽晚要返嚟自然會重新入返
    stale = sorted({str(e["contact_phone"]) for e in existing} - set(contacts.keys()))
    for i in range(0, len(stale), 40):
        requests.delete(
            f"{SUPABASE_URL}/rest/v1/inquiry_conversions",
            params={"contact_phone": f"in.({','.join(stale[i : i + 40])})"},
            headers=sb_headers(),
            timeout=60,
        )
    if stale:
        print(f"清走 {len(stale)} 行唔再屬零售口徑嘅舊行")

    from collections import Counter
    print("classification:", dict(Counter(r["classification"] for r in out_rows)))
    print(f"upsert OK({len(out_rows)} 行)")


if __name__ == "__main__":
    main()
