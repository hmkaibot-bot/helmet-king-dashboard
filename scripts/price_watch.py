#!/usr/bin/env python3
"""
格價系統 scraper (AI 配對版) — 抓對手價 + AI 驗證配對 + 寫入 competitor_prices。

來源:
  - FC-Moto (德, EUR): sitemap.xml.gz → 頭盔商品頁 og:price
  - SHOPLINE 利力 leelik (HKD): sitemap → JSON-LD Product offers.price
  (鐵騎 ridershop / 車迷城 motomart / Webike 待加 — 見 README/blueprint)

配對: 先 token 粗篩同品牌+型號候選, 再用 OpenRouter (gpt-4o-mini) 確認「係咪同一
型號+版本」(忽略色款/尺碼, carbon 須對齊, 排除 visor/配件)。冇 GTIN link, AI 比對
係最可靠方法。到手價計算喺 SQL view (product_price_comparison) 做。

env: SUPABASE_SERVICE_KEY, OPENROUTER_API_KEY   (SUPABASE_URL 有預設)
排程/一鍵: .github/workflows/price-watch.yml
"""
import json, os, re, time, gzip, urllib.request, urllib.parse

SB = os.environ.get("SUPABASE_URL", "https://myrangmxyjamsupbxbba.supabase.co").rstrip("/")
SVC = os.environ["SUPABASE_SERVICE_KEY"]
OR_KEY = os.environ.get("OPENROUTER_API_KEY", "")
OR_MODEL = os.environ.get("OR_MODEL", "openai/gpt-4o-mini")
H = {"apikey": SVC, "Authorization": "Bearer " + SVC}
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
CAP = int(os.environ.get("PW_CAP", "55"))
BRANDS = {"SCORPION":"scorpion","SHOEI":"shoei","ARAI":"arai","AGV":"agv","AGV ASIAN":"agv",
          "ALPINESTARS":"alpinestars","SHARK":"shark","HJC":"hjc","LS2 HELMETS":"ls2","NOLAN":"nolan","CABERG":"caberg"}
FULL = ("FULL FACE","OPEN FACE","MODULAR","DIRT","DUAL SPORT")
GEN = set("helm helmet air evo full face mono 2 ii carbon the for fit asian schwarz weiss rot blau grau matt".split())

def sbget(p): return json.load(urllib.request.urlopen(urllib.request.Request(SB+"/rest/v1/"+p,headers=H),timeout=40))
def sbdel(m): urllib.request.urlopen(urllib.request.Request(SB+"/rest/v1/competitor_prices?merchant=eq."+m,headers={**H,"Prefer":"return=minimal"},method="DELETE"),timeout=40)
def sbins(rows):
    if rows: urllib.request.urlopen(urllib.request.Request(SB+"/rest/v1/competitor_prices",data=json.dumps(rows).encode(),headers={**H,"Content-Type":"application/json","Prefer":"return=minimal"},method="POST"),timeout=60)
def fetch(u): return urllib.request.urlopen(urllib.request.Request(u,headers={"User-Agent":UA}),timeout=30).read()
def toks(s): return set(re.findall(r'[a-z0-9]+', s.lower().replace("ii","2")))
def modeltoks(t): return {x for x in t if x not in GEN and (len(x)>=4 or re.search(r'\d',x))}

def ai_match(our, cands):
    txt="\n".join(f"[{i}] {t}" for i,t in cands)
    msg=('You match motorcycle helmets across shops. OUR: "%s".\nCANDIDATES:\n%s\n'
         'Pick the index that is the SAME helmet model AND sub-model/edition as OUR (ignore colour & size). '
         'If OUR is Carbon, the match must be Carbon (and vice-versa). The match must be the HELMET itself, '
         'NOT a visor/parts/battery/accessory. If none truly matches, use null. '
         'Reply ONLY JSON {"match": <index or null>, "confidence":"high|medium|low"}.' % (our, txt))
    body=json.dumps({"model":OR_MODEL,"temperature":0,"max_tokens":80,"messages":[{"role":"user","content":msg}]}).encode()
    try:
        r=json.load(urllib.request.urlopen(urllib.request.Request("https://openrouter.ai/api/v1/chat/completions",
            data=body,headers={"Authorization":"Bearer "+OR_KEY,"Content-Type":"application/json"}),timeout=45))
        j=json.loads(re.search(r'\{.*\}',r["choices"][0]["message"]["content"],re.S).group(0))
        m=j.get("match")
        return (m if isinstance(m,int) else None), j.get("confidence","medium")
    except Exception:
        return None,None

