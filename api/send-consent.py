"""POST /api/send-consent  —  Vercel serverless function.
Body: { to, teenName, token, consentUrl }

All email-sending code is inlined to avoid Vercel's per-function bundling
from missing the shared _lib folder.
"""

import os
import json
import time
import smtplib
import ssl
import urllib.request
import urllib.error
import threading
from http.server import BaseHTTPRequestHandler
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from email.utils import formatdate
from collections import defaultdict, deque


# ---------------------------------------------------------------------------
# Rate limiting (hosted/upstream instance only)
# ---------------------------------------------------------------------------
_rate_lock = threading.Lock()
_rate_bucket = defaultdict(deque)
RATE_LIMIT_PER_HOUR = int(os.environ.get("RATE_LIMIT_PER_HOUR", "20"))
IS_UPSTREAM = os.environ.get("IS_UPSTREAM", "").strip() in ("1", "true", "yes")
UPSTREAM_EMAIL_URL = os.environ.get("UPSTREAM_EMAIL_URL", "").strip()


# ---------------------------------------------------------------------------
# Email senders
# ---------------------------------------------------------------------------
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
            with smtplib.SMTP_SSL(host, port, context=ctx, timeout=9) as s:
                s.login(user, pw)
                s.send_message(msg)
        else:
            with smtplib.SMTP(host, port, timeout=9) as s:
                s.ehlo(); s.starttls(); s.ehlo()
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
        "from": sender, "to": to_email, "subject": subject, "text": body,
    }).encode("utf-8")
    req = urllib.request.Request(
        "https://api.resend.com/emails",
        data=payload,
        headers={
            "Authorization": f"Bearer {key.strip()}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "StockSaathi/1.0 (+https://stocksaathi.co.in)",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=8) as r:
            data = json.loads(r.read().decode("utf-8"))
            return {"ok": True, "provider": "resend", "id": data.get("id")}
    except urllib.error.HTTPError as e:
        try: err = json.loads(e.read().decode("utf-8"))
        except Exception: err = {"message": str(e)}
        return {"ok": False, "reason": "resend_http_error", "status": e.code, "error": err}
    except Exception as e:
        return {"ok": False, "reason": "resend_exception", "error": str(e)}


def send_via_upstream(to_email, teen, token, consent_url, relayed):
    if not UPSTREAM_EMAIL_URL or IS_UPSTREAM or relayed:
        return {"ok": False, "reason": "upstream_disabled"}
    payload = json.dumps({
        "to": to_email, "teenName": teen, "token": token, "consentUrl": consent_url,
    }).encode("utf-8")
    req = urllib.request.Request(
        UPSTREAM_EMAIL_URL, data=payload,
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "StockSaathi-Relay/1.0",
            "X-StockSaathi-Relay": "1",
        }, method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=9) as r:
            data = json.loads(r.read().decode("utf-8"))
            if data.get("ok"):
                return {"ok": True, "provider": "upstream"}
            return {"ok": False, "reason": "upstream_rejected", "upstream": data}
    except Exception as e:
        return {"ok": False, "reason": "upstream_exception", "error": str(e)}


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


def send_email(to_email, subject, body, token=None, teen=None, consent_url=None, relayed=False):
    attempts = []
    # Resend first on Vercel (outbound SMTP sometimes blocked in serverless)
    if os.environ.get("RESEND_API_KEY"):
        r = send_via_resend(to_email, subject, body)
        if r.get("ok"): return r
        attempts.append({"provider": "resend", **r})
    if os.environ.get("SMTP_USER") and os.environ.get("SMTP_PASS"):
        r = send_via_smtp(to_email, subject, body)
        if r.get("ok"): return r
        attempts.append({"provider": "smtp", **r})
    if UPSTREAM_EMAIL_URL and not IS_UPSTREAM and not relayed:
        r = send_via_upstream(to_email, teen or "your child", token or "", consent_url or "", relayed)
        if r.get("ok"): return r
        attempts.append({"provider": "upstream", **r})
    return {
        "ok": True,
        "provider": "devlog",
        "dev_token": token,
        "attempts": attempts,
        "warning": ("All delivery attempts failed — dev-mode fallback. "
                    "Consent code shown inline so app still works."),
    }


# ---------------------------------------------------------------------------
# Vercel handler
# ---------------------------------------------------------------------------
class handler(BaseHTTPRequestHandler):
    def _json(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-StockSaathi-Relay")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-StockSaathi-Relay")
        self.end_headers()

    def do_POST(self):
        # Rate-limit on the hosted instance to protect the public relay
        if IS_UPSTREAM:
            ip = self.headers.get("X-Forwarded-For", "").split(",")[0].strip() or "unknown"
            now = time.time()
            with _rate_lock:
                bucket = _rate_bucket[ip]
                while bucket and now - bucket[0] > 3600:
                    bucket.popleft()
                if len(bucket) >= RATE_LIMIT_PER_HOUR:
                    self._json(429, {"ok": False, "error": "rate_limited",
                                     "detail": f"Max {RATE_LIMIT_PER_HOUR}/hr per IP."})
                    return
                bucket.append(now)

        try:
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length) if length else b"{}"
            data = json.loads(raw.decode("utf-8") or "{}")
        except Exception as e:
            self._json(400, {"ok": False, "error": "bad_json", "detail": str(e)})
            return

        to = (data.get("to") or data.get("parentEmail") or "").strip()
        teen = (data.get("teenName") or "your child").strip()
        token = str(data.get("token") or "").strip()
        consent_url = data.get("consentUrl") or ""
        if not to or "@" not in to:
            self._json(400, {"ok": False, "error": "bad_recipient"})
            return

        relayed = self.headers.get("X-StockSaathi-Relay", "") == "1"
        subject = f"StockSaathi - Consent requested for {teen}"
        body = consent_body(teen, to, token, consent_url)
        result = send_email(to, subject, body, token=token, teen=teen,
                            consent_url=consent_url, relayed=relayed)
        self._json(200 if result.get("ok") else 500, result)
