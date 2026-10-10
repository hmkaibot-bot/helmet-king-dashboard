import { useEffect, useMemo, useRef, useState } from "react";
import { ClipboardCheck, Download, Plus, Save, Trash2, ShieldCheck, Image as ImageIcon, Sparkles, Search } from "lucide-react";
import { supabase } from "@/lib/supabase";

type Status = "draft" | "review" | "approved";
type StoreProduct = {id:string;title:string;vendor:string;image:string;images:string[];variants:{id:string;sku:string;title:string;price:string;qty:number;image:string}[]};
type Scope = "all_brand"|"selected"|"single"|"general";
type Campaign = {
  scope?:Scope;brand?:string;models?:string;offer?:string;products?:StoreProduct[]; copyWarnings?:string[];
  id:string; name:string; start:string; end:string; product:string; sku:string; price:string;
  imageUrl:string; imageVerified:boolean; headline:string; body:string; terms:string; cta:string;
  channel:"ig"|"vm"; status:Status; notes:string; updatedAt:string;
};
const KEY="helmet-king-marketing-os-v1";
const blank=():Campaign=>({id:crypto.randomUUID(),name:"",start:"",end:"",scope:"selected",brand:"",models:"",offer:"",products:[],product:"",sku:"",price:"",
 imageUrl:"",imageVerified:false,headline:"",body:"",terms:"",cta:"WhatsApp 6203 9357",
 channel:"ig",status:"draft",notes:"",updatedAt:new Date().toISOString()});
