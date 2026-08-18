"""
SleekFlow 查詢同步 — 拉對話+訊息內容,對照商品,寫入 inquiry_events。

做咩:
1. GET /api/conversation/all(分頁,modifiedAt 新→舊,行到過咗 DAYS_BACK 就停)
2. 每個對話 GET /api/conversation/message/{id},只要 inbound(客人發嘅)
3. 訊息文字 → 品牌/型號對照(字典由 shopify_products 即場起):
   存 matched_brand / matched_product_id / matched_title;認到商品嘅訊息
   會存埋原文(截 200 字)俾 dashboard 撳入去睇對話 — 認唔到嘅唔存原文
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

# channel 身份 → 業務(老闆「淨係睇零售」用)。同一個 SleekFlow workspace 內
# 三盤生意各有自己條線 — 用返條線分業務最準(唔使靠估內容)。
# 可用 app_config key SLEEKFLOW_CHANNEL_BUSINESS(JSON object)補充/覆蓋。
CHANNEL_BUSINESS = {
    "85263858830": "retail",   # 頭盔王 Main WhatsApp(helmetking.com 官網嗰條)
    "85262039357": "26king",   # 26King 賣車/回收/寄賣 WhatsApp
    "85259614354": "rental",   # Rentalbike 租車 WhatsApp
    "17841401978965150": "retail",  # IG @helmetking_hk
    "17841446002032010": "26king",  # IG @26kinghk
    "110139034178233": "26king",    # IG @26kinghk 嘅 FB page id(部分訊息用呢個做 identity)
    "1607355899494029": "retail",   # FB 頭盔王 Helmetking.com page
}

# 同事分隊 → 業務(assignedTeam 優先過條線:好多客搵零售線但問車/維修,
# 同事 triage 分咗隊 — 嗰個先係真業務)。key 用大寫對照。
TEAM_BUSINESS = {
    "RETAIL": "retail",
    "26KING": "26king",
    "GARAGE": "garage",
    "RENTALBIKEHK": "rental",
    "RENTALBIKE": "rental",
    "TOUR": "tour",
}


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


def channel_business_map() -> dict:
    """內置對照 + app_config SLEEKFLOW_CHANNEL_BUSINESS(JSON)覆蓋 — 新開線唔使改 code。"""
    merged = dict(CHANNEL_BUSINESS)
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/app_config",
        params={"key": "eq.SLEEKFLOW_CHANNEL_BUSINESS", "select": "value"},
        headers=sb_headers(),
        timeout=30,
    )
    rows = r.json() if r.status_code == 200 else []
    if rows and rows[0].get("value"):
        try:
            merged.update({str(k): str(v) for k, v in json.loads(rows[0]["value"]).items()})
        except (ValueError, AttributeError):
            print("WARN: app_config SLEEKFLOW_CHANNEL_BUSINESS 唔係有效 JSON,用內置對照")
    return merged


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


# ── 零售 vs 車件商品類型 ────────────────────────────────────────────────
# Shopify product_type 前綴分得清楚:HELMET / RIDER GEARS / ACCESSORIES 係零售賣嘅
# 嘢;MOTORCYCLE PARTS 係車件(車房嗰邊),SERVICES & EVENTS 唔係貨。
def is_retail_type(pt) -> bool:
    t = str(pt or "").upper()
    return t.startswith(("HELMET", "RIDER GEARS", "ACCESSORIES"))


def is_parts_type(pt) -> bool:
    t = str(pt or "").upper()
    return t.startswith(("MOTORCYCLE PARTS", "SERVICES"))


# ── 商品對照字典(shopify_products 即場起)─────────────────────────────────
def build_dictionary():
    rows: list = []
    offset = 0
    while True:
        r = requests.get(
            f"{SUPABASE_URL}/rest/v1/shopify_products",
            params={
                "select": "id,title,vendor,status,product_type",
                "limit": "1000",
                "offset": str(offset),
            },
            headers=sb_headers(),
            timeout=60,
        )
        page = r.json() if r.status_code == 200 else []
        rows.extend(page)
        if len(page) < 1000:
            break
        offset += 1000
    active = [p for p in rows if str(p.get("status", "")).lower() == "active"]

    # 起型號 token 用「唔係車件」嘅商品 —— 有啲貨 product_type 空白,唔可以當車件剔走
    retail = [p for p in active if not is_parts_type(p.get("product_type"))]

    # 品牌:一個 vendor 車件多過零售商品就唔當零售品牌 —— 咁 YAMAHA / HONDA /
    # BABYFACE / CBR250RR 呢啲車廠同車件牌自動出局,SCORPION / SHOEI 照留。
    per_vendor: dict = {}
    for p in active:
        v = str(p.get("vendor") or "").strip().upper()
        if not v:
            continue
        cnt = per_vendor.setdefault(v, {"parts": 0, "retail": 0})
        if is_parts_type(p.get("product_type")):
            cnt["parts"] += 1
        elif is_retail_type(p.get("product_type")):
            cnt["retail"] += 1
    # 有車件 而且 車件唔少過零售商品先剔 —— 冇車件嘅 vendor(包括 product_type
    # 空白嗰啲)一律照留,唔好誤殺正經裝備牌子
    brands = sorted(
        v for v, c in per_vendor.items() if not (c["parts"] > 0 and c["parts"] >= c["retail"])
    )
    dropped = len(per_vendor) - len(brands)

    # 通用英文字做「品牌」會亂中(FULL FACE 嘅 FULL、PHONE CASE 嘅 CASE)— 剔走
    # 車牌/OVER/TBC:vendor 值撞正常用語(講車牌照、英文 over)一樣要剔
    stop = {"FULL", "CASE", "PART", "PARTS", "SET", "NEW", "GENERAL", "OVER", "TBC", "車牌"}
    # 短品牌(<=3 字)要 word-boundary 先算中 — 免「K」「Z」亂中
    brand_res = []
    for b in brands:
        if len(b) < 2 or b in stop:
            continue
        pat = re.escape(b)
        brand_res.append((b, re.compile(rf"(?<![A-Z0-9]){pat}(?![A-Z0-9])") if len(b) <= 3 else re.compile(pat)))

    # 型號 token:title 入面「帶數字」嘅字;齋對應一件零售商品先可以指向單品
    token_map: dict = {}
    for p in retail:
        for t in re.split(r"[\s/\[\]()]+", str(p.get("title", ""))):
            if 2 <= len(t) <= 12 and re.search(r"[0-9]", t) and re.fullmatch(r"[A-Za-z0-9#-]+", t):
                token_map.setdefault(t.upper(), set()).add(
                    (p["id"], str(p.get("title", ""))[:120], str(p.get("product_type") or ""))
                )
    model_tokens = {
        tok: next(iter(ids)) for tok, ids in token_map.items() if len(ids) == 1 and len(tok) >= 3
    }
    print(
        f"字典:{len(active)} 件活躍商品(非車件 {len(retail)})| {len(brand_res)} 品牌"
        f"(剔走 {dropped} 個車件為主嘅 vendor)| {len(model_tokens)} 個單品型號 token"
    )
    return brand_res, model_tokens


def match_text(text: str, brand_res, model_tokens):
    if not text:
        return None, None, None, None
    up = text.upper()
    brand = next((b for b, rx in brand_res if rx.search(up)), None)
    pid = title = ptype = None
    for tok, (tpid, ttitle, tptype) in model_tokens.items():
        if re.search(rf"(?<![A-Z0-9]){re.escape(tok)}(?![A-Z0-9])", up):
            pid, title, ptype = tpid, ttitle, tptype
            break
    return brand, pid, title, ptype


def ctwa_referral(m: dict):
    """CTWA 入口訊息:Meta referral 原封不動喺 SleekFlow payload 入面 —
    source_id = 帶個客入嚟嗰個 ad 嘅 id(廣告歸因就靠佢,唔使靠 webhook 估)。"""
    ref = (
        ((m.get("extendedMessagePayload") or {}).get("extendedMessagePayloadDetail") or {}).get(
            "whatsappCloudApiReferral"
        )
        or {}
    )
    if str(ref.get("source_type") or "").lower() == "ad" and ref.get("source_id"):
        return str(ref["source_id"])
    return None


def has_column(table: str, col: str) -> bool:
    """DB 加咗新欄未(sql/ 檔要手動 apply)— 未加就退化,唔好炒成個 job。"""
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/{table}",
        params={"select": col, "limit": "1"},
        headers=sb_headers(),
        timeout=30,
    )
    return r.status_code == 200


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
    biz_map = channel_business_map()

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

    # 2+3. 逐對話拉訊息 → inbound → 對照 + 業務歸屬(邊條線 = 邊盤生意)
    rows: list = []
    matched_brand_n = matched_prod_n = 0
    unknown_idents: dict = {}
    for c in recent:
        conv_id = c.get("conversationId")
        up = c.get("userProfile") or {}
        conv_ident = str(c.get("lastChannelIdentityId") or "")
        at = c.get("assignedTeam")
        team_name = str((at or {}).get("teamName") if isinstance(at, dict) else (at or "")).strip()
        team_biz = TEAM_BUSINESS.get(team_name.upper())
        msgs = sf_get(key, f"conversation/message/{conv_id}", {"offset": 0, "limit": MSG_PAGE_SIZE})
        for m in msgs:
            created = str(m.get("createdAt") or "")
            ad_id = ctwa_referral(m)
            # referral 訊息(CTWA 入口)舊過 cutoff 都照入 — 對話今日先再郁,
            # 但個客係 N 日前撳廣告入嚟,廣告歸因唔可以漏咗佢
            if not created or (created < cutoff_iso and not ad_id):
                continue
            if m.get("isSentFromSleekflow") is True:
                continue  # 店方覆,唔計
            if str(m.get("channel") or "") == "note":
                continue  # 同事內部 note,唔係客人查詢
            text = str(m.get("messageContent") or "") if str(m.get("messageType")) == "text" else ""
            brand, pid, title, ptype = match_text(text, brand_res, model_tokens)
            if brand:
                matched_brand_n += 1
            if pid:
                matched_prod_n += 1
            ident = str(m.get("channelIdentityId") or "") or conv_ident
            # 業務:同事分隊優先(triage 過先至準),冇分隊先按條線
            business = team_biz or biz_map.get(ident)
            if ident and not business:
                unknown_idents[ident] = unknown_idents.get(ident, 0) + 1
            row = {
                "message_id": str(m.get("messageUniqueID") or m.get("id") or ""),
                "conversation_id": str(conv_id),
                "contact_id": str(up.get("id") or "") or None,
                "contact_phone": up.get("phoneNumber") or None,
                "channel": norm_channel(m.get("channel")),
                "team": team_name or None,
                "occurred_at": created,
                "matched_brand": brand,
                "matched_product_id": pid,
                "matched_title": title,
                "matched_product_type": ptype,
                # 認到商品先存原文(dashboard 品牌 Top 10 撳入去睇對話用)
                "message_text": text[:200] if (brand or pid) else None,
                "channel_identity_id": ident or None,
                "business": business,
            }
            # CTWA 入口訊息:記低邊個 ad 帶入嚟(source 唔好喺普通行 send —
            # 免得 merge upsert 冚走 webhook 打落嘅 ctwa 標記)
            if ad_id:
                row["source"] = "ctwa"
                row["ctwa_ad_id"] = ad_id
            rows.append(row)
    rows = [r for r in rows if r["message_id"]]
    biz_n = {}
    for r_ in rows:
        biz_n[r_["business"] or "unknown"] = biz_n.get(r_["business"] or "unknown", 0) + 1
    print(f"inbound 訊息:{len(rows)} | 認到品牌 {matched_brand_n} | 認到單品 {matched_prod_n} | 業務分佈 {biz_n}")
    if unknown_idents:
        print(f"WARN: 未識別 channel 線(要加入對照/app_config SLEEKFLOW_CHANNEL_BUSINESS):{unknown_idents}")

    # 4. upsert(batch 500)— CTWA 行帶多兩個欄(source/ctwa_ad_id),PostgREST bulk
    # 要求同一批行 keys 一致,所以分兩批寄;DB 未加新欄就退返淨 source(唔炒 job)
    ctwa_rows = [r_ for r_ in rows if "ctwa_ad_id" in r_]
    plain_rows = [r_ for r_ in rows if "ctwa_ad_id" not in r_]
    if ctwa_rows and not has_column("inquiry_events", "ctwa_ad_id"):
        print("WARN: inquiry_events 未有 ctwa_ad_id 欄(要 apply sql/inquiry-ctwa-ad-id.sql)— ad id 今次唔存")
        for r_ in ctwa_rows:
            r_.pop("ctwa_ad_id")
    print(f"CTWA referral:{len(ctwa_rows)} 條入口訊息認到 ad id")
    for batch in (plain_rows, ctwa_rows):
        for i in range(0, len(batch), 500):
            r = requests.post(
                f"{SUPABASE_URL}/rest/v1/inquiry_events",
                params={"on_conflict": "message_id"},
                headers={**sb_headers(), "Prefer": "resolution=merge-duplicates"},
                data=json.dumps(batch[i : i + 500]),
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

    # 歷史清理:字典會變(例如「車件為主嘅 vendor」規則收緊),舊行可能仲留住
    # 而家唔算零售嘅品牌/商品對照。逐晚用最新字典掃全表,唔止今次同步嗰批。
    valid_brands = {b for b, _ in brand_res}
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/inquiry_events",
        params={"select": "matched_brand", "matched_brand": "not.is.null", "limit": "100000"},
        headers=sb_headers(),
        timeout=60,
    )
    seen_brands = {str(x["matched_brand"]) for x in (r.json() if r.status_code == 200 else [])}
    stale_brands = sorted(seen_brands - valid_brands)
    if stale_brands:
        quoted = ",".join('"' + b.replace('"', '') + '"' for b in stale_brands)
        requests.patch(
            f"{SUPABASE_URL}/rest/v1/inquiry_events",
            params={"matched_brand": f"in.({quoted})"},
            headers={**sb_headers(), "Prefer": "return=minimal"},
            data=json.dumps({"matched_brand": None}),
            timeout=60,
        )

    valid_pids = {pid for pid, _, _ in model_tokens.values()}
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/inquiry_events",
        params={
            "select": "matched_product_id",
            "matched_product_id": "not.is.null",
            "limit": "100000",
        },
        headers=sb_headers(),
        timeout=60,
    )
    seen_pids = {x["matched_product_id"] for x in (r.json() if r.status_code == 200 else [])}
    stale_pids = [p for p in seen_pids if p not in valid_pids]
    if stale_pids:
        requests.patch(
            f"{SUPABASE_URL}/rest/v1/inquiry_events",
            params={"matched_product_id": f"in.({','.join(str(p) for p in stale_pids)})"},
            headers={**sb_headers(), "Prefer": "return=minimal"},
            data=json.dumps(
                {"matched_product_id": None, "matched_title": None, "matched_product_type": None}
            ),
            timeout=60,
        )
    print(f"字典清理:剷走 {len(stale_brands)} 個過期品牌對照、{len(stale_pids)} 件過期商品對照")

    # 歷史清理:早期版本將同事內部 note 當咗查詢入咗庫 — 剷走(而家唔會再寫,呢步好快變 no-op)
    requests.delete(
        f"{SUPABASE_URL}/rest/v1/inquiry_events",
        params={"channel": "eq.note"},
        headers=sb_headers(),
        timeout=60,
    )


if __name__ == "__main__":
    main()
