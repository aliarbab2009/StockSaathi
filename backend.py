#!/usr/bin/env python3
"""
StockSaathi Backend
===================
Single-file Python server. Serves the static SPA AND exposes a real email
API (/api/send-consent) backed by SMTP or Resend. No mailto. Ever.

Configure once via a `.env` file in this folder, or environment variables.

=== Option A: Gmail / any SMTP (recommended) =============================
  SMTP_HOST=smtp.gmail.com
  SMTP_PORT=587
  SMTP_USER=your.email@gmail.com
  SMTP_PASS=your-16-char-app-password
  SMTP_FROM=StockSaathi <your.email@gmail.com>

  (Gmail: create an app password at https://myaccount.google.com/apppasswords)

=== Option B: Resend.com (zero SMTP config) ==============================
  RESEND_API_KEY=re_xxxxxxxxx
  RESEND_FROM=StockSaathi <onboarding@resend.dev>

=== No config? ===========================================================
  Still works for demo: emails are logged to app/logs/emails/*.txt
  and a success response is returned (with a "warning" field).
  The teen still completes onboarding — you just don't actually deliver.
"""

import os
import sys
import json
import time
import http.server
import socketserver
import urllib.request
import urllib.error
from pathlib import Path
from socketserver import ThreadingMixIn
from collections import defaultdict, deque
import threading as _threading

APP_DIR = Path(__file__).parent.resolve()
LOG_DIR = APP_DIR / "logs" / "emails"
LOG_DIR.mkdir(parents=True, exist_ok=True)

# Make the `api` package importable so we can share helpers.
if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))
from api._email import (  # noqa: E402
    consent_body, send_email, sanitize_header, is_valid_email,
    is_safe_consent_url, resolve_consent_allowlist, redact,
)


def load_env():
    """Load .env. Unlike os.environ.setdefault, THIS overrides shell vars so
    the .env file is the single source of truth at the project root."""
    env_path = APP_DIR / ".env"
    if not env_path.exists():
        return
    for raw in env_path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        v = v.strip().strip('"').strip("'")
        os.environ[k.strip()] = v


load_env()

PORT = int(os.environ.get("PORT") or os.environ.get("STOCKSAATHI_PORT") or "7348")
HOST = os.environ.get("HOST") or ("0.0.0.0" if os.environ.get("PORT") else "127.0.0.1")
PUBLIC_ORIGIN = os.environ.get("PUBLIC_ORIGIN", "").rstrip("/")

UPSTREAM_EMAIL_URL = os.environ.get("UPSTREAM_EMAIL_URL", "").strip()
IS_UPSTREAM = os.environ.get("IS_UPSTREAM", "").strip() in ("1", "true", "yes")

# Sane defaults. Explicit env var required to raise the ceiling — the old
# 100 000/hr "off by default" was effectively no rate limit at all.
RATE_LIMIT_PER_HOUR = int(os.environ.get("RATE_LIMIT_PER_HOUR", "30"))
CHAT_RATE_PER_HOUR = int(os.environ.get("CHAT_RATE_PER_HOUR", "240"))
MAX_CHAT_BODY = int(os.environ.get("MAX_CHAT_BODY", str(64 * 1024)))   # 64 KB
MAX_EMAIL_BODY = int(os.environ.get("MAX_EMAIL_BODY", str(8 * 1024)))  # 8 KB
CHAT_MODEL_PIN = os.environ.get("CHAT_MODEL", "llama-3.3-70b-versatile")
CHAT_MAX_TOKENS = int(os.environ.get("CHAT_MAX_TOKENS", "800"))

_rate_lock = _threading.Lock()
_rate_bucket = defaultdict(deque)
_chat_bucket = defaultdict(deque)
_last_gc = [time.time()]


def _gc_rate_buckets(now):
    """Drop IPs whose buckets are empty / all entries expired. Bounded memory."""
    if now - _last_gc[0] < 600:
        return
    _last_gc[0] = now
    for bucket_map in (_rate_bucket, _chat_bucket):
        stale = []
        for ip, b in bucket_map.items():
            while b and now - b[0] > 3600:
                b.popleft()
            if not b:
                stale.append(ip)
        for ip in stale:
            bucket_map.pop(ip, None)


# --------------------------------------------------------------------------
# CORS allowlist + security headers
# --------------------------------------------------------------------------
_ALLOWED_ORIGINS = {
    PUBLIC_ORIGIN,
    "https://stocksaathi.co.in",
    "https://www.stocksaathi.co.in",
    f"http://localhost:{PORT}",
    f"http://127.0.0.1:{PORT}",
    # Dev convenience — Vite / Live Server ports
    "http://localhost:5173",
    "http://localhost:3000",
}
_ALLOWED_ORIGINS.discard("")


