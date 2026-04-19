"""POST /api/chat  —  Vercel serverless Anthropic proxy.

Forwards the body to Anthropic's /v1/messages using the server's
ANTHROPIC_API_KEY env var. Lets users without their own key use the
real LLM. Soft rate-limit per IP (60/hour).
"""

import os
import json
import time
import threading
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler
from collections import defaultdict, deque


CHAT_RATE_PER_HOUR = int(os.environ.get("CHAT_RATE_PER_HOUR", "60"))
_rate_lock = threading.Lock()
_chat_bucket = defaultdict(deque)


class handler(BaseHTTPRequestHandler):
    def _json(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_POST(self):
        key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
        if not key:
            self._json(501, {
                "error": "no_server_key",
                "detail": "Server has no ANTHROPIC_API_KEY configured. Add your own key in Settings."
            })
            return

        ip = self.headers.get("X-Forwarded-For", "").split(",")[0].strip() or "unknown"
        now = time.time()
        with _rate_lock:
            bucket = _chat_bucket[ip]
            while bucket and now - bucket[0] > 3600:
                bucket.popleft()
            if len(bucket) >= CHAT_RATE_PER_HOUR:
                self._json(429, {
                    "error": "rate_limited",
                    "detail": f"Max {CHAT_RATE_PER_HOUR} chat calls/hour per IP.",
                })
                return
            bucket.append(now)

        try:
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length) if length else b"{}"
        except Exception as e:
            self._json(400, {"error": "bad_body", "detail": str(e)})
            return

        req = urllib.request.Request(
            "https://api.anthropic.com/v1/messages",
            data=raw,
            headers={
                "Content-Type": "application/json",
                "x-api-key": key,
                "anthropic-version": "2023-06-01",
                "User-Agent": "StockSaathi-Vercel/1.0",
            },
            method="POST",
        )
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
            try:
                err_body = e.read()
            except Exception:
                err_body = b'{"error":{"message":"upstream error"}}'
            self.send_response(e.code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(err_body)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(err_body)
        except Exception as e:
            self._json(502, {"error": "anthropic_unreachable", "detail": str(e)})
