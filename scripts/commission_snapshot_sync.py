#!/usr/bin/env python3
"""
零售佣金快照 — 每晚自動計,寫入 Supabase retail_commission_snapshot。

點解有呢個 job:dashboard 個 Vercel API 冇 read_reports scope,live 模式計唔到;
但 GH Actions 個 SHOPIFY_TOKEN 有(2026-08-12 已驗證),所以喺度用 ShopifyQL
每晚照住 api/retail-commission.ts 一模一樣嘅規則計好,俾頁面 fallback 讀。

規則(同 api/retail-commission.ts 完全一致,改嗰邊記得改埋呢邊):
  ① 門市月結 net_sales ≥ $1,400,000 → 每位全職 +$1,000
  ② 代理品牌(9 隻)當月 net 分級:<100k→1% / 100k–<130k→1.5% / ≥130k→2%
  ③ 非代理品牌當月 net ≥ $200,000 → 全額 × 0.5%
  ④ 平均件數(扣 DRINK/beverages/膠袋;4捨5入 1 位)≥2.6→$1,100 / ≥2.2→$900 / ≥1.8→$700
  ⑤ 全職:Kenny/Dicky/Zoe/Bean;VAVA 2026-08 起
  ⑥ 有 assisting 歸 assisting,冇就歸 primary;非全職剔走

計邊啲月:當月(1 號至今日)+ 如果今日 ≤ 5 號連埋上個月(等月尾遲入嘅單執返正)。

env: SHOPIFY_TOKEN, SHOPIFY_STORE, SUPABASE_URL, SUPABASE_SERVICE_KEY
"""

import os
import sys
import json
import datetime
import requests

SHOPIFY_TOKEN = os.environ["SHOPIFY_TOKEN"]
SHOPIFY_STORE = os.environ["SHOPIFY_STORE"]
SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_KEY"]
API_VERSION = "2026-07"

POS_LOCATION = "Helmet King Shop"
STORE_TARGET = 1_400_000
STORE_BONUS = 1_000
NONAGENT_TARGET = 200_000
NONAGENT_RATE = 0.005
EXCLUDE_TITLES = ["DRINK", "beverages", "Enhanced Plastic Shopping Bag Charging Scheme"]
AGENT_VENDORS = [
    "SCORPION", "FETURE", "MODER", "JOHN DOE", "PANDO",
    "ROUGH AND ROAD", "ELEVEIT", "FURYGAN", "HELSTONS",
]
FULLTIME = {  # Shopify staff 全名 → code(from = 入職生效月)
    "Kenny Chu": {"code": "KENNY"},
    "Dicky Leung": {"code": "DICKY"},
    "Zoe Lau": {"code": "ZOE"},
    "Bean Tang": {"code": "BEAN"},
    "VAVA Yeung": {"code": "VAVA", "from": "2026-08"},
}


def hkt_today() -> datetime.date:
    return (datetime.datetime.utcnow() + datetime.timedelta(hours=8)).date()


def roster_for_month(month: str) -> dict:
    return {name: v["code"] for name, v in FULLTIME.items() if not v.get("from") or v["from"] <= month}


def agent_tier_rate(total: float) -> float:
    if total < 100_000:
        return 0.01
    if total < 130_000:
        return 0.015
    return 0.02


def avg_items_bonus(avg: float) -> int:
    if avg >= 2.6:
        return 1100
    if avg >= 2.2:
        return 900
    if avg >= 1.8:
        return 700
    return 0


def run_ql(ql: str):
    """ShopifyQL → list[dict](MCP 式 row objects)。"""
    r = requests.post(
        f"https://{SHOPIFY_STORE}/admin/api/{API_VERSION}/graphql.json",
        headers={"Content-Type": "application/json", "X-Shopify-Access-Token": SHOPIFY_TOKEN},
        json={"query": "query($q:String!){ shopifyqlQuery(query:$q){ parseErrors tableData { columns { name } rows } } }",
              "variables": {"q": ql}},
        timeout=60,
    )
    r.raise_for_status()
    j = r.json()
    if j.get("errors"):
        raise RuntimeError(f"ShopifyQL 失敗: {json.dumps(j['errors'])[:300]}")
    resp = j["data"]["shopifyqlQuery"]
    if resp.get("parseErrors"):
        raise RuntimeError(f"parse error: {resp['parseErrors']}")
    td = resp.get("tableData") or {}
    cols = [c["name"] for c in td.get("columns") or []]
    out = []
    for row in td.get("rows") or []:
        if isinstance(row, dict):
            out.append(row)
        else:
            out.append({cols[i]: row[i] for i in range(len(cols))})
    return out


def f(v) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def effective_code(primary, assisting, roster: dict):
    eff = (assisting or "").strip() or (primary or "").strip()
    return roster.get(eff)


