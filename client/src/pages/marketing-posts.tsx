import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { formatNumber } from '@/lib/format';
import {
  Megaphone, RefreshCw, AlertCircle, Search, Sparkles, Copy, Check,
  PackageOpen, Store, BadgePercent, CloudSun, Loader2, X,
  ImageIcon, Send, Download,
} from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { fetchAllRows, todayISO, type Promotion, type PromotionItem } from '@/lib/promotions-shared';
import { supabase } from '@/lib/supabase';
import { renderPostCard, downloadDataUrl, type CardProduct, type CardTemplate, type CardSize } from '@/lib/post-card';
import {
  generateMarketingPost, fetchLiveProduct, variantToClipboard, buildTemplateVariants,
  PLATFORM_LABEL, TONE_LABEL, LANG_LABEL, SCENARIO_LABEL,
  type PostType, type Tone, type Lang, type Platform, type ScenarioKey,
  type PostVariant, type GenProduct,
} from '@/lib/marketing-post';

/**
 * 營銷貼文 Post Studio — P1 文案 MVP。
 * 流程:揀類型 → 揀產品(每類型有智能候選)→ 設定 → AI 生成 → 逐格編輯 → copy。
 * 生成嗰刻經 /api/shopify-product 攞 live 價,唔用隔夜 snapshot。
 *
 * 價格合規:price/comparePrice/cost 一律嚟自「最平嗰個 variant」(同一個 SKU),
 * 唔准跨 variant 溝數 — 否則 min 價配 max 劃線價會誇大折扣。
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
  // 以下三個欄一律嚟自最平嗰行(同一個 SKU)
  price: number;
  comparePrice: number | null;
  cost: number;
  sku: string;
  createdAt: string | null;
  promo: { name: string; promoPrice: number | null; endDate: string } | null;
}

// 編輯用 variant — hashtags 以原始文字保存,唔好喺每下 keystroke 就 split
// (split(/\s+/) on change 會令空格打唔出)
type EditableVariant = PostVariant & { hashtagsText: string };

const CORE_TYPES: { key: PostType; label: string; desc: string; icon: any }[] = [
  { key: 'new_arrival', label: '新品介紹', desc: '90 日內新貨,自動候選', icon: PackageOpen },
  { key: 'brand_story', label: '品牌介紹', desc: '揀品牌,AI 搵官方背景', icon: Store },
  { key: 'weekly_deal', label: '本周優惠', desc: '推行中活動商品 + 期限', icon: BadgePercent },
  { key: 'scenario', label: '情境貼', desc: '雨天/夏日等場景組合', icon: CloudSun },
];

// 英文關鍵字用 \b 綁字界 — 免 air→Airoh、vent→Adventure、led→shielded 呢類誤中
const SCENARIO_MATCH: Record<ScenarioKey, RegExp> = {
  rainy: /\b(rain|waterproof|pinlock|anti-?fog)\b|防水|雨|防霧/i,
  summer: /\b(mesh|vent|vented|airflow|air|summer|cool)\b|透氣|涼|夏/i,
  night: /\b(reflect|reflective|led|night|photochromic)\b|反光|夜|變色/i,
  touring: /\b(tour|touring|luggage|comfort)\b|長途|袋|尾箱/i,
  beginner: /\b(protector|gloves?)\b|ce level|護具|護膝|護肘|入門/i,
};

const MAX_SELECT = 6;

export default function MarketingPostsPage() {
  // ── 數據 ──
  const [products, setProducts] = useState<PickerProduct[]>([]);
  const [costBySku, setCostBySku] = useState<Map<string, number>>(new Map());
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
  const [capMsg, setCapMsg] = useState(false);

  // ── 生成 ──
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [genNotice, setGenNotice] = useState<string | null>(null);
  const [variants, setVariants] = useState<EditableVariant[]>([]);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  // 生成上下文序號 — 換類型/情境後,飛行中嘅舊 request 結果一律作廢
  const genSeqRef = useRef(0);

  // ── 圖卡 state ──
  const [cardProducts, setCardProducts] = useState<CardProduct[]>([]);
  const [cardTemplate, setCardTemplate] = useState<CardTemplate>('dark');
  const [cardSize, setCardSize] = useState<CardSize>('square');
  const [cardUrls, setCardUrls] = useState<string[]>([]);
  const [renderingCards, setRenderingCards] = useState(false);
  const [sendingIdx, setSendingIdx] = useState<number | null>(null);
  const [slackNotice, setSlackNotice] = useState<string | null>(null);
  const [new90Stats, setNew90Stats] = useState<{ total: number; visible: number }>({ total: 0, visible: 0 });

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

      const costMap = new Map<string, number>();
      for (const b of bc) {
        const c = Number(b.unit_cost) || 0;
        if (b.number && c > 0) costMap.set(b.number, c);
      }
      setCostBySku(costMap);

      const metaById = new Map<string, ShopifyProductRow>();
      for (const sp of shopifyProducts) metaById.set(String(sp.id), sp);

      // 用 HKT 本地日期(todayISO),唔用 UTC — 半夜 12 點至朝早 8 點 UTC 日期仲係「琴日」,
      // 會令啱啱過咗期嘅優惠繼續當生效
      const today = todayISO();
      const activePromoById = new Map<string, Promotion>(
        promos.filter(p => p.status === 'active' && p.end_date >= today).map(p => [p.id, p])
      );
      // 一件商品可入多個進行中活動 —— 帖文只 feature 一個,揀法要 deterministic
      // (唔可以靠 Map last-write-wins,順序係任意)。規則:最快完結優先(最緊急宣傳),
      // 打和 → 推廣價低者,再打和 → promotion_id 穩定排序。排好後 first-wins。
      const activeAssignments = items
        .filter(it => !it.is_archived && activePromoById.has(it.promotion_id))
        .sort((a, b) => {
          const pa = activePromoById.get(a.promotion_id)!;
          const pb = activePromoById.get(b.promotion_id)!;
          if (pa.end_date !== pb.end_date) return pa.end_date < pb.end_date ? -1 : 1;
          const ppa = a.promo_price != null ? Number(a.promo_price) : Infinity;
          const ppb = b.promo_price != null ? Number(b.promo_price) : Infinity;
          if (ppa !== ppb) return ppa - ppb;
          return a.promotion_id < b.promotion_id ? -1 : a.promotion_id > b.promotion_id ? 1 : 0;
        });
      const promoByProduct = new Map<string, { name: string; promoPrice: number | null; endDate: string }>();
      for (const it of activeAssignments) {
        const pid = String(it.product_id);
        if (promoByProduct.has(pid)) continue; // 已有(更優先嗰個)→ 唔覆蓋
        const promo = activePromoById.get(it.promotion_id)!;
        promoByProduct.set(pid, {
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
        // 揀最平嗰行,price/compare/cost/sku 全部用佢一個嘅
        const pricedRows = rows.filter(r => (Number(r.price) || 0) > 0);
        const cheapest = pricedRows.length
          ? pricedRows.reduce((a, b) => (Number(b.price) < Number(a.price) ? b : a))
          : null;
        if (!cheapest) continue; // 冇有效價唔入候選
        const cheapCompare = Number(cheapest.compare_at_price) || 0;
        out.push({
          product_id: pid,
          title: rows[0].product_title ?? '—',
          vendor: rows[0].vendor ?? '—',
          product_type: rows[0].product_type ?? '—',
          qty: rows.reduce((s, r) => s + (r.inventory_quantity ?? 0), 0),
          price: Number(cheapest.price),
          comparePrice: cheapCompare > 0 ? cheapCompare : null,
          cost: cheapest.sku ? costMap.get(cheapest.sku) ?? 0 : 0,
          sku: cheapest.sku || '',
          createdAt: meta?.created_at ?? null,
          promo: promoByProduct.get(pid) ?? null,
        });
      }
      out.sort((a, b) => a.title.localeCompare(b.title));
      setProducts(out);

      // 90 日新貨統計:幾多款因冇庫存/冇價入唔到候選(empty state 老實講)
      const cutoff90 = Date.now() - 90 * 86400000;
      let total90 = 0;
      for (const [pid, rows] of byProduct.entries()) {
        const meta = metaById.get(pid);
        if (meta?.status && meta.status.toLowerCase() !== 'active') continue;
        if (meta?.created_at && new Date(meta.created_at).getTime() > cutoff90) total90++;
      }
      const visible90 = out.filter(p => p.qty > 0 && p.createdAt && new Date(p.createdAt).getTime() > cutoff90).length;
      setNew90Stats({ total: total90, visible: visible90 });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // 換上下文(類型/情境/品牌)→ 清選擇 + 作廢飛行中嘅生成
  const resetContext = () => {
    genSeqRef.current++;
    setSelected(new Set());
    setGenError(null);
    setGenNotice(null);
    setCardProducts([]);
    setCardUrls([]);
    setSlackNotice(null);
  };

  const pickType = (t: PostType) => {
    if (t === postType) return; // 撳返同一張卡唔好清嘢
    setPostType(t);
    setVariants([]);
    resetContext();
  };
  const pickScenario = (s: ScenarioKey) => {
    if (s === scenario) return;
    setScenario(s);
    resetContext();
  };
  const pickVendor = (v: string) => {
    if (v === vendorFilter) return;
    setVendorFilter(v);
    resetContext();
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
        // 未揀品牌 → 唔出候選(同「先揀一個品牌」提示一致)
        list = vendorFilter ? list.filter(p => p.vendor === vendorFilter) : [];
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

  const selectedProducts = useMemo(
    () => products.filter(p => selected.has(p.product_id)),
    [products, selected]
  );

  const toggleSelect = (pid: string) => {
    setSelected(s => {
      if (s.has(pid)) {
        const next = new Set(s);
        next.delete(pid);
        return next;
      }
      if (s.size >= MAX_SELECT) {
        setCapMsg(true);
        setTimeout(() => setCapMsg(false), 2500);
        return s; // 回傳原 set — 唔觸發冇意義嘅 re-render
      }
      const next = new Set(s);
      next.add(pid);
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
    const mySeq = ++genSeqRef.current; // 呢輪生成嘅序號
    setGenerating(true);
    setGenError(null);
    setGenNotice(null);
    // 注意:唔喺呢度清 variants — 舊(可能已人手改)嘅版本保留到新版成功先替換
    try {
      const picked = selectedProducts;

      // 生成嗰刻攞 live 數據(並行);失敗就用 snapshot + 提示
      const lives = await Promise.all(picked.map(p => fetchLiveProduct(p.product_id)));

      // 圖卡數據(用 live 相 + live 價;badge 按 post 類型)
      const cardBadge =
        postType === 'new_arrival' ? '新品' :
        postType === 'weekly_deal' ? '優惠' :
        postType === 'clearance' ? '清貨' : '精選';
      setCardProducts(picked.map((p, i) => ({
        title: lives[i]?.title || p.title,
        vendor: lives[i]?.vendor || p.vendor,
        price: lives[i]?.price ?? p.price,
        comparePrice: lives[i] ? lives[i]!.comparePrice : p.comparePrice,
        promoPrice: p.promo?.promoPrice ?? null,
        promoEndDate: p.promo?.endDate ?? null,
        imageUrl: lives[i]?.imageUrls?.[0] ?? null,
        badge: cardBadge,
      })));

      let staleCount = 0;
      const allGen: GenProduct[] = picked.map((p, i) => {
        const live = lives[i];
        if (!live) staleCount++;
        const price = live?.price ?? p.price;
        const qty = live ? live.totalQty : p.qty;
        // 成本同售價配對同一個 SKU:live 攞到就用 live 嗰個 variant 嘅 sku 搵成本
        const sku = live?.sku || p.sku;
        const cost = sku ? costBySku.get(sku) ?? 0 : 0;
        return {
          title: live?.title || p.title,
          vendor: live?.vendor || p.vendor,
          productType: live?.productType || p.product_type,
          price,
          comparePrice: live ? live.comparePrice : p.comparePrice,
          promoPrice: p.promo?.promoPrice ?? null,
          promoEndDate: p.promo?.endDate ?? null,
          qty,
          sellingPoints: live?.descriptionText || '',
          cost: cost > 0 ? cost : null,
        };
      });

      // 前置安全欄(server 會再驗一次)— 順序:先剔缺貨/冇價,先唔好俾佢哋擋死成單
      const inStock = allGen.filter(g => g.qty > 0);
      const droppedOos = allGen.length - inStock.length;
      const withPrice = inStock.filter(g => (g.promoPrice ?? g.price) > 0);
      const droppedNoPrice = inStock.length - withPrice.length;
      const belowCost = withPrice.filter(g => g.cost != null && (g.promoPrice ?? g.price) < g.cost);
      if (belowCost.length > 0) {
        throw new Error(`以下產品售價低過成本,唔可以出貼文:${belowCost.map(b => b.title).join('、')}`);
      }
      if (withPrice.length === 0) {
        throw new Error(droppedOos > 0 ? '所揀產品全部缺貨(以 live 庫存為準)' : '所揀產品冇有效售價');
      }

      const genInput = {
        postType,
        products: withPrice,
        scenario: postType === 'scenario' ? scenario : null,
        tone,
        lang,
        platforms: Array.from(platforms),
      };
      let result;
      let usedTemplate = false;
      try {
        result = await generateMarketingPost(genInput);
      } catch (genErr) {
        const msg = genErr instanceof Error ? genErr.message : String(genErr);
        // AI 未接線(冇 ANTHROPIC_API_KEY)→ 用基本模板文案,唔好成個功能死晒
        if (msg.includes('ANTHROPIC_API_KEY')) {
          result = {
            variants: buildTemplateVariants(genInput),
            dropped: { belowCost: [], outOfStock: 0, noPrice: 0 },
          };
          usedTemplate = true;
        } else {
          throw genErr;
        }
      }

      // 用戶喺等緊嗰陣換咗類型/情境 → 呢個結果已經唔啱 context,棄掉
      if (genSeqRef.current !== mySeq) return;

      setVariants(result.variants.map(v => ({ ...v, hashtagsText: v.hashtags.join(' ') })));

      const notices: string[] = [];
      if (usedTemplate) notices.push('AI 文案未接通(Vercel 未設定 ANTHROPIC_API_KEY)— 已改用基本模板文案,可以照改照 send;想要 AI 執筆先至使設定');
      if (staleCount > 0) notices.push(`${staleCount} 件產品攞唔到 live 價,用咗每日 snapshot 數(出街前請自行核對價錢)`);
      if (droppedOos > 0) notices.push(`${droppedOos} 件缺貨產品已自動剔走`);
      if (droppedNoPrice > 0 || result.dropped.noPrice > 0) notices.push(`${droppedNoPrice + result.dropped.noPrice} 件冇有效售價已剔走`);
      if (result.dropped.belowCost.length > 0) notices.push(`已擋(低過成本):${result.dropped.belowCost.join('、')}`);
      if (notices.length > 0) setGenNotice(notices.join(' · '));
    } catch (e) {
      if (genSeqRef.current === mySeq) setGenError(e instanceof Error ? e.message : String(e));
    } finally {
      setGenerating(false); // 無論結果有冇被作廢,spinner 都要熄
    }
  };

  const updateVariant = (idx: number, patch: Partial<EditableVariant>) => {
    setVariants(vs => vs.map((v, i) => (i === idx ? { ...v, ...patch } : v)));
  };

  const copyVariant = async (idx: number) => {
    const v = variants[idx];
    try {
      await navigator.clipboard.writeText(
        variantToClipboard({ ...v, hashtags: v.hashtagsText.split(/\s+/).filter(Boolean) })
      );
      setCopiedIdx(idx);
      setTimeout(() => setCopiedIdx(c => (c === idx ? null : c)), 2000);
    } catch {
      alert('複製失敗 — 請手動選取文字');
    }
  };

  // ── 圖卡 render(template/size 一轉就重畫)──
  useEffect(() => {
    if (cardProducts.length === 0) { setCardUrls([]); return; }
    let cancelled = false;
    (async () => {
      setRenderingCards(true);
      const urls = await Promise.all(cardProducts.map(p => renderPostCard(p, { template: cardTemplate, size: cardSize })));
      if (!cancelled) { setCardUrls(urls); setRenderingCards(false); }
    })();
    return () => { cancelled = true; };
  }, [cardProducts, cardTemplate, cardSize]);

  // ── Send 去 Slack(#po-stream):揀咗邊個 variant 就用佢做 caption + 全部圖卡 ──
  const sendToSlack = async (idx: number) => {
    if (sendingIdx != null) return;
    setSendingIdx(idx);
    setSlackNotice(null);
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error('未登入 — 請重新登入 dashboard');
      const v = variants[idx];
      const caption = variantToClipboard({ ...v, hashtags: v.hashtagsText.split(/\s+/).filter(Boolean) });
      const resp = await fetch('/api/slack-post', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          caption,
          images: cardUrls.map((u, i) => ({ filename: `post-card-${i + 1}.png`, dataUrl: u })),
        }),
      });
      const j = await resp.json().catch(() => ({} as any));
      if (resp.status === 501) { setSlackNotice('setup'); return; }
      if (!resp.ok) throw new Error(j.error || `HTTP ${resp.status}`);
      setSlackNotice(`✅ 已 send 去 #${j.channel}(${j.files ?? 0} 張圖 + 文案)— 同事可以直接攞去出`);
    } catch (e) {
      setSlackNotice(`❌ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSendingIdx(null);
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
              onChange={e => pickVendor(e.target.value)}
              className="text-xs px-2 py-1.5 rounded-md border border-border bg-background"
            >
              <option value="">揀品牌…</option>
              {vendorOptions.map(v => <option key={v} value={v}>{v}</option>)}
            </select>
          )}
          {postType === 'scenario' && (
            <select
              value={scenario}
              onChange={e => pickScenario(e.target.value as ScenarioKey)}
              className="text-xs px-2 py-1.5 rounded-md border border-border bg-background"
            >
              {(Object.keys(SCENARIO_LABEL) as ScenarioKey[]).map(k => (
                <option key={k} value={k}>{SCENARIO_LABEL[k]}</option>
              ))}
            </select>
          )}
          <span className={`text-[11px] ml-auto tabular-nums ${capMsg ? 'text-amber-300 font-medium' : 'text-muted-foreground'}`}>
            候選 {formatNumber(candidates.length)} · 已揀 {selected.size}/{MAX_SELECT}{capMsg ? '(最多咁多喇)' : ''}
          </span>
        </div>

        {/* 已揀 chips — 就算 filter 換咗睇唔到嗰行,揀咗啲乜一目了然 */}
        {selectedProducts.length > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap">
            {selectedProducts.map(p => (
              <span
                key={p.product_id}
                className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/30"
              >
                {p.title.length > 36 ? p.title.slice(0, 36) + '…' : p.title}
                <button onClick={() => toggleSelect(p.product_id)} className="hover:text-rose-300">
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
            <button
              onClick={() => setSelected(new Set())}
              className="text-[11px] px-2 py-0.5 rounded-full border border-border text-muted-foreground hover:bg-accent/60"
            >
              清空
            </button>
          </div>
        )}

        {loading ? (
          <Skeleton className="h-48 w-full" />
        ) : candidates.length === 0 ? (
          <div className="text-center text-xs text-muted-foreground py-8">
            {postType === 'brand_story' && !vendorFilter
              ? '先揀一個品牌'
              : postType === 'new_arrival' && new90Stats.total > new90Stats.visible
              ? `90 日內有 ${new90Stats.total} 款新上架,但 ${new90Stats.total - new90Stats.visible} 款因為未有庫存記錄/未定價被隱藏 — 去 Shopify 補返庫存同產品相,先出得 post`
              : '冇符合條件嘅候選產品'}
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
                        <input type="checkbox" readOnly checked={isSel} className="cursor-pointer pointer-events-none" />
                      </td>
                      <td className="px-2 py-1.5 font-medium">{p.title}</td>
                      <td className="px-2 py-1.5 text-muted-foreground">{p.vendor}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">
                        {p.promo?.promoPrice ? (
                          <span className="text-amber-300">${p.promo.promoPrice}</span>
                        ) : (
                          <>${p.price}</>
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
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => copyVariant(idx)}
                    className="text-[11px] px-2 py-1 rounded-md border border-border hover:bg-accent/60 inline-flex items-center gap-1"
                    data-testid={`copy-variant-${idx}`}
                  >
                    {copiedIdx === idx ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
                    {copiedIdx === idx ? '已複製' : 'Copy 全文'}
                  </button>
                  <button
                    onClick={() => sendToSlack(idx)}
                    disabled={sendingIdx != null || cardUrls.length === 0}
                    className="text-[11px] px-2 py-1 rounded-md bg-primary/90 text-primary-foreground hover:bg-primary disabled:opacity-50 inline-flex items-center gap-1"
                    data-testid={`slack-variant-${idx}`}
                    title="呢個文案 + 全部圖卡 send 去 Slack #po-stream"
                  >
                    <Send className="h-3 w-3" />
                    {sendingIdx === idx ? 'Send 緊…' : 'Send Slack'}
                  </button>
                </div>
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
                value={v.hashtagsText}
                onChange={e => updateVariant(idx, { hashtagsText: e.target.value })}
                rows={2}
                className="w-full px-2 py-1.5 text-xs rounded-md border border-border bg-background resize-y text-sky-300"
                placeholder="#hashtags"
              />
              <div className="text-[10px] text-muted-foreground">
                圖片 alt:{v.altText || '—'}
                {v.platform !== 'ig_story' && <span className="ml-2 text-muted-foreground/60">· Copy/Send 會自動加店舖資料尾巴</span>}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ⑤ 圖卡 Post 圖 */}
      {cardProducts.length > 0 && (
        <div className="rounded-md border border-border/60 bg-card p-3 space-y-3" data-testid="card-studio">
          <div className="flex items-center gap-2 flex-wrap">
            <ImageIcon className="h-4 w-4 text-primary" />
            <span className="text-sm font-semibold">圖卡 Post 圖</span>
            <span className="text-[11px] text-muted-foreground">產品真相自動排版 — download 或者撳文案格嘅「Send Slack」連文案一齊出</span>
            <div className="ml-auto flex items-center gap-1.5">
              {(['dark', 'light'] as CardTemplate[]).map(t => (
                <button key={t} onClick={() => setCardTemplate(t)}
                  className={`text-[11px] px-2.5 py-1 rounded-md border ${cardTemplate === t ? 'bg-primary text-primary-foreground border-primary' : 'border-border bg-background hover:bg-accent/60'}`}>
                  {t === 'dark' ? '黑金' : '白底'}
                </button>
              ))}
              <span className="w-px h-4 bg-border mx-1" />
              {(['square', 'story'] as CardSize[]).map(s => (
                <button key={s} onClick={() => setCardSize(s)}
                  className={`text-[11px] px-2.5 py-1 rounded-md border ${cardSize === s ? 'bg-primary text-primary-foreground border-primary' : 'border-border bg-background hover:bg-accent/60'}`}>
                  {s === 'square' ? '方圖 Post' : 'Story 長圖'}
                </button>
              ))}
            </div>
          </div>

          {renderingCards ? (
            <div className="text-xs text-muted-foreground py-6 text-center">整緊圖卡…</div>
          ) : (
            <div className="flex gap-3 overflow-x-auto pb-1">
              {cardUrls.map((u, i) => (
                <div key={i} className="shrink-0 space-y-1.5">
                  <img src={u} alt={cardProducts[i]?.title}
                    className={`rounded-lg border border-border/40 ${cardSize === 'story' ? 'h-80' : 'h-64'} w-auto`} />
                  <button
                    onClick={() => downloadDataUrl(u, `post-card-${i + 1}.png`)}
                    className="w-full text-[11px] px-2 py-1 rounded-md border border-border hover:bg-accent/60 inline-flex items-center justify-center gap-1"
                  >
                    <Download className="h-3 w-3" /> 下載 PNG
                  </button>
                </div>
              ))}
            </div>
          )}

          {slackNotice === 'setup' ? (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-amber-200 text-xs space-y-1">
              <div className="font-semibold">Slack 未接通(一次過設定,5 分鐘):</div>
              <ol className="list-decimal list-inside space-y-0.5">
                <li>Slack 開條 channel 叫 <b>#po-stream</b></li>
                <li>api.slack.com/apps → Create New App「HK Post Studio」→ OAuth Scopes 加 <code>files:write</code> <code>chat:write</code> <code>channels:read</code> <code>groups:read</code> → Install to Workspace</li>
                <li>Copy 個 <code>xoxb-</code> token → Vercel 環境變數 <code>SLACK_BOT_TOKEN</code></li>
                <li>喺 #po-stream 入面 <code>/invite @HK Post Studio</code></li>
              </ol>
              <div>設定好之前,用「下載 PNG」+「Copy 全文」照出得。</div>
            </div>
          ) : slackNotice ? (
            <div className={`rounded-md border p-2.5 text-xs ${slackNotice.startsWith('✅') ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200' : 'border-rose-500/40 bg-rose-500/10 text-rose-200'}`}>
              {slackNotice}
            </div>
          ) : null}
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
