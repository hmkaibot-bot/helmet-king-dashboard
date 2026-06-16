#!/usr/bin/env python3
"""格價 — 車迷城 (Moto Mart, motomartco.com) 抓取器。

車迷城 用 Cloudflare 擋海外/機房 IP, 但放行香港 IP (本地店)。所以要經
Apify 「Cloudflare web scraper」actor + 香港 residential proxy 去攞頁面。
平台 Magento: 分類頁列出 product-item-link(型號) + data-price-amount(門市價)。

車迷城產品名只有型號冇品牌 → 反向配對: 每件車迷城產品, 揾本店「一模一樣
(同品牌同型號同花)」嗰件, 1對1, 只收 high 信心 (錯數比冇數危險)。
到手價(會員9折)由 view 計 (chemei.export_vat_pct=11.11 → ×0.9)。

env: SUPABASE_SERVICE_KEY, OPENROUTER_API_KEY, APIFY_TOKEN  (SUPABASE_URL 有預設)
慢 (HK residential + 解 Cloudflare): 約 3-6 分鐘, 故另開, 唔入快 cron。
"""
import json, os, re, time, urllib.request, urllib.parse

SB  = os.environ.get("SUPABASE_URL", "https://myrangmxyjamsupbxbba.supabase.co").rstrip("/")
SVC = os.environ["SUPABASE_SERVICE_KEY"]
OR_KEY = os.environ["OPENROUTER_API_KEY"]
APIFY  = os.environ["APIFY_TOKEN"]
OR_MODEL = os.environ.get("OR_MODEL", "openai/gpt-4o-mini")
H = {"apikey": SVC, "Authorization": "Bearer " + SVC}
CF_ACTOR = "ecomscrape~cloudflare-web-scraper-ppe"
# 抓邊幾版 (Magento 每版 16 件); full-face 約 5 版
CATEGORIES = ["https://www.motomartco.com/helmet/full-face.html"] + \
             [f"https://www.motomartco.com/helmet/full-face.html?p={p}" for p in range(2, 6)]
BRANDS = {"SCORPION","SHOEI","ARAI","AGV","AGV ASIAN","ALPINESTARS","SHARK","HJC","LS2 HELMETS","NOLAN"}
FULL = ("FULL FACE","OPEN FACE","MODULAR","DIRT","DUAL SPORT")
GEN = set("helm helmet air evo full face mono 2 ii carbon the for fit asian solid matt gloss black white red blue grey graphic le special edition replica plain classic knack sv".split())

def sbget(p): return json.load(urllib.request.urlopen(urllib.request.Request(SB+"/rest/v1/"+p, headers=H), timeout=40))
def toks(s): return set(re.findall(r'[a-z0-9]+', s.lower().replace("ii","2")))
def mtok(t): return {x for x in t if x not in GEN and (len(x)>=3 or re.search(r'\d', x))}

def cf_fetch(url, retries=3):
    """經 Apify Cloudflare actor + HK residential 攞 HTML。"""
    body = json.dumps({
        "urls": [url], "retrieve_html_from_url_after_loaded": True,
        "page_is_loaded_before_running_script": True, "execute_js_async": False,
        "retrieve_result_from_js_script": False, "js_timeout": 15, "max_retries_per_url": 2,
        "proxy": {"useApifyProxy": True, "apifyProxyGroups": ["RESIDENTIAL"], "apifyProxyCountry": "HK"},
    }).encode()
    for _ in range(retries):
        try:
            r = urllib.request.urlopen(urllib.request.Request(
                f"https://api.apify.com/v2/acts/{CF_ACTOR}/run-sync-get-dataset-items?token={APIFY}",
                data=body, headers={"Content-Type": "application/json"}), timeout=290)
            d = json.load(r)
            if isinstance(d, list) and d and d[0].get("html"): return d[0]["html"]
        except Exception:
            pass
        time.sleep(3)
    return None

def parse(html):
    items = re.findall(r'product-item-link"\s*href="([^"]+)"[^>]*>\s*([^<]+)', html)
    prices = re.findall(r'data-price-amount="([0-9.]+)"', html)
    return [(u, n.strip(), float(p)) for (u, n), p in zip(items, prices)] if len(items) == len(prices) else []

