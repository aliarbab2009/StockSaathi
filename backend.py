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
import smtplib
import ssl
import http.server
import socketserver
import urllib.request
import urllib.error
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from email.utils import formatdate
from datetime import datetime
from pathlib import Path
from socketserver import ThreadingMixIn

APP_DIR = Path(__file__).parent.resolve()
LOG_DIR = APP_DIR / "logs" / "emails"
LOG_DIR.mkdir(parents=True, exist_ok=True)


def load_env():
    env_path = APP_DIR / ".env"
    if not env_path.exists():
        return
    for raw in env_path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        v = v.strip().strip('"').strip("'")
        os.environ.setdefault(k.strip(), v)


load_env()

# Railway / Render / Heroku set $PORT; fall back to our local convention.
PORT = int(os.environ.get("PORT") or os.environ.get("STOCKSAATHI_PORT") or "7348")
# Bind to 0.0.0.0 in hosted environments; 127.0.0.1 locally.
HOST = os.environ.get("HOST") or ("0.0.0.0" if os.environ.get("PORT") else "127.0.0.1")
PUBLIC_ORIGIN = os.environ.get("PUBLIC_ORIGIN", "").rstrip("/")

# Outbound email relay is disabled by default. Only set UPSTREAM_EMAIL_URL
# explicitly if you want a secondary instance to forward emails through the
# hosted production server.
UPSTREAM_EMAIL_URL = os.environ.get("UPSTREAM_EMAIL_URL", "").strip()

# This backend considers itself "the hosted one" when IS_UPSTREAM=1 is set.
# That stops it from relaying to itself (infinite loop) and enables rate limiting.
IS_UPSTREAM = os.environ.get("IS_UPSTREAM", "").strip() in ("1", "true", "yes")

# Simple per-IP rate limit (only enforced on the upstream/hosted instance).
from collections import defaultdict, deque
import threading as _threading
_rate_lock = _threading.Lock()
_rate_bucket = defaultdict(deque)
_chat_bucket = defaultdict(deque)
# Disabled by default for production — set env vars explicitly if you want caps.
RATE_LIMIT_PER_HOUR = int(os.environ.get("RATE_LIMIT_PER_HOUR", "100000"))
CHAT_RATE_PER_HOUR = int(os.environ.get("CHAT_RATE_PER_HOUR", "100000"))


# --------------------------------------------------------------------------
# Email providers
# --------------------------------------------------------------------------

def send_via_smtp(to_email, subject, body):
    host = os.environ.get("SMTP_HOST")
    port = int(os.environ.get("SMTP_PORT", 587))
    user = os.environ.get("SMTP_USER")
    pw = os.environ.get("SMTP_PASS")
    sender = os.environ.get("SMTP_FROM") or user
    if not (host and user and pw):
        return {"ok": False, "reason": "smtp_not_configured"}

    msg = MIMEMultipart("alternative")
    msg["From"] = sender
    msg["To"] = to_email
    msg["Subject"] = subject
    msg["Date"] = formatdate(localtime=True)
    msg.attach(MIMEText(body, "plain", "utf-8"))

    try:
        if port == 465:
            ctx = ssl.create_default_context()
            with smtplib.SMTP_SSL(host, port, context=ctx, timeout=20) as s:
                s.login(user, pw)
                s.send_message(msg)
        else:
            with smtplib.SMTP(host, port, timeout=20) as s:
                s.ehlo()
                s.starttls()
                s.ehlo()
                s.login(user, pw)
                s.send_message(msg)
        return {"ok": True, "provider": "smtp", "host": host}
    except Exception as e:
        return {"ok": False, "reason": "smtp_error", "error": str(e)}


