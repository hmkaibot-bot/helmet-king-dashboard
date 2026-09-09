import { Fragment, useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { queryAllPages } from '@/lib/query-helpers';
import { Card, CardContent } from '@/components/ui/card';
import { formatCurrency } from '@/lib/format';
import { CircleDollarSign, Search, Undo2, TriangleAlert } from 'lucide-react';

/**
 * 改價 Price Editor — 逐個 SKU 改「正價」(售價 + 劃線價),即改即生效。
 *
 * 同推廣活動嗰套嘅分工(grilling 2026-09-09 老闆定案):
 *  - 呢頁改嘅係正價(例如加價),唔搞活動、唔寫 snapshot、冇還原機制
 *  - 推廣減價照舊行推廣活動頁(有自動劃線價 + snapshot + 一撳還原)
 *  - 推廣中(Shopify 有 hk_promo.snapshot)嘅 SKU 呢頁拒改 —— API 層把關,
 *    唔係嘅話活動「還原原價」會用舊 snapshot 冚走啱啱改嘅新正價
 *
 * 真相邊個:Shopify 係價格唯一真相。寫成功先至鏡返落本地 shopify_inventory
 * (RLS authenticated 可寫),全 dashboard 即改即見,唔使等夜間 sync。
 *
 * 保險絲:改價前 confirm 對照(舊→新);劃線價唔高過售價會黃字警告;
 * 同原價差 >40% 當疑似打錯,confirm 入面紅字提醒。
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

// 每個 variant 嘅未儲存輸入(raw string,俾人打緊字唔好搶格式)
interface EditInput { price: string; compare: string; }

interface Change {
  productId: number;
  variantId: number;
  label: string;       // 「產品名 — variant/SKU」
  oldP: number;
  newP: number | null;      // null = 冇改售價
  oldC: number | null;
  newC: number | null | undefined; // undefined = 冇改;null = 清走劃線價
  warnings: string[];
}

const priceStr = (v: number | null) => (v != null ? String(v) : '');

export default function PriceEditorPage() {
  const [rows, setRows] = useState<InvRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [edits, setEdits] = useState<Record<number, EditInput>>({});
  const [rowErrors, setRowErrors] = useState<Record<number, string>>({});
  const [savedIds, setSavedIds] = useState<Set<number>>(new Set());
  const [confirmChanges, setConfirmChanges] = useState<Change[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

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

  // ── 搜尋 → 商品分組(要打至少 2 個字先出結果,免一開頁 render 幾千行)──
  const products = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (needle.length < 2) return { list: [] as Array<{ pid: number; title: string; vendor: string; ptype: string; variants: InvRow[] }>, more: 0 };
    const byPid = new Map<number, InvRow[]>();
    for (const r of rows) {
      if (r.variant_id == null) continue;
      const hay = `${r.product_title ?? ''} ${r.vendor ?? ''} ${r.sku ?? ''} ${r.product_type ?? ''}`.toLowerCase();
      if (!hay.includes(needle)) continue;
      const arr = byPid.get(r.product_id) ?? [];
      arr.push(r);
      byPid.set(r.product_id, arr);
    }
    const all = [...byPid.entries()]
      .map(([pid, variants]) => ({
        pid,
        title: variants[0]?.product_title ?? `#${pid}`,
        vendor: variants[0]?.vendor ?? '',
        ptype: variants[0]?.product_type ?? '',
        variants: [...variants].sort((a, b) => String(a.sku ?? '').localeCompare(String(b.sku ?? ''))),
      }))
      .sort((a, b) => a.title.localeCompare(b.title));
    return { list: all.slice(0, 40), more: Math.max(0, all.length - 40) };
  }, [rows, q]);

  const setEdit = (vid: number, field: keyof EditInput, value: string, original: InvRow) => {
    setEdits((m) => {
      const cur = m[vid] ?? { price: priceStr(original.price), compare: priceStr(original.compare_at_price) };
      return { ...m, [vid]: { ...cur, [field]: value } };
    });
    setRowErrors((m) => { const n = { ...m }; delete n[vid]; return n; });
    setSavedIds((s) => { if (!s.has(vid)) return s; const n = new Set(s); n.delete(vid); return n; });
  };

  // ── 未儲存改動(逐行對比輸入 vs 原值)────────────────────────────────
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

      // 成功嗰批:鏡返落本地 shopify_inventory(即改即見,唔等夜間 sync)+ 更新 state
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

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between flex-wrap gap-2">
        <h2 className="text-sm font-semibold flex items-center gap-1.5" data-testid="section-price-editor">
          <CircleDollarSign className="h-4 w-4 text-primary" /> 改價 <span className="text-xs font-normal text-muted-foreground">Price Editor(正價,逐個 SKU)</span>
        </h2>
        <span className="text-[11px] text-muted-foreground">
          即改即生效(網店 + 門市 POS + dashboard)· 推廣減價去「推廣活動」頁 · 推廣中嘅 SKU 要先還原先改得
        </span>
      </div>

      {/* 搜尋 */}
      <div className="relative max-w-md">
        <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜貨名 / SKU / 品牌 / 類別(至少 2 個字)"
          className="w-full pl-8 pr-3 py-2 rounded-md border border-border bg-card text-sm"
          data-testid="price-editor-search"
        />
      </div>

      {toast && (
        <div className="rounded-md border border-border/60 bg-card px-3 py-2 text-xs" data-testid="price-editor-toast">{toast}</div>
      )}

      {/* 未儲存改動列 */}
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
              儲存改價…
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <p className="text-xs text-muted-foreground py-8 text-center animate-pulse">載入緊 SKU 價目…</p>
      ) : q.trim().length < 2 ? (
        <p className="text-xs text-muted-foreground py-10 text-center">
          🔍 打貨名 / SKU / 品牌搜尋(例:CARDO、S00049899、SHOEI)— 搵到先逐個 SKU 改
        </p>
      ) : products.list.length === 0 ? (
        <p className="text-xs text-muted-foreground py-10 text-center">搵唔到「{q}」— 試下貨名其他寫法或 SKU</p>
      ) : (
        <div className="space-y-3">
          {products.more > 0 && (
            <p className="text-[11px] text-muted-foreground">結果太多,只顯示頭 40 件商品(仲有 {products.more} 件)— 打精確啲</p>
          )}
          {products.list.map((p) => (
            <Card key={p.pid} className="border-border/40 overflow-hidden">
              <CardContent className="p-0">
                <div className="px-4 pt-3 pb-2 flex items-baseline gap-2 flex-wrap">
                  <h3 className="text-sm font-semibold">{p.title}</h3>
                  <span className="text-[11px] text-muted-foreground">{p.vendor}{p.ptype ? ` · ${p.ptype}` : ''}</span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-border/40 bg-muted/30">
                        <th className="text-left px-3 py-2 font-medium text-muted-foreground">SKU</th>
                        <th className="text-left px-3 py-2 font-medium text-muted-foreground">Variant</th>
                        <th className="text-right px-3 py-2 font-medium text-muted-foreground">庫存</th>
                        <th className="text-right px-3 py-2 font-medium text-muted-foreground">成本</th>
                        <th className="text-right px-3 py-2 font-medium text-muted-foreground">售價 HK$</th>
                        <th className="text-right px-3 py-2 font-medium text-muted-foreground" title="Compare-at price — 高過售價先會顯示做劃線原價/折扣">劃線價 HK$</th>
                        <th className="text-right px-3 py-2 font-medium text-muted-foreground">毛利率</th>
                        <th className="text-left px-3 py-2 font-medium text-muted-foreground w-56">狀態</th>
                      </tr>
                    </thead>
                    <tbody>
                      {p.variants.map((r) => {
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
                        return (
                          <tr key={vid} className={`border-b border-border/20 ${touched ? 'bg-amber-500/10' : ''}`} data-testid={`price-row-${vid}`}>
                            <td className="px-3 py-2 tabular-nums whitespace-nowrap">{r.sku ?? '—'}</td>
                            <td className="px-3 py-2 max-w-[180px] truncate" title={r.variant_title ?? ''}>
                              {r.variant_title && r.variant_title !== 'Default Title' ? r.variant_title : '—'}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums">{r.inventory_quantity ?? '—'}</td>
                            <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{r.cost != null && r.cost > 0 ? formatCurrency(r.cost) : '—'}</td>
                            <td className="px-3 py-2 text-right">
                              <input
                                value={priceVal}
                                onChange={(ev) => setEdit(vid, 'price', ev.target.value, r)}
                                inputMode="decimal"
                                className="w-24 px-2 py-1 rounded border border-border bg-background text-right tabular-nums"
                                data-testid={`price-input-${vid}`}
                              />
                            </td>
                            <td className="px-3 py-2 text-right">
                              <input
                                value={compareVal}
                                onChange={(ev) => setEdit(vid, 'compare', ev.target.value, r)}
                                inputMode="decimal"
                                placeholder="冇"
                                className="w-24 px-2 py-1 rounded border border-border bg-background text-right tabular-nums"
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
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* 改價 confirm — 舊→新 對照 + 警告,睇清楚先出手 */}
      {confirmChanges && (
        <div className="fixed inset-0 z-[100] bg-black/70 flex items-center justify-center p-4" onClick={() => !saving && setConfirmChanges(null)}>
          <div className="bg-card border border-border rounded-lg max-w-2xl w-full max-h-[80vh] overflow-y-auto p-4 space-y-3" onClick={(ev) => ev.stopPropagation()}>
            <h3 className="text-sm font-semibold">確認改價({confirmChanges.length} 個 SKU)— 一撳即生效落網店 + POS</h3>
            <div className="space-y-2">
              {confirmChanges.map((c) => (
                <Fragment key={c.variantId}>
                  <div className="rounded border border-border/50 px-3 py-2 text-xs space-y-1">
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
                </Fragment>
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
    </div>
  );
}