def compute_month(month: str):
    y, m = map(int, month.split("-"))
    start = f"{month}-01"
    today = hkt_today()
    is_current = month == today.strftime("%Y-%m")
    if is_current:
        until = "today"
    else:
        last = (datetime.date(y + (m // 12), (m % 12) + 1, 1) - datetime.timedelta(days=1)).day
        until = f"{month}-{last:02d}"
    where_pos = f"WHERE pos_location_name = '{POS_LOCATION}'"
    period = f"SINCE {start} UNTIL {until}"
    agent_or = " OR ".join(f"product_vendor = '{v}'" for v in AGENT_VENDORS)
    exclude = " ".join(f"AND product_title != '{t}'" for t in EXCLUDE_TITLES)

    store_rows = run_ql(f"FROM sales SHOW net_sales {where_pos} {period}")
    store_total = sum(f(r.get("net_sales")) for r in store_rows)
    store_hit = store_total >= STORE_TARGET

    grp = "GROUP BY staff_member_name, assisting_staff_member_name"
    q_agent = run_ql(f"FROM sales SHOW net_sales {grp} {where_pos} AND ({agent_or}) {period}")
    q_all = run_ql(f"FROM sales SHOW net_sales {grp} {where_pos} {period}")
    q_orders = run_ql(f"FROM sales SHOW orders {grp} {where_pos} {period}")
    q_items = run_ql(f"FROM sales SHOW net_items_sold {grp} {where_pos} {exclude} {period}")

    roster = roster_for_month(month)
    agg = {code: {"agent": 0.0, "all": 0.0, "orders": 0, "items": 0} for code in roster.values()}

    def add(rows, field, key, as_int=False):
        for r in rows:
            code = effective_code(r.get("staff_member_name"), r.get("assisting_staff_member_name"), roster)
            if not code:
                continue
            v = f(r.get(field))
            agg[code][key] += int(v) if as_int else v

    add(q_agent, "net_sales", "agent")
    add(q_all, "net_sales", "all")
    add(q_orders, "orders", "orders", as_int=True)
    add(q_items, "net_items_sold", "items", as_int=True)

    rows = []
    for code, a in agg.items():
        agent_total = a["agent"]
        nonagent_total = a["all"] - a["agent"]
        rate = agent_tier_rate(agent_total)
        agent_comm = agent_total * rate
        nonagent_hit = nonagent_total >= NONAGENT_TARGET
        nonagent_comm = nonagent_total * NONAGENT_RATE if nonagent_hit else 0.0
        avg_items = round(a["items"] / a["orders"] * 10) / 10 if a["orders"] > 0 else 0.0
        avg_bonus = avg_items_bonus(avg_items)
        target_bonus = STORE_BONUS if store_hit else 0
        total = agent_comm + nonagent_comm + avg_bonus + target_bonus
        rows.append({
            "month": month, "code": code,
            "agent_total": round(agent_total, 2), "agent_rate": rate, "agent_comm": round(agent_comm, 2),
            "nonagent_total": round(nonagent_total, 2), "nonagent_comm": round(nonagent_comm, 2),
            "nonagent_hit": nonagent_hit,
            "items": a["items"], "orders": a["orders"], "avg_items": avg_items,
            "avg_bonus": avg_bonus, "target_bonus": target_bonus, "total": round(total, 2),
            "store_total": round(store_total, 2), "store_hit": store_hit,
            "computed_at": datetime.datetime.utcnow().isoformat() + "Z",
        })
    return rows


def sb_headers():
    return {"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}", "Content-Type": "application/json"}


def write_snapshot(month: str, rows: list):
    d = requests.delete(
        f"{SUPABASE_URL}/rest/v1/retail_commission_snapshot?month=eq.{month}",
        headers=sb_headers(), timeout=30,
    )
    d.raise_for_status()
    i = requests.post(
        f"{SUPABASE_URL}/rest/v1/retail_commission_snapshot",
        headers={**sb_headers(), "Prefer": "return=minimal"},
        json=rows, timeout=30,
    )
    if i.status_code >= 300:
        raise RuntimeError(f"寫入失敗 {i.status_code}: {i.text[:300]}")


def main():
    today = hkt_today()
    months = [today.strftime("%Y-%m")]
    if today.day <= 5:  # 月頭連上個月執埋(月尾遲入嘅單)
        prev = (today.replace(day=1) - datetime.timedelta(days=1)).strftime("%Y-%m")
        months.append(prev)
    for month in months:
        rows = compute_month(month)
        write_snapshot(month, rows)
        payout = sum(r["total"] for r in rows)
        print(f"[{month}] store={rows[0]['store_total'] if rows else 0} staff={len(rows)} payout={payout:.2f}")
    print("done")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)
