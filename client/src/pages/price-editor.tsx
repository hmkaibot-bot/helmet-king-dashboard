import { useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { queryAllPages } from '@/lib/query-helpers';
import { Card, CardContent } from '@/components/ui/card';
import { formatCurrency } from '@/lib/format';
import { CircleDollarSign, Search, Undo2, TriangleAlert, X } from 'lucide-react';

/**
 * 改價 Price Editor — 逐個 SKU 改「正價」(售價 + 劃線價),即改即生效。
 *
 * UX(老闆 2026-09-09 第二輪):品牌 + Product Type filter;預設 list 晒
 * 母項(product)出嚟,每行極簡(貨名/牌子/價錢範圍/SKU 數);撳一行先
 * 彈 modal 改價 — 所有輸入/警告/儲存都收埋入 modal,列表唔好嘈。
 *
 * 分工(grilling 定案):呢頁改正價(例如加價),唔搞活動、唔寫 snapshot;
 * 推廣減價行推廣活動頁。推廣中(Shopify 有 hk_promo.snapshot)嘅 SKU
 * API 層拒改 — 唔係活動「還原原價」會冚走新正價。
 *
 * 真相:Shopify 係唯一真相;寫成功先鏡返本地 shopify_inventory(RLS
 * authenticated 可寫),全 dashboard 即改即見,唔使等夜間 sync。
 */

interface InvRow {
  id: number;
  product_id: number;
  variant_id: number;
  product_title: string | null;
  variant_title: string | null;
  sku: string | null;
  price: number | null;
  compare_at_price: number | null;
  inventory_quantity: number | null;
  vendor: string | null;
  product_type: string | null;
  cost: number | null;
}

interface EditInput { price: string; compare: string; }

interface Change {
  productId: number;
  variantId: number;
  label: string;
  oldP: number;
  newP: number | null;             // null = 冇改售價
  oldC: number | null;
  newC: number | null | undefined; // undefined = 冇改;null = 清走劃線價
  warnings: string[];
}

const priceStr = (v: number | null) => (v != null ? String(v) : '');
const PAGE = 200; // 母項列表每次 render 幾多行(幾千件貨一次過 render 會卡)

// variant_title 一般係「顏色 / SIZE」(Shopify 用 " / " 駁選項)—
// 拆開兩欄:顏色全名一欄、SIZE 一欄(老闆:唔要截字,SIZE 分開睇)
const splitVariant = (t: string | null): [string | null, string | null] => {
  if (!t || t === 'Default Title') return [null, null];
  const i = t.indexOf(' / ');
  if (i < 0) return [t, null];
  return [t.slice(0, i), t.slice(i + 3)];
};

// modal 內每個 variant 嘅顏色/圖(/api/shopify-product action:variants 回嘅)
interface ProductDetail {
  pid: number;
  loading: boolean;
  featured: string | null;
  optionSummary: Array<{ name: string; values: string[] }>; // 例:顏色 → [BLACK, WHITE]
  byVid: Record<number, { imageUrl: string | null; options: Record<string, string> }>;
  truncated?: boolean;
}

export default function PriceEditorPage() {
  const [rows, setRows] = useState<InvRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [vendorF, setVendorF] = useState('');
  const [typeF, setTypeF] = useState('');
  const [shown, setShown] = useState(PAGE);
  const [openPid, setOpenPid] = useState<number | null>(null);
  const [edits, setEdits] = useState<Record<number, EditInput>>({});
  const [rowErrors, setRowErrors] = useState<Record<number, string>>({});
  const [savedIds, setSavedIds] = useState<Set<number>>(new Set());
  const [confirmChanges, setConfirmChanges] = useState<Change[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  // 產品主圖(列表左邊)— 顯示緊嗰批先攞,requestedImgs 防重覆問
  const [imgMap, setImgMap] = useState<Record<string, string | null>>({});
  const requestedImgs = useRef(new Set<string>());
  // modal 顏色/variant 圖(cache 免重覆問 Shopify)
  const [detail, setDetail] = useState<ProductDetail | null>(null);
  const detailCache = useRef(new Map<number, ProductDetail>());
  const [lightbox, setLightbox] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await queryAllPages(
          'shopify_inventory',
          'id,product_id,variant_id,product_title,variant_title,sku,price,compare_at_price,inventory_quantity,vendor,product_type,cost'
        );
        if (!cancelled) setRows(data as InvRow[]);
      } catch (e) {
        console.error('shopify_inventory load error:', e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Esc 逐層閂:大圖 → modal(confirm 開緊嗰陣唔好搶)
  useEffect(() => {
    if (openPid == null && lightbox == null) return;
    const h = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (lightbox) { setLightbox(null); return; }
      if (!confirmChanges) setOpenPid(null);
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [openPid, confirmChanges, lightbox]);

  // ── filter 選項(由數據嚟,帶母項數)────────────────────────────────
  const { vendors, types } = useMemo(() => {
    const vSet = new Map<string, Set<number>>();
    const tSet = new Map<string, Set<number>>();
    for (const r of rows) {
      const v = (r.vendor ?? '').trim();
      const t = (r.product_type ?? '').trim();
      if (v) { const s = vSet.get(v) ?? new Set(); s.add(r.product_id); vSet.set(v, s); }
      if (t) { const s = tSet.get(t) ?? new Set(); s.add(r.product_id); tSet.set(t, s); }
    }
    const toList = (m: Map<string, Set<number>>) =>
      [...m.entries()].map(([name, s]) => ({ name, n: s.size })).sort((a, b) => a.name.localeCompare(b.name));
    return { vendors: toList(vSet), types: toList(tSet) };
  }, [rows]);

  // ── 母項列表(filter + 搜尋;預設全部 list 晒)──────────────────────
  const products = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const byPid = new Map<number, InvRow[]>();
    for (const r of rows) {
      if (r.variant_id == null) continue;
      if (vendorF && (r.vendor ?? '').trim() !== vendorF) continue;
      if (typeF && (r.product_type ?? '').trim() !== typeF) continue;
      if (needle) {
        const hay = `${r.product_title ?? ''} ${r.vendor ?? ''} ${r.sku ?? ''}`.toLowerCase();
        if (!hay.includes(needle)) continue;
      }
      const arr = byPid.get(r.product_id) ?? [];
      arr.push(r);
      byPid.set(r.product_id, arr);
    }
    return [...byPid.entries()]
      .map(([pid, variants]) => {
        const prices = variants.map((v) => v.price).filter((p): p is number => p != null && p > 0);
        return {
          pid,
          title: variants[0]?.product_title ?? `#${pid}`,
          vendor: (variants[0]?.vendor ?? '').trim(),
          ptype: (variants[0]?.product_type ?? '').trim(),
          minP: prices.length ? Math.min(...prices) : null,
          maxP: prices.length ? Math.max(...prices) : null,
          variants: [...variants].sort((a, b) => String(a.sku ?? '').localeCompare(String(b.sku ?? ''))),
        };
      })
      .sort((a, b) => a.title.localeCompare(b.title));
  }, [rows, q, vendorF, typeF]);

  useEffect(() => { setShown(PAGE); }, [q, vendorF, typeF]);

  // ── 產品主圖:顯示緊嗰批 lazy 攞(featuredImages 批量,每批 200)──────
  // ⚠️ 特登冇「取消」邏輯:imgMap 係 append-only cache,遲返嚟嘅 response
  // 照入 cache 冇壞處。舊版打搜尋每一下鍵盤都 cancel 上一次請求,但啲 id
  // 已經標咗「攞過」,最後一下見「全部攞過」就唔再攞 → 灰格永遠唔上圖
  // (老闆 2026-09-09 實試中招)。攞唔成功(401/500/網絡死)一律解除標記,
  // 下次 render 自動重試。
  useEffect(() => {
    const pids = products
      .slice(0, shown)
      .map((p) => String(p.pid))
      .filter((id) => !requestedImgs.current.has(id));
    if (pids.length === 0) return;
    pids.forEach((id) => requestedImgs.current.add(id));
    (async () => {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) {
        pids.forEach((id) => requestedImgs.current.delete(id));
        return;
      }
      for (let i = 0; i < pids.length; i += 200) {
        const chunk = pids.slice(i, i + 200);
        try {
          const resp = await fetch('/api/shopify-product', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ action: 'featuredImages', productIds: chunk }),
          });
          const j: any = await resp.json().catch(() => null);
          if (resp.ok && j?.images && typeof j.images === 'object') {
            const images = j.images;
            setImgMap((m) => ({ ...m, ...Object.fromEntries(chunk.map((id) => [id, images[id] ?? null])) }));
          } else {
            chunk.forEach((id) => requestedImgs.current.delete(id));
          }
        } catch {
          chunk.forEach((id) => requestedImgs.current.delete(id));
        }
      }
    })();
  }, [products, shown]);

  // ── modal 顏色/variant 圖:開 modal 先問(action:variants,有 cache)──
  useEffect(() => {
    if (openPid == null) { setDetail(null); return; }
    const cached = detailCache.current.get(openPid);
    if (cached) { setDetail(cached); return; }
    setDetail({ pid: openPid, loading: true, featured: imgMap[String(openPid)] ?? null, optionSummary: [], byVid: {} });
    let cancelled = false;
    (async () => {
      try {
        const { data } = await supabase.auth.getSession();
        const token = data.session?.access_token;
        if (!token) throw new Error('no session');
        const resp = await fetch('/api/shopify-product', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ action: 'variants', productId: String(openPid) }),
        });
        const j: any = await resp.json().catch(() => null);
        if (!resp.ok || !j?.product) throw new Error(j?.error || 'variants fetch failed');
        const byVid: ProductDetail['byVid'] = {};
        for (const v of j.product.variants ?? []) {
          const num = Number(String(v.id ?? '').split('/').pop());
          if (num) byVid[num] = { imageUrl: v.imageUrl ?? null, options: v.options ?? {} };
        }
        const names: string[] = (j.product.optionNames ?? []).filter((n: string) => n && n !== 'Title');
        const optionSummary = names.map((name) => ({
          name,
          values: [...new Set((j.product.variants ?? []).map((v: any) => String(v.options?.[name] ?? '')).filter(Boolean))] as string[],
        }));
        const d: ProductDetail = {
          pid: openPid,
          loading: false,
          featured: j.product.featuredImage ?? imgMap[String(openPid)] ?? null,
          optionSummary,
          byVid,
          truncated: !!j.product.truncated,
        };
        detailCache.current.set(openPid, d);
        if (!cancelled) setDetail((cur) => (cur && cur.pid === openPid ? d : cur));
      } catch {
        // 攞唔到顏色/圖唔算致命 — modal 改價功能照用
        if (!cancelled) setDetail((cur) => (cur && cur.pid === openPid ? { ...cur, loading: false } : cur));
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openPid]);

  const openProduct = openPid != null ? products.find((p) => p.pid === openPid) ?? null : null;

  const setEdit = (vid: number, field: keyof EditInput, value: string, original: InvRow) => {
    setEdits((m) => {
      const cur = m[vid] ?? { price: priceStr(original.price), compare: priceStr(original.compare_at_price) };
      return { ...m, [vid]: { ...cur, [field]: value } };
    });
    setRowErrors((m) => { const n = { ...m }; delete n[vid]; return n; });
    setSavedIds((s) => { if (!s.has(vid)) return s; const n = new Set(s); n.delete(vid); return n; });
  };

  // ── 未儲存改動(全域計,行為同舊版一致)────────────────────────────
  const dirty = useMemo((): { changes: Change[]; invalid: string[] } => {
    const changes: Change[] = [];
    const invalid: string[] = [];
    const byVid = new Map(rows.map((r) => [r.variant_id, r]));
    for (const [vidStr, e] of Object.entries(edits)) {
      const vid = Number(vidStr);
      const r = byVid.get(vid);
      if (!r) continue;
      const label = `${r.product_title ?? ''} — ${r.variant_title && r.variant_title !== 'Default Title' ? r.variant_title : r.sku ?? vid}`;

      const rawP = e.price.trim();
      const rawC = e.compare.trim();
      const newPNum = rawP === '' ? NaN : Number(rawP);
      const newCNum = rawC === '' ? null : Number(rawC);
      if (rawP === '' || !isFinite(newPNum) || newPNum <= 0) {
        if (rawP !== priceStr(r.price)) invalid.push(`${label}:售價「${rawP || '(空)'}」唔係有效價錢`);
        continue;
      }
      if (newCNum != null && (!isFinite(newCNum) || newCNum < 0)) {
        invalid.push(`${label}:劃線價「${rawC}」唔係有效價錢`);
        continue;
      }

      const priceChanged = newPNum !== (r.price ?? 0);
      const oldC = r.compare_at_price;
      const normNewC = newCNum != null && newCNum > 0 ? newCNum : null;
      const compareChanged = normNewC !== (oldC ?? null);
      if (!priceChanged && !compareChanged) continue;

      const warnings: string[] = [];
      if (normNewC != null && normNewC <= newPNum) warnings.push('劃線價唔高過售價 — 客人唔會見到折扣');
      if (priceChanged && r.price && Math.abs(newPNum - r.price) / r.price > 0.4) warnings.push(`同原價 ${formatCurrency(r.price)} 差超過 40% — 確認唔係打錯`);
      if (r.cost != null && r.cost > 0 && newPNum < r.cost) warnings.push(`新售價低過成本 ${formatCurrency(r.cost)} — 會蝕住賣`);

      changes.push({
        productId: r.product_id,
        variantId: vid,
        label,
        oldP: r.price ?? 0,
        newP: priceChanged ? newPNum : null,
        oldC: oldC ?? null,
        newC: compareChanged ? normNewC : undefined,
        warnings,
      });
    }
    return { changes, invalid };
  }, [edits, rows]);

  const dirtyPids = useMemo(() => new Set(dirty.changes.map((c) => c.productId)), [dirty.changes]);

  const resetEdits = () => { setEdits({}); setRowErrors({}); };

  // ── 儲存:寫 Shopify → 成功先鏡返本地 DB + state ─────────────────────
  const doSave = async (changes: Change[]) => {
    setSaving(true);
    setToast(null);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) throw new Error('未登入 — 請重新登入 dashboard');

      const byProduct = new Map<number, Change[]>();
      for (const c of changes) {
        const arr = byProduct.get(c.productId) ?? [];
        arr.push(c);
        byProduct.set(c.productId, arr);
      }
      const items = [...byProduct.entries()].map(([productId, cs]) => ({
        productId: String(productId),
        variants: cs.map((c) => ({
          variantId: String(c.variantId),
          ...(c.newP != null ? { price: c.newP } : {}),
          ...(c.newC !== undefined ? { compareAtPrice: c.newC } : {}),
        })),
      }));

      const resp = await fetch('/api/shopify-variant-price', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ items }),
      });
      const j: any = await resp.json().catch(() => null);
      if (!resp.ok) throw new Error(j?.error || `改價服務回應 ${resp.status}(未 deploy 前呢度用唔到)`);

      const okVids = new Set<number>();
      const errs: Record<number, string> = {};
      for (const pr of j.results ?? []) {
        for (const v of pr.variants ?? []) {
          const vid = Number(v.variantId);
          if (v.ok) okVids.add(vid);
          else errs[vid] = v.error || '失敗';
        }
        if (pr.error) for (const c of byProduct.get(Number(pr.productId)) ?? []) errs[c.variantId] = pr.error;
      }

      const okChanges = changes.filter((c) => okVids.has(c.variantId));
      for (const c of okChanges) {
        const patch: Record<string, number | null> = {};
        if (c.newP != null) patch.price = c.newP;
        if (c.newC !== undefined) patch.compare_at_price = c.newC;
        const { error } = await supabase.from('shopify_inventory').update(patch).eq('variant_id', c.variantId);
        if (error) console.error('本地鏡寫失敗(夜間 sync 會自動補正):', error.message);
      }
      setRows((prev) =>
        prev.map((r) => {
          const c = okChanges.find((x) => x.variantId === r.variant_id);
          if (!c) return r;
          return {
            ...r,
            price: c.newP != null ? c.newP : r.price,
            compare_at_price: c.newC !== undefined ? c.newC : r.compare_at_price,
          };
        })
      );
      setEdits((m) => {
        const n = { ...m };
        for (const c of okChanges) delete n[c.variantId];
        return n;
      });
      setRowErrors((m) => ({ ...m, ...errs }));
      setSavedIds(new Set(okVids));
      const failN = Object.keys(errs).length;
      setToast(`✅ 改咗 ${okVids.size} 個 SKU,已同步 Shopify + dashboard${failN > 0 ? ` · ⚠️ ${failN} 個失敗(見行內紅字)` : ''}`);
    } catch (e) {
      setToast(`❌ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
      setConfirmChanges(null);
    }
  };

  const marginPct = (price: number | null, cost: number | null) => {
    if (price == null || price <= 0 || cost == null || cost <= 0) return null;
    return ((price - cost) / price) * 100;
  };

  const fmtRange = (minP: number | null, maxP: number | null) => {
    if (minP == null) return '—';
    return minP === maxP ? formatCurrency(minP) : `${formatCurrency(minP)} – ${formatCurrency(maxP!)}`;
  };

  // 呢個母項自己嘅未儲存改動(modal 儲存掣用)
  const openChanges = openPid != null ? dirty.changes.filter((c) => c.productId === openPid) : [];

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between flex-wrap gap-2">
        <h2 className="text-sm font-semibold flex items-center gap-1.5" data-testid="section-price-editor">
          <CircleDollarSign className="h-4 w-4 text-primary" /> 改價 <span className="text-xs font-normal text-muted-foreground">Price Editor(正價,逐個 SKU)</span>
        </h2>
        <span className="text-[11px] text-muted-foreground">
          撳件貨先彈出嚟改 · 即改即生效(網店 + POS + dashboard)· 推廣中嘅 SKU 要先還原先改得
        </span>
      </div>

      {/* filter 列:品牌 / Product Type / 搜尋 */}
      <div className="flex gap-2 flex-wrap items-center">
        <select
          value={vendorF}
          onChange={(e) => setVendorF(e.target.value)}
          className="px-2 py-2 rounded-md border border-border bg-card text-xs max-w-[180px]"
          data-testid="price-filter-vendor"
        >
          <option value="">全部品牌</option>
          {vendors.map((v) => (
            <option key={v.name} value={v.name}>{v.name}({v.n})</option>
          ))}
        </select>
        <select
          value={typeF}
          onChange={(e) => setTypeF(e.target.value)}
          className="px-2 py-2 rounded-md border border-border bg-card text-xs max-w-[220px]"
          data-testid="price-filter-type"
        >
          <option value="">全部類別</option>
          {types.map((t) => (
            <option key={t.name} value={t.name}>{t.name}({t.n})</option>
          ))}
        </select>
        <div className="relative flex-1 min-w-[200px] max-w-md">
          <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜貨名 / SKU"
            className="w-full pl-8 pr-3 py-2 rounded-md border border-border bg-card text-xs"
            data-testid="price-editor-search"
          />
        </div>
        <span className="text-[11px] text-muted-foreground tabular-nums">{products.length} 件商品</span>
      </div>

      {toast && (
        <div className="rounded-md border border-border/60 bg-card px-3 py-2 text-xs" data-testid="price-editor-toast">{toast}</div>
      )}

      {/* 全域未儲存提示(可以幾件貨改埋一齊先儲存)*/}
      {(dirty.changes.length > 0 || dirty.invalid.length > 0) && (
        <div className="sticky top-0 z-20 rounded-md border border-amber-500/40 bg-amber-950/60 backdrop-blur px-3 py-2 flex items-center gap-3 flex-wrap text-xs">
          <span className="text-amber-300 font-semibold">{dirty.changes.length} 項未儲存改動</span>
          {dirty.invalid.length > 0 && (
            <span className="text-red-300" title={dirty.invalid.join('\n')}>⚠️ {dirty.invalid.length} 項輸入無效(儲存唔包括佢哋)</span>
          )}
          <div className="ml-auto flex gap-2">
            <button
              onClick={resetEdits}
              className="px-2.5 py-1 rounded border border-border text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
              data-testid="price-editor-reset"
            >
              <Undo2 className="h-3 w-3" /> 還原輸入
            </button>
            <button
              onClick={() => dirty.changes.length > 0 && setConfirmChanges(dirty.changes)}
              disabled={dirty.changes.length === 0 || saving}
              className="px-3 py-1 rounded bg-primary text-primary-foreground font-semibold disabled:opacity-50"
              data-testid="price-editor-save"
            >
              儲存全部改價…
            </button>
          </div>
        </div>
      )}

      {/* 母項列表 — 極簡:貨名 + 牌子/類別細字 + 價錢範圍 + SKU 數 */}
      {loading ? (
        <p className="text-xs text-muted-foreground py-8 text-center animate-pulse">載入緊 SKU 價目…</p>
      ) : products.length === 0 ? (
        <p className="text-xs text-muted-foreground py-10 text-center">呢個 filter 組合冇貨 — 試下放寬啲</p>
      ) : (
        <Card className="border-border/40 overflow-hidden">
          <CardContent className="p-0">
            <div className="divide-y divide-border/20">
              {products.slice(0, shown).map((p) => (
                <button
                  key={p.pid}
                  onClick={() => setOpenPid(p.pid)}
                  className="w-full px-4 py-2 flex items-center gap-3 text-left hover:bg-muted/20 transition-colors"
                  data-testid={`price-product-${p.pid}`}
                >
                  {imgMap[String(p.pid)] ? (
                    <img src={imgMap[String(p.pid)]!} alt="" loading="lazy" className="w-10 h-10 max-w-none object-cover rounded border border-border/40 shrink-0 bg-white" />
                  ) : (
                    <div className="w-10 h-10 rounded bg-muted/40 border border-border/40 shrink-0" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-sm truncate">
                      {dirtyPids.has(p.pid) && <span className="text-amber-300 mr-1" title="有未儲存改動">●</span>}
                      {p.title}
                    </p>
                    <p className="text-[11px] text-muted-foreground truncate">{p.vendor}{p.ptype ? ` · ${p.ptype}` : ''}</p>
                  </div>
                  <span className="text-sm tabular-nums whitespace-nowrap">{fmtRange(p.minP, p.maxP)}</span>
                  <span className="text-[11px] text-muted-foreground tabular-nums w-14 text-right shrink-0">{p.variants.length} SKU</span>
                </button>
              ))}
            </div>
            {products.length > shown && (
              <button
                onClick={() => setShown((n) => n + PAGE)}
                className="w-full py-2.5 text-xs text-muted-foreground hover:text-foreground border-t border-border/40"
                data-testid="price-editor-more"
              >
                顯示更多(仲有 {products.length - shown} 件)
              </button>
            )}
          </CardContent>
        </Card>
      )}

      {/* 改價 modal — 撳咗件貨先見到 SKU 同輸入欄 */}
      {openProduct && (
        <div className="fixed inset-0 z-[100] bg-black/70 flex items-center justify-center p-4" onClick={() => !saving && setOpenPid(null)}>
          <div className="bg-card border border-border rounded-lg max-w-6xl w-full max-h-[90vh] overflow-y-auto" onClick={(ev) => ev.stopPropagation()}>
            <div className="sticky top-0 bg-card border-b border-border/40 px-4 py-3 flex items-start gap-3 z-10">
              {(detail?.featured ?? imgMap[String(openProduct.pid)]) ? (
                <img
                  src={(detail?.featured ?? imgMap[String(openProduct.pid)])!}
                  alt=""
                  className="w-20 h-20 max-w-none object-cover rounded border border-border/40 shrink-0 bg-white cursor-zoom-in"
                  title="撳嚟睇大圖"
                  onClick={() => setLightbox((detail?.featured ?? imgMap[String(openProduct.pid)])!)}
                />
              ) : (
                <div className="w-20 h-20 rounded bg-muted/40 border border-border/40 shrink-0" />
              )}
              <div className="min-w-0 flex-1">
                <h3 className="text-lg font-semibold truncate">{openProduct.title}</h3>
                <p className="text-sm text-muted-foreground">{openProduct.vendor}{openProduct.ptype ? ` · ${openProduct.ptype}` : ''} · 改完撳「儲存」先會郁 Shopify</p>
                {detail?.loading ? (
                  <p className="text-sm text-muted-foreground animate-pulse mt-1">攞緊顏色/圖…</p>
                ) : detail && detail.optionSummary.length > 0 ? (
                  <p className="text-sm mt-1 flex flex-wrap gap-x-4 gap-y-0.5">
                    {detail.optionSummary.map((o) => (
                      <span key={o.name} className="text-muted-foreground">
                        {o.name}:<span className="text-foreground">{o.values.join(' · ')}</span>
                      </span>
                    ))}
                  </p>
                ) : null}
              </div>
              <button onClick={() => setOpenPid(null)} className="p-1 rounded hover:bg-muted/40 shrink-0" title="閂(Esc)" data-testid="price-modal-close">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="overflow-x-auto">
              {/* min-w:塞唔落就橫向 scroll — 唔好俾瀏覽器壓縮啲欄(壓縮會令圖同
                  狀態文字變晒幼條;Tailwind preflight img max-width:100% 係幫兇) */}
              <table className="w-full min-w-[1080px] text-sm">
                <thead>
                  <tr className="border-b border-border/40 bg-muted/30">
                    <th className="text-left px-3 py-2 font-medium text-muted-foreground w-16">圖</th>
                    <th className="text-left px-3 py-2 font-medium text-muted-foreground">SKU</th>
                    <th className="text-left px-3 py-2 font-medium text-muted-foreground">顏色</th>
                    <th className="text-left px-3 py-2 font-medium text-muted-foreground w-20">SIZE</th>
                    <th className="text-right px-3 py-2 font-medium text-muted-foreground">庫存</th>
                    <th className="text-right px-3 py-2 font-medium text-muted-foreground">成本</th>
                    <th className="text-right px-3 py-2 font-medium text-muted-foreground">售價 HK$</th>
                    <th className="text-right px-3 py-2 font-medium text-muted-foreground" title="Compare-at price — 高過售價先會顯示做劃線原價/折扣">劃線價 HK$</th>
                    <th className="text-right px-3 py-2 font-medium text-muted-foreground">毛利率</th>
                    <th className="text-left px-3 py-2 font-medium text-muted-foreground w-56">狀態</th>
                  </tr>
                </thead>
                <tbody>
                  {openProduct.variants.map((r) => {
                    const vid = r.variant_id;
                    const e = edits[vid];
                    const priceVal = e ? e.price : priceStr(r.price);
                    const compareVal = e ? e.compare : priceStr(r.compare_at_price);
                    const newP = Number(priceVal);
                    const touched =
                      e != null && (e.price !== priceStr(r.price) || e.compare !== priceStr(r.compare_at_price));
                    const m = marginPct(isFinite(newP) && newP > 0 ? newP : r.price, r.cost);
                    const cmpNum = compareVal.trim() === '' ? null : Number(compareVal);
                    const cmpWeird = cmpNum != null && isFinite(cmpNum) && cmpNum > 0 && isFinite(newP) && cmpNum <= newP;
                    const vImg = detail?.byVid[vid]?.imageUrl ?? detail?.featured ?? null;
                    return (
                      <tr key={vid} className={`border-b border-border/20 ${touched ? 'bg-amber-500/10' : ''}`} data-testid={`price-row-${vid}`}>
                        <td className="px-3 py-2">
                          {vImg ? (
                            <img
                              src={vImg}
                              alt=""
                              loading="lazy"
                              className="w-12 h-12 max-w-none object-cover rounded border border-border/40 bg-white cursor-zoom-in"
                              title="撳嚟睇大圖"
                              onClick={() => setLightbox(vImg)}
                            />
                          ) : (
                            <div className="w-12 h-12 rounded bg-muted/40 border border-border/40" />
                          )}
                        </td>
                        <td className="px-3 py-2 tabular-nums whitespace-nowrap">{r.sku ?? '—'}</td>
                        {(() => {
                          const [colour, size] = splitVariant(r.variant_title);
                          return (
                            <>
                              <td className="px-3 py-2 whitespace-nowrap">{colour ?? '—'}</td>
                              <td className="px-3 py-2 whitespace-nowrap font-medium">{size ?? '—'}</td>
                            </>
                          );
                        })()}
                        <td className="px-3 py-2 text-right tabular-nums">{r.inventory_quantity ?? '—'}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{r.cost != null && r.cost > 0 ? formatCurrency(r.cost) : '—'}</td>
                        <td className="px-3 py-2 text-right">
                          <input
                            value={priceVal}
                            onChange={(ev) => setEdit(vid, 'price', ev.target.value, r)}
                            inputMode="decimal"
                            className="w-28 px-2.5 py-1.5 rounded border border-border bg-background text-right tabular-nums"
                            data-testid={`price-input-${vid}`}
                          />
                        </td>
                        <td className="px-3 py-2 text-right">
                          <input
                            value={compareVal}
                            onChange={(ev) => setEdit(vid, 'compare', ev.target.value, r)}
                            inputMode="decimal"
                            placeholder="冇"
                            className="w-28 px-2.5 py-1.5 rounded border border-border bg-background text-right tabular-nums"
                            data-testid={`compare-input-${vid}`}
                          />
                        </td>
                        <td className={`px-3 py-2 text-right tabular-nums ${m != null && m < 20 ? 'text-red-300' : ''}`}>{m != null ? `${m.toFixed(0)}%` : '—'}</td>
                        <td className="px-3 py-2">
                          {rowErrors[vid] ? (
                            <span className="text-red-300">{rowErrors[vid]}</span>
                          ) : savedIds.has(vid) ? (
                            <span className="text-emerald-300">✅ 已同步</span>
                          ) : cmpWeird ? (
                            <span className="text-amber-300 inline-flex items-center gap-1"><TriangleAlert className="h-3 w-3" /> 劃線價唔高過售價</span>
                          ) : touched ? (
                            <span className="text-amber-300">未儲存</span>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="sticky bottom-0 bg-card border-t border-border/40 px-4 py-3 flex items-center gap-2">
              <span className="text-sm text-muted-foreground">
                {openChanges.length > 0 ? `呢件貨 ${openChanges.length} 項未儲存` : '未有改動'}
              </span>
              <div className="ml-auto flex gap-2">
                <button onClick={() => setOpenPid(null)} className="px-4 py-2 rounded border border-border text-sm hover:text-foreground">閂</button>
                <button
                  onClick={() => openChanges.length > 0 && setConfirmChanges(openChanges)}
                  disabled={openChanges.length === 0 || saving}
                  className="px-5 py-2 rounded bg-primary text-primary-foreground text-sm font-semibold disabled:opacity-50"
                  data-testid="price-modal-save"
                >
                  儲存改價…
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 改價 confirm — 舊→新 對照 + 警告,睇清楚先出手 */}
      {confirmChanges && (
        <div className="fixed inset-0 z-[110] bg-black/70 flex items-center justify-center p-4" onClick={() => !saving && setConfirmChanges(null)}>
          <div className="bg-card border border-border rounded-lg max-w-2xl w-full max-h-[80vh] overflow-y-auto p-4 space-y-3" onClick={(ev) => ev.stopPropagation()}>
            <h3 className="text-base font-semibold">確認改價({confirmChanges.length} 個 SKU)— 一撳即生效落網店 + POS</h3>
            <div className="space-y-2">
              {confirmChanges.map((c) => (
                <div key={c.variantId} className="rounded border border-border/50 px-3 py-2 text-sm space-y-1">
                  <p className="font-medium">{c.label}</p>
                  <p className="tabular-nums text-muted-foreground">
                    {c.newP != null && (
                      <>售價 {formatCurrency(c.oldP)} → <span className="text-foreground font-semibold">{formatCurrency(c.newP)}</span>　</>
                    )}
                    {c.newC !== undefined && (
                      <>劃線價 {c.oldC != null ? formatCurrency(c.oldC) : '冇'} → <span className="text-foreground font-semibold">{c.newC != null ? formatCurrency(c.newC) : '清走'}</span></>
                    )}
                  </p>
                  {c.warnings.map((w, i) => (
                    <p key={i} className="text-amber-300">⚠️ {w}</p>
                  ))}
                </div>
              ))}
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button onClick={() => setConfirmChanges(null)} disabled={saving} className="px-3 py-1.5 rounded border border-border text-xs hover:text-foreground">取消</button>
              <button onClick={() => doSave(confirmChanges)} disabled={saving} className="px-4 py-1.5 rounded bg-primary text-primary-foreground text-xs font-semibold disabled:opacity-50" data-testid="price-editor-confirm">
                {saving ? '改緊價…' : '確認改價'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 產品/variant 大圖 lightbox — 撳任何地方或 Esc 閂 */}
      {lightbox && (
        <div
          className="fixed inset-0 z-[130] bg-black/85 flex items-center justify-center p-6 cursor-zoom-out"
          onClick={() => setLightbox(null)}
          data-testid="price-image-lightbox"
        >
          <img src={lightbox} alt="" className="max-w-[92vw] max-h-[92vh] object-contain rounded-lg shadow-2xl bg-white" />
        </div>
      )}
    </div>
  );
}
