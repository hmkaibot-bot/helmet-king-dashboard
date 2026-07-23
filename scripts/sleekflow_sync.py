"""
SleekFlow 查詢同步 — 拉對話+訊息內容,對照商品,寫入 inquiry_events。

做咩:
1. GET /api/conversation/all(分頁,modifiedAt 新→舊,行到過咗 DAYS_BACK 就停)
2. 每個對話 GET /api/conversation/message/{id},只要 inbound(客人發嘅)
3. 訊息文字 → 品牌/型號對照(字典由 shopify_products 即場起):
   只存 matched_brand / matched_product_id / matched_title —— 原文唔入庫(私隱)
4. upsert inquiry_events(真 message id / conversation id,channel 正規化
   whatsappcloudapi→whatsapp、instagram、facebook)
5. 對賬:同一時段 webhook 嘅 synth 行(即時計數用)刪走,由 API 真數取代;
   剷之前先將 synth 行嘅 source='ctwa'(廣告入口標記)過戶俾同客同日嘅 API 行

env: SLEEKFLOW_API_KEY(冇就用 SUPABASE_SERVICE_KEY 讀 app_config)
     SUPABASE_URL, SUPABASE_SERVICE_KEY, DAYS_BACK(default 3;回填用 90)
"""

import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone

import requests

SF_KEY = os.environ.get("SLEEKFLOW_API_KEY", "")
SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
DAYS_BACK = int(os.environ.get("DAYS_BACK", "3"))
SF_BASE = "https://api.sleekflow.io/api"

# 對話/訊息分頁上限(保險絲;90 日回填都夠)
MAX_CONV_PAGES = 40
CONV_PAGE_SIZE = 100
MSG_PAGE_SIZE = 200


def fail(msg: str) -> None:
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(1)


def sb_headers() -> dict:
    return {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
    }


def sleekflow_key() -> str:
    if SF_KEY:
        return SF_KEY
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/app_config",
        params={"key": "eq.SLEEKFLOW_API_KEY", "select": "value"},
        headers=sb_headers(),
        timeout=30,
    )
    rows = r.json() if r.status_code == 200 else []
    if rows and rows[0].get("value"):
        return str(rows[0]["value"])
    fail("搵唔到 SLEEKFLOW_API_KEY(env 同 app_config 都冇)")
    return ""


def sf_get(key: str, path: str, params: dict) -> list:
    r = requests.get(
        f"{SF_BASE}/{path}",
        params=params,
        headers={"X-Sleekflow-Api-Key": key},
        timeout=60,
    )
    if r.status_code == 429:
        import time

        time.sleep(5)
        r = requests.get(
            f"{SF_BASE}/{path}", params=params, headers={"X-Sleekflow-Api-Key": key}, timeout=60
        )
    if r.status_code != 200:
        fail(f"SleekFlow GET /{path} HTTP {r.status_code}: {r.text[:300]}")
    data = r.json()
    return data if isinstance(data, list) else []


# ── 商品對照字典(shopify_products 即場起)─────────────────────────────────
def build_dictionary():
    rows: list = []
    offset = 0
    while True:
        r = requests.get(
            f"{SUPABASE_URL}/rest/v1/shopify_products",
            params={"select": "id,title,vendor,status", "limit": "1000", "offset": str(offset)},
            headers=sb_headers(),
            timeout=60,
        )
        page = r.json() if r.status_code == 200 else []
        rows.extend(page)
        if len(page) < 1000:
            break
        offset += 1000
    active = [p for p in rows if str(p.get("status", "")).lower() == "active"]

    brands = sorted({str(p["vendor"]).strip().upper() for p in active if p.get("vendor")})
    # 通用英文字做「品牌」會亂中(FULL FACE 嘅 FULL、PHONE CASE 嘅 CASE)— 剔走
    stop = {"FULL", "CASE", "PART", "PARTS", "SET", "NEW", "GENERAL"}
    # 短品牌(<=3 字)要 word-boundary 先算中 — 免「K」「Z」亂中
    brand_res = []
    for b in brands:
        if len(b) < 2 or b in stop:
            continue
        pat = re.escape(b)
        brand_res.append((b, re.compile(rf"(?<![A-Z0-9]){pat}(?![A-Z0-9])") if len(b) <= 3 else re.compile(pat)))

    # 型號 token:title 入面「帶數字」嘅字;齋對應一件商品先可以指向單品
    token_map: dict = {}
    for p in active:
        for t in re.split(r"[\s/\[\]()]+", str(p.get("title", ""))):
            if 2 <= len(t) <= 12 and re.search(r"[0-9]", t) and re.fullmatch(r"[A-Za-z0-9#-]+", t):
                token_map.setdefault(t.upper(), set()).add((p["id"], str(p.get("title", ""))[:120]))
    model_tokens = {
        tok: next(iter(ids)) for tok, ids in token_map.items() if len(ids) == 1 and len(tok) >= 3
    }
    print(f"字典:{len(active)} 件活躍商品 | {len(brand_res)} 品牌 | {len(model_tokens)} 個單品型號 token")
    return brand_res, model_tokens


