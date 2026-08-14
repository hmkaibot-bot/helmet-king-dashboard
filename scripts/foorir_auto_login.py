#!/usr/bin/env python3
"""
Foorir 自動連線 — 保住 server-side token cache,dashboard 一開就有客流數據。

流程:
  1. 由 foorir-proxy edge function 攞 cached token,GET /auth/info 驗生死
  2. 生 → 收工(唔重新登入,避免踢走現有 session)
  3. 死 → 攞驗證碼(4 個大楷泡泡字,tesseract 讀唔到)→ Claude Haiku
     vision 讀字 → RSA 加密密碼登入 → token 回存 edge function cache
  4. 最多試 MAX_ATTEMPTS 次(每次新驗證碼),全敗先 exit 1

前端 FoorirLogin mount 時本身就會 fallback 去 server cache — 呢個 script
淨係負責令個 cache 長期有貨。

Env(GitHub Secrets):
  FOORIR_USERNAME / FOORIR_PASSWORD — Foorir 登入(同 Vercel VITE_FOORIR_* 同值)
  ANTHROPIC_API_KEY                 — 讀驗證碼用(claude-haiku)
  SUPABASE_URL / SUPABASE_ANON_KEY  — 可選;預設同前端 config.ts 一致
"""
import base64
import json
import os
import sys
import time

import requests
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import padding

FOORIR_BASE = "https://vf.foorir.com/hx-api"
SUPABASE_URL = os.environ.get("SUPABASE_URL") or "https://myrangmxyjamsupbxbba.supabase.co"
# anon key 係公開嘅(本身打包喺前端 bundle 入面),fallback 同 client/src/lib/config.ts 一致
SUPABASE_ANON_KEY = os.environ.get("SUPABASE_ANON_KEY") or (
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im15cmFuZ214eWphbXN1cGJ4YmJh"
    "Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU3MzA0NjQsImV4cCI6MjA5MTMwNjQ2NH0.RmMZyuLZrddw7kL4y2qFY8XaI6zGXPx5D9xCi58-iSY"
)
USERNAME = os.environ.get("FOORIR_USERNAME", "")
PASSWORD = os.environ.get("FOORIR_PASSWORD", "")
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")

# 同 client/src/lib/foorir.ts 一致 — Foorir 登入用嘅 RSA public key
RSA_PUBLIC_KEY_B64 = (
    "MFwwDQYJKoZIhvcNAQEBBQADSwAwSAJBANL378k3RiZHWx5AfJqdH9xRNBmD9wGD"
    "2iRe41HdTNF8RUhNnHit5NpMNtGL0NPTSSpPjjI1kJfVorRvaQerUgkCAwEAAQ=="
)

MAX_ATTEMPTS = 6
TIMEOUT = 30


def edge_headers(action: str) -> dict:
    return {
        "Authorization": f"Bearer {SUPABASE_ANON_KEY}",
        "x-foorir-action": action,
    }


def get_cached_token() -> str | None:
    try:
        r = requests.get(f"{SUPABASE_URL}/functions/v1/foorir-proxy",
                         headers=edge_headers("get-cached-token"), timeout=TIMEOUT)
        if r.ok:
            return r.json().get("token") or None
    except requests.RequestException as e:
        print(f"[cache] read failed: {e}")
    return None


def save_token(token: str) -> None:
    try:
        r = requests.post(f"{SUPABASE_URL}/functions/v1/foorir-proxy",
                          headers={**edge_headers("save-token"), "Content-Type": "application/json"},
                          json={"token": token}, timeout=TIMEOUT)
        print(f"[cache] save-token → HTTP {r.status_code}")
    except requests.RequestException as e:
        print(f"[cache] save failed: {e}")


def token_alive(token: str) -> bool:
    try:
        r = requests.get(f"{FOORIR_BASE}/auth/info",
                         headers={"Authorization": f"Bearer {token}"}, timeout=TIMEOUT)
        return r.ok
    except requests.RequestException:
        return False


def read_captcha_with_claude(img_b64: str) -> str:
    """Claude Haiku vision 讀 4 個大楷字母。返回大楷字串(可能長度唔啱,由 caller 篩)。"""
    media = "image/png"
    payload = {
        "model": "claude-haiku-4-5-20251001",
        "max_tokens": 16,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "image", "source": {"type": "base64", "media_type": media, "data": img_b64}},
                {"type": "text", "text": "This CAPTCHA shows exactly 4 uppercase letters (A-Z) drawn as hollow bubble letters, with a strike-through line. Reply with ONLY the 4 letters, nothing else."},
            ],
        }],
    }
    r = requests.post("https://api.anthropic.com/v1/messages",
                      headers={
                          "x-api-key": ANTHROPIC_API_KEY,
                          "anthropic-version": "2023-06-01",
                          "Content-Type": "application/json",
                      },
                      json=payload, timeout=60)
    r.raise_for_status()
    text = "".join(b.get("text", "") for b in r.json().get("content", []))
    guess = "".join(c for c in text.upper() if c.isalpha())
    return guess


def rsa_encrypt_password() -> str:
    der = base64.b64decode(RSA_PUBLIC_KEY_B64)
    pub = serialization.load_der_public_key(der)
    ct = pub.encrypt(PASSWORD.encode(), padding.PKCS1v15())
    return base64.b64encode(ct).decode()


def try_login() -> str | None:
    cap = requests.get(f"{FOORIR_BASE}/auth/code", timeout=TIMEOUT).json()
    uuid, img = cap.get("uuid", ""), cap.get("img", "")
    if not uuid or not img:
        print("[login] captcha response missing uuid/img")
        return None
    img_b64 = img.split(",")[-1]

    guess = read_captcha_with_claude(img_b64)
    print(f"[login] captcha guess: {guess}")
    if len(guess) != 4:
        return None

    r = requests.post(f"{FOORIR_BASE}/auth/login",
                      json={"username": USERNAME, "password": rsa_encrypt_password(),
                            "code": guess, "uuid": uuid},
                      timeout=TIMEOUT)
    data = r.json() if r.content else {}
    token = data.get("token")
    if token:
        return token.removeprefix("Bearer ").strip()
    print(f"[login] failed: HTTP {r.status_code} {str(data.get('message', ''))[:120]}")
    return None


def main() -> int:
    # 1) cache 有生嘅 token → 唔使做嘢
    cached = get_cached_token()
    if cached and token_alive(cached):
        print("[ok] cached token still alive — nothing to do")
        return 0
    print("[info] cached token missing/dead — auto login")

    if not USERNAME or not PASSWORD:
        print("[skip] FOORIR_USERNAME / FOORIR_PASSWORD not set")
        return 0
    if not ANTHROPIC_API_KEY:
        print("[skip] ANTHROPIC_API_KEY not set — cannot read captcha")
        return 0

    # 2) captcha 自動登入,錯就換過張再試
    for attempt in range(1, MAX_ATTEMPTS + 1):
        print(f"=== attempt {attempt}/{MAX_ATTEMPTS} ===")
        try:
            token = try_login()
        except Exception as e:  # 網絡/API 異常照樣入下一輪
            print(f"[login] error: {e}")
            token = None
        if token:
            if token_alive(token):
                save_token(token)
                print("[ok] logged in, token cached server-side")
                return 0
            print("[login] got token but /auth/info rejected it?")
        time.sleep(3)

    print(f"[fail] could not log in after {MAX_ATTEMPTS} attempts")
    return 1


if __name__ == "__main__":
    sys.exit(main())
