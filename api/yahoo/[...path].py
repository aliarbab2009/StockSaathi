"""GET /api/yahoo/...  —  Server-side Yahoo Finance proxy (CORS-free).

Routes like:
  /api/yahoo/chart/RELIANCE.NS?interval=1d&range=5d
→ https://query1.finance.yahoo.com/v8/finance/chart/RELIANCE.NS?interval=1d&range=5d
"""

import json
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler


USER_AGENT = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
              "AppleWebKit/537.36 (KHTML, like Gecko) "
              "Chrome/120.0.0.0 Safari/537.36")


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        # self.path is like '/api/yahoo/chart/RELIANCE.NS?interval=1d&range=5d'
        p = self.path
        # Strip '/api/yahoo/' prefix
        for prefix in ("/api/yahoo/", "/yahoo/"):
            if p.startswith(prefix):
                p = p[len(prefix):]
                break

        # Route: chart/<symbol>
        if p.startswith("chart/"):
            self._proxy_chart(p[len("chart/"):])
            return

        self._json(404, {"error": "unknown_yahoo_endpoint", "path": p})

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.end_headers()

    def _json(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _proxy_chart(self, rest):
        url = f"https://query1.finance.yahoo.com/v8/finance/chart/{rest}"
        req = urllib.request.Request(url, headers={
            "User-Agent": USER_AGENT,
            "Accept": "application/json,text/plain,*/*",
            "Accept-Language": "en-US,en;q=0.9",
        })
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                body = r.read()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "public, max-age=45")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(body)
        except urllib.error.HTTPError as e:
            self._json(e.code if 400 <= e.code < 600 else 502,
                       {"error": "yahoo_http", "status": e.code, "detail": str(e)})
        except Exception as e:
            self._json(502, {"error": "yahoo_unreachable", "detail": str(e)})
