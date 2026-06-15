import { useEffect, useMemo, useState, useCallback } from 'react';
import { queryAllPages } from '@/lib/query-helpers';
import {
  fetchProduct,
  listCollections,
  saveProductText,
  addMedia,
  deleteMedia,
  reorderMedia,
  addToCollection,
  removeFromCollection,
  type EditorProduct,
  type EditorCollection,
} from '@/lib/shopify-editor';
import { reviewCopy, type CopyReview } from '@/lib/ai-copy';
import {
  FileEdit,
  RefreshCw,
  AlertCircle,
  Search,
  Save,
  Trash2,
  ArrowUp,
  ArrowDown,
  Plus,
  ExternalLink,
  X,
  ArrowLeft,
  Sparkles,
} from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';

interface PickRow {
  id: string;
  title: string;
  vendor: string | null;
  product_type: string | null;
  status: string | null;
}

export default function ProductEditorPage() {
  const [list, setList] = useState<PickRow[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [search, setSearch] = useState('');
  const [allCollections, setAllCollections] = useState<EditorCollection[]>([]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [product, setProduct] = useState<EditorProduct | null>(null);
  const [loadingProduct, setLoadingProduct] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const [ptype, setPtype] = useState('');
  const [savingText, setSavingText] = useState(false);

  const [media, setMedia] = useState<EditorProduct['media']>([]);
  const [newUrl, setNewUrl] = useState('');
  const [busyMedia, setBusyMedia] = useState(false);
  const [orderDirty, setOrderDirty] = useState(false);

  const [addColId, setAddColId] = useState('');
  const [busyCol, setBusyCol] = useState(false);

  const [reviewing, setReviewing] = useState(false);
  const [review, setReview] = useState<CopyReview | null>(null);
  const [reviewErr, setReviewErr] = useState<string | null>(null);

  const loadList = useCallback(async () => {
    setLoadingList(true);
    try {
      const rows = await queryAllPages('shopify_products', 'id,title,vendor,product_type,status');
      setList(rows as PickRow[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingList(false);
    }
  }, []);
  useEffect(() => {
    loadList();
  }, [loadList]);

  const loadProduct = useCallback(
    async (id: string) => {
      setSelectedId(id);
      setLoadingProduct(true);
      setError(null);
      setProduct(null);
      setOrderDirty(false);
      try {
        const [p, cols] = await Promise.all([
          fetchProduct(id),
          allCollections.length ? Promise.resolve(allCollections) : listCollections(),
        ]);
        setProduct(p);
        setTitle(p.title);
        setDesc(p.descriptionHtml);
        setPtype(p.productType);
        setMedia(p.media);
        if (!allCollections.length) setAllCollections(cols);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoadingProduct(false);
      }
    },
    [allCollections]
  );

  const reload = useCallback(async () => {
    if (selectedId) await loadProduct(selectedId);
  }, [selectedId, loadProduct]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let l = list;
    if (q) l = l.filter((p) => p.title.toLowerCase().includes(q) || (p.vendor || '').toLowerCase().includes(q));
    return l.slice(0, 100);
  }, [list, search]);

  // ── 文案 ──
  const handleSaveText = async () => {
    if (!selectedId) return;
    setSavingText(true);
    try {
      await saveProductText(selectedId, { title, descriptionHtml: desc, productType: ptype });
      setProduct((p) => (p ? { ...p, title, descriptionHtml: desc, productType: ptype } : p));
      alert('文案已儲存到 Shopify ✓');
    } catch (e) {
      alert(`儲存失敗：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSavingText(false);
    }
  };

  // ── AI 文案校對 ──
  const handleReview = async () => {
    if (!selectedId) return;
    const vendor = list.find((p) => p.id === selectedId)?.vendor || '';
    setReviewing(true);
    setReviewErr(null);
    setReview(null);
    try {
      const r = await reviewCopy({ title, vendor, productType: ptype, descriptionHtml: desc });
      setReview(r);
    } catch (e) {
      setReviewErr(e instanceof Error ? e.message : String(e));
    } finally {
      setReviewing(false);
    }
  };

  // ── 圖片 ──
  const runMedia = async (fn: () => Promise<unknown>, after?: () => void) => {
    if (!selectedId) return;
    setBusyMedia(true);
    try {
      await fn();
      if (after) after();
      else await reload();
    } catch (e) {
      alert(`圖片操作失敗：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusyMedia(false);
    }
  };
  const handleAddImage = () => {
    const url = newUrl.trim();
    if (!url || !selectedId) return;
    runMedia(() => addMedia(selectedId, [url]), undefined);
    setNewUrl('');
  };
  const handleDeleteImage = (mediaId: string) => {
    if (!selectedId || !confirm('確定刪除呢張相？')) return;
    runMedia(() => deleteMedia(selectedId, [mediaId]));
  };
  const moveImage = (idx: number, dir: -1 | 1) => {
    setMedia((arr) => {
      const next = [...arr];
      const j = idx + dir;
      if (j < 0 || j >= next.length) return arr;
      [next[idx], next[j]] = [next[j], next[idx]];
      return next;
    });
    setOrderDirty(true);
  };
  const handleSaveOrder = () => {
    if (!selectedId) return;
    runMedia(() => reorderMedia(selectedId, media.map((m) => m.id)), () => setOrderDirty(false));
  };

  // ── Collection ──
  const runCol = async (fn: () => Promise<unknown>) => {
    if (!selectedId) return;
    setBusyCol(true);
    try {
      await fn();
      await reload();
    } catch (e) {
      alert(`Collection 操作失敗：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusyCol(false);
    }
  };
  const handleAddCol = () => {
    if (!addColId || !selectedId) return;
    const id = addColId;
    setAddColId('');
    runCol(() => addToCollection(selectedId, id));
  };

  const availableCollections = useMemo(() => {
    const inIds = new Set((product?.collections || []).map((c) => c.id));
    return allCollections.filter((c) => !inIds.has(c.id));
  }, [allCollections, product]);

  // ── Picker view ──
  if (!selectedId) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <FileEdit className="h-5 w-5 text-primary" />
          <h1 className="text-lg font-semibold">商品編輯器</h1>
          <span className="text-xs text-muted-foreground">Product Editor · 文案 / 圖片 / 分類</span>
        </div>
        {error && (
          <div className="rounded-md border border-rose-500/40 bg-rose-500/10 p-3 text-rose-200 text-sm flex items-center gap-2">
            <AlertCircle className="h-4 w-4" />
            {error}
          </div>
        )}
        <div className="relative max-w-md">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜尋商品名稱、品牌…"
            className="w-full pl-8 pr-3 py-1.5 text-sm rounded-md border border-border bg-background"
          />
        </div>
        {loadingList ? (
          <Skeleton className="h-64 w-full" />
        ) : (
          <div className="rounded-md border border-border/60 bg-card divide-y divide-border/40 max-h-[70vh] overflow-y-auto">
            {filtered.map((p) => (
              <button
                key={p.id}
                onClick={() => loadProduct(p.id)}
                className="w-full text-left px-3 py-2 hover:bg-accent/40 transition-colors flex items-center justify-between gap-3"
              >
                <span className="text-sm truncate">{p.title}</span>
                <span className="text-[11px] text-muted-foreground shrink-0">
                  {p.vendor || '—'} · {p.product_type || '（無分類）'}
                </span>
              </button>
            ))}
            {filtered.length === 0 && <div className="px-3 py-8 text-center text-sm text-muted-foreground">冇符合嘅商品</div>}
          </div>
        )}
        <p className="text-[11px] text-muted-foreground">
          ⚠️ 改文案 / 圖片 / collection 會即時寫返 Shopify，需要喺 Vercel 設定 <code>SHOPIFY_ADMIN_TOKEN</code>。
        </p>
      </div>
    );
  }

  // ── Editor view ──
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <button
            onClick={() => { setSelectedId(null); setProduct(null); }}
            className="text-xs px-2 py-1.5 rounded-md border border-border bg-card hover:bg-accent/60 inline-flex items-center gap-1"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            揀過
          </button>
          <FileEdit className="h-5 w-5 text-primary shrink-0" />
          <h1 className="text-base font-semibold truncate">{product?.title ?? '載入中…'}</h1>
        </div>
        <div className="flex items-center gap-2">
          {product?.onlineStoreUrl && (
            <a
              href={product.onlineStoreUrl}
              target="_blank"
              rel="noreferrer"
              className="text-xs px-2 py-1.5 rounded-md border border-border bg-card hover:bg-accent/60 inline-flex items-center gap-1"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              睇網店
            </a>
          )}
          <button onClick={reload} disabled={loadingProduct} className="text-xs px-2 py-1.5 rounded-md border border-border bg-card hover:bg-accent/60 inline-flex items-center gap-1">
            <RefreshCw className={`h-3.5 w-3.5 ${loadingProduct ? 'animate-spin' : ''}`} />
            重載
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-rose-500/40 bg-rose-500/10 p-3 text-rose-200 text-sm flex items-center gap-2">
          <AlertCircle className="h-4 w-4" />
          {error}
        </div>
      )}

      {loadingProduct || !product ? (
        <Skeleton className="h-96 w-full" />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* 文案 */}
          <section className="rounded-md border border-border/60 bg-card p-4 space-y-3 lg:col-span-2">
            <h2 className="text-sm font-semibold">文案</h2>
            <div>
              <label className="text-[11px] text-muted-foreground">商品名稱 Title</label>
              <input value={title} onChange={(e) => setTitle(e.target.value)} className="w-full mt-0.5 px-2 py-1.5 text-sm rounded-md border border-border bg-background" />
            </div>
            <div>
              <label className="text-[11px] text-muted-foreground">分類 Product type</label>
              <input value={ptype} onChange={(e) => setPtype(e.target.value)} className="w-full mt-0.5 px-2 py-1.5 text-sm rounded-md border border-border bg-background" />
            </div>
            <div>
              <label className="text-[11px] text-muted-foreground">描述 Description（HTML 格式）</label>
              <textarea value={desc} onChange={(e) => setDesc(e.target.value)} rows={8} className="w-full mt-0.5 px-2 py-1.5 text-xs font-mono rounded-md border border-border bg-background" />
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <button
                onClick={handleSaveText}
                disabled={savingText}
                className="text-xs px-3 py-1.5 rounded-md border border-primary/50 bg-primary/10 text-primary hover:bg-primary/20 inline-flex items-center gap-1 disabled:opacity-50"
              >
                <Save className="h-3.5 w-3.5" />
                {savingText ? '儲存中…' : '儲存文案去 Shopify'}
              </button>
              <button
                onClick={handleReview}
                disabled={reviewing}
                title="Claude 上網搵官方資料核對 + 出更正中英文案"
                className="text-xs px-3 py-1.5 rounded-md border border-border bg-card hover:bg-accent/60 inline-flex items-center gap-1 disabled:opacity-50"
              >
                <Sparkles className={`h-3.5 w-3.5 ${reviewing ? 'animate-pulse' : ''}`} />
                {reviewing ? 'AI 校對中…(約 30 秒)' : 'AI 校對文案'}
              </button>
            </div>
            {reviewErr && <div className="text-xs text-rose-300">{reviewErr}</div>}
            {review && (
              <div className="rounded-md border border-border/60 bg-muted/20 p-3 space-y-2 text-xs">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold">AI 校對結果</span>
                  <span
                    className={`px-1.5 py-0.5 rounded border text-[10px] ${
                      review.confidence === 'high'
                        ? 'border-emerald-500/40 text-emerald-300'
                        : review.confidence === 'medium'
                          ? 'border-amber-500/40 text-amber-300'
                          : 'border-rose-500/40 text-rose-300'
                    }`}
                  >
                    信心 {review.confidence}
                  </span>
                  {!review.found && <span className="text-muted-foreground">（搵唔到官方資料,請人手核實）</span>}
                </div>
                {review.discrepancies.length > 0 && (
                  <div>
                    <div className="text-muted-foreground mb-1">疑似錯漏 {review.discrepancies.length}:</div>
                    <ul className="space-y-1">
                      {review.discrepancies.map((d, i) => (
                        <li key={i} className="border-l-2 border-amber-500/40 pl-2">
                          <span className="text-foreground">{d.field}</span>:{' '}
                          <span className="text-rose-300 line-through">{d.current}</span> →{' '}
                          <span className="text-emerald-300">{d.correct}</span>
                          {d.source && (
                            <a href={d.source} target="_blank" rel="noreferrer" className="text-primary hover:underline ml-1">
                              來源
                            </a>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  <div>
                    <div className="text-muted-foreground mb-0.5">更正中文</div>
                    <div className="rounded border border-border/40 bg-background p-2 max-h-32 overflow-y-auto whitespace-pre-wrap">{review.correctedZh || '—'}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground mb-0.5">Corrected English</div>
                    <div className="rounded border border-border/40 bg-background p-2 max-h-32 overflow-y-auto whitespace-pre-wrap">{review.correctedEn || '—'}</div>
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <button onClick={() => setDesc(review.correctedZh)} disabled={!review.correctedZh} className="text-[11px] px-2 py-1 rounded-md border border-border bg-card hover:bg-accent/60 disabled:opacity-50">套用中文</button>
                  <button onClick={() => setDesc(review.correctedEn)} disabled={!review.correctedEn} className="text-[11px] px-2 py-1 rounded-md border border-border bg-card hover:bg-accent/60 disabled:opacity-50">套用英文</button>
                  <button onClick={() => setDesc(`${review.correctedZh}\n\n${review.correctedEn}`)} className="text-[11px] px-2 py-1 rounded-md border border-primary/50 bg-primary/10 text-primary hover:bg-primary/20">套用(中+英)</button>
                  <span className="text-[10px] text-muted-foreground">套用後記得撳「儲存文案去 Shopify」</span>
                </div>
                {review.sources.length > 0 && (
                  <div className="text-[10px] text-muted-foreground">
                    來源:{' '}
                    {review.sources.map((s, i) => (
                      <a key={i} href={s} target="_blank" rel="noreferrer" className="text-primary hover:underline mr-2">[{i + 1}]</a>
                    ))}
                  </div>
                )}
                <div className="text-[10px] text-muted-foreground">
                  ⚠️ 若英文用 Langify 翻譯儲存,「套用」只改主語言 body_html — 英文要喺 Langify 度更新。AI 可能出錯,請對返來源。
                </div>
              </div>
            )}
          </section>

          {/* 圖片 */}
          <section className="rounded-md border border-border/60 bg-card p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">圖片 <span className="text-[11px] font-normal text-muted-foreground">({media.length})</span></h2>
              {orderDirty && (
                <button onClick={handleSaveOrder} disabled={busyMedia} className="text-[11px] px-2 py-1 rounded-md border border-primary/50 bg-primary/10 text-primary hover:bg-primary/20 disabled:opacity-50">
                  儲存次序
                </button>
              )}
            </div>
            <div className="grid grid-cols-3 gap-2">
              {media.map((m, i) => (
                <div key={m.id} className="relative group border border-border/60 rounded-md overflow-hidden bg-muted/20 aspect-square">
                  {m.url ? <img src={m.url} alt="" className="w-full h-full object-cover" /> : <div className="flex items-center justify-center h-full text-[10px] text-muted-foreground">{m.type}</div>}
                  <button onClick={() => handleDeleteImage(m.id)} disabled={busyMedia} title="刪除" className="absolute top-1 right-1 p-0.5 rounded bg-rose-600/80 text-white opacity-0 group-hover:opacity-100 transition-opacity">
                    <Trash2 className="h-3 w-3" />
                  </button>
                  <div className="absolute bottom-1 left-1 flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button onClick={() => moveImage(i, -1)} disabled={i === 0 || busyMedia} className="p-0.5 rounded bg-black/60 text-white disabled:opacity-30"><ArrowUp className="h-3 w-3" /></button>
                    <button onClick={() => moveImage(i, 1)} disabled={i === media.length - 1 || busyMedia} className="p-0.5 rounded bg-black/60 text-white disabled:opacity-30"><ArrowDown className="h-3 w-3" /></button>
                  </div>
                  {i === 0 && <span className="absolute top-1 left-1 text-[9px] px-1 rounded bg-primary/80 text-primary-foreground">主圖</span>}
                </div>
              ))}
              {media.length === 0 && <div className="col-span-3 text-center text-xs text-muted-foreground py-6">冇圖片</div>}
            </div>
            <div className="flex items-center gap-1.5">
              <input value={newUrl} onChange={(e) => setNewUrl(e.target.value)} placeholder="貼圖片 URL 加相…" className="flex-1 px-2 py-1 text-xs rounded-md border border-border bg-background" />
              <button onClick={handleAddImage} disabled={busyMedia || !newUrl.trim()} className="text-xs px-2 py-1 rounded-md border border-border bg-card hover:bg-accent/60 inline-flex items-center gap-1 disabled:opacity-50">
                <Plus className="h-3.5 w-3.5" />加
              </button>
            </div>
            <p className="text-[10px] text-muted-foreground">* 由圖片 URL 加相。電腦檔案直接上載之後版本先支援。</p>
          </section>

          {/* Collection */}
          <section className="rounded-md border border-border/60 bg-card p-4 space-y-3">
            <h2 className="text-sm font-semibold">Collection <span className="text-[11px] font-normal text-muted-foreground">({product.collections.length})</span></h2>
            <div className="flex flex-wrap gap-1.5">
              {product.collections.map((c) => (
                <span key={c.id} className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-md border border-border bg-muted/30">
                  {c.title}
                  <button onClick={() => runCol(() => removeFromCollection(selectedId, c.id))} disabled={busyCol} title="移除" className="text-rose-300 hover:text-rose-200">
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
              {product.collections.length === 0 && <span className="text-xs text-muted-foreground">未加入任何 collection</span>}
            </div>
            <div className="flex items-center gap-1.5">
              <select value={addColId} onChange={(e) => setAddColId(e.target.value)} className="flex-1 px-2 py-1 text-xs rounded-md border border-border bg-background">
                <option value="">加入 collection…</option>
                {availableCollections.map((c) => (
                  <option key={c.id} value={c.id}>{c.title}</option>
                ))}
              </select>
              <button onClick={handleAddCol} disabled={busyCol || !addColId} className="text-xs px-2 py-1 rounded-md border border-border bg-card hover:bg-accent/60 inline-flex items-center gap-1 disabled:opacity-50">
                <Plus className="h-3.5 w-3.5" />加入
              </button>
            </div>
            <p className="text-[10px] text-muted-foreground">* 自動 / 規則 collection 無法手動加減（會回錯誤）。</p>
          </section>
        </div>
      )}
    </div>
  );
}