function load():Campaign[]{try{return JSON.parse(localStorage.getItem(KEY)||"[]") as Campaign[]}catch{return []}}
function checks(c:Campaign){
 return [
 {label:"已填寫 Campaign 名稱",pass:!!c.name.trim()},
 {label:"已填寫活動優惠",pass:!!c.offer?.trim()},
 {label:"已選擇產品範圍",pass:c.scope==="general"||!!c.brand?.trim()||!!c.models?.trim()},
 {label:"已填寫正式活動日期",pass:!!c.start&&!!c.end&&c.start<=c.end},
 {label:"已填寫標題及文案",pass:!!c.headline.trim()&&!!c.body.trim()},
 {label:"已填寫優惠條款",pass:!!c.terms.trim()},
 {label:"已填寫聯絡／CTA",pass:!!c.cta.trim()},
 {label:"如有指定產品，請核對 Shopify 圖片來源",pass:c.scope==="general"||c.scope==="all_brand"||c.imageVerified},
 ] ;
}
function escapeHtml(s:string){return s.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]||c))}
function printable(c:Campaign){
 const isVM=c.channel==="vm";
 const html=`<!doctype html><html lang="zh-HK"><head><meta charset="utf-8"><title>${escapeHtml(c.name)}</title><style>
 @page{size:${isVM?"A4 portrait":"108mm 135mm"};margin:0}*{box-sizing:border-box}body{margin:0;font-family:Arial,"Microsoft JhengHei",sans-serif;color:#fff}
 .poster{height:${isVM?"297mm":"135mm"};width:${isVM?"210mm":"108mm"};overflow:hidden;background:#071c31;display:flex;flex-direction:column;padding:7%;position:relative}
 .brand{font-weight:900;letter-spacing:3px;color:#f6f9ff;font-size:14px}.eyebrow{font-size:10px;margin-top:12px;opacity:.8}.title{font-weight:900;font-size:${isVM?"38px":"30px"};line-height:1.15;margin:12px 0;color:#fff}
 .photo{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;background:#fff;border-radius:8px;margin:14px 0;padding:12px}
 .photo img{height:100%;width:100%;object-fit:contain}.product{font-weight:800;font-size:18px}.body{white-space:pre-wrap;font-size:12px;margin:8px 0;line-height:1.5}
 .footer{border-top:1px solid #73879b;padding-top:10px}.cta{font-size:16px;font-weight:800}.terms{font-size:9px;line-height:1.35;opacity:.85;white-space:pre-wrap;margin-top:8px}
 </style></head><body><div class="poster"><div class="brand">HELMET KING 頭盔王</div><div class="eyebrow">${escapeHtml(c.start)} — ${escapeHtml(c.end)}</div><div class="title">${escapeHtml(c.headline)}</div>
 <div class="photo">${c.imageUrl?`<img alt="Product" src="${escapeHtml(c.imageUrl)}">`:"<span style='color:#333'>未提供產品圖片</span>"}</div>
 <div class="product">${escapeHtml(c.product)}</div><div class="body">${escapeHtml(c.body)}</div>
 <div class="footer"><div class="cta">${escapeHtml(c.cta)}</div><div class="terms">${escapeHtml(c.terms)}</div></div></div></body></html>`;
 const url=URL.createObjectURL(new Blob([html],{type:"text/html;charset=utf-8"}));const a=document.createElement("a");a.href=url;a.download=(c.name.replace(/[^\w\u4e00-\u9fff-]/g,"_")||"campaign")+(isVM?"-A4-print":"-IG-preview")+".html";a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
const Field=({label,children}:{label:string,children:React.ReactNode})=><label className="block space-y-1"><span className="block text-xs font-semibold text-muted-foreground">{label}</span>{children}</label>;
const inputClass="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm";
export default function MarketingOSPage(){
 const [items,setItems]=useState<Campaign[]>(load);
 const [selected,setSelected]=useState<string|null>(null);
 const [notice,setNotice]=useState("");
 const [busy,setBusy]=useState<""|"catalog"|"generate">("");
 const [lookup,setLookup]=useState("");
 const [results,setResults]=useState<StoreProduct[]>([]);
 const current=items.find(x=>x.id===selected)||null;
 useEffect(()=>{if(!selected&&items.length)setSelected(items[0].id)},[items,selected]);
 const save=(all:Campaign[])=>{setItems(all);try{localStorage.setItem(KEY,JSON.stringify(all));setNotice("已儲存到本機瀏覽器（非雲端）")}catch{setNotice("瀏覽器無法儲存資料，請先匯出備份")}};
 const update=(patch:Partial<Campaign>)=>{if(!current)return;save(items.map(x=>x.id===current.id?{...x,...patch,status:patch.status??(current.status==="approved"?"draft":current.status),updatedAt:new Date().toISOString()}:x))};
 const checkList=useMemo(()=>current?checks(current):[],[current]);
 const pass=checkList.every(x=>x.pass);
 const request=async(payload:unknown)=>{const {data}=await supabase.auth.getSession();if(!data.session)throw Error("請先登入");const r=await fetch("/api/marketing-os",{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+data.session.access_token},body:JSON.stringify(payload)});const j=await r.json();if(!r.ok||!j.ok)throw Error(j.error||"API error");return j};
 const searchShopify=async()=>{if(!current)return;setBusy("catalog");setNotice("");try{const j=await request({action:"catalog",query:lookup||current.brand||current.models});setResults(j.products||[]);setNotice(`Shopify 找到 ${j.products?.length||0} 款${j.hasMore?"（只顯示頭 35 款，請縮窄搜尋）":""}`)}catch(e:any){setNotice(e.message)}finally{setBusy("")}};
 const makeCopy=async()=>{if(!current)return;setBusy("generate");setNotice("");try{const j=await request({action:"generate",brief:current,products:current.products||[]});update({headline:j.copy.headline,body:j.copy.caption,terms:j.copy.terms,copyWarnings:j.copy.warnings||[]});setNotice("AI 文案及 VM 草稿已生成。請先核對內容再審批。")}catch(e:any){setNotice("AI 生成失敗："+e.message)}finally{setBusy("")}};
 const toggleProduct=(p:StoreProduct)=>{if(!current)return;const old=current.products||[];const selected=old.some(x=>x.id===p.id)?old.filter(x=>x.id!==p.id):[...old,p];update({products:selected,imageUrl:selected[0]?.image||"",imageVerified:false,product:selected.map(x=>x.title).join("、")})};
 const exportJson=()=>{const blob=new Blob([JSON.stringify(items,null,2)],{type:"application/json"});const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;a.download="helmet-king-campaigns.json";a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)};
 const importer=useRef<HTMLInputElement>(null);
 const importJson=async(file?:File)=>{if(!file)return;try{const data=JSON.parse(await file.text());if(!Array.isArray(data)||!data.every(x=>typeof x.id==="string"&&typeof x.name==="string"))throw Error("invalid");save(data);setSelected(data[0]?.id||null)}catch{setNotice("匯入失敗：檔案格式不正確")}};
 return <div className="space-y-5 p-4 md:p-6 max-w-[1500px] mx-auto">
 <div className="flex flex-wrap items-center justify-between gap-3"><div><div className="text-xs tracking-widest text-muted-foreground">HELMET KING / INTERNAL STUDIO</div><h1 className="text-2xl font-bold">Marketing OS <span className="text-sm font-normal text-muted-foreground">MVP 0.1</span></h1><p className="text-sm text-muted-foreground">Campaign → 文案 → 圖片預覽 → QA → 人手審批</p></div>
 <div className="flex flex-wrap gap-2"><button className="rounded-lg border px-3 py-2 text-sm" onClick={exportJson}><Download className="inline h-4 w-4"/> 匯出備份</button><button className="rounded-lg border px-3 py-2 text-sm" onClick={()=>importer.current?.click()}>匯入</button><input ref={importer} type="file" accept=".json" className="hidden" onChange={e=>importJson(e.target.files?.[0])}/>
 <button className="rounded-lg bg-primary text-primary-foreground px-4 py-2 text-sm" onClick={()=>{const x=blank();save([x,...items]);setSelected(x.id)}}><Plus className="inline h-4 w-4"/> New Campaign</button></div></div>
 <div className="rounded-lg border border-amber-400/40 bg-amber-400/10 text-sm p-3">Beta：資料只儲存喺呢個瀏覽器（唔會同步其他裝置）。Shopify 搜尋和 AI 文案需 API 設定；IG／VM 為模板預覽，不會由 AI 重新畫產品。QA 目前只核對基本欄位，正式發布仍需人工驗證優惠、庫存及原圖。</div>
 {notice&&<p role="status" className="text-sm text-muted-foreground">{notice}</p>}
 <div className="grid grid-cols-1 xl:grid-cols-[250px_minmax(0,1fr)_320px] gap-4">
 <section className="rounded-xl border p-3 space-y-2"><h2 className="font-semibold mb-2">Campaign Pipeline ({items.length})</h2>{items.length===0&&<p className="text-sm text-muted-foreground">未有 Campaign。新增後只需輸入商品範圍、活動日期及優惠，再按 AI 生成。</p>}{items.map(x=><button key={x.id} onClick={()=>setSelected(x.id)} className={`w-full rounded-lg p-3 text-left border ${selected===x.id?"border-primary bg-primary/5":"border-border"}`}><div className="font-semibold text-sm break-words">{x.name||"未命名活動"}</div><div className="text-xs text-muted-foreground mt-1">{x.status==="approved"?"已審批":x.status==="review"?"待審批":"草稿"} · {x.channel.toUpperCase()}</div></button>)}</section>
 <section className="rounded-xl border p-4 space-y-4 min-w-0">{!current?<div className="text-muted-foreground py-20 text-center">建立第一個 Campaign 開始</div>:<>
 <div className="flex justify-between items-center gap-2"><h2 className="text-lg font-semibold">Campaign Editor</h2><button className="text-sm text-destructive" onClick={()=>{if(confirm("刪除這個 Campaign？")){save(items.filter(x=>x.id!==current.id));setSelected(null)}}}><Trash2 className="inline h-4 w-4"/> 刪除</button></div>
 <Field label="活動名稱"><input className={inputClass} value={current.name} onChange={e=>update({name:e.target.value})} placeholder="例如：Halloween 頭盔贈品活動"/></Field>
 <div className="grid grid-cols-2 gap-3"><Field label="開始日期"><input type="date" className={inputClass} value={current.start} onChange={e=>update({start:e.target.value})}/></Field><Field label="結束日期"><input type="date" className={inputClass} value={current.end} onChange={e=>update({end:e.target.value})}/></Field></div>
 <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
 <Field label="產品範圍"><select className={inputClass} value={current.scope||"selected"} onChange={e=>update({scope:e.target.value as Scope})}><option value="all_brand">品牌所有商品</option><option value="selected">多款指定型號</option><option value="single">單一指定型號</option><option value="general">不指定產品（通用宣傳）</option></select></Field>
 {current.scope!=="general"&&<Field label="品牌（例如 SCORPION）"><input className={inputClass} value={current.brand||""} onChange={e=>update({brand:e.target.value})}/></Field>}</div>
 {(current.scope==="selected"||current.scope==="single")&&<Field label="型號／系列（可輸入多個，SKU 非必填）"><textarea className={inputClass} rows={2} placeholder="EXO-TECH EVO, EXO-530, EXO-GT SP AIR..." value={current.models||""} onChange={e=>update({models:e.target.value})}/></Field>}
 <Field label="優惠內容（必填）"><textarea className={inputClass} rows={3} value={current.offer||""} onChange={e=>update({offer:e.target.value})} placeholder="例如：購買指定 Full-face 頭盔即送 Halloween 頭套，先到先得，送完即止"/></Field>
 <Field label="活動條款（由你確認）"><textarea className={inputClass} rows={2} value={current.terms} onChange={e=>update({terms:e.target.value})} placeholder="例：指定款式適用；不能與其他優惠同時使用"/></Field>
 {current.scope!=="general"&&<div className="rounded-xl border p-3 space-y-3"><div className="font-semibold text-sm">Shopify 自動搜圖／選產品</div><div className="flex gap-2"><input className={inputClass} placeholder="輸入品牌或型號搜尋" value={lookup} onChange={e=>setLookup(e.target.value)}/><button disabled={!!busy} onClick={searchShopify} className="rounded-lg border px-3 whitespace-nowrap text-sm"><Search className="inline h-4 w-4"/> 搜尋</button></div>
 <p className="text-xs text-muted-foreground">系統自動取得產品原圖、SKU、售價與庫存。可選多款；全品牌活動毋須逐件選。這個搜尋僅供預覽及驗證，唔會修改 Shopify。</p>
 {results.length>0&&<div className="max-h-72 overflow-auto grid grid-cols-1 sm:grid-cols-2 gap-2">{results.map(p=><button key={p.id} onClick={()=>toggleProduct(p)} className={`rounded border p-2 text-left text-xs flex gap-2 ${current.products?.some(v=>v.id===p.id)?"border-primary bg-primary/10":""}`}>{p.image&&<img src={p.image} className="h-14 w-14 object-contain bg-white rounded" alt="Shopify Product"/>}<div className="min-w-0"><div className="font-semibold line-clamp-2">{p.title}</div><div className="text-muted-foreground mt-1">{p.vendor}</div><div>{current.products?.some(v=>v.id===p.id)?"✓ 已選":"選擇"}</div></div></button>)}</div>}
 <p className="text-xs text-muted-foreground">已選 {current.products?.length||0} 款產品</p></div>}
 <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 space-y-2"><div className="font-semibold text-sm flex gap-2 items-center"><Sparkles className="h-4 w-4"/> AI 一鍵生成文案</div><button className="rounded-lg bg-primary px-4 py-2 text-primary-foreground text-sm disabled:opacity-50" disabled={!!busy||!current.name||!current.start||!current.end||!current.offer} onClick={makeCopy}>{busy==="generate"?"生成中...":"生成廣東話 IG 文案及 VM 內容"}</button><p className="text-xs text-muted-foreground">AI 將使用活動 Brief 及已選 Shopify 商品資料。不會自行創造折扣、售價或贈品條款。</p></div>
 <details><summary className="text-sm font-semibold cursor-pointer">生成後文案微調（可選）</summary><div className="space-y-3 pt-3">
 <Field label="宣傳標題"><input className={inputClass} value={current.headline} onChange={e=>update({headline:e.target.value})} placeholder="主標題"/></Field>
 <Field label="廣東話文案"><textarea rows={5} className={inputClass} value={current.body} onChange={e=>update({body:e.target.value})}/></Field>
 <Field label="活動條款"><textarea rows={3} className={inputClass} value={current.terms} onChange={e=>update({terms:e.target.value})}/></Field>
 <Field label="CTA／聯絡"><input className={inputClass} value={current.cta} onChange={e=>update({cta:e.target.value})}/></Field>
 </div></details>
 <Field label="交付格式"><select className={inputClass} value={current.channel} onChange={e=>update({channel:e.target.value as "ig"|"vm"})}><option value="ig">IG 4:5 (1080 × 1350 比例)</option><option value="vm">店內 A4 宣傳海報</option></select></Field>
 <Field label="審批備註"><textarea rows={2} className={inputClass} value={current.notes} onChange={e=>update({notes:e.target.value})}/></Field>
 {current.copyWarnings&&current.copyWarnings.length>0&&<div className="rounded-lg border border-amber-400 p-2 text-xs">AI 提醒：{current.copyWarnings.join("；")}</div>}
 <div className="flex flex-wrap gap-2"><button className="rounded-lg border px-4 py-2 text-sm" onClick={()=>setNotice("草稿已自動儲存於本機")}><Save className="inline h-4 w-4"/> 儲存草稿</button><button className="rounded-lg border px-4 py-2 text-sm" onClick={()=>printable(current)}><Download className="inline h-4 w-4"/> 匯出版面 HTML</button></div>
 </>}</section>
 <aside className="space-y-4 min-w-0"><div className="rounded-xl border p-4 space-y-3"><h2 className="font-semibold flex gap-2 items-center"><ImageIcon className="h-4 w-4"/> 素材預覽</h2>{current?<div className="mx-auto overflow-hidden bg-[#09233d] text-white p-4 flex flex-col gap-2" style={{maxWidth:260,aspectRatio:current.channel==="ig"?"4/5":"210/297"}}><div className="text-xs tracking-widest font-bold">HELMET KING</div><div className="font-bold text-xl leading-tight break-words">{current.headline||"CAMPAIGN TITLE"}</div><div className="flex-1 min-h-0 rounded bg-white flex items-center justify-center overflow-hidden">{current.imageUrl?<img src={current.imageUrl} alt="來源產品預覽" className="w-full h-full object-contain" referrerPolicy="no-referrer"/>:<span className="text-slate-500 text-xs">PRODUCT IMAGE</span>}</div><div className="font-semibold text-sm">{current.product}</div><div className="text-xs whitespace-pre-wrap line-clamp-3">{current.body}</div><div className="text-xs font-bold border-t border-white/30 pt-2">{current.cta}</div><div className="text-[9px] opacity-75 line-clamp-2">{current.terms}</div></div>:<p className="text-sm text-muted-foreground">未選擇活動</p>}</div>
 <div className="rounded-xl border p-4 space-y-3"><h2 className="font-semibold flex gap-2 items-center"><ShieldCheck className="h-4 w-4"/> QA Checklist</h2>{current?<>{checkList.map(c=><div className="flex gap-2 text-sm" key={c.label}><span className={c.pass?"text-green-600":"text-amber-600"}>{c.pass?"✓":"!"}</span><span>{c.label}</span></div>)}<p className="text-xs text-muted-foreground">注意：全部通過仍需要人手確認售價、存貨、日期、素材真偽及版面。</p><button className="w-full rounded-lg border px-3 py-2 text-sm" onClick={()=>update({status:"review"})} disabled={!pass}>提交審批</button><button className="w-full rounded-lg bg-primary text-primary-foreground px-3 py-2 text-sm disabled:opacity-50" disabled={!pass||current.status!=="review"} onClick={()=>{if(confirm("我已逐項人工核實文案、價格、圖片及條款，確認審批？"))update({status:"approved"})}}><ClipboardCheck className="inline h-4 w-4"/> 人手確認通過</button><p className="text-xs">目前狀態：{current.status==="approved"?"已審批":current.status==="review"?"待審批":"草稿"}</p></>:<p className="text-sm text-muted-foreground">未有內容</p>}</div></aside>
 </div></div>;
}
