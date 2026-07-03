import { useEffect, useState, useMemo, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { formatNumber } from '@/lib/format';
import {
  Megaphone, RefreshCw, AlertCircle, Search, Sparkles, Copy, Check,
  PackageOpen, Store, BadgePercent, CloudSun, Loader2, X,
} from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { fetchAllRows, type Promotion, type PromotionItem } from '@/lib/promotions-shared';
import {
  generateMarketingPost, fetchLiveProduct, variantToClipboard,
  PLATFORM_LABEL, TONE_LABEL, LANG_LABEL, SCENARIO_LABEL,
  type PostType, type Tone, type Lang, type Platform, type ScenarioKey,
  type PostVariant, type GenProduct,
} from '@/lib/marketing-post';

/**
 * 營銷貼文 Post Studio — P1 文案 MVP。
 * 流程:揀類型 → 揀產品(每類型有智能候選)→ 設定 → AI 生成 → 逐格編輯 → copy。
 * 生成嗰刻經 /api/shopify-product 攞 live 價,唔用隔夜 snapshot。
 */

interface InvRow {
  sku: string;
  product_id: number | string | null;
  product_title: string | null;
  vendor: string | null;
  product_type: string | null;
  inventory_quantity: number | null;
  price: number | string | null;
  compare_at_price: number | string | null;
}
interface ShopifyProductRow { id: number | string; created_at: string | null; status: string | null; }
interface BcRow { number: string | null; unit_cost: number | string | null; }

interface PickerProduct {
  product_id: string;
  title: string;
  vendor: string;
  product_type: string;
  qty: number;
  minPrice: number;
  maxCompare: number | null;
  maxCost: number; // 同產品 SKU 之中最高成本 — 安全欄用最保守值
  createdAt: string | null;
  promo: { name: string; promoPrice: number | null; endDate: string } | null;
}

const CORE_TYPES: { key: PostType; label: string; desc: string; icon: any }[] = [
  { key: 'new_arrival', label: '新品介紹', desc: '90 日內新貨,自動候選', icon: PackageOpen },
  { key: 'brand_story', label: '品牌介紹', desc: '揀品牌,AI 搵官方背景', icon: Store },
  { key: 'weekly_deal', label: '本周優惠', desc: '推行中活動商品 + 期限', icon: BadgePercent },
  { key: 'scenario', label: '情境貼', desc: '雨天/夏日等場景組合', icon: CloudSun },
];

const SCENARIO_MATCH: Record<ScenarioKey, RegExp> = {
  rainy: /rain|waterproof|防水|雨|anti-?fog|防霧|pinlock/i,
  summer: /mesh|vent|air|summer|cool|透氣|涼|夏/i,
  night: /reflect|led|light|night|反光|夜|photochromic|變色/i,
  touring: /tour|comfort|luggage|bag|tank|touring|長途|袋|尾箱/i,
  beginner: /protector|ce level|glove|護具|護膝|護肘|入門/i,
};

const MAX_SELECT = 6;

export default function MarketingPostsPage() {
  // ── 數據 ──
  const [products, setProducts] = useState<PickerProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // ── wizard state ──
  const [postType, setPostType] = useState<PostType>('new_arrival');
  const [search, setSearch] = useState('');
  const [vendorFilter, setVendorFilter] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [scenario, setScenario] = useState<ScenarioKey>('summer');
  const [tone, setTone] = useState<Tone>('value');
  const [lang, setLang] = useState<Lang>('yue');
  const [platforms, setPlatforms] = useState<Set<Platform>>(new Set(['ig_post']));

  // ── 生成 ──
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [genNotice, setGenNotice] = useState<string | null>(null);
  const [variants, setVariants] = useState<PostVariant[]>([]);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [inv, shopifyProducts, promos, items, bc] = await Promise.all([
        fetchAllRows<InvRow>(
          'shopify_inventory',
          'sku,product_id,product_title,vendor,product_type,inventory_quantity,price,compare_at_price'
        ),
        fetchAllRows<ShopifyProductRow>('shopify_products', 'id,created_at,status'),
        fetchAllRows<Promotion>('promotions'),
        fetchAllRows<PromotionItem>('promotion_items'),
        fetchAllRows<BcRow>('bc_inventory', 'number,unit_cost'),
      ]);

      const costBySku = new Map<string, number>();
      for (const b of bc) {
        const c = Number(b.unit_cost) || 0;
        if (b.number && c > 0) costBySku.set(b.number, c);
      }
      const metaById = new Map<string, ShopifyProductRow>();
      for (const sp of shopifyProducts) metaById.set(String(sp.id), sp);

      const today = new Date().toISOString().slice(0, 10);
      const activePromoById = new Map<string, Promotion>(
        promos.filter(p => p.status === 'active' && p.end_date >= today).map(p => [p.id, p])
      );
      const promoByProduct = new Map<string, { name: string; promoPrice: number | null; endDate: string }>();
      for (const it of items) {
        if (it.is_archived) continue;
        const promo = activePromoById.get(it.promotion_id);
        if (!promo) continue;
        promoByProduct.set(String(it.product_id), {
          name: promo.name,
          promoPrice: it.promo_price != null ? Number(it.promo_price) : null,
          endDate: promo.end_date,
        });
      }

      // group inventory rows → product
      const byProduct = new Map<string, InvRow[]>();
      for (const r of inv) {
        if (r.product_id == null) continue;
        const k = String(r.product_id);
        const arr = byProduct.get(k) ?? [];
        arr.push(r);
        byProduct.set(k, arr);
      }

      const out: PickerProduct[] = [];
      for (const [pid, rows] of byProduct.entries()) {
        const meta = metaById.get(pid);
        if (meta?.status && meta.status.toLowerCase() !== 'active') continue; // draft/archived 唔推
        const prices = rows.map(r => Number(r.price) || 0).filter(n => n > 0);
        const compares = rows.map(r => Number(r.compare_at_price) || 0).filter(n => n > 0);
        const costs = rows.map(r => (r.sku ? costBySku.get(r.sku) ?? 0 : 0));
        out.push({
          product_id: pid,
          title: rows[0].product_title ?? '—',
          vendor: rows[0].vendor ?? '—',
          product_type: rows[0].product_type ?? '—',
          qty: rows.reduce((s, r) => s + (r.inventory_quantity ?? 0), 0),
          minPrice: prices.length ? Math.min(...prices) : 0,
          maxCompare: compares.length ? Math.max(...compares) : null,
          maxCost: Math.max(0, ...costs),
          createdAt: meta?.created_at ?? null,
          promo: promoByProduct.get(pid) ?? null,
        });
      }
      out.sort((a, b) => a.title.localeCompare(b.title));
      setProducts(out);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // 換類型:清返選擇,免帶錯產品過去
  const pickType = (t: PostType) => {
    setPostType(t);
    setSelected(new Set());
    setVariants([]);
    setGenError(null);
    setGenNotice(null);
  };

  // ── 每類型嘅智能候選名單 ──
  const candidates = useMemo(() => {
    const ninety = Date.now() - 90 * 86400000;
    let list = products.filter(p => p.qty > 0); // 缺貨一律唔入候選
    switch (postType) {
      case 'new_arrival':
        list = list
          .filter(p => p.createdAt && new Date(p.createdAt).getTime() > ninety)
          .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
        break;
      case 'brand_story':
        if (vendorFilter) list = list.filter(p => p.vendor === vendorFilter);
        break;
      case 'weekly_deal':
        list = list.filter(p => p.promo != null);
        break;
      case 'scenario': {
        const re = SCENARIO_MATCH[scenario];
        list = list.filter(p => re.test(`${p.title} ${p.product_type}`));
        break;
      }
      default:
        break;
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(p => p.title.toLowerCase().includes(q) || p.vendor.toLowerCase().includes(q));
    }
    return list.slice(0, 300);
  }, [products, postType, vendorFilter, scenario, search]);

  const vendorOptions = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of products) {
      if (p.qty <= 0) continue;
      m.set(p.vendor, (m.get(p.vendor) ?? 0) + 1);
    }
    return Array.from(m.entries()).sort((a, b) => b[1] - a[1]).map(([k]) => k);
  }, [products]);

  const toggleSelect = (pid: string) => {
    setSelected(s => {
      const next = new Set(s);
      if (next.has(pid)) next.delete(pid);
      else if (next.size < MAX_SELECT) next.add(pid);
      return next;
    });
  };

  const togglePlatform = (pl: Platform) => {
    setPlatforms(s => {
      const next = new Set(s);
      if (next.has(pl)) { if (next.size > 1) next.delete(pl); }
      else next.add(pl);
      return next;
    });
  };

  // ── 生成 ──
  const handleGenerate = async () => {
    if (selected.size === 0 || generating) return;
    setGenerating(true);
    setGenError(null);
    setGenNotice(null);
    setVariants([]);
    try {
      const picked = products.filter(p => selected.has(p.product_id));

      // 生成嗰刻攞 live 數據(並行);失敗就用 snapshot + 提示
      const lives = await Promise.all(picked.map(p => fetchLiveProduct(p.product_id)));
      let staleCount = 0;
      const genProducts: GenProduct[] = picked.map((p, i) => {
        const live = lives[i];
        if (!live) staleCount++;
        const price = live?.price ?? p.minPrice;
        const qty = live ? live.totalQty : p.qty;
        return {
          title: live?.title || p.title,
          vendor: live?.vendor || p.vendor,
          productType: live?.productType || p.product_type,
          price,
          comparePrice: live ? live.comparePrice : p.maxCompare,
          promoPrice: p.promo?.promoPrice ?? null,
          promoEndDate: p.promo?.endDate ?? null,
          qty,
          sellingPoints: live?.descriptionText || '',
          cost: p.maxCost > 0 ? p.maxCost : null,
        };
      });

      // 前置安全欄(server 會再驗一次)
      const belowCost = genProducts.filter(
        g => g.cost != null && (g.promoPrice ?? g.price) < g.cost
      );
      if (belowCost.length > 0) {
        throw new Error(`以下產品售價低過成本,唔可以出貼文:${belowCost.map(b => b.title).join('、')}`);
      }
      const inStock = genProducts.filter(g => g.qty > 0);
      if (inStock.length === 0) throw new Error('所揀產品全部缺貨(以 live 庫存為準)');
      const droppedOos = genProducts.length - inStock.length;

      const result = await generateMarketingPost({
        postType,
        products: inStock,
        scenario: postType === 'scenario' ? scenario : null,
        tone,
        lang,
        platforms: Array.from(platforms),
      });
      setVariants(result.variants);

      const notices: string[] = [];
      if (staleCount > 0) notices.push(`${staleCount} 件產品攞唔到 live 價,用咗每日 snapshot 數(出街前請自行核對價錢)`);
      if (droppedOos > 0) notices.push(`${droppedOos} 件缺貨產品已自動剔走`);
      if (result.dropped.belowCost.length > 0) notices.push(`已擋(低過成本):${result.dropped.belowCost.join('、')}`);
      if (notices.length > 0) setGenNotice(notices.join(' · '));
    } catch (e) {
      setGenError(e instanceof Error ? e.message : String(e));
    } finally {
      setGenerating(false);
    }
  };

  const updateVariant = (idx: number, patch: Partial<PostVariant>) => {
    setVariants(vs => vs.map((v, i) => (i === idx ? { ...v, ...patch } : v)));
  };

  const copyVariant = async (idx: number) => {
    try {
      await navigator.clipboard.writeText(variantToClipboard(variants[idx]));
      setCopiedIdx(idx);
      setTimeout(() => setCopiedIdx(c => (c === idx ? null : c)), 2000);
    } catch {
      alert('複製失敗 — 請手動選取文字');
    }
  };

  // ─────────────────────────── render ───────────────────────────
  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <Megaphone className="h-5 w-5 text-primary" />
          <h1 className="text-lg font-semibold">營銷貼文</h1>
          <span className="text-xs text-muted-foreground">Post Studio · AI 文案(P1)</span>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="text-xs px-3 py-1.5 rounded-md border border-border bg-card hover:bg-accent/60 transition-colors inline-flex items-center gap-1"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          重新整理
        </button>
      </div>

      {error && (
        <div className="rounded-md border border-rose-500/40 bg-rose-500/10 p-3 text-rose-200 text-sm flex items-center gap-2">
          <AlertCircle className="h-4 w-4" /> {error}
        </div>
      )}

      {/* ① 揀類型 */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
        {CORE_TYPES.map(t => {
          const Icon = t.icon;
          const active = postType === t.key;
          return (
            <button
              key={t.key}
              onClick={() => pickType(t.key)}
              className={`rounded-md border p-3 text-left transition-colors ${
                active ? 'border-primary bg-primary/10' : 'border-border bg-card hover:bg-accent/40'
              }`}
              data-testid={`posttype-${t.key}`}
            >
              <div className="flex items-center gap-2">
                <Icon className={`h-4 w-4 ${active ? 'text-primary' : 'text-muted-foreground'}`} />
                <span className="text-sm font-medium">{t.label}</span>
              </div>
              <div className="text-[11px] text-muted-foreground mt-1">{t.desc}</div>
            </button>
          );
        })}
      </div>

      {/* ② 揀產品 */}
      <div className="rounded-md border border-border/60 bg-card p-3 space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[180px] max-w-sm">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="搜尋產品/品牌…"
              className="w-full pl-8 pr-3 py-1.5 text-xs rounded-md border border-border bg-background"
            />
          </div>
          {postType === 'brand_story' && (
            <select
              value={vendorFilter}
              onChange={e => setVendorFilter(e.target.value)}
              className="text-xs px-2 py-1.5 rounded-md border border-border bg-background"
            >
              <option value="">揀品牌…</option>
              {vendorOptions.map(v => <option key={v} value={v}>{v}</option>)}
            </select>
          )}
          {postType === 'scenario' && (
            <select
              value={scenario}
              onChange={e => setScenario(e.target.value as ScenarioKey)}
              className="text-xs px-2 py-1.5 rounded-md border border-border bg-background"
            >
              {(Object.keys(SCENARIO_LABEL) as ScenarioKey[]).map(k => (
                <option key={k} value={k}>{SCENARIO_LABEL[k]}</option>
              ))}
            </select>
          )}
          <span className="text-[11px] text-muted-foreground ml-auto tabular-nums">
            候選 {formatNumber(candidates.length)} · 已揀 {selected.size}/{MAX_SELECT}
          </span>
          {selected.size > 0 && (
            <button
              onClick={() => setSelected(new Set())}
              className="text-[11px] px-2 py-1 rounded-md border border-border hover:bg-accent/60 inline-flex items-center gap-1"
            >
              <X className="h-3 w-3" /> 清空
            </button>
          )}
        </div>

        {loading ? (
          <Skeleton className="h-48 w-full" />
        ) : candidates.length === 0 ? (
          <div className="text-center text-xs text-muted-foreground py-8">
            {postType === 'brand_story' && !vendorFilter ? '先揀一個品牌' : '冇符合條件嘅候選產品'}
          </div>
        ) : (
          <div className="max-h-72 overflow-y-auto rounded border border-border/40">
            <table className="w-full text-xs">
              <thead className="bg-muted/30 sticky top-0">
                <tr>
                  <th className="w-8 px-2 py-1.5"></th>
                  <th className="text-left px-2 py-1.5 font-normal text-muted-foreground">產品</th>
                  <th className="text-left px-2 py-1.5 font-normal text-muted-foreground">品牌</th>
                  <th className="text-right px-2 py-1.5 font-normal text-muted-foreground">價</th>
                  <th className="text-right px-2 py-1.5 font-normal text-muted-foreground">庫存</th>
                  <th className="text-left px-2 py-1.5 font-normal text-muted-foreground">備註</th>
                </tr>
              </thead>
              <tbody>
                {candidates.map(p => {
                  const isSel = selected.has(p.product_id);
                  return (
                    <tr
                      key={p.product_id}
                      onClick={() => toggleSelect(p.product_id)}
                      className={`border-t border-border/30 cursor-pointer hover:bg-accent/30 ${isSel ? 'bg-primary/5' : ''}`}
                    >
                      <td className="px-2 py-1.5">
                        <input type="checkbox" readOnly checked={isSel} className="cursor-pointer" />
                      </td>
                      <td className="px-2 py-1.5 font-medium">{p.title}</td>
                      <td className="px-2 py-1.5 text-muted-foreground">{p.vendor}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">
                        {p.promo?.promoPrice ? (
                          <span className="text-amber-300">${p.promo.promoPrice}</span>
                        ) : (
                          <>${p.minPrice}</>
                        )}
                      </td>
                      <td className={`px-2 py-1.5 text-right tabular-nums ${p.qty <= 3 ? 'text-amber-300' : ''}`}>{p.qty}</td>
                      <td className="px-2 py-1.5 text-muted-foreground">
                        {p.promo ? `${p.promo.name} 至 ${p.promo.endDate}` : p.qty <= 3 ? '低庫存' : ''}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ③ 設定 + 生成 */}
      <div className="rounded-md border border-border/60 bg-card p-3 flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-1.5">
          {(Object.keys(PLATFORM_LABEL) as Platform[]).map(pl => (
            <button
              key={pl}
              onClick={() => togglePlatform(pl)}
              className={`text-xs px-2.5 py-1 rounded-md border transition-colors ${
                platforms.has(pl)
                  ? 'bg-primary/90 text-primary-foreground border-primary'
                  : 'border-border bg-background hover:bg-accent/60'
              }`}
            >
              {PLATFORM_LABEL[pl]}
            </button>
          ))}
        </div>
        <select value={tone} onChange={e => setTone(e.target.value as Tone)}
          className="text-xs px-2 py-1.5 rounded-md border border-border bg-background">
          {(Object.keys(TONE_LABEL) as Tone[]).map(t => <option key={t} value={t}>語氣:{TONE_LABEL[t]}</option>)}
        </select>
        <select value={lang} onChange={e => setLang(e.target.value as Lang)}
          className="text-xs px-2 py-1.5 rounded-md border border-border bg-background">
          {(Object.keys(LANG_LABEL) as Lang[]).map(l => <option key={l} value={l}>語言:{LANG_LABEL[l]}</option>)}
        </select>
        <button
          onClick={handleGenerate}
          disabled={selected.size === 0 || generating}
          className="ml-auto text-xs px-4 py-1.5 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 inline-flex items-center gap-1.5"
          data-testid="button-generate"
        >
          {generating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
          {generating ? '生成中…(10-30 秒)' : variants.length > 0 ? '再生成一版' : '生成文案'}
        </button>
      </div>

      {genError && (
        <div className="rounded-md border border-rose-500/40 bg-rose-500/10 p-3 text-rose-200 text-sm flex items-center gap-2">
          <AlertCircle className="h-4 w-4 shrink-0" /> {genError}
        </div>
      )}
      {genNotice && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 text-amber-200 text-xs">
          ⚠ {genNotice}
        </div>
      )}

      {/* ④ 結果 — 逐格可編輯 */}
      {variants.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-3">
          {variants.map((v, idx) => (
            <div key={idx} className="rounded-md border border-border/60 bg-card p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[11px] px-2 py-0.5 rounded-full bg-primary/10 text-primary font-medium">
                  {PLATFORM_LABEL[v.platform] ?? v.platform}
                </span>
                <button
                  onClick={() => copyVariant(idx)}
                  className="text-[11px] px-2 py-1 rounded-md border border-border hover:bg-accent/60 inline-flex items-center gap-1"
                  data-testid={`copy-variant-${idx}`}
                >
                  {copiedIdx === idx ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
                  {copiedIdx === idx ? '已複製' : 'Copy 全文'}
                </button>
              </div>
              <input
                value={v.headline}
                onChange={e => updateVariant(idx, { headline: e.target.value })}
                className="w-full px-2 py-1.5 text-sm font-semibold rounded-md border border-border bg-background"
                placeholder="標題"
              />
              <textarea
                value={v.body}
                onChange={e => updateVariant(idx, { body: e.target.value })}
                rows={v.platform === 'ig_story' ? 3 : 7}
                className="w-full px-2 py-1.5 text-xs rounded-md border border-border bg-background resize-y leading-relaxed"
                placeholder="內文"
              />
              <input
                value={v.cta}
                onChange={e => updateVariant(idx, { cta: e.target.value })}
                className="w-full px-2 py-1.5 text-xs rounded-md border border-border bg-background"
                placeholder="CTA"
              />
              <textarea
                value={v.hashtags.join(' ')}
                onChange={e => updateVariant(idx, { hashtags: e.target.value.split(/\s+/).filter(Boolean) })}
                rows={2}
                className="w-full px-2 py-1.5 text-xs rounded-md border border-border bg-background resize-y text-sky-300"
                placeholder="#hashtags"
              />
              <div className="text-[10px] text-muted-foreground">
                圖片 alt:{v.altText || '—'}
              </div>
            </div>
          ))}
        </div>
      )}

      {variants.length === 0 && !generating && !loading && (
        <div className="rounded-md border border-dashed border-border/60 p-10 text-center text-sm text-muted-foreground">
          揀好類型同產品(最多 {MAX_SELECT} 件),㩒「生成文案」。<br />
          <span className="text-xs">AI 只會用已核實嘅產品資料寫文案;生成嗰刻會攞 Shopify live 價。出街前請人手核對。</span>
        </div>
      )}
    </div>
  );
}