def match_text(text: str, brand_res, model_tokens):
    if not text:
        return None, None, None
    up = text.upper()
    brand = next((b for b, rx in brand_res if rx.search(up)), None)
    pid = title = None
    for tok, (tpid, ttitle) in model_tokens.items():
        if re.search(rf"(?<![A-Z0-9]){re.escape(tok)}(?![A-Z0-9])", up):
            pid, title = tpid, ttitle
            break
    return brand, pid, title


def norm_channel(ch: str) -> str:
    c = str(ch or "").lower()
    if "whatsapp" in c:
        return "whatsapp"
    if "instagram" in c:
        return "instagram"
    if "facebook" in c or "messenger" in c:
        return "facebook"
    return c or "unknown"


def main() -> None:
    if not SUPABASE_URL or not SUPABASE_KEY:
        fail("SUPABASE_URL / SUPABASE_SERVICE_KEY 未設定")
    key = sleekflow_key()
    cutoff = datetime.now(timezone.utc) - timedelta(days=DAYS_BACK)
    cutoff_iso = cutoff.isoformat()
    brand_res, model_tokens = build_dictionary()

    # 1. 對話(modifiedAt 新→舊;過咗 cutoff 停)
    convs: list = []
    for page in range(MAX_CONV_PAGES):
        batch = sf_get(key, "conversation/all", {"offset": page * CONV_PAGE_SIZE, "limit": CONV_PAGE_SIZE})
        if not batch:
            break
        convs.extend(batch)
        oldest = min(str(c.get("modifiedAt") or c.get("updatedTime") or "9999") for c in batch)
        if oldest < cutoff_iso:
            break
    recent = [c for c in convs if str(c.get("modifiedAt") or c.get("updatedTime") or "") >= cutoff_iso]
    print(f"對話:掃咗 {len(convs)},{DAYS_BACK} 日內有活動 {len(recent)}")

    # 2+3. 逐對話拉訊息 → inbound → 對照
    rows: list = []
    matched_brand_n = matched_prod_n = 0
    for c in recent:
        conv_id = c.get("conversationId")
        up = c.get("userProfile") or {}
        msgs = sf_get(key, f"conversation/message/{conv_id}", {"offset": 0, "limit": MSG_PAGE_SIZE})
        for m in msgs:
            created = str(m.get("createdAt") or "")
            if not created or created < cutoff_iso:
                continue
            if m.get("isSentFromSleekflow") is True:
                continue  # 店方覆,唔計
            text = str(m.get("messageContent") or "") if str(m.get("messageType")) == "text" else ""
            brand, pid, title = match_text(text, brand_res, model_tokens)
            if brand:
                matched_brand_n += 1
            if pid:
                matched_prod_n += 1
            rows.append(
                {
                    "message_id": str(m.get("messageUniqueID") or m.get("id") or ""),
                    "conversation_id": str(conv_id),
                    "contact_id": str(up.get("id") or "") or None,
                    "contact_phone": up.get("phoneNumber") or None,
                    "channel": norm_channel(m.get("channel")),
                    "occurred_at": created,
                    "matched_brand": brand,
                    "matched_product_id": pid,
                    "matched_title": title,
                }
            )
    rows = [r for r in rows if r["message_id"]]
    print(f"inbound 訊息:{len(rows)} | 認到品牌 {matched_brand_n} | 認到單品 {matched_prod_n}")

    # 4. upsert(batch 500)
    for i in range(0, len(rows), 500):
        r = requests.post(
            f"{SUPABASE_URL}/rest/v1/inquiry_events",
            params={"on_conflict": "message_id"},
            headers={**sb_headers(), "Prefer": "resolution=merge-duplicates"},
            data=json.dumps(rows[i : i + 500]),
            timeout=120,
        )
        if r.status_code not in (200, 201):
            fail(f"upsert HTTP {r.status_code}: {r.text[:300]}")
    print(f"upsert OK({len(rows)} 行)")

    # 5. 對賬:synth(webhook 即時行)→ 過戶 ctwa 標記 → 刪走
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/inquiry_events",
        params={
            "message_id": "like.synth:*",
            "occurred_at": f"gte.{cutoff_iso}",
            "select": "contact_id,occurred_at,source",
        },
        headers=sb_headers(),
        timeout=60,
    )
    synth = r.json() if r.status_code == 200 else []
    ctwa_pairs = {
        (s["contact_id"], str(s["occurred_at"])[:10]) for s in synth if s.get("source") == "ctwa" and s.get("contact_id")
    }
    for contact_id, day in ctwa_pairs:
        requests.patch(
            f"{SUPABASE_URL}/rest/v1/inquiry_events",
            params={
                "contact_id": f"eq.{contact_id}",
                "occurred_at": f"gte.{day}T00:00:00Z",
                "and": f"(occurred_at.lt.{day}T23:59:59.999Z)",
                "message_id": "not.like.synth:*",
            },
            headers=sb_headers(),
            data=json.dumps({"source": "ctwa"}),
            timeout=30,
        )
    if synth:
        requests.delete(
            f"{SUPABASE_URL}/rest/v1/inquiry_events",
            params={"message_id": "like.synth:*", "occurred_at": f"gte.{cutoff_iso}"},
            headers=sb_headers(),
            timeout=60,
        )
    print(f"對賬:剷走 {len(synth)} 行 synth(webhook 即時數),ctwa 過戶 {len(ctwa_pairs)} 對")


if __name__ == "__main__":
    main()
