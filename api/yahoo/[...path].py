"""GET /api/yahoo/...  —  Server-side Yahoo Finance proxy (CORS-free).

Robust against Vercel path quirks via regex. Tries query1 first, query2
as fallback. Returns JSON matching Yahoo's v8 chart endpoint.
"""

import re
import json
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler


USER_AGENT = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
              "AppleWebKit/537.36 (KHTML, like Gecko) "
              "Chrome/125.0.0.0 Safari/537.36")

# Hosts we'll try in order. If one blocks, the next usually works.
YAHOO_HOSTS = [
    "https://query1.finance.yahoo.com/v8/finance/chart",
    "https://query2.finance.yahoo.com/v8/finance/chart",
]


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        # Extract the chart path from self.path, regardless of how Vercel
        # presents it. Accepts: /api/yahoo/chart/X, /yahoo/chart/X, /chart/X
        m = re.search(r"/chart/([^?]+)(\?.*)?$", self.path)
        if not m:
            self._json(400, {"error": "bad_path", "path": self.path})
            return
        ticker = m.group(1)
        query = m.group(2) or ""
        self._proxy_chart(ticker, query)

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
                continue
            except Exception as e:
                last_err = {"detail": str(e)}
                continue
        # all hosts failed
        self._json(502, {"error": "yahoo_unreachable", "last": last_err})
