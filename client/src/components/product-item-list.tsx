import React, { useState, useCallback, useRef } from 'react';
import { formatCurrency } from '@/lib/format';
import { ImageOff } from 'lucide-react';

// ── 產品明細列表(品牌明細 / 週類別明細共用)─────────────────
// 一行一款:縮圖(撳大 lightbox)| 名 + badge | ×件數 銀碼 | 毛利率 | 庫存 | 預計缺貨
// 縮圖:DB image_url 優先,冇就展開嗰陣由公開 storefront 逐款攞(有 cache)

// 公開 storefront domain(products/{handle}.json 有 CORS)
const STOREFRONT_DOMAIN = 'helmetking-0001.myshopify.com';

export interface ProductListItem {
  title: string;
  productId: string | null;
  skus: Set<string>;
  qty: number;
  revenue: number;
  profit: number;      // 有成本價 lines 嘅毛利
  coveredRev: number;  // 有成本價 lines 嘅營收
  badge?: string | null;  // 例:「昨日×2」
  sub?: string | null;    // 名底細字,例:品牌
}

interface Props {
  items: ProductListItem[];
  qtyLabel: string;        // 件數欄標題:「昨日售出」「本週售出」「當月售出」
  topN?: number | null;    // 預設 10;null = 全列唔摺
  showRank?: boolean;      // 行頭顯示 1,2,3…
  highlight?: boolean;     // 成個 list 用 primary 底(昨日售出 section)
  imageMap: Record<string, string>;
  handleMap: Record<string, string>;
  productStockMap: Record<string, number>;
  velocityMap: Record<string, number>;
}

const GRID = 'grid grid-cols-[44px_minmax(0,1fr)_150px_72px_64px_92px] items-center gap-x-3';

