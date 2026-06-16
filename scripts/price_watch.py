#!/usr/bin/env python3
"""
格價系統 scraper — 多來源抓對手價 + 配對我方頭盔 + 寫入 competitor_prices。

來源:
  - FC-Moto (德, EUR): sitemap.xml.gz → 商品頁 og:price (德文 slug 'helm' 過濾配件)
  - SHOPLINE 本地店 (利力 leelik / 鐵騎 ridershop, HKD): sitemap → /products/ →
    JSON-LD Product offers.price (商品名隔走配件)

到手價計算喺 SQL view 度做; 呢度只存標價 (listed_price)。
配對: 型號 token (含類型/carbon 對齊 + generic glue 字剔除), 附 high/med/low 信心。
冇 GTIN 所以 medium/low 需人手核實 — 補 Shopify barcode + AI 配對可大幅提升準繩。

env: SUPABASE_URL, SUPABASE_SERVICE_KEY   排程: GitHub Actions (見 price-watch.yml)
"""
import json, os, re, time, gzip, urllib.request, urllib.parse

SB = os.environ.get("SUPABASE_URL", "https://myrangmxyjamsupbxbba.supabase.co").rstrip("/")
SVC = os.environ["SUPABASE_SERVICE_KEY"]
H = {"apikey": SVC, "Authorization": "Bearer " + SVC}
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
MAX = int(os.environ.get("PW_MAX", "50"))

BRANDS = {"SCORPION":"scorpion","SHOEI":"shoei","ARAI":"arai","AGV":"agv","AGV ASIAN":"agv",
          "ALPINESTARS":"alpinestars","SHARK":"shark","HJC":"hjc","LS2 HELMETS":"ls2","NOLAN":"nolan","CABERG":"caberg"}
FULL = ("FULL FACE","OPEN FACE","MODULAR","DIRT","DUAL SPORT")
# generic glue 字 — 唔可以做配對依據 (否則唔同型號會撞中)
STOP = set(("helm helmet air evo full face mono the for fit asian fim 2 ii set with and de carbon "
            "blank sp replica special race le edition limited ltd pro hi vis high visibility "
            "sv s m l xl xxl xs schwarz weiss rot blau grau matt black white red blue grey gray").split())
FC_ACC = ("visier","pinlock","innenausstattung","spoiler","wange","ersatz","schirm","tasche","beutel","aufkleber","sticker","schraub")
SL_ACC = ("visor","visier","pinlock","lens","inner","cheek","spoiler","peak","tear","screw","mount","bag",
          "鏡","片","配件","部品","襯","墊","螺","帽舌","內裡","支架","袋")

def sbget(p): return json.load(urllib.request.urlopen(urllib.request.Request(SB+"/rest/v1/"+p,headers=H),timeout=40))
def sbdel(m): urllib.request.urlopen(urllib.request.Request(SB+"/rest/v1/competitor_prices?merchant=eq."+m,headers={**H,"Prefer":"return=minimal"},method="DELETE"),timeout=40)
def sbins(rows):
    if rows: urllib.request.urlopen(urllib.request.Request(SB+"/rest/v1/competitor_prices",data=json.dumps(rows).encode(),
        headers={**H,"Content-Type":"application/json","Prefer":"return=minimal"},method="POST"),timeout=60)
def fetch(u): return urllib.request.urlopen(urllib.request.Request(u,headers={"User-Agent":UA}),timeout=30).read()
def toks(s): return set(re.findall(r'[a-z0-9]+', s.lower().replace("ii","2")))
def sig(t): return {x for x in t if x not in STOP and (len(x)>=4 or re.search(r'\d',x))}

def ldproduct(html):
    for m in re.findall(r'<script[^>]*application/ld\+json[^>]*>(.*?)</script>',html,re.S):
        try: d=json.loads(m.strip())
        except: continue
        items=d.get('@graph',[d]) if isinstance(d,dict) else (d if isinstance(d,list) else [d])
        for it in items:
            if isinstance(it,dict) and (it.get('@type')=='Product' or (isinstance(it.get('@type'),list) and 'Product' in it.get('@type'))):
                of=it.get('offers') or {}
                if isinstance(of,list): of=of[0] if of else {}
                pr=of.get('price') or of.get('lowPrice')
                if pr:
                    try: return it.get('name',''), float(pr), of.get('priceCurrency','HKD')
                    except: pass
    return None

def load_products():
    inb='("'+'","'.join(BRANDS)+'")'
    prods=[p for p in sbget("shopify_products?select=id,title,vendor,product_type&status=eq.active&vendor=in."+urllib.parse.quote(inb)+"&product_type=ilike.HELMET*") if any(f in (p["product_type"]or"") for f in FULL)]
    inv=sbget("shopify_inventory?select=product_id,price&price=gt.0&vendor=in."+urllib.parse.quote(inb))
    pmin={}
    for r in inv: pmin[r["product_id"]]=min(pmin.get(r["product_id"],9e9),float(r["price"]))
    return [(p,pmin[p["id"]]) for p in prods if p["id"] in pmin and BRANDS.get(p["vendor"])]

