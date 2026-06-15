import { supabase } from './supabase';
import { updateProducts } from './shopify-update';

export interface EditorMedia {
  id: string;
  url: string | null;
  type: string;
  status: string;
}
export interface EditorCollection {
  id: string;
  title: string;
}
export interface EditorProduct {
  id: string;
  title: string;
  descriptionHtml: string;
  productType: string;
  tags: string[];
  status: string;
  handle: string;
  onlineStoreUrl: string | null;
  media: EditorMedia[];
  collections: EditorCollection[];
}

async function authToken(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  const t = data.session?.access_token;
  if (!t) throw new Error('未登入 — 請重新登入 dashboard');
  return t;
}

async function callProduct(payload: Record<string, unknown>): Promise<any> {
  const token = await authToken();
  const resp = await fetch('/api/shopify-product', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  let j: any = null;
  try { j = await resp.json(); } catch { /* non-JSON (本地 dev 404) */ }
  if (!resp.ok) throw new Error(j?.error || `服務回應 ${resp.status}（部署後先可用）`);
  if (j && j.ok === false) throw new Error(j.error || '操作失敗');
  return j;
}

export async function fetchProduct(productId: string): Promise<EditorProduct> {
  const j = await callProduct({ action: 'get', productId });
  return j.product as EditorProduct;
}

export async function listCollections(): Promise<EditorCollection[]> {
  const j = await callProduct({ action: 'listCollections' });
  return (j.collections || []) as EditorCollection[];
}

export async function saveProductText(
  productId: string,
  fields: { title?: string; descriptionHtml?: string; productType?: string; tags?: string[] }
): Promise<void> {
  const r = await updateProducts([{ productId, ...fields }]);
  if (r.failed > 0) throw new Error(r.results.find((x) => !x.ok)?.error || '儲存失敗');
}

export const addMedia = (productId: string, urls: string[]) => callProduct({ action: 'addMedia', productId, urls });
export const deleteMedia = (productId: string, mediaIds: string[]) => callProduct({ action: 'deleteMedia', productId, mediaIds });
export const reorderMedia = (productId: string, mediaIds: string[]) => callProduct({ action: 'reorderMedia', productId, mediaIds });
export const addToCollection = (productId: string, collectionId: string) => callProduct({ action: 'addCollection', productId, collectionId });
export const removeFromCollection = (productId: string, collectionId: string) =>
  callProduct({ action: 'removeCollection', productId, collectionId });
