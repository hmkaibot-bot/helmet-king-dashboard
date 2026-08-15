/**
 * Post Studio 圖卡生成 — 全 client-side canvas,產品真相 + 排版
 * 兩款 template(黑金 dark / 白底 light)× 兩個尺寸(方圖 1080² / Story 1080×1920)
 * 產品圖嚟自 Shopify CDN(有 CORS,crossOrigin anonymous 唔會 taint canvas)
 */

export interface CardProduct {
  title: string;
  vendor: string;
  price: number;
  comparePrice: number | null;
  promoPrice: number | null;
  promoEndDate: string | null;
  imageUrl: string | null;
  badge: string; // 「新品」「優惠」等
}

export type CardTemplate = 'dark' | 'light';
export type CardSize = 'square' | 'story';

const PALETTE = {
  dark: {
    bg: '#0B0B10', bg2: '#16161e',
    panel: '#FFFFFF',
    title: '#F4F4F5', sub: '#9CA3AF',
    accent: '#F5A524', accentText: '#1A1205',
    compare: '#6B7280', footer: '#F5A524',
  },
  light: {
    bg: '#F7F7F4', bg2: '#EDEDE8',
    panel: '#FFFFFF',
    title: '#18181B', sub: '#6B7280',
    accent: '#B45309', accentText: '#FFFFFF',
    compare: '#9CA3AF', footer: '#B45309',
  },
} as const;

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise(resolve => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

// CJK 逐字 wrap(英文詞太長都照斬),最多 maxLines 行,尾行 ellipsis
function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const lines: string[] = [];
  let cur = '';
  for (const ch of text) {
    if (ctx.measureText(cur + ch).width > maxWidth && cur) {
      lines.push(cur);
      cur = ch;
      if (lines.length === maxLines) break;
    } else {
      cur += ch;
    }
  }
  if (lines.length < maxLines && cur) lines.push(cur);
  if (lines.length === maxLines && cur && lines[maxLines - 1] !== cur) {
    let last = lines[maxLines - 1];
    while (last && ctx.measureText(last + '…').width > maxWidth) last = last.slice(0, -1);
    lines[maxLines - 1] = last + '…';
  }
  return lines;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const fmt = (n: number) => `HK$${Math.round(n).toLocaleString('en-US')}`;

export async function renderPostCard(
  p: CardProduct,
  opts: { template: CardTemplate; size: CardSize }
): Promise<string> {
  const W = 1080;
  const H = opts.size === 'story' ? 1920 : 1080;
  const c = PALETTE[opts.template];
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  const FONT = '"Noto Sans TC", "PingFang TC", "Microsoft JhengHei", sans-serif';

  // ── 背景 ──
  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, c.bg);
  grad.addColorStop(1, c.bg2);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
  // 黑金版加一浸 amber glow
  if (opts.template === 'dark') {
    const glow = ctx.createRadialGradient(W - 120, 100, 0, W - 120, 100, 700);
    glow.addColorStop(0, 'rgba(245,165,36,0.16)');
    glow.addColorStop(1, 'rgba(245,165,36,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);
  }

  const story = opts.size === 'story';
  const pad = 70;

  // ── Badge ──
  ctx.font = `bold 38px ${FONT}`;
  const bw = ctx.measureText(p.badge).width + 56;
  roundRect(ctx, pad, story ? 120 : 64, bw, 68, 34);
  ctx.fillStyle = c.accent;
  ctx.fill();
  ctx.fillStyle = c.accentText;
  ctx.textBaseline = 'middle';
  ctx.fillText(p.badge, pad + 28, (story ? 120 : 64) + 35);

  // vendor 喺 badge 右邊
  ctx.font = `600 34px ${FONT}`;
  ctx.fillStyle = c.sub;
  ctx.fillText(p.vendor.toUpperCase(), pad + bw + 28, (story ? 120 : 64) + 35);

  // ── 產品圖白底面板 ──
  const panelY = story ? 250 : 160;
  const panelH = story ? 900 : 490;
  const panelX = pad;
  const panelW = W - pad * 2;
  roundRect(ctx, panelX, panelY, panelW, panelH, 36);
  ctx.fillStyle = c.panel;
  ctx.shadowColor = 'rgba(0,0,0,0.35)';
  ctx.shadowBlur = 40;
  ctx.shadowOffsetY = 16;
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;

  const img = p.imageUrl ? await loadImage(p.imageUrl) : null;
  if (img) {
    const inset = 46;
    const availW = panelW - inset * 2;
    const availH = panelH - inset * 2;
    const scale = Math.min(availW / img.width, availH / img.height);
    const dw = img.width * scale;
    const dh = img.height * scale;
    ctx.drawImage(img, panelX + (panelW - dw) / 2, panelY + (panelH - dh) / 2, dw, dh);
  } else {
    ctx.font = `120px ${FONT}`;
    ctx.fillStyle = '#D4D4D8';
    ctx.textAlign = 'center';
    ctx.fillText('🪖', W / 2, panelY + panelH / 2);
    ctx.font = `32px ${FONT}`;
    ctx.fillText('相片準備中', W / 2, panelY + panelH / 2 + 100);
    ctx.textAlign = 'left';
  }

  // ── 標題(最多 2 行,置中)──
  const titleY = panelY + panelH + (story ? 110 : 70);
  ctx.font = `bold ${story ? 56 : 52}px ${FONT}`;
  ctx.fillStyle = c.title;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const titleLines = wrapText(ctx, p.title, panelW - 40, 2);
  const lineH = story ? 74 : 66;
  titleLines.forEach((ln, i) => ctx.fillText(ln, W / 2, titleY + i * lineH));

  // ── 價錢行 ──
  const effective = p.promoPrice ?? p.price;
  const hasCompare = (p.promoPrice != null && p.promoPrice < p.price)
    || (p.comparePrice != null && p.comparePrice > effective);
  const compareVal = p.promoPrice != null && p.promoPrice < p.price
    ? p.price
    : (p.comparePrice ?? 0);
  const priceY = titleY + titleLines.length * lineH + (story ? 96 : 60);

  const priceFont = `bold ${story ? 88 : 80}px ${FONT}`;
  ctx.font = priceFont;
  const priceStr = fmt(effective);
  const priceW = ctx.measureText(priceStr).width;
  ctx.font = `44px ${FONT}`;
  const compStr = hasCompare ? fmt(compareVal) : '';
  const compW = compStr ? ctx.measureText(compStr).width + 36 : 0;
  const startX = W / 2 - (priceW + compW) / 2;

  ctx.textAlign = 'left';
  ctx.font = priceFont;
  ctx.fillStyle = c.accent;
  ctx.fillText(priceStr, startX, priceY);
  if (compStr) {
    ctx.font = `44px ${FONT}`;
    ctx.fillStyle = c.compare;
    const cx = startX + priceW + 36;
    ctx.fillText(compStr, cx, priceY - 8);
    ctx.strokeStyle = c.compare;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(cx - 4, priceY - 22);
    ctx.lineTo(cx + ctx.measureText(compStr).width + 4, priceY - 22);
    ctx.stroke();
  }

  // 優惠期限
  if (p.promoPrice != null && p.promoEndDate) {
    ctx.font = `500 36px ${FONT}`;
    ctx.fillStyle = c.sub;
    ctx.textAlign = 'center';
    ctx.fillText(`優惠至 ${p.promoEndDate.slice(5).replace('-', '/')}`, W / 2, priceY + 62);
    ctx.textAlign = 'left';
  }

  // ── Footer ──
  const footY = H - (story ? 120 : 64);
  ctx.strokeStyle = opts.template === 'dark' ? 'rgba(245,165,36,0.35)' : 'rgba(180,83,9,0.3)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(pad, footY - 44);
  ctx.lineTo(W - pad, footY - 44);
  ctx.stroke();
  ctx.font = `bold 40px ${FONT}`;
  ctx.fillStyle = c.footer;
  ctx.textAlign = 'center';
  ctx.fillText('頭盔王 Helmet King', W / 2, footY + 8);
  ctx.textAlign = 'left';

  return canvas.toDataURL('image/png');
}

export function downloadDataUrl(dataUrl: string, filename: string) {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename;
  a.click();
}
