/**
 * CSV 匯出 helper — 帶 UTF-8 BOM,Excel 直接開唔會中文亂碼。
 */

export interface CsvColumn<T> {
  /** Header text in the CSV */
  label: string;
  /** Extract the cell value from a row */
  value: (row: T) => string | number | null | undefined;
}

function escapeCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

export function downloadCsv<T>(filename: string, rows: T[], columns: CsvColumn<T>[]) {
  const header = columns.map((c) => escapeCell(c.label)).join(',');
  const lines = rows.map((row) =>
    columns.map((c) => escapeCell(c.value(row))).join(',')
  );
  const csv = '\uFEFF' + [header, ...lines].join('\r\n');

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.csv') ? filename : `${filename}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** 今日日期字串 (YYYYMMDD) 方便做檔名 */
export function dateStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}
