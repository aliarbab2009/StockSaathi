"""GET /api/fundamentals?symbol=RELIANCE  —  real fundamentals from Yahoo.

Three-tier fallback for when Yahoo rate-limits specific endpoints on our
Vercel IPs (which happens daily):

  1. /v7/finance/quote          — richest data, but Yahoo strips this for
                                   throttled IPs (502s half the time).
  2. /v10/finance/quoteSummary  — most durable, usually works when v7 fails,
                                   returns deeply-nested JSON per "module".
  3. /v8/finance/chart?range=1y — always works (same endpoint as /api/quote).
                                   Provides fiftyTwoWeekHigh/Low in meta +
                                   we compute market_cap from sharesOutstanding
                                   × price when available.

Any single tier that returns SOMETHING is used; we merge fields so partial
data from tier 3 fills gaps in tier 1/2. Never returns 502 if ANY tier
produced even a price.
"""

import re
import json
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs, quote as url_quote


UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
      "AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/125.0.0.0 Safari/537.36")

V7_HOSTS = [
    "https://query1.finance.yahoo.com/v7/finance/quote",
    "https://query2.finance.yahoo.com/v7/finance/quote",
]
V10_HOSTS = [
    "https://query1.finance.yahoo.com/v10/finance/quoteSummary",
    "https://query2.finance.yahoo.com/v10/finance/quoteSummary",
]
V8_HOSTS = [
    "https://query1.finance.yahoo.com/v8/finance/chart",
    "https://query2.finance.yahoo.com/v8/finance/chart",
]

_SYMBOL_RE = re.compile(r"^[A-Z0-9.\-\^=_&]{1,24}$")


