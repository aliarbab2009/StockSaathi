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


def send_email(to_email, subject, body, token=None):
    # SMTP first — sends to ANY recipient. Resend sandbox only delivers to the
    # account owner's email, so it's a fallback for when SMTP isn't configured.
    attempts = []
    if os.environ.get("SMTP_USER") and os.environ.get("SMTP_PASS"):
        r = send_via_smtp(to_email, subject, body)
        if r.get("ok"):
            return r
        attempts.append({"provider": "smtp", **r})
    if os.environ.get("RESEND_API_KEY"):
        r = send_via_resend(to_email, subject, body)
        if r.get("ok"):
            return r
        attempts.append({"provider": "resend", **r})
    path = log_email(to_email, subject, body)
    # IMPORTANT: in dev-log mode we echo the token back so the onboarding flow
    # still completes end-to-end (for cloners who haven't configured email yet).
    return {
        "ok": True,
        "provider": "devlog",
        "logged_to": path,
        "attempts": attempts,
        "dev_token": token,   # so the UI can display it directly in dev mode
        "warning": ("Email providers tried and failed (see 'attempts'). "
                    "Logged to disk. Dev token included so you can test the flow.") if attempts else
                   ("No email provider configured — running in dev mode. "
                    "For real delivery, set RESEND_API_KEY or SMTP_* in .env (see .env.example)."),
    }


# --------------------------------------------------------------------------
# HTTP handler
# --------------------------------------------------------------------------

def consent_body(teen, parent_email, token, consent_url):
    lines = [
        "Hi,",
        "",
        f"{teen} is signing up for StockSaathi - a virtual-money investing simulator",
        "designed for Indian teens aged 13-18. Because they're under 18, we need your",
        "consent before they can begin.",
        "",
        "What StockSaathi is:",
        "  - A virtual Rs.1,00,000 portfolio. NO real money, NO real trades.",
        "  - Real Indian stock prices for learning.",
        "  - An AI coach that reflects on decisions - never recommends trades.",
        "",
        f"Your consent code: {token}",
        "",
    ]
    if consent_url:
        lines.append(f"To approve, share this code with {teen}, or visit: {consent_url}")
    else:
        lines.append(f"To approve, read this code to {teen} - they enter it to proceed.")
    lines += [
        "",
        "This code expires in 7 days. If you did not expect this email, ignore it.",
        "",
        "- StockSaathi",
        "(Built for the Masters' Union AI Buildathon 2026. No funds at risk.)",
    ]
    return "\n".join(lines)


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
                },
            })
            return
        super().do_GET()

    def do_POST(self):
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
        subject = f"StockSaathi - Consent requested for {teen}"
        body = consent_body(teen, to, token, consent_url)
        result = send_email(to, subject, body, token=token)
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
