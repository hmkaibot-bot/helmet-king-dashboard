import { useState } from 'react';
import { useAuth } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Lock, Mail } from 'lucide-react';
import { HelmetLogo } from '@/components/helmet-logo';

export default function LoginPage() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    const result = await login(email.trim(), password);
    if (!result.ok) {
      setError(result.message || '登入失敗');
      setPassword('');
    }
    setLoading(false);
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <Card className="w-full max-w-sm border-border/50">
        <CardContent className="pt-8 pb-8 px-6">
          <div className="flex flex-col items-center gap-6">
            <div className="flex flex-col items-center gap-3">
              <HelmetLogo size={56} />
              <div className="text-center">
                <h1 className="text-lg font-semibold tracking-tight">頭盔王</h1>
                <p className="text-xs text-muted-foreground mt-0.5">Helmet King Dashboard</p>
              </div>
            </div>

            <form onSubmit={handleSubmit} className="w-full space-y-4">
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  data-testid="input-email"
                  type="email"
                  placeholder="電郵 Email"
                  value={email}
                  onChange={(e) => { setEmail(e.target.value); setError(''); }}
                  className="pl-10"
                  autoComplete="username"
                  autoFocus
                />
              </div>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  data-testid="input-password"
                  type="password"
                  placeholder="輸入密碼 Enter password"
                  value={password}
                  onChange={(e) => { setPassword(e.target.value); setError(''); }}
                  className="pl-10"
                  autoComplete="current-password"
                />
              </div>
              {error && (
                <p className="text-xs text-destructive" data-testid="text-error">
                  {error}
                </p>
              )}
              <Button
                data-testid="button-login"
                type="submit"
                className="w-full"
                disabled={loading || !password || !email}
              >
                {loading ? '驗證中...' : '登入 Login'}
              </Button>
            </form>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
