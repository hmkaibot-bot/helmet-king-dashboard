import { createClient } from '@supabase/supabase-js';

// AliCloud FC Reverse Proxy — service_role key stays server-side
const SUPABASE_URL = 'https://supabase-proxy-hk-dashboard-pdjqgrdxpm.cn-hongkong.fcapp.run';
const SUPABASE_KEY = 'hk-dashboard-proxy-2026';

// Memory-only storage to avoid localStorage in sandboxed iframe
const memoryStorage: Record<string, string> = {};
const customStorage = {
  getItem: (key: string) => memoryStorage[key] ?? null,
  setItem: (key: string, value: string) => { memoryStorage[key] = value; },
  removeItem: (key: string) => { delete memoryStorage[key]; },
};

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    storage: customStorage,
  },
});
