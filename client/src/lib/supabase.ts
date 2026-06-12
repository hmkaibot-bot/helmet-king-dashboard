import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config';

// localStorage-backed auth storage with in-memory fallback for sandboxed
// iframes (some embed contexts throw on any localStorage access).
const memoryStorage: Record<string, string> = {};
const customStorage = {
  getItem: (key: string) => {
    try { return localStorage.getItem(key); } catch { return memoryStorage[key] ?? null; }
  },
  setItem: (key: string, value: string) => {
    try { localStorage.setItem(key, value); } catch { memoryStorage[key] = value; }
  },
  removeItem: (key: string) => {
    try { localStorage.removeItem(key); } catch { delete memoryStorage[key]; }
  },
};

// Anon key only — RLS policies (sql/enable-rls.sql) grant data access to
// logged-in (authenticated) users. Once signed in via supabase.auth, this
// client automatically attaches the user's JWT to every query.
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { storage: customStorage, autoRefreshToken: true, persistSession: true },
});