def _allow_origin(origin):
    if not origin:
        return None
    if origin in _ALLOWED_ORIGINS:
        return origin
    if origin.startswith("https://") and origin.endswith(".vercel.app"):
        return origin
    return None


def _write_security_headers(handler_self):
    handler_self.send_header("X-Content-Type-Options", "nosniff")
    handler_self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
    handler_self.send_header("X-Frame-Options", "DENY")
    handler_self.send_header("Permissions-Policy",
                             "camera=(), microphone=(), geolocation=(), payment=()")
    # Relatively open CSP so the inline favicon SVG + Supabase + Groq work.
    handler_self.send_header(
        "Content-Security-Policy",
        ("default-src 'self'; "
         "img-src 'self' data: https:; "
         "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
         "font-src 'self' data: https://fonts.gstatic.com; "
         # esm.sh hosts the Supabase JS SDK which is loaded via dynamic
         # import() from js/db/supabase.js. Without it the client can't
         # connect to the DB and trades fall back to local-only.
         "script-src 'self' https://esm.sh; "
         "connect-src 'self' https: wss:; "
         "worker-src 'self'; "
         "frame-ancestors 'none'; "
         "base-uri 'self'; object-src 'none'")
    )


# --------------------------------------------------------------------------
# Upstream relay (cloners can forward to the hosted instance).
# --------------------------------------------------------------------------