export function ProductItemList({
  items, qtyLabel, topN = 10, showRank = false, highlight = false,
  imageMap, handleMap, productStockMap, velocityMap,
}: Props) {
  const [showAll, setShowAll] = useState(false);
  const [lightbox, setLightbox] = useState<{ url: string; title: string } | null>(null);

  // storefront 攞圖 cache(null = 攞過但冇圖)
  const [storefrontImgs, setStorefrontImgs] = useState<Record<string, string | null>>({});
  const fetchingRef = useRef<Set<string>>(new Set());
  const fetchStorefrontImage = useCallback((productId: string) => {
    const handle = handleMap[productId];
    if (!handle || fetchingRef.current.has(productId)) return;
    fetchingRef.current.add(productId);
    fetch(`https://${STOREFRONT_DOMAIN}/products/${handle}.json`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        const src: string | undefined = d?.product?.image?.src || d?.product?.images?.[0]?.src;
        setStorefrontImgs(prev => ({ ...prev, [productId]: src || null }));
      })
      .catch(() => setStorefrontImgs(prev => ({ ...prev, [productId]: null })));
  }, [handleMap]);

  const effectiveTopN = topN ?? items.length;
  const shown = showAll ? items : items.slice(0, effectiveTopN);
  const rest = items.slice(effectiveTopN);
  const restRev = rest.reduce((s, it) => s + it.revenue, 0);

  const thumb = (item: ProductListItem) => {
    const pid = item.productId;
    const img = pid ? (imageMap[pid] ?? storefrontImgs[pid] ?? undefined) : undefined;
    if (pid && !imageMap[pid] && storefrontImgs[pid] === undefined) fetchStorefrontImage(pid);
    return img ? (
      <button
        onClick={e => { e.stopPropagation(); setLightbox({ url: img, title: item.title }); }}
        className="w-10 h-10 rounded-md overflow-hidden bg-white/90 hover:ring-2 hover:ring-primary/60 transition-all cursor-zoom-in shrink-0"
        title="撳大睇"
      >
        <img src={img} alt={item.title} loading="lazy" className="w-full h-full object-cover" />
      </button>
    ) : (
      <div className="w-10 h-10 rounded-md bg-accent/40 flex items-center justify-center shrink-0">
        <ImageOff className="h-4 w-4 text-muted-foreground/40" />
      </div>
    );
  };

  const stockCells = (item: ProductListItem) => {
    const stock = item.productId != null ? productStockMap[item.productId] : undefined;
    const margin = item.coveredRev > 0 ? (item.profit / item.coveredRev) * 100 : null;
    const velocity = [...item.skus].reduce((s, k) => s + (velocityMap[k] || 0), 0);
    const days = stock != null && stock > 0 && velocity > 0 ? stock / velocity : null;
    const riskBadge = stock == null
      ? <span className="text-muted-foreground/30">—</span>
      : stock === 0
      ? <span className="text-xs font-semibold text-red-400 bg-red-500/15 px-1.5 py-0.5 rounded whitespace-nowrap">🔴 缺貨</span>
      : days !== null && days <= 7
      ? <span className="text-xs font-semibold text-red-400 bg-red-500/15 px-1.5 py-0.5 rounded whitespace-nowrap">🔴 {Math.round(days)}日</span>
      : days !== null && days <= 21
      ? <span className="text-xs text-yellow-400 bg-yellow-500/15 px-1.5 py-0.5 rounded whitespace-nowrap">🟡 {Math.round(days)}日</span>
      : <span className="text-xs text-muted-foreground/60 whitespace-nowrap">{days !== null ? `${Math.round(days)}日` : '充足'}</span>;
    return (
      <>
        <span className="text-right tabular-nums text-xs">
          {margin !== null
            ? <span className={item.profit >= 0 ? 'text-emerald-400' : 'text-red-400'}>{margin.toFixed(0)}%</span>
            : <span className="text-muted-foreground/30">—</span>}
        </span>
        <span className={`text-right tabular-nums text-xs font-semibold ${
          stock == null ? 'text-muted-foreground/30' : stock === 0 ? 'text-red-400' : stock <= 5 ? 'text-yellow-400' : ''
        }`}>
          {stock != null ? stock : '—'}
        </span>
        <span className="text-right">{riskBadge}</span>
      </>
    );
  };

  return (
    <div>
      {/* 欄頭 */}
      <div className={`${GRID} text-xs text-muted-foreground/60 pb-1 border-b border-border/20`}>
        <span />
        <span>產品</span>
        <span className="text-right">{qtyLabel}</span>
        <span className="text-right">毛利率</span>
        <span className="text-right">庫存</span>
        <span className="text-right">預計缺貨</span>
      </div>

      {shown.map((item, ii) => (
        <div
          key={item.title}
          className={`${GRID} text-[13px] py-1.5 border-b border-border/10 last:border-0 ${highlight ? 'bg-primary/5 -mx-2 px-2 rounded' : ''}`}
        >
          {thumb(item)}
          <div className="flex items-center gap-2 min-w-0">
            {showRank && <span className="text-muted-foreground/50 tabular-nums w-5 text-right shrink-0">{ii + 1}</span>}
            <span className={`truncate ${highlight ? 'font-medium' : ''}`}>{item.title}</span>
            {item.sub && <span className="text-[11px] text-muted-foreground/50 shrink-0 hidden md:inline">{item.sub}</span>}
            {item.badge && (
              <span className="text-xs bg-primary/15 text-primary px-1 py-0.5 rounded shrink-0">{item.badge}</span>
            )}
          </div>
          <span className="text-right tabular-nums">
            <span className="text-muted-foreground">×{item.qty}</span>
            <span className="font-medium ml-2">{formatCurrency(item.revenue)}</span>
          </span>
          {stockCells(item)}
        </div>
      ))}

      {rest.length > 0 && !showAll && (
        <button
          onClick={e => { e.stopPropagation(); setShowAll(true); }}
          className="w-full text-left text-[13px] text-muted-foreground hover:text-foreground py-1.5 transition-colors"
        >
          ⋯ 仲有 {rest.length} 款 · {formatCurrency(restRev)} — 撳開晒
        </button>
      )}
      {showAll && rest.length > 0 && (
        <button
          onClick={e => { e.stopPropagation(); setShowAll(false); }}
          className="w-full text-left text-[13px] text-muted-foreground/60 hover:text-foreground py-1.5 transition-colors"
        >
          收返埋長尾
        </button>
      )}

      {/* 產品圖 Lightbox(撳任何地方閂)*/}
      {lightbox && (
        <div
          className="fixed inset-0 z-50 bg-black/85 flex flex-col items-center justify-center p-6 cursor-zoom-out"
          onClick={e => { e.stopPropagation(); setLightbox(null); }}
          data-testid="product-lightbox"
        >
          <img
            src={lightbox.url}
            alt={lightbox.title}
            className="max-w-[85vw] max-h-[78vh] rounded-lg bg-white object-contain shadow-2xl"
          />
          <p className="mt-3 text-sm text-white/90 text-center max-w-[85vw]">{lightbox.title}</p>
          <p className="text-xs text-white/40 mt-1">撳任何地方閂返</p>
        </div>
      )}
    </div>
  );
}