def ai_match(comp, cands):
    txt = "\n".join(f"[{i}] {t}" for i, t in cands)
    msg = ('A competitor lists this helmet (brand often omitted): "%s".\nOUR shop products (with brand):\n%s\n'
           'Pick the index of OUR product that is the IDENTICAL helmet — same brand, same model, AND same graphic/edition '
           '(ignore only size & trivial colour-name wording; Carbon must match Carbon). If that exact graphic/edition is '
           'NOT among OURS, reply null (do NOT match a different graphic). Beware near-names that are different models '
           '(AGV K3 vs K3 SV). Reply ONLY JSON {"match":<index|null>,"confidence":"high|medium|low"}.' % (comp, txt))
    body = json.dumps({"model": OR_MODEL, "temperature": 0, "max_tokens": 60,
                       "messages": [{"role": "user", "content": msg}]}).encode()
    try:
        r = json.load(urllib.request.urlopen(urllib.request.Request(
            "https://openrouter.ai/api/v1/chat/completions", data=body,
            headers={"Authorization": "Bearer " + OR_KEY, "Content-Type": "application/json"}), timeout=45))
        j = json.loads(re.search(r'\{.*\}', r["choices"][0]["message"]["content"], re.S).group(0))
        m = j.get("match"); return (m if isinstance(m, int) else None), j.get("confidence", "medium")
    except Exception:
        return None, None

def main():
    # 收集車迷城產品
    cm = {}
    for url in CATEGORIES:
        html = cf_fetch(url)
        if not html: print("車迷城 fetch fail:", url); continue
        for u, n, p in parse(html): cm.setdefault(u, (u, n, p))
        time.sleep(1)
    cand = [(u, n, p, mtok(toks(n))) for (u, n, p) in cm.values() if p >= 500]
    print("車迷城 helmets:", len(cand))
    if not cand: raise SystemExit("無車迷城資料 (可能被擋)")

    # 本店頭盔
    inb = '("' + '","'.join(BRANDS) + '")'
    prods = [p for p in sbget("shopify_products?select=id,title,vendor,product_type&status=eq.active&vendor=in."
             + urllib.parse.quote(inb) + "&product_type=ilike.HELMET*") if any(f in (p["product_type"] or "") for f in FULL)]
    inv = sbget("shopify_inventory?select=product_id,price&price=gt.0&vendor=in." + urllib.parse.quote(inb))
    pmin = {}
    for r in inv: pmin[r["product_id"]] = min(pmin.get(r["product_id"], 9e9), float(r["price"]))
    ours = [(p, pmin[p["id"]], mtok(toks(p["title"])), "carbon" in toks(p["title"])) for p in prods if p["id"] in pmin]
    print("our helmets:", len(ours))

    # 反向 1對1 identical 配對
    rows = []; used = set()
    for (u, n, price, cft) in cand:
        ccarb = "carbon" in cft
        pool = [(p, opr) for (p, opr, omt, ocarb) in ours if (cft & omt) and ocarb == ccarb]
        if not pool: continue
        pool = sorted(pool, key=lambda x: -len(toks(n) & toks(x[0]["title"])))[:8]
        mi, conf = ai_match(n, [(i, pp["title"]) for i, (pp, _) in enumerate(pool)])
        if mi is None or mi >= len(pool) or conf != "high": continue
        pp, opr = pool[mi]
        if pp["id"] in used: continue
        used.add(pp["id"])
        rows.append({"our_product_id": str(pp["id"]), "our_title": pp["title"], "our_price": opr, "merchant": "chemei",
                     "competitor_title": n[:120], "url": u, "currency": "HKD", "listed_price": price, "in_stock": True,
                     "match_confidence": conf, "match_method": "ai"})
    # 換 chemei rows
    urllib.request.urlopen(urllib.request.Request(SB+"/rest/v1/competitor_prices?merchant=eq.chemei",
        headers={**H, "Prefer": "return=minimal"}, method="DELETE"), timeout=40)
    if rows:
        urllib.request.urlopen(urllib.request.Request(SB+"/rest/v1/competitor_prices", data=json.dumps(rows).encode(),
            headers={**H, "Content-Type": "application/json", "Prefer": "return=minimal"}, method="POST"), timeout=60)
    print("車迷城 inserted:", len(rows))

if __name__ == "__main__":
    main()
