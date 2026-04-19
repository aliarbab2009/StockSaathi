"""POST /api/chat  —  Vercel serverless LLM proxy.

Hardened:
- Model is pinned server-side; client cannot choose expensive models.
- max_tokens is capped; tools are stripped.
- Body size is bounded.
- Origin is allowlisted (blocks CSRF-style cross-site abuse).
- Error messages redact bearer tokens and API keys.
- Rate limit is best-effort (Vercel cold starts reset state) — the real
  safeguard is CHAT_MAX_TOKENS + CHAT_MODEL pinning.
"""

import os
import json
import re
import time
import threading
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler
from collections import defaultdict, deque


CHAT_RATE_PER_HOUR = int(os.environ.get("CHAT_RATE_PER_HOUR", "240"))
MAX_BODY = int(os.environ.get("MAX_CHAT_BODY", str(64 * 1024)))  # 64 KB
CHAT_MODEL_PIN = os.environ.get("CHAT_MODEL", "llama-3.3-70b-versatile")
CHAT_MAX_TOKENS = int(os.environ.get("CHAT_MAX_TOKENS", "800"))
PUBLIC_ORIGIN = os.environ.get("PUBLIC_ORIGIN", "").rstrip("/")

_rate_lock = threading.Lock()
_chat_bucket = defaultdict(deque)

_BEARER_RE = re.compile(r"(Bearer\s+)[A-Za-z0-9._\-]+", re.IGNORECASE)
_KEY_RE = re.compile(r"((?:gsk_|sk-ant-|sk-|re_)[A-Za-z0-9._\-]{8,})")


def _redact(text):
    if not text:
        return ""
    s = str(text)
    s = _BEARER_RE.sub(r"\1<redacted>", s)
    s = _KEY_RE.sub("<redacted>", s)
    return s


_ALLOWED_ORIGINS = {
    PUBLIC_ORIGIN,
    "https://stocksaathi.co.in",
    "https://www.stocksaathi.co.in",
    "http://localhost:7348",
    "http://127.0.0.1:7348",
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


class handler(BaseHTTPRequestHandler):
    def _cors(self, origin):
        allow = _allow_origin(origin)
        if allow:
            self.send_header("Access-Control-Allow-Origin", allow)
            self.send_header("Vary", "Origin")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")

    def _json(self, code, obj, origin=None):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self._cors(origin or self.headers.get("Origin"))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        origin = self.headers.get("Origin")
        self.send_response(204)
        self._cors(origin)
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "600")
        self.end_headers()

    def do_POST(self):
        origin = self.headers.get("Origin")
        if origin and not _allow_origin(origin):
            self._json(403, {"error": "forbidden_origin"}, origin)
            return

        groq_key = os.environ.get("GROQ_API_KEY", "").strip()
        if not groq_key:
            self._json(501, {
                "error": "no_server_key",
                "detail": "Set GROQ_API_KEY env var on Vercel (free at console.groq.com).",
            }, origin)
            return

        # Best-effort per-IP rate limit (Vercel state isn't sticky, so this
        # only catches the happy path of a single warm instance).
        ip = self.headers.get("X-Forwarded-For", "").split(",")[0].strip() or "unknown"
        now = time.time()
        with _rate_lock:
            bucket = _chat_bucket[ip]
            while bucket and now - bucket[0] > 3600:
                bucket.popleft()
            if len(bucket) >= CHAT_RATE_PER_HOUR:
                self._json(429, {"error": "rate_limited",
                                 "detail": f"Max {CHAT_RATE_PER_HOUR} chat calls/hour per IP."},
                           origin)
                return
            bucket.append(now)

        try:
            length = int(self.headers.get("Content-Length", "0"))
        except Exception:
            length = 0
        if length > MAX_BODY:
            self._json(413, {"error": "payload_too_large"}, origin)
            return

        try:
            raw = self.rfile.read(length) if length else b"{}"
            payload = json.loads(raw.decode("utf-8") or "{}")
        except Exception:
            self._json(400, {"error": "bad_body"}, origin)
            return

        # Pin model; strip tools; cap max_tokens. Client cannot upgrade to
        # an expensive model or plug arbitrary tools in on our dime.
        payload["model"] = CHAT_MODEL_PIN
        if not isinstance(payload.get("max_tokens"), int) or payload["max_tokens"] > CHAT_MAX_TOKENS:
            payload["max_tokens"] = CHAT_MAX_TOKENS
        payload.pop("tools", None)
        payload.pop("tool_choice", None)
        msgs = payload.get("messages")
        if not isinstance(msgs, list) or not msgs:
            self._json(400, {"error": "bad_messages"}, origin)
            return
        safe_body = json.dumps(payload).encode("utf-8")

        req = urllib.request.Request(
            "https://api.groq.com/openai/v1/chat/completions",
            data=safe_body,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {groq_key}",
                "User-Agent": "StockSaathi-Vercel/1.0",
            },
            method="POST",
        )
        try:
            # Vercel hobby tier functions cap at ~10s, pro at ~60s. Keep
            # under the hobby limit by default.
            with urllib.request.urlopen(req, timeout=8) as r:
                body = r.read()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self._cors(origin)
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
            self._cors(origin)
            self.end_headers()
            self.wfile.write(err_body)
        except Exception as e:
            self._json(502, {"error": "groq_unreachable",
                             "detail": _redact(str(e))[:120]}, origin)
