"""GET /api/quote?symbol=RELIANCE  —  single-symbol live quote.

Normalized JSON output so the client doesn't need to parse Yahoo's nested
structure. Tries query1 then query2 with a realistic User-Agent.
"""

import re
import json
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs


UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
      "AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/125.0.0.0 Safari/537.36")

HOSTS = [
    "https://query1.finance.yahoo.com/v8/finance/chart",
    "https://query2.finance.yahoo.com/v8/finance/chart",
]

_SYMBOL_RE = re.compile(r"^[A-Z0-9.\-\^=_]{1,24}$")


def fetch_one(symbol):
    """Fetch a single symbol from Yahoo. Returns dict or None."""
    if "." not in symbol and "-" not in symbol.replace(".", ""):
        ticker = f"{symbol}.NS"
    else:
        ticker = symbol
    for base in HOSTS:
        try:
            url = f"{base}/{ticker}?interval=1d&range=5d"
            req = urllib.request.Request(url, headers={
                "User-Agent": UA,
                "Accept": "application/json,text/plain,*/*",
                "Accept-Language": "en-US,en;q=0.9",
            })
            with urllib.request.urlopen(req, timeout=8) as r:
                raw = r.read()
            data = json.loads(raw)
            result = (data.get("chart") or {}).get("result") or [{}]
            if not result:
                continue
            meta = result[0].get("meta") or {}
            price = meta.get("regularMarketPrice")
            if price is None:
                continue
            # regularMarketPreviousClose = yesterday's close (what Google Finance
            # shows as the "prev close" baseline for today's % change).
            # chartPreviousClose = close just before the chart's range starts
            # (5 trading days ago for range=5d) — WRONG for daily % change but
            # kept as last-resort fallback in case the meta shape changes.
            prev = (meta.get("regularMarketPreviousClose")
                    or meta.get("previousClose")
                    or meta.get("chartPreviousClose")
                    or price)
            return {
                "symbol": symbol,
                "ticker": ticker,
                "price": float(price),
                "prev_close": float(prev),
                "change_pct": ((float(price) - float(prev)) / float(prev)) if prev else 0.0,
                "day_high": float(meta.get("regularMarketDayHigh") or price),
                "day_low": float(meta.get("regularMarketDayLow") or price),
                "volume": int(meta.get("regularMarketVolume") or 0),
                "ts_ms": int((meta.get("regularMarketTime") or 0)) * 1000,
                "currency": meta.get("currency") or "INR",
                "exchange": meta.get("exchangeName") or "",
                "source": "yahoo",
                "host": base.split("//")[1].split("/")[0],
            }
        except Exception:
            continue
    return {"error": "yahoo_unreachable"}


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        q = parse_qs(urlparse(self.path).query)
        symbol = (q.get("symbol") or [""])[0].strip().upper()
        if not symbol or not _SYMBOL_RE.match(symbol):
            self._json(400, {"ok": False, "error": "bad_symbol"})
            return
        data = fetch_one(symbol)
        if data.get("error"):
            self._json(502, {"ok": False, **data})
            return
        self._json(200, {"ok": True, **data})

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
        self.send_header("Cache-Control", "public, max-age=8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)