def send_via_upstream(to_email, teen, token, consent_url, relay_header=False):
    if not UPSTREAM_EMAIL_URL:
        return {"ok": False, "reason": "no_upstream"}
    if IS_UPSTREAM:
        return {"ok": False, "reason": "self_is_upstream"}
    if relay_header:
        return {"ok": False, "reason": "already_relayed"}
    payload = json.dumps({
        "to": to_email, "teenName": teen, "token": token,
        "consentUrl": consent_url,
    }).encode("utf-8")
    req = urllib.request.Request(
        UPSTREAM_EMAIL_URL,
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "StockSaathi-Relay/1.0",
            "X-StockSaathi-Relay": "1",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            data = json.loads(r.read().decode("utf-8"))
            if data.get("ok"):
                return {"ok": True, "provider": "upstream",
                        "via": UPSTREAM_EMAIL_URL,
                        "upstream_provider": data.get("provider")}
            return {"ok": False, "reason": "upstream_rejected", "upstream": data}
    except urllib.error.HTTPError as e:
        try:
            err = json.loads(e.read().decode("utf-8"))
        except Exception:
            err = {"message": "upstream_error"}
        return {"ok": False, "reason": "upstream_http_error",
                "status": e.code, "error": err}
    except Exception as e:
        return {"ok": False, "reason": "upstream_exception",
                "error": redact(str(e))[:200]}


# --------------------------------------------------------------------------
# HTTP handler
# --------------------------------------------------------------------------

class SSHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(APP_DIR), **kwargs)

    def log_message(self, fmt, *args):
        sys.stderr.write(f"[{self.log_date_time_string()}] {fmt % args}\n")

    def _json(self, code, obj, origin_hdr=None):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        _write_security_headers(self)
        allow = _allow_origin(origin_hdr or self.headers.get("Origin"))
        if allow:
            self.send_header("Access-Control-Allow-Origin", allow)
            self.send_header("Vary", "Origin")
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        """Apply baseline security headers to static file responses too."""
        if self.path != "/api/config":  # config has its own cache policy
            self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def do_OPTIONS(self):
        origin = self.headers.get("Origin")
        self.send_response(204)
        allow = _allow_origin(origin)
        if allow:
            self.send_header("Access-Control-Allow-Origin", allow)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers",
                         "Content-Type,X-StockSaathi-Relay")
        self.send_header("Access-Control-Max-Age", "600")
        self.end_headers()

    def do_GET(self):
        if self.path == "/api/health":
            # Don't leak WHICH providers are configured — just yes/no overall.
            any_email = bool(
                (os.environ.get("SMTP_USER") and os.environ.get("SMTP_PASS"))
                or os.environ.get("RESEND_API_KEY")
            )
            any_llm = bool(os.environ.get("GROQ_API_KEY")
                           or os.environ.get("ANTHROPIC_API_KEY"))
            self._json(200, {
                "ok": True,
                "name": "StockSaathi",
                "email_configured": any_email,
                "llm_configured": any_llm,
            })
            return
        if self.path == "/api/config":
            self._json(200, {
                "supabaseUrl": os.environ.get("SUPABASE_URL", "").strip(),
                "supabaseAnonKey": os.environ.get("SUPABASE_ANON_KEY", "").strip(),
                "appName": "StockSaathi",
                "supportEmail": os.environ.get("SUPPORT_EMAIL",
                                               "accounts@stocksaathi.co.in"),
            })
            return
        if self.path.startswith("/api/yahoo/chart/"):
            self._proxy_yahoo_chart()
            return
        super().do_GET()

    def _proxy_llm(self):
        groq_key = os.environ.get("GROQ_API_KEY", "").strip()
        if not groq_key:
            self._json(501, {"error": "no_server_key",
                             "detail": "Set GROQ_API_KEY on the server."})
            return

        origin = self.headers.get("Origin")
        if origin and not _allow_origin(origin):
            self._json(403, {"error": "forbidden_origin"}, origin)
            return

        ip = (self.headers.get("X-Forwarded-For", "").split(",")[0].strip()
              or self.client_address[0])
        now = time.time()
        with _rate_lock:
            _gc_rate_buckets(now)
            bucket = _chat_bucket[ip]
            while bucket and now - bucket[0] > 3600:
                bucket.popleft()
            if len(bucket) >= CHAT_RATE_PER_HOUR:
                self._json(429, {"error": "rate_limited",
                                 "detail": f"Max {CHAT_RATE_PER_HOUR} chat calls/hour per IP."})
                return
            bucket.append(now)

        # Body-size cap
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except Exception:
            length = 0
        if length > MAX_CHAT_BODY:
            self._json(413, {"error": "payload_too_large"})
            return

        try:
            raw = self.rfile.read(length) if length else b"{}"
            payload = json.loads(raw.decode("utf-8") or "{}")
        except Exception:
            self._json(400, {"error": "bad_body"})
            return

        # Pin model + cap max_tokens + forbid arbitrary tools. The client
        # cannot pick an expensive model or plug in tools on our dime.
        payload["model"] = CHAT_MODEL_PIN
        if not isinstance(payload.get("max_tokens"), int) or payload["max_tokens"] > CHAT_MAX_TOKENS:
            payload["max_tokens"] = CHAT_MAX_TOKENS
        if "tools" in payload:
            payload.pop("tools", None)
        # Messages must be a list of {role, content}
        msgs = payload.get("messages")
        if not isinstance(msgs, list) or not msgs:
            self._json(400, {"error": "bad_messages"})
            return
        safe_body = json.dumps(payload).encode("utf-8")

        req = urllib.request.Request(
            "https://api.groq.com/openai/v1/chat/completions",
            data=safe_body,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {groq_key}",
                "User-Agent": "StockSaathi-Backend/1.0",
            },
            method="POST",
        )

        try:
            with urllib.request.urlopen(req, timeout=25) as r:
                body = r.read()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            _write_security_headers(self)
            allow = _allow_origin(origin)
            if allow:
                self.send_header("Access-Control-Allow-Origin", allow)
                self.send_header("Vary", "Origin")
            self.end_headers()
            self.wfile.write(body)
        except urllib.error.HTTPError as e:
            try:
                err_body = e.read()
            except Exception:
                err_body = b'{"error":{"message":"upstream error"}}'
            self.send_response(e.code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(err_body)))
            self.send_header("Cache-Control", "no-store")
            _write_security_headers(self)
            allow = _allow_origin(origin)
            if allow:
                self.send_header("Access-Control-Allow-Origin", allow)
            self.end_headers()
            self.wfile.write(err_body)
        except Exception as e:
            self._json(502, {"error": "llm_unreachable",
                             "detail": redact(str(e))[:120]})

    def _proxy_yahoo_chart(self):
        import re as _re
        m = _re.search(r"/chart/([A-Za-z0-9.\-\^=_]{1,24})(\?[^#]{0,512})?$",
                       self.path)
        if not m:
            self._json(400, {"error": "bad_ticker"})
            return
        ticker = m.group(1)
        qs = m.group(2) or ""
        last_err = None
        hosts = [
            "https://query1.finance.yahoo.com/v8/finance/chart",
            "https://query2.finance.yahoo.com/v8/finance/chart",
        ]
        ua = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
              "AppleWebKit/537.36 (KHTML, like Gecko) "
              "Chrome/125.0.0.0 Safari/537.36")
        for base in hosts:
            url = f"{base}/{ticker}{qs}"
            req = urllib.request.Request(url, headers={
                "User-Agent": ua,
                "Accept": "application/json,text/plain,*/*",
                "Accept-Language": "en-US,en;q=0.9",
            })
            try:
                with urllib.request.urlopen(req, timeout=8) as r:
                    body = r.read()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "public, max-age=30")
                _write_security_headers(self)
                allow = _allow_origin(self.headers.get("Origin"))
                if allow:
                    self.send_header("Access-Control-Allow-Origin", allow)
                self.end_headers()
                self.wfile.write(body)
                return
            except urllib.error.HTTPError as e:
                last_err = {"status": e.code}
            except Exception as e:
                last_err = {"detail": redact(str(e))[:120]}
        self._json(502, {"error": "yahoo_unreachable", "last": last_err})

    def do_POST(self):
        origin = self.headers.get("Origin")
        if self.path == "/api/chat":
            self._proxy_llm()
            return
        if self.path not in ("/api/send-consent", "/api/send-email"):
            self._json(404, {"ok": False, "error": "not_found"}, origin)
            return

        # CSRF: only cross-origin POSTs from allowlisted sites.
        if origin and not _allow_origin(origin):
            self._json(403, {"ok": False, "error": "forbidden_origin"}, origin)
            return

        # Body-size cap
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except Exception:
            length = 0
        if length > MAX_EMAIL_BODY:
            self._json(413, {"ok": False, "error": "payload_too_large"}, origin)
            return

        try:
            raw = self.rfile.read(length) if length else b"{}"
            data = json.loads(raw.decode("utf-8") or "{}")
        except Exception:
            self._json(400, {"ok": False, "error": "bad_json"}, origin)
            return

        to = (data.get("to") or data.get("parentEmail") or "").strip()
        teen = sanitize_header(data.get("teenName") or "your child")
        token = sanitize_header(str(data.get("token") or ""))
        consent_url = (data.get("consentUrl") or "").strip()[:512]

        if not is_valid_email(to):
            self._json(400, {"ok": False, "error": "bad_recipient"}, origin)
            return
        allowlist = resolve_consent_allowlist()
        if consent_url and not is_safe_consent_url(consent_url, allowlist):
            self._json(400, {"ok": False, "error": "bad_consent_url"}, origin)
            return

        # Rate limit only on hosted/upstream instance (or whenever a real
        # provider is configured — protects SMTP credentials).
        enforce_rl = IS_UPSTREAM or bool(os.environ.get("SMTP_USER")
                                         or os.environ.get("RESEND_API_KEY"))
        if enforce_rl:
            ip = (self.headers.get("X-Forwarded-For", "").split(",")[0].strip()
                  or self.client_address[0])
            now = time.time()
            with _rate_lock:
                _gc_rate_buckets(now)
                bucket = _rate_bucket[ip]
                while bucket and now - bucket[0] > 3600:
                    bucket.popleft()
                if len(bucket) >= RATE_LIMIT_PER_HOUR:
                    self._json(429, {"ok": False, "error": "rate_limited",
                                     "detail": f"Max {RATE_LIMIT_PER_HOUR} emails/hour per IP."},
                               origin)
                    return
                bucket.append(now)

        relayed = self.headers.get("X-StockSaathi-Relay", "") == "1"
        subject = sanitize_header(f"StockSaathi - Consent requested for {teen}")
        body = consent_body(teen, to, token, consent_url)

        # Try local providers first.
        try:
            result = send_email(
                to_email=to, subject=subject, body=body,
                token=token, teen=teen, consent_url=consent_url,
                relay_header=relayed, log_dir=str(LOG_DIR),
            )
        except Exception as e:
            self._json(500, {"ok": False, "error": "send_failed",
                             "detail": redact(str(e))[:120]}, origin)
            return

        # If local fell through to devlog AND an upstream is configured and we
        # aren't the upstream, try the relay as a final attempt.
        if result.get("provider") == "devlog" and UPSTREAM_EMAIL_URL \
                and not IS_UPSTREAM and not relayed:
            relay_res = send_via_upstream(to, teen, token, consent_url,
                                          relay_header=relayed)
            if relay_res.get("ok"):
                result = relay_res

        code = 200 if result.get("ok") else 500
        self._json(code, result, origin)


class ThreadingServer(ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main():
    os.chdir(str(APP_DIR))
    try:
        with ThreadingServer((HOST, PORT), SSHandler) as httpd:
            print()
            print(" " + "=" * 55)
            print("       StockSaathi backend  -  Python SMTP + static")
            print(" " + "=" * 55)
            print(f"   http://{HOST}:{PORT}/")
            resend = "on " if os.environ.get("RESEND_API_KEY") else "off"
            smtp = "on " if (os.environ.get("SMTP_USER")
                             and os.environ.get("SMTP_PASS")) else "off"
            print(f"   email providers:  Resend [{resend}]  SMTP [{smtp}]")
            if resend == "off" and smtp == "off":
                print("   (no provider configured -- dev-log mode, emails echo token)")
            print(f"   rate limits:     consent {RATE_LIMIT_PER_HOUR}/hr   chat {CHAT_RATE_PER_HOUR}/hr")
            print("   Ctrl+C to stop.")
            print()
            sys.stdout.flush()
            httpd.serve_forever()
    except OSError as e:
        print(f"Cannot bind {HOST}:{PORT} -- {e}")
        sys.exit(1)
    except KeyboardInterrupt:
        print("\nShutting down.")


if __name__ == "__main__":
    main()
