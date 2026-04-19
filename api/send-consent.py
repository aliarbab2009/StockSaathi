"""POST /api/send-consent  —  Vercel serverless function.
Body: { to, teenName, token, consentUrl }
"""

import sys
import os
import json
import time
from http.server import BaseHTTPRequestHandler
from collections import defaultdict, deque
import threading

# Let Vercel find our _lib package (same directory)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _lib.email_sender import send_email, consent_body


_rate_lock = threading.Lock()
_rate_bucket = defaultdict(deque)
RATE_LIMIT_PER_HOUR = int(os.environ.get("RATE_LIMIT_PER_HOUR", "20"))
IS_UPSTREAM = os.environ.get("IS_UPSTREAM", "").strip() in ("1", "true", "yes")


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
        # Rate limit on the hosted instance (stocksaathi.co.in) to protect relay.
        if IS_UPSTREAM:
            ip = self.headers.get("X-Forwarded-For", "").split(",")[0].strip() or "unknown"
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
                            consent_url=consent_url, relay_header=relayed)
        self._json(200 if result.get("ok") else 500, result)
