/**
 * Foorir CAPTCHA Login Card
 * Shows a small inline card where the user types the CAPTCHA code (4 chars) to connect to Foorir.
 * Once logged in, hides itself and calls onSuccess.
 */
import { useEffect, useState, useCallback } from 'react';
import { getCaptcha, loginFoorir, getFoorirToken, checkSession, getCachedServerToken } from '@/lib/foorir';
import { Card, CardContent } from '@/components/ui/card';
import { Users, RefreshCw, CheckCircle2, AlertCircle } from 'lucide-react';

interface Props {
  onSuccess: () => void;
  compact?: boolean; // smaller version for embedding in daily report
}

export function FoorirLogin({ onSuccess, compact = false }: Props) {
  const [captchaImg, setCaptchaImg] = useState('');
  const [captchaUuid, setCaptchaUuid] = useState('');
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(false);
  const [checking, setChecking] = useState(true);

  // Check existing session on mount — try local token first, then server-cached token
  useEffect(() => {
    (async () => {
      // 1) Try local token (localStorage)
      if (getFoorirToken()) {
        const valid = await checkSession();
        if (valid) { setConnected(true); onSuccess(); setChecking(false); return; }
      }
      // 2) Try server-cached token (Supabase Edge Function)
      const serverToken = await getCachedServerToken();
      if (serverToken) {
        const valid = await checkSession();
        if (valid) { setConnected(true); onSuccess(); setChecking(false); return; }
      }
      // 3) No valid token — show CAPTCHA
      setChecking(false);
      refreshCaptcha();
    })();
  }, []);

  const refreshCaptcha = useCallback(async () => {
    try {
      const { uuid, img } = await getCaptcha();
      setCaptchaUuid(uuid);
      setCaptchaImg(img);
      setCode('');
      setError('');
    } catch (e) {
      setError('無法載入驗證碼');
    }
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (code.length < 3) return;
    setLoading(true);
    setError('');
    const result = await loginFoorir(code.trim(), captchaUuid);
    setLoading(false);
    if (result.ok) {
      setConnected(true);
      onSuccess();
    } else {
      setError(result.message || '驗證碼錯誤');
      refreshCaptcha();
    }
  };

  if (checking) return null;

  // Already connected — show success badge
  if (connected) {
    return compact ? (
      <div className="flex items-center gap-1.5 text-[11px] text-green-400">
        <CheckCircle2 className="h-3 w-3" /> 客流已連接
      </div>
    ) : (
      <Card className="border-green-500/20 bg-green-500/5">
        <CardContent className="p-3 flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4 text-green-400" />
          <span className="text-xs text-green-300">Foorir 客流系統已連接</span>
          <button onClick={() => { setConnected(false); refreshCaptcha(); }}
            className="ml-auto text-[10px] text-muted-foreground hover:text-foreground">
            重新連接
          </button>
        </CardContent>
      </Card>
    );
  }

  // CAPTCHA login form
  return (
    <Card className={`border-border/40 ${compact ? '' : ''}`}>
      <CardContent className={compact ? 'p-3' : 'p-4'}>
        <div className="flex items-start gap-3">
          <Users className={`text-muted-foreground shrink-0 ${compact ? 'h-4 w-4 mt-0.5' : 'h-5 w-5 mt-0.5'}`} />
          <div className="flex-1 min-w-0">
            <p className={`font-medium mb-1 ${compact ? 'text-[11px]' : 'text-xs'}`}>
              輸入驗證碼查看客流數據
              <span className="text-muted-foreground font-normal ml-1">Foorir Foot Traffic</span>
            </p>
            <form onSubmit={handleSubmit} className="flex items-center gap-2 flex-wrap">
              {/* CAPTCHA image */}
              {captchaImg && (
                <div className="flex items-center gap-1.5">
                  <img
                    src={captchaImg}
                    alt="CAPTCHA"
                    className="h-8 rounded border border-border/40 bg-white"
                    style={{ imageRendering: 'auto' }}
                  />
                  <button type="button" onClick={refreshCaptcha} title="刷新驗證碼"
                    className="text-muted-foreground hover:text-foreground p-0.5">
                    <RefreshCw className="h-3 w-3" />
                  </button>
                </div>
              )}
              {/* Code input */}
              <input
                value={code}
                onChange={e => setCode(e.target.value)}
                placeholder="輸入驗證碼"
                maxLength={6}
                autoComplete="off"
                className="w-20 px-2 py-1 text-xs bg-background border border-border/60 rounded text-foreground placeholder-muted-foreground focus:outline-none focus:border-primary"
              />
              <button
                type="submit"
                disabled={loading || code.length < 3}
                className="px-3 py-1 text-xs bg-primary/90 text-primary-foreground rounded hover:bg-primary disabled:opacity-50 transition-colors"
              >
                {loading ? '連接中...' : '連接'}
              </button>
              {error && (
                <span className="flex items-center gap-1 text-[10px] text-red-400">
                  <AlertCircle className="h-3 w-3" /> {error}
                </span>
              )}
            </form>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
