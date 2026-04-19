"""GET /api/yahoo/...  —  Server-side Yahoo Finance proxy (CORS-free).

Hardened:
- Ticker is whitelisted (^[A-Za-z0-9.\\-\\^=_]{1,24}$) — no path traversal,
  no arbitrary SSRF target.
- Query string is restricted to safe URL-param characters.
- Error messages redact bearer tokens (defence in depth).
"""

import re
import json
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler


USER_AGENT = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
              "AppleWebKit/537.36 (KHTML, like Gecko) "
              "Chrome/125.0.0.0 Safari/537.36")

YAHOO_HOSTS = [
    "https://query1.finance.yahoo.com/v8/finance/chart",
    "https://query2.finance.yahoo.com/v8/finance/chart",
]

_TICKER_RE = re.compile(r"^[A-Za-z0-9.\-\^=_]{1,24}$")
_QUERY_RE = re.compile(r"^\?[A-Za-z0-9_\-=&.%,]{0,512}$")
_BEARER_RE = re.compile(r"(Bearer\s+)[A-Za-z0-9._\-]+", re.IGNORECASE)


def _redact(s):
    if not s:
        return ""
    return _BEARER_RE.sub(r"\1<redacted>", str(s))[:120]


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        m = re.search(r"/chart/([^?]+)(\?.*)?$", self.path or "")
        if not m:
            self._json(400, {"error": "bad_path"})
            return
        ticker = m.group(1)
        query = m.group(2) or ""
        if not _TICKER_RE.match(ticker):
            self._json(400, {"error": "bad_ticker"})
            return
        if query and not _QUERY_RE.match(query):
            self._json(400, {"error": "bad_query"})
            return
        self._proxy_chart(ticker, query)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Max-Age", "600")
        self.end_headers()

    def _json(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _proxy_chart(self, ticker, query):
        last_err = None
        for base in YAHOO_HOSTS:
            url = f"{base}/{ticker}{query}"
            req = urllib.request.Request(url, headers={
                "User-Agent": USER_AGENT,
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
                self.send_header("X-Content-Type-Options", "nosniff")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(body)
                return
            except urllib.error.HTTPError as e:
                last_err = {"status": e.code}
                continue
            except Exception as e:
                last_err = {"detail": _redact(str(e))}
                continue
        self._json(502, {"error": "yahoo_unreachable", "last": last_err})