def refresh_fx():
    try:
        d=json.load(urllib.request.urlopen(urllib.request.Request("https://open.er-api.com/v6/latest/HKD",headers={"User-Agent":UA}),timeout=30))
        r=d["rates"]; now=time.strftime("%Y-%m-%dT%H:%M:%SZ",time.gmtime())
        rows=[{"currency":c,"hkd_per_unit":round(1/r[c],4),"fetched_at":now} for c in ["EUR","USD","JPY","GBP","CHF","SEK","CNY"] if c in r]+[{"currency":"HKD","hkd_per_unit":1,"fetched_at":now}]
        urllib.request.urlopen(urllib.request.Request(SB+"/rest/v1/fx_rates?on_conflict=currency",data=json.dumps(rows).encode(),
            headers={**H,"Content-Type":"application/json","Prefer":"resolution=merge-duplicates,return=minimal"},method="POST"),timeout=30)
        print("fx refreshed")
    except Exception as e: print("fx failed",e)

def fc_candidates():
    idx=fetch("https://www.fc-moto.com/de-de/sitemap.xml").decode("utf-8","ignore"); out=[]
    for u in re.findall(r"https://[^<]*products-[0-9]+\.xml\.gz",idx):
        try: xml=gzip.decompress(fetch(u)).decode("utf-8","ignore")
        except: continue
        for url in re.findall(r"<loc>(https://www\.fc-moto\.com/de-de/p/[^<]+)</loc>",xml):
            slug=re.sub(r"-[A-Z0-9]{2,3}-[0-9].*$","",url.split("/p/",1)[1]).lower()
            if "helm" in slug: out.append((url,slug,toks(slug)))
    return out
def sl_candidates(base):
    return [(u,u.rsplit('/products/',1)[1].lower(),toks(u.rsplit('/products/',1)[1])) for u in dict.fromkeys(re.findall(r'(https://[^< ]+/products/[^< ]+)',fetch(base+"/sitemap.xml").decode("utf-8","ignore")))]
def fc_price(html):
    mp=re.search(r'product:price:amount" content="([0-9.]+)"',html); cur=re.search(r'product:price:currency" content="([A-Z]+)"',html)
    return (float(mp.group(1)), cur.group(1) if cur else "EUR", "OutOfStock" not in html) if mp else None
def sl_price(html):
    for m in re.findall(r'<script[^>]*application/ld\+json[^>]*>(.*?)</script>',html,re.S):
        try: d=json.loads(m.strip())
        except: continue
        items=d.get('@graph',[d]) if isinstance(d,dict) else (d if isinstance(d,list) else [d])
        for it in items:
            if isinstance(it,dict) and 'Product' in str(it.get('@type','')):
                of=it.get('offers') or {}
                if isinstance(of,list): of=of[0] if of else {}
                if of.get('price'):
                    try: return float(of['price']), of.get('priceCurrency','HKD'), True
                    except: pass
    return None

def run_merchant(key, loadc, pricef, products):
    sbdel(key); cand=loadc(); print(f"{key}: {len(cand)} candidates")
    rows=[]
    for pr,price in products:
        bk=BRANDS[pr["vendor"]]; ot=toks(pr["title"]); omt=modeltoks(ot); ocarb="carbon" in ot
        pool=[(u,slug) for (u,slug,ft) in cand if bk in ft and ("carbon" in ft)==ocarb and (omt & modeltoks(ft))]
        if not pool: continue
        pool=sorted(pool,key=lambda x:-len(ot & toks(x[1])))[:8]
        mi,conf=ai_match(pr["title"],[(i,s) for i,(u,s) in enumerate(pool)])
        if mi is None or mi>=len(pool): continue
        u,slug=pool[mi]
        try: html=fetch(u).decode("utf-8","ignore")
        except: continue
        info=pricef(html)
        if not info: continue
        lp,cur,ins=info
        if cur=="HKD" and lp<800: continue
        rows.append({"our_product_id":str(pr["id"]),"our_title":pr["title"],"our_price":price,"merchant":key,
          "competitor_title":slug[:120],"url":u,"currency":cur,"listed_price":lp,"in_stock":ins,
          "match_confidence":conf or "medium","match_method":"ai"})
        time.sleep(0.25)
        if len(rows)>=CAP: break
    sbins(rows); print(f"  {key}: inserted {len(rows)}")

def main():
    if not OR_KEY: raise SystemExit("OPENROUTER_API_KEY required")
    refresh_fx()
    inb='("'+'","'.join(BRANDS)+'")'
    prods=[p for p in sbget("shopify_products?select=id,title,vendor,product_type&status=eq.active&vendor=in."+urllib.parse.quote(inb)+"&product_type=ilike.HELMET*") if any(f in (p["product_type"]or"") for f in FULL)]
    inv=sbget("shopify_inventory?select=product_id,price&price=gt.0&vendor=in."+urllib.parse.quote(inb))
    pmin={}
    for r in inv: pmin[r["product_id"]]=min(pmin.get(r["product_id"],9e9),float(r["price"]))
    products=[(p,pmin[p["id"]]) for p in prods if p["id"] in pmin]
    print("our helmets:",len(products))
    run_merchant("fcmoto", fc_candidates, fc_price, products)
    run_merchant("lilik", lambda: sl_candidates("https://www.leelik.hk"), sl_price, products)

if __name__=="__main__": main()