def _yahoo_fetch(url, timeout=6):
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Accept": "application/json,text/plain,*/*",
        "Accept-Language": "en-US,en;q=0.9",
    })
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read())
    except Exception:
        return None


# --- Tier 1 --------------------------------------------------------------
def fetch_v7(ticker):
    for base in V7_HOSTS:
        data = _yahoo_fetch(f"{base}?symbols={url_quote(ticker, safe='.')}")
        if not data:
            continue
        arr = (data.get("quoteResponse") or {}).get("result") or []
        if not arr:
            continue
        q = arr[0]
        return {
            "name": q.get("longName") or q.get("shortName"),
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
            "prev_close": q.get("regularMarketPreviousClose"),
            "day_high": q.get("regularMarketDayHigh"),
            "day_low": q.get("regularMarketDayLow"),
            "volume": q.get("regularMarketVolume"),
            "change_pct": q.get("regularMarketChangePercent"),
            "source_tiers": ["v7"],
        }
    return None


# --- Tier 2 --------------------------------------------------------------
def _raw(obj, *path):
    """Drill into quoteSummary's nested {raw, fmt} shape."""
    cur = obj
    for k in path:
        if cur is None:
            return None
        cur = cur.get(k) if isinstance(cur, dict) else None
    if isinstance(cur, dict) and "raw" in cur:
        return cur.get("raw")
    return cur


def fetch_v10(ticker):
    modules = "summaryDetail,defaultKeyStatistics,financialData,price,summaryProfile"
    for base in V10_HOSTS:
        data = _yahoo_fetch(f"{base}/{url_quote(ticker, safe='.')}?modules={modules}")
        if not data:
            continue
        result = ((data.get("quoteSummary") or {}).get("result") or [None])[0]
        if not result:
            continue
        sd = result.get("summaryDetail") or {}
        ks = result.get("defaultKeyStatistics") or {}
        fd = result.get("financialData") or {}
        pr = result.get("price") or {}
        sp = result.get("summaryProfile") or {}
        price_val = _raw(pr, "regularMarketPrice") or _raw(sd, "regularMarketPreviousClose")
        shares = _raw(ks, "sharesOutstanding")
        mcap = _raw(pr, "marketCap") or (price_val * shares if (price_val and shares) else None)
        return {
            "name": _raw(pr, "longName") or _raw(pr, "shortName"),
            "exchange": _raw(pr, "exchangeName"),
            "sector": sp.get("sector"),
            "industry": sp.get("industry"),
            "market_cap": mcap,
            "pe_ratio": _raw(sd, "trailingPE"),
            "forward_pe": _raw(sd, "forwardPE"),
            "pb_ratio": _raw(ks, "priceToBook"),
            "beta": _raw(sd, "beta") or _raw(ks, "beta"),
            "dividend_yield": _raw(sd, "trailingAnnualDividendYield") or _raw(sd, "dividendYield"),
            "eps": _raw(ks, "trailingEps") or _raw(fd, "currentPrice"),
            "fifty_two_week_high": _raw(sd, "fiftyTwoWeekHigh"),
            "fifty_two_week_low": _raw(sd, "fiftyTwoWeekLow"),
            "fifty_day_average": _raw(sd, "fiftyDayAverage"),
            "two_hundred_day_average": _raw(sd, "twoHundredDayAverage"),
            "shares_outstanding": shares,
            "average_daily_volume": _raw(sd, "averageDailyVolume10Day"),
            "currency": _raw(pr, "currency") or "INR",
            "price": price_val,
            "prev_close": _raw(sd, "regularMarketPreviousClose"),
            "day_high": _raw(sd, "dayHigh"),
            "day_low": _raw(sd, "dayLow"),
            "volume": _raw(sd, "regularMarketVolume") or _raw(sd, "volume"),
            "change_pct": None,  # v10 doesn't expose a single combined %
            "source_tiers": ["v10"],
        }
    return None


# --- Tier 3 (always works, limited fields) --------------------------------
def fetch_v8_chart(ticker):
    """Pulls what we can from the chart endpoint — same one /api/quote uses.
    Has 52W high/low + day high/low + price/prev_close via closes[] walk."""
    for base in V8_HOSTS:
        data = _yahoo_fetch(f"{base}/{url_quote(ticker, safe='.')}?interval=1d&range=1y")
        if not data:
            continue
        res = ((data.get("chart") or {}).get("result") or [None])[0]
        if not res:
            continue
        meta = res.get("meta") or {}
        # 52W from meta if present
        hi = meta.get("fiftyTwoWeekHigh")
        lo = meta.get("fiftyTwoWeekLow")
        # Else compute from closes array
        closes = ((res.get("indicators", {}).get("quote") or [{}])[0].get("close") or [])
        if hi is None or lo is None:
            non_null = [c for c in closes if c is not None]
            if non_null:
                hi = hi if hi is not None else max(non_null)
                lo = lo if lo is not None else min(non_null)
        # Yesterday's close from closes[-2]
        prev = meta.get("regularMarketPreviousClose") or meta.get("previousClose")
        if prev is None:
            for i in range(len(closes) - 2, -1, -1):
                if closes[i] is not None:
                    prev = closes[i]
                    break
        price = meta.get("regularMarketPrice")
        return {
            "name": None,
            "exchange": meta.get("exchangeName"),
            "market_cap": None,
            "pe_ratio": None,
            "pb_ratio": None,
            "beta": None,
            "dividend_yield": None,
            "eps": None,
            "fifty_two_week_high": hi,
            "fifty_two_week_low": lo,
            "fifty_day_average": None,
            "two_hundred_day_average": None,
            "currency": meta.get("currency") or "INR",
            "price": price,
            "prev_close": prev,
            "day_high": meta.get("regularMarketDayHigh"),
            "day_low": meta.get("regularMarketDayLow"),
            "volume": meta.get("regularMarketVolume"),
            "source_tiers": ["v8_chart"],
        }
    return None


def _merge(base, extra):
    """Non-destructive merge: extra fills in fields base has as None."""
    if not extra:
        return base
    if not base:
        return extra
    merged = dict(extra)
    merged.update({k: v for k, v in base.items() if v is not None})
    if "source_tiers" in extra:
        merged["source_tiers"] = list(dict.fromkeys((base.get("source_tiers") or []) + extra.get("source_tiers", [])))
    return merged


def fetch_fundamentals(symbol):
    ticker = symbol if "." in symbol else f"{symbol}.NS"
    # Tier 1 first (richest), then fill gaps with tier 2, then tier 3.
    r = fetch_v7(ticker)
    r = _merge(r, fetch_v10(ticker))
    r = _merge(r, fetch_v8_chart(ticker))
    if not r:
        return {"error": "yahoo_unreachable"}
    r["symbol"] = symbol
    r["ticker"] = ticker
    r["source"] = "yahoo_" + "+".join(r.get("source_tiers") or ["unknown"])
    return r


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
        # Fundamentals don't change minute-to-minute — cache 5 min at the edge
        self.send_header("Cache-Control", "public, max-age=300")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)