def send_via_resend(to_email, subject, body):
    key = os.environ.get("RESEND_API_KEY")
    sender = os.environ.get("RESEND_FROM", "onboarding@resend.dev")
    if not key:
        return {"ok": False, "reason": "resend_not_configured"}
    payload = json.dumps({
        "from": sender,
        "to": to_email,
        "subject": subject,
        "text": body,
    }).encode("utf-8")
    req = urllib.request.Request(
        "https://api.resend.com/emails",
        data=payload,
        headers={
            "Authorization": f"Bearer {key.strip()}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            # Cloudflare in front of Resend blocks Python's default UA ("Python-urllib/x.y")
            "User-Agent": "StockSaathi/1.0 (+https://stocksaathi.local)",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            data = json.loads(r.read().decode("utf-8"))
            return {"ok": True, "provider": "resend", "id": data.get("id")}
    except urllib.error.HTTPError as e:
        # Read the actual body so the client gets the real Resend error
        try:
            raw = e.read().decode("utf-8")
            err = json.loads(raw)
        except Exception:
            err = {"message": raw if 'raw' in dir() else str(e)}
        return {"ok": False, "reason": "resend_http_error", "status": e.code, "error": err}
    except Exception as e:
        return {"ok": False, "reason": "resend_exception", "error": str(e)}


def log_email(to_email, subject, body):
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    safe = "".join(c if c.isalnum() else "_" for c in to_email)[:40]
    path = LOG_DIR / f"{ts}_{safe}.txt"
    path.write_text(
        f"TO: {to_email}\nSUBJECT: {subject}\nSENT-AT: {datetime.now().isoformat()}\n\n{body}\n",
        encoding="utf-8",
    )
    return str(path)


def send_via_upstream(to_email, teen, token, consent_url, relay_header=False):
    """Forward the email request to the hosted StockSaathi backend.
    Lets cloned/local instances send real email through the production
    server without needing their own SMTP creds."""
    if not UPSTREAM_EMAIL_URL:
        return {"ok": False, "reason": "no_upstream"}
    if IS_UPSTREAM:
        # We ARE the upstream — don't relay to ourselves.
        return {"ok": False, "reason": "self_is_upstream"}
    if relay_header:
        # Someone already relayed to us — break the chain.
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
        with urllib.request.urlopen(req, timeout=20) as r:
            data = json.loads(r.read().decode("utf-8"))
            if data.get("ok"):
                return {"ok": True, "provider": "upstream", "via": UPSTREAM_EMAIL_URL, "upstream_provider": data.get("provider")}
            return {"ok": False, "reason": "upstream_rejected", "upstream": data}
    except urllib.error.HTTPError as e:
        try: err = json.loads(e.read().decode("utf-8"))
        except Exception: err = {"message": str(e)}
        return {"ok": False, "reason": "upstream_http_error", "status": e.code, "error": err}
    except Exception as e:
        return {"ok": False, "reason": "upstream_exception", "error": str(e)}


def send_email(to_email, subject, body, token=None, teen=None, consent_url=None, relay_header=False):
    # 1. Local SMTP (sends to any recipient).
    # 2. Local Resend (sandbox: only owner's email).
    # 3. Upstream relay (forwards to stocksaathi.co.in — cloners get zero-config delivery).
    # 4. Dev log (last resort: echoes token to UI so onboarding still completes).
    attempts = []
    if os.environ.get("SMTP_USER") and os.environ.get("SMTP_PASS"):
        r = send_via_smtp(to_email, subject, body)
        if r.get("ok"): return r
        attempts.append({"provider": "smtp", **r})
    if os.environ.get("RESEND_API_KEY"):
        r = send_via_resend(to_email, subject, body)
        if r.get("ok"): return r
        attempts.append({"provider": "resend", **r})
    if UPSTREAM_EMAIL_URL and not IS_UPSTREAM and not relay_header:
        r = send_via_upstream(to_email, teen or "your child", token or "", consent_url or "", relay_header=relay_header)
        if r.get("ok"): return r
        attempts.append({"provider": "upstream", **r})
    path = log_email(to_email, subject, body)
    return {
        "ok": True,
        "provider": "devlog",
        "logged_to": path,
        "attempts": attempts,
        "dev_token": token,
        "warning": ("All delivery attempts failed — falling back to dev mode. "
                    "Your consent code is shown inline so you can still use the app."),
    }


# --------------------------------------------------------------------------
# HTTP handler
# --------------------------------------------------------------------------

class SSHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(APP_DIR), **kwargs)

    def log_message(self, fmt, *args):
        sys.stderr.write(f"[{self.log_date_time_string()}] {fmt % args}\n")

    def _json(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        if self.path == "/api/health":
            self._json(200, {
                "ok": True,
                "providers": {
                    "smtp": bool(os.environ.get("SMTP_USER") and os.environ.get("SMTP_PASS")),
                    "resend": bool(os.environ.get("RESEND_API_KEY")),
                    "anthropic": bool(os.environ.get("ANTHROPIC_API_KEY")),
                    "groq": bool(os.environ.get("GROQ_API_KEY")),
                    "supabase": bool(os.environ.get("SUPABASE_URL") and os.environ.get("SUPABASE_ANON_KEY")),
                },
            })
            return
        if self.path == "/api/config":
            self._json(200, {
                "supabaseUrl": os.environ.get("SUPABASE_URL", "").strip(),
                "supabaseAnonKey": os.environ.get("SUPABASE_ANON_KEY", "").strip(),
                "appName": "StockSaathi",
                "supportEmail": os.environ.get("SUPPORT_EMAIL", "accounts@stocksaathi.co.in"),
            })
            return
        # Yahoo Finance proxy — zero-CORS live prices for the frontend.
        # Pattern: /api/yahoo/chart/<SYMBOL>?interval=1d&range=5d
        if self.path.startswith("/api/yahoo/chart/"):
            self._proxy_yahoo_chart()
            return
        super().do_GET()

    def _proxy_llm(self):
        """Proxy POST /api/chat → Groq (OpenAI-compatible). Free + fast.
        Anthropic path available as fallback if GROQ_API_KEY not set."""
        groq_key = os.environ.get("GROQ_API_KEY", "").strip()
        anth_key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
        if not groq_key and not anth_key:
            self._json(501, {"error": "no_server_key",
                             "detail": "Set GROQ_API_KEY (free at console.groq.com) or ANTHROPIC_API_KEY on the server."})
            return

        # Rate limit
        ip = self.headers.get("X-Forwarded-For", "").split(",")[0].strip() or self.client_address[0]
        now = time.time()
        with _rate_lock:
            bucket = _chat_bucket[ip]
            while bucket and now - bucket[0] > 3600:
                bucket.popleft()
            if len(bucket) >= CHAT_RATE_PER_HOUR:
                self._json(429, {"error": "rate_limited",
                                 "detail": f"Max {CHAT_RATE_PER_HOUR} chat calls/hour per IP."})
                return
            bucket.append(now)

        try:
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length) if length else b"{}"
        except Exception as e:
            self._json(400, {"error": "bad_body", "detail": str(e)})
            return

        # Prefer Groq (much faster, free tier)
        if groq_key:
            req = urllib.request.Request(
                "https://api.groq.com/openai/v1/chat/completions",
                data=raw,
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {groq_key}",
                    "User-Agent": "StockSaathi-Backend/1.0",
                },
                method="POST",
            )
        else:
            # Anthropic fallback (would need schema translation — keep simple: just 501 if no Groq)
            self._json(501, {"error": "anthropic_path_unavailable",
                             "detail": "Backend requires GROQ_API_KEY for LLM proxy. Anthropic fallback not wired."})
            return

        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                body = r.read()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(body)
        except urllib.error.HTTPError as e:
            try: err_body = e.read()
            except Exception: err_body = b'{"error":{"message":"upstream error"}}'
            self.send_response(e.code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(err_body)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(err_body)
        except Exception as e:
            self._json(502, {"error": "llm_unreachable", "detail": str(e)})

    def _proxy_yahoo_chart(self):
        path = self.path[len("/api/yahoo/chart/"):]
        last_err = None
        hosts = [
            "https://query1.finance.yahoo.com/v8/finance/chart",
            "https://query2.finance.yahoo.com/v8/finance/chart",
        ]
        ua = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
              "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36")
        for base in hosts:
            url = f"{base}/{path}"
            req = urllib.request.Request(url, headers={
                "User-Agent": ua,
                "Accept": "application/json,text/plain,*/*",
                "Accept-Language": "en-US,en;q=0.9",
            })
            try:
                with urllib.request.urlopen(req, timeout=10) as r:
                    body = r.read()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "public, max-age=30")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(body)
                return
            except urllib.error.HTTPError as e:
                last_err = {"status": e.code, "detail": str(e)}
            except Exception as e:
                last_err = {"detail": str(e)}
        self._json(502, {"error": "yahoo_unreachable", "last": last_err})

    def do_POST(self):
        if self.path == "/api/chat":
            self._proxy_llm()
            return
        if self.path not in ("/api/send-consent", "/api/send-email"):
            self._json(404, {"ok": False, "error": "not_found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length) if length else b"{}"
            data = json.loads(raw.decode("utf-8") or "{}")
        except Exception as e:
            self._json(400, {"ok": False, "error": "bad_json", "detail": str(e)})
            return
        to = data.get("to") or data.get("parentEmail") or ""
        to = to.strip()
        teen = (data.get("teenName") or "your child").strip()
        token = str(data.get("token") or "").strip()
        consent_url = data.get("consentUrl") or ""
        if not to or "@" not in to:
            self._json(400, {"ok": False, "error": "bad_recipient"})
            return
        # Rate limit only on hosted/upstream instance
        if IS_UPSTREAM:
            ip = self.headers.get("X-Forwarded-For", "").split(",")[0].strip() or self.client_address[0]
            now = time.time()
            with _rate_lock:
                bucket = _rate_bucket[ip]
                while bucket and now - bucket[0] > 3600:
                    bucket.popleft()
                if len(bucket) >= RATE_LIMIT_PER_HOUR:
                    self._json(429, {"ok": False, "error": "rate_limited",
                                     "detail": f"Max {RATE_LIMIT_PER_HOUR} emails/hour per IP."})
                    return
                bucket.append(now)
        relayed_from_downstream = self.headers.get("X-StockSaathi-Relay", "") == "1"
        subject = f"StockSaathi - Consent requested for {teen}"
        body = consent_body(teen, to, token, consent_url)
        result = send_email(to, subject, body, token=token, teen=teen,
                            consent_url=consent_url, relay_header=relayed_from_downstream)
        code = 200 if result.get("ok") else 500
        self._json(code, result)


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
            smtp = "on " if (os.environ.get("SMTP_USER") and os.environ.get("SMTP_PASS")) else "off"
            print(f"   email providers:  Resend [{resend}]  SMTP [{smtp}]")
            if resend == "off" and smtp == "off":
                print(f"   (no provider configured -- dev-log mode, emails echo token)")
            print(f"   Ctrl+C to stop.")
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
