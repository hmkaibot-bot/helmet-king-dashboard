#!/usr/bin/env python3
"""
格價系統 — FC-Moto 抓價 + 配對我方商品 + 寫入 competitor_prices。

無需搜尋引擎(全部 anti-bot): 由 FC-Moto sitemap.xml 攞商品 URL → 過濾頭盔
(德文 slug 含 'helm', 排除 visier/spoiler 等配件) → 按型號 token 嚴格配對我方
全面罩/開面/可掀/越野頭盔 → 抓 og:price → 寫入。

到手價計算喺 SQL view (product_price_comparison) 度做, 呢度只存標價。

需要 env:
  SUPABASE_URL          (e.g. https://xxxx.supabase.co)
  SUPABASE_SERVICE_KEY  (service_role; 繞過 RLS 讀寫)
排程: 可加入 .github/workflows 每日/每週跑 (同 daily_inventory_snapshot.py 一樣)。
"""
import json, os, re, time, urllib.request, urllib.parse

SB = os.environ["SUPABASE_URL"].rstrip("/")
SVC = os.environ["SUPABASE_SERVICE_KEY"]
H = {"apikey": SVC, "Authorization": "Bearer " + SVC}
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"

BRANDS = {"SCORPION": "scorpion", "SHOEI": "shoei", "ARAI": "arai", "AGV": "agv",
          "AGV ASIAN": "agv", "ALPINESTARS": "alpinestars", "SHARK": "shark",
          "HJC": "hjc", "LS2 HELMETS": "ls2", "NOLAN": "nolan", "CABERG": "caberg"}
FULL = ("FULL FACE", "OPEN FACE", "MODULAR", "DIRT", "DUAL SPORT")
ACC = ("visier", "pinlock", "innenausstattung", "spoiler", "wange", "ersatz",
       "schirm", "tasche", "beutel", "aufkleber", "sticker", "schraub")
STOP = set("helm helmet air evo full face mono the for fit asian fim 2 ii set with sv s m l xl xs and de carbon".split())
COL = set("schwarz weiss weiß rot blau grau gelb orange grun grün silber matt glanz black white red blue grey gray green yellow pink rosa lila".split())
SITEMAP = "https://www.fc-moto.com/de-de/sitemap.xml"
MAX_PRODUCTS = int(os.environ.get("PW_MAX", "60"))


def sb_get(path):
    return json.load(urllib.request.urlopen(urllib.request.Request(SB + "/rest/v1/" + path, headers=H), timeout=40))


def fetch(url):
    return urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=30).read()


def toks(s):
    return set(re.findall(r"[a-z0-9]+", s.lower().replace("ii", "2")))


def sig(t):
    return {x for x in t if x not in STOP and x not in COL and (len(x) >= 4 or re.search(r"\d", x))}


def load_fcmoto_helmets():
    import gzip, io
    idx = fetch(SITEMAP).decode("utf-8", "ignore")
    sms = re.findall(r"https://[^<]*products-[0-9]+\.xml\.gz", idx)
    urls = []
    for u in sms:
        raw = fetch(u)
        try:
            xml = gzip.decompress(raw).decode("utf-8", "ignore")
        except Exception:
            xml = raw.decode("utf-8", "ignore")
        urls += re.findall(r"<loc>(https://www\.fc-moto\.com/de-de/p/[^<]+)</loc>", xml)
    out = []
    for u in urls:
        slug = re.sub(r"-[A-Z0-9]{2,3}-[0-9].*$", "", u.split("/p/", 1)[1]).lower()
        if "helm" not in slug or any(a in slug for a in ACC):
            continue
        out.append((u, slug, set(re.findall(r"[a-z0-9]+", slug.replace("ii", "2")))))
    return out


def main():
    # clear previous FC-Moto rows (idempotent)
    urllib.request.urlopen(urllib.request.Request(
        SB + "/rest/v1/competitor_prices?merchant=eq.fcmoto",
        headers={**H, "Prefer": "return=minimal"}, method="DELETE"), timeout=40)

    inb = '("' + '","'.join(BRANDS) + '")'
    prods = sb_get("shopify_products?select=id,title,vendor,product_type&status=eq.active"
                   "&vendor=in." + urllib.parse.quote(inb) + "&product_type=ilike.HELMET*")
    prods = [p for p in prods if any(f in (p["product_type"] or "") for f in FULL)]
    inv = sb_get("shopify_inventory?select=product_id,price&price=gt.0&vendor=in." + urllib.parse.quote(inb))
    pmin = {}
    for r in inv:
        pmin[r["product_id"]] = min(pmin.get(r["product_id"], 9e9), float(r["price"]))

    fc = load_fcmoto_helmets()
    print(f"our full helmets={len(prods)}  fcmoto helmet candidates={len(fc)}")

    rows, matched = [], 0
    for pr in prods:
        price = pmin.get(pr["id"])
        bk = BRANDS.get(pr["vendor"])
        if not price or not bk:
            continue
        ot = toks(pr["title"]); osig = sig(ot); ocarb = "carbon" in ot
        best, bs = None, 0
        for (u, slug, ft) in fc:
            if bk not in ft or ("carbon" in ft) != ocarb:
                continue
            shared = osig & sig(ft)
            if len(shared) < 2:
                continue
            sc = len(shared) * 3 + len(ot & ft)
            if sc > bs:
                bs, best = sc, (u, slug, shared)
        if not best:
            continue
        u, slug, shared = best
        try:
            html = fetch(u).decode("utf-8", "ignore")
        except Exception:
            continue
        mp = re.search(r'product:price:amount" content="([0-9.]+)"', html)
        cur = re.search(r'product:price:currency" content="([A-Z]+)"', html)
        if not mp:
            continue
        eur = float(mp.group(1))
        landed = eur / 1.19 * 9.083 + 260  # rough, only for confidence flag
        conf = "high" if len(shared) >= 3 else "medium"
        if landed < price * 0.45:
            conf = "low"
        rows.append({"our_product_id": str(pr["id"]), "our_title": pr["title"], "our_price": price,
                     "merchant": "fcmoto", "competitor_title": slug[:120], "url": u,
                     "currency": (cur.group(1) if cur else "EUR"), "listed_price": eur,
                     "in_stock": ("OutOfStock" not in html), "match_confidence": conf, "match_method": "model"})
        matched += 1
        time.sleep(0.35)
        if matched >= MAX_PRODUCTS:
            break

    if rows:
        urllib.request.urlopen(urllib.request.Request(
            SB + "/rest/v1/competitor_prices", data=json.dumps(rows).encode(),
            headers={**H, "Content-Type": "application/json", "Prefer": "return=minimal"}, method="POST"), timeout=60)
    print(f"inserted {len(rows)} FC-Moto comparisons")


if __name__ == "__main__":
    main()