def best_match(pr, cands):
    ot=toks(pr["title"]); osig=sig(ot); ocarb="carbon" in ot; bk=BRANDS[pr["vendor"]]
    best=None;bs=0
    for (key,ft) in cands:
        if bk not in ft or ("carbon" in ft)!=ocarb: continue
        sh=osig & sig(ft)
        if len(sh)<2: continue
        sc=len(sh)*3+len(ot&ft)
        if sc>bs: bs,best=sc,(key,sh)
    return best

def scrape_fcmoto(products):
    sbdel("fcmoto")
    idx=fetch("https://www.fc-moto.com/de-de/sitemap.xml").decode("utf-8","ignore")
    urls=[]
    for u in re.findall(r"https://[^<]*products-[0-9]+\.xml\.gz",idx):
        raw=fetch(u)
        try: urls+=re.findall(r"<loc>(https://www\.fc-moto\.com/de-de/p/[^<]+)</loc>",gzip.decompress(raw).decode("utf-8","ignore"))
        except: pass
    cand=[]
    for u in urls:
        slug=re.sub(r"-[A-Z0-9]{2,3}-[0-9].*$","",u.split("/p/",1)[1]).lower()
        if "helm" not in slug or any(a in slug for a in FC_ACC): continue
        cand.append((u,set(re.findall(r"[a-z0-9]+",slug.replace("ii","2")))))
    rows=[];n=0
    for pr,price in products:
        b=best_match(pr,cand)
        if not b: continue
        u,sh=b
        try: html=fetch(u).decode("utf-8","ignore")
        except: continue
        mp=re.search(r'product:price:amount" content="([0-9.]+)"',html); cur=re.search(r'product:price:currency" content="([A-Z]+)"',html)
        if not mp: continue
        eur=float(mp.group(1)); landed=eur/1.19*9.083+260
        conf="high" if len(sh)>=3 else "medium"
        if landed<price*0.45: conf="low"
        rows.append({"our_product_id":str(pr["id"]),"our_title":pr["title"],"our_price":price,"merchant":"fcmoto",
          "competitor_title":u.split('/p/',1)[1][:120],"url":u,"currency":(cur.group(1) if cur else "EUR"),
          "listed_price":eur,"in_stock":("OutOfStock" not in html),"match_confidence":conf,"match_method":"model"})
        n+=1; time.sleep(0.35)
        if n>=MAX: break
    sbins(rows); print(f"fcmoto: {len(rows)}")

def scrape_shopline(key, base, products):
    sbdel(key)
    purls=list(dict.fromkeys(re.findall(r'(https://[^< ]+/products/[^< ]+)',fetch(base+"/sitemap.xml").decode("utf-8","ignore"))))
    cand=[(u,set(re.findall(r'[a-z0-9]+',u.rsplit('/products/',1)[1].lower().replace("ii","2")))) for u in purls]
    rows=[];n=0
    for pr,price in products:
        b=best_match(pr,cand)
        if not b: continue
        u,sh=b
        try: html=fetch(u).decode("utf-8","ignore")
        except: continue
        info=ldproduct(html)
        if not info: continue
        name,hkd,cur=info
        if any(a in name.lower() for a in SL_ACC) or hkd<800: continue
        conf="high" if len(sh)>=3 else "medium"
        if hkd<price*0.45: conf="low"
        rows.append({"our_product_id":str(pr["id"]),"our_title":pr["title"],"our_price":price,"merchant":key,
          "competitor_title":name[:120],"url":u,"currency":cur,"listed_price":hkd,"in_stock":True,
          "match_confidence":conf,"match_method":"model"})
        n+=1; time.sleep(0.3)
        if n>=MAX: break
    sbins(rows); print(f"{key}: {len(rows)}")

def refresh_fx():
    try:
        d=json.load(urllib.request.urlopen(urllib.request.Request("https://open.er-api.com/v6/latest/HKD",headers={"User-Agent":UA}),timeout=30))
        r=d["rates"]; now=time.strftime("%Y-%m-%dT%H:%M:%SZ",time.gmtime())
        rows=[{"currency":c,"hkd_per_unit":round(1/r[c],4),"fetched_at":now} for c in ["EUR","USD","JPY","GBP","CHF","SEK","CNY"] if c in r]
        rows.append({"currency":"HKD","hkd_per_unit":1,"fetched_at":now})
        urllib.request.urlopen(urllib.request.Request(SB+"/rest/v1/fx_rates?on_conflict=currency",data=json.dumps(rows).encode(),
            headers={**H,"Content-Type":"application/json","Prefer":"resolution=merge-duplicates,return=minimal"},method="POST"),timeout=30)
        print("fx: refreshed",len(rows))
    except Exception as e:
        print("fx: failed",e)

def main():
    refresh_fx()
    products=load_products(); print("our helmets:",len(products))
    scrape_fcmoto(products)
    scrape_shopline("lilik","https://www.leelik.hk",products)
    scrape_shopline("titkei","https://www.ridershophk.com",products)

if __name__=="__main__": main()
