/**
 * MultiSelectChipFilter — chip-style 多選 filter，帶搜尋 popover
 * 用於品牌 / 分類這類 options 多但需要快選取的場景。
 * 原本住喺 dead-stock.tsx,抽出嚟俾 推廣商品池 / 推廣詳情 等頁共用。
 */
import React from 'react';
import { Search, X, CheckCircle2 } from 'lucide-react';

interface MultiSelectChipFilterProps {
  label: string;            // 左邊標題（例：品牌）
  options: string[];        // 所有可選項
  selected: string[];       // 現時已選
  onChange: (next: string[]) => void;
  placeholder?: string;     // 搜尋框 placeholder
  emptyLabel?: string;      // 0 選 時 chip 顯示（預設「全部」）
  maxChips?: number;        // 現時已選動 chip 最多顯示几個，剩下收為 +N
}

export function MultiSelectChipFilter({
  label, options, selected, onChange,
  placeholder = '搜尋…',
  emptyLabel = '全部',
  maxChips = 5,
}: MultiSelectChipFilterProps) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const popRef = React.useRef<HTMLDivElement>(null);

  // 打開 popover 噠那個 moment snapshot 一次項目順序
  // 連續 toggle 期間清單不重排，防止這個選完這個跳動
  const [snapshot, setSnapshot] = React.useState<string[]>([]);

  // Click outside to close
  React.useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (popRef.current && !popRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  // 開 popover 時重新 snapshot：已選 → alphabetical 在最頂，其餘 → alphabetical 跟後
  React.useEffect(() => {
    if (!open) return;
    const sel = new Set(selected);
    const top = options.filter(o => sel.has(o));
    const rest = options.filter(o => !sel.has(o));
    setSnapshot([...top, ...rest]);
    // 有意不依賴 selected：snapshot 一旦設了就凍住，直到重新打開
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, options]);

  const q = query.trim().toLowerCase();
  const baseList = snapshot.length > 0 ? snapshot : options;
  const filtered = q
    ? baseList.filter(o => (o ?? '').toLowerCase().includes(q))
    : baseList;

  const toggle = (v: string) => {
    onChange(selected.includes(v) ? selected.filter(x => x !== v) : [...selected, v]);
  };
  const clearAll = () => onChange([]);
  const selectAllVisible = () => {
    const merged = Array.from(new Set([...selected, ...filtered]));
    onChange(merged);
  };

  const visibleChips = selected.slice(0, maxChips);
  const hiddenCount = Math.max(0, selected.length - maxChips);

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[11px] font-medium text-muted-foreground w-20 shrink-0">{label}</span>

      {/* + 加選項 button + popover — 釘定位置，不受已選 chip 推動 */}
      <div className="relative shrink-0" ref={popRef}>
        <button
          onClick={() => { setOpen(o => !o); setQuery(''); }}
          className="px-2.5 py-1 rounded-md text-xs border border-dashed border-border/60 bg-background hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
        >
          + 加{label}
        </button>
        {open && (
          <div className="absolute z-50 mt-1 left-0 w-72 rounded-md border border-border bg-popover shadow-lg p-2">
            <div className="relative mb-2">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <input
                autoFocus
                type="text"
                placeholder={placeholder}
                value={query}
                onChange={e => setQuery(e.target.value)}
                className="w-full pl-7 pr-2 py-1.5 rounded-md border border-border bg-background text-xs focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
            <div className="max-h-64 overflow-y-auto -mx-1 px-1">
              {filtered.length === 0 && (
                <div className="text-xs text-muted-foreground text-center py-4">沒有符合結果</div>
              )}
              {filtered.map(opt => {
                const checked = selected.includes(opt);
                return (
                  <button
                    key={opt}
                    onClick={() => toggle(opt)}
                    className="flex items-center gap-2 w-full px-2 py-1.5 rounded text-xs text-left hover:bg-accent"
                  >
                    <span className={`inline-flex items-center justify-center w-4 h-4 rounded border ${
                      checked
                        ? 'bg-primary border-primary text-primary-foreground'
                        : 'border-border bg-background'
                    }`}>
                      {checked && <CheckCircle2 className="h-3 w-3" />}
                    </span>
                    <span className="flex-1 truncate">{opt}</span>
                  </button>
                );
              })}
            </div>
            {filtered.length > 1 && (
              <div className="flex items-center justify-between gap-2 mt-2 pt-2 border-t border-border/60">
                <button
                  onClick={selectAllVisible}
                  className="text-[11px] text-primary hover:underline"
                >
                  全選符合（{filtered.length}）
                </button>
                {selected.length > 0 && (
                  <button
                    onClick={clearAll}
                    className="text-[11px] text-muted-foreground hover:text-foreground"
                  >
                    清空已選
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 「全部」 chip = 清空 selection */}
      <button
        onClick={clearAll}
        className={`px-2.5 py-1 rounded-md text-xs border transition-colors ${
          selected.length === 0
            ? 'bg-primary text-primary-foreground border-primary'
            : 'border-border/60 bg-background hover:bg-accent'
        }`}
      >
        {emptyLabel}
      </button>

      {/* 已選 chips — 在右邊增長，不影響 button 位置 */}
      {visibleChips.map(v => (
        <button
          key={v}
          onClick={() => toggle(v)}
          className="group inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs border bg-primary/90 text-primary-foreground border-primary hover:bg-primary"
          title={`移除：${v}`}
        >
          <span className="truncate max-w-[180px]">{v}</span>
          <X className="h-3 w-3 opacity-70 group-hover:opacity-100" />
        </button>
      ))}
      {hiddenCount > 0 && (
        <span className="text-[11px] text-muted-foreground px-1">
          +{hiddenCount}
        </span>
      )}
    </div>
  );
}
