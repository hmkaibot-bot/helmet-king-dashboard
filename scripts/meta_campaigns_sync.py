"""
Meta Campaigns 每日同步 — 刷新 Supabase meta_campaigns(campaign 列表 + 90 日成效)。

背景:meta_ad_insights(賬戶級日支出)由 n8n Daily ETL 每晚同步,但 meta_campaigns
一直冇 writer(2026-04-09 一次性快照之後就死咗),營銷分析頁嘅廣告活動列表
(篩 spend_90d > 0)因此見唔到現行 campaigns。呢個 job 補返呢條管。

做法:以 /campaigns 全列表做 driver,left-join /insights?level=campaign&date_preset=last_90d
— 冇 90 日投放嘅 campaign 一律歸零(唔會留低過時 spend_90d 污染個列表),
再成批 upsert(on_conflict=campaign_id)。

env: META_ACCESS_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_KEY
     META_AD_ACCOUNT(可選,預設 act_1632943856935233)
"""

import json
import os
import sys
from datetime import datetime, timezone

import requests

META_TOKEN = os.environ.get("META_ACCESS_TOKEN", "")
AD_ACCOUNT = os.environ.get("META_AD_ACCOUNT", "act_1632943856935233")
SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
GRAPH = "https://graph.facebook.com/v25.0"

# 購買數:Meta actions 入面優先攞 omni_purchase(線上+線下合計),fallback 舊 key
PURCHASE_KEYS = ["omni_purchase", "purchase", "offsite_conversion.fb_pixel_purchase"]


def fail(msg: str) -> None:
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(1)


def fetch_paged(url: str, params: dict) -> list:
    """跟 paging.next 拉晒所有頁;Meta 錯誤直接 fail(等 Actions 標紅,唔好靜靜跳過)。"""
    out: list = []
    resp = requests.get(url, params=params, timeout=60)
    for _ in range(20):  # 頁數保險絲
        data = resp.json()
        if "error" in data:
            fail(f"Meta API: {data['error'].get('message', data['error'])}")
        out.extend(data.get("data", []))
        next_url = (data.get("paging") or {}).get("next")
        if not next_url:
            break
        resp = requests.get(next_url, timeout=60)  # next 已包晒 query params
    return out


def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def integer(v):
    try:
        return int(v)
    except (TypeError, ValueError):
        return 0


def purchases_of(ins: dict | None) -> int:
    actions = (ins or {}).get("actions") or []
    for key in PURCHASE_KEYS:
        for a in actions:
            if a.get("action_type") == key:
                return integer(a.get("value"))
    return 0


def main() -> None:
    if not META_TOKEN:
        fail("META_ACCESS_TOKEN 未設定(GitHub repo secret)")
    if not SUPABASE_URL or not SUPABASE_KEY:
        fail("SUPABASE_URL / SUPABASE_SERVICE_KEY 未設定")

    campaigns = fetch_paged(
        f"{GRAPH}/{AD_ACCOUNT}/campaigns",
        {
            "fields": "id,name,status,objective,start_time,stop_time",
            "limit": 200,
            "access_token": META_TOKEN,
        },
    )
    print(f"campaigns: {len(campaigns)}")

    insights = fetch_paged(
        f"{GRAPH}/{AD_ACCOUNT}/insights",
        {
            "level": "campaign",
            "date_preset": "last_90d",
            "fields": "campaign_id,spend,impressions,clicks,reach,cpm,cpc,ctr,actions",
            "limit": 500,
            "access_token": META_TOKEN,
        },
    )
    by_id = {r.get("campaign_id"): r for r in insights}
    print(f"insights rows (90d): {len(insights)}")

    now = datetime.now(timezone.utc).isoformat()
    rows = []
    for c in campaigns:
        ins = by_id.get(c["id"])
        rows.append(
            {
                "campaign_id": c["id"],
                "campaign_name": c.get("name"),
                "status": c.get("status"),
                "objective": c.get("objective"),
                "start_time": c.get("start_time"),
                "stop_time": c.get("stop_time"),
                "spend_90d": (num(ins.get("spend")) or 0) if ins else 0,
                "impressions_90d": integer(ins.get("impressions")) if ins else 0,
                "clicks_90d": integer(ins.get("clicks")) if ins else 0,
                "reach_90d": integer(ins.get("reach")) if ins else 0,
                "cpm_90d": num(ins.get("cpm")) if ins else None,
                "cpc_90d": num(ins.get("cpc")) if ins else None,
                "ctr_90d": num(ins.get("ctr")) if ins else None,
                "purchases_90d": purchases_of(ins),
                "synced_at": now,
            }
        )

    resp = requests.post(
        f"{SUPABASE_URL}/rest/v1/meta_campaigns",
        params={"on_conflict": "campaign_id"},
        headers={
            "apikey": SUPABASE_KEY,
            "Authorization": f"Bearer {SUPABASE_KEY}",
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates",
        },
        data=json.dumps(rows),
        timeout=120,
    )
    if resp.status_code not in (200, 201):
        fail(f"Supabase upsert HTTP {resp.status_code}: {resp.text[:500]}")

    active_spending = sum(1 for r in rows if r["spend_90d"] > 0)
    print(f"upsert OK — {len(rows)} campaigns 已刷新,{active_spending} 個有 90 日支出")


if __name__ == "__main__":
    main()
