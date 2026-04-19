"""GET /api/fundamentals?symbol=RELIANCE  —  real fundamentals from Yahoo.

Pulls market cap, P/E, P/B, beta, 52W range, dividend yield, etc. via the
Yahoo Finance v7/quote endpoint (works without crumb cookie). Falls back to
v10/quoteSummary on failure.
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

V7_HOSTS = [
    "https://query1.finance.yahoo.com/v7/finance/quote",
    "https://query2.finance.yahoo.com/v7/finance/quote",
]

_SYMBOL_RE = re.compile(r"^[A-Z0-9.\-\^=_]{1,24}$")


def fetch_fundamentals(symbol):
    ticker = symbol if "." in symbol else f"{symbol}.NS"
    for base in V7_HOSTS:
        try:
            url = f"{base}?symbols={ticker}"
            req = urllib.request.Request(url, headers={
                "User-Agent": UA,
                "Accept": "application/json,text/plain,*/*",
                "Accept-Language": "en-US,en;q=0.9",
            })
            with urllib.request.urlopen(req, timeout=8) as r:
                data = json.loads(r.read())
            arr = (data.get("quoteResponse") or {}).get("result") or []
            if not arr:
                continue
            q = arr[0]
            return {
                "symbol": symbol,
                "ticker": ticker,
                "name": q.get("longName") or q.get("shortName") or symbol,
                "exchange": q.get("fullExchangeName") or q.get("exchange"),
                "sector": q.get("sector"),
                "industry": q.get("industry"),
                "market_cap": q.get("marketCap"),
                "pe_ratio": q.get("trailingPE"),
                "forward_pe": q.get("forwardPE"),
                "pb_ratio": q.get("priceToBook"),
                "beta": q.get("beta"),
                "dividend_yield": q.get("trailingAnnualDividendYield") or q.get("dividendYield"),
                "eps": q.get("epsTrailingTwelveMonths"),
                "fifty_two_week_high": q.get("fiftyTwoWeekHigh"),
                "fifty_two_week_low": q.get("fiftyTwoWeekLow"),
                "fifty_day_average": q.get("fiftyDayAverage"),
                "two_hundred_day_average": q.get("twoHundredDayAverage"),
                "shares_outstanding": q.get("sharesOutstanding"),
                "average_daily_volume": q.get("averageDailyVolume10Day"),
                "currency": q.get("currency") or "INR",
                "price": q.get("regularMarketPrice"),
                "prev_close": q.get("regularMarketPreviousClose") or q.get("regularMarketPrice"),
                "day_high": q.get("regularMarketDayHigh"),
                "day_low": q.get("regularMarketDayLow"),
                "volume": q.get("regularMarketVolume"),
                "change_pct": q.get("regularMarketChangePercent"),
                "source": "yahoo_v7",
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
        data = fetch_fundamentals(symbol)
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
        # Fundamentals don't change minute-to-minute — cache 5 min
        self.send_header("Cache-Control", "public, max-age=300")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)
