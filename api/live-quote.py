"""GET /api/live-quote?symbols=A,B,C — cache-first live quote aggregator.

Architecture:
  1. Check Supabase `quote_cache` table for each symbol.
     Rows newer than CACHE_TTL_MS are served straight back.
  2. For cache misses, fall through a source chain:
        Dhan REST  →  Yahoo v8/chart  →  existing /api/quotes fallback
     First source that returns data wins. Subsequent sources are not called.
  3. Upsert fresh data into `quote_cache` so other users / tabs benefit.

Designed so hundreds of concurrent users polling the same symbols hit the
external APIs only ~6 times per minute total (cache-TTL-bound), instead of
once per user per poll. Matches the Groww/Zerodha "single upstream feed +
fanout to clients" pattern, but runs entirely on Vercel + Supabase.

Required env vars on Vercel:
  SUPABASE_URL                    (already set for /api/config)
  SUPABASE_SERVICE_ROLE_KEY       (NEW — add this; never exposed to client)

Optional (enables Dhan real-time, replaces Yahoo once configured):
  DHAN_ACCESS_TOKEN               long-lived API token from dhan.co
  DHAN_CLIENT_ID                  your Dhan user ID

Without Dhan env vars → falls through to Yahoo. Same data you have today,
but cached 10s across all users, dramatically reducing Yahoo rate-limit
hits and fixing the 2-hour-stale problem.
"""

import os
import re
import json
import time
import urllib.request
import urllib.error
import concurrent.futures
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs, quote as url_quote

SUPA_URL = os.environ.get("SUPABASE_URL", "").strip().rstrip("/")
SUPA_SRV = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
DHAN_TOKEN = os.environ.get("DHAN_ACCESS_TOKEN", "").strip()
DHAN_CLIENT = os.environ.get("DHAN_CLIENT_ID", "").strip()

# Cache TTL — shorter = fresher but more upstream calls. 10s is a sweet spot:
# humans can't tell the difference, and even 1000 users all polling the same
# stocks only hit Yahoo/Dhan 6 times/minute total.
CACHE_TTL_MS = int(os.environ.get("QUOTE_CACHE_TTL_MS", "10000"))

_SYMBOL_RE = re.compile(r"^[A-Z0-9.\-\^=_&]{1,24}$")
_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
       "AppleWebKit/537.36 (KHTML, like Gecko) "
       "Chrome/125.0.0.0 Safari/537.36")

YAHOO_HOSTS = [
    "https://query1.finance.yahoo.com/v8/finance/chart",
    "https://query2.finance.yahoo.com/v8/finance/chart",
]
MAX_SYMBOLS = 80


# --------------------------------------------------------------------------
# Supabase cache (uses PostgREST with service_role auth)
# --------------------------------------------------------------------------

def _supa_headers():
    return {
        "apikey": SUPA_SRV,
        "Authorization": f"Bearer {SUPA_SRV}",
        "Content-Type": "application/json",
    }


def read_cache(symbols):
    """Returns {symbol: row_dict} for rows WRITTEN to cache within CACHE_TTL_MS.
    Filters on cached_at_ms (when our server wrote), NOT ts_ms (Yahoo market
    time, which can be hours stale during Yahoo lag)."""
    if not (SUPA_URL and SUPA_SRV) or not symbols:
        return {}
    cutoff = int(time.time() * 1000) - CACHE_TTL_MS
    sym_list = ",".join(f'"{s}"' for s in symbols)
    url = (f"{SUPA_URL}/rest/v1/quote_cache"
           f"?symbol=in.({sym_list})"
           f"&cached_at_ms=gte.{cutoff}"
           f"&select=*")
    req = urllib.request.Request(url, headers=_supa_headers())
    try:
        with urllib.request.urlopen(req, timeout=3) as r:
            rows = json.loads(r.read().decode("utf-8"))
        return {row["symbol"]: row for row in rows}
    except Exception:
        return {}


_last_write_error = {"status": None, "body": None, "key_prefix": None}

def write_cache(rows):
    """Upsert rows into quote_cache. Stores last failure for diagnostics."""
    global _last_write_error
    if not (SUPA_URL and SUPA_SRV) or not rows:
        _last_write_error = {"status": "skipped", "body": "SUPA_URL or SUPA_SRV empty", "key_prefix": None}
        return
    url = f"{SUPA_URL}/rest/v1/quote_cache"
    headers = _supa_headers()
    headers["Prefer"] = "resolution=merge-duplicates,return=minimal"
    body = json.dumps(rows).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        r = urllib.request.urlopen(req, timeout=3)
        _last_write_error = {"status": r.status, "body": None, "key_prefix": SUPA_SRV[:12] + "..."}
    except urllib.error.HTTPError as e:
        try: err_body = e.read().decode("utf-8")[:300]
        except Exception: err_body = str(e)
        _last_write_error = {"status": e.code, "body": err_body, "key_prefix": SUPA_SRV[:12] + "..."}
    except Exception as e:
        _last_write_error = {"status": "exception", "body": str(e)[:200], "key_prefix": SUPA_SRV[:12] + "..."}


# --------------------------------------------------------------------------
# Dhan REST — LTP batch endpoint (free with Dhan account)
# Returns {symbol: quote-dict} or {} if unconfigured/failed.
# Symbols that aren't in dhan_instruments are silently skipped so Yahoo
# can pick them up.
# --------------------------------------------------------------------------

def fetch_dhan_ltp(symbols):
    if not (DHAN_TOKEN and DHAN_CLIENT and SUPA_URL and SUPA_SRV):
        return {}
    # Resolve symbols → Dhan security_ids via the mapping table.
    sym_list = ",".join(f'"{s}"' for s in symbols)
    mapping_url = (f"{SUPA_URL}/rest/v1/dhan_instruments"
                   f"?symbol=in.({sym_list})&select=symbol,security_id,exchange_segment")
    try:
        req = urllib.request.Request(mapping_url, headers=_supa_headers())
        with urllib.request.urlopen(req, timeout=3) as r:
            mapping_rows = json.loads(r.read().decode("utf-8"))
    except Exception:
        return {}
    if not mapping_rows:
        return {}
    # Group by exchange segment → list of security_ids (Dhan's LTP endpoint format).
    by_segment = {}
    id_to_sym = {}
    for row in mapping_rows:
        seg = row.get("exchange_segment") or "NSE_EQ"
        sid = row["security_id"]
        by_segment.setdefault(seg, []).append(sid)
        id_to_sym[(seg, sid)] = row["symbol"]
    payload = {seg: ids for seg, ids in by_segment.items()}
    req = urllib.request.Request(
        "https://api.dhan.co/v2/marketfeed/ltp",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "access-token": DHAN_TOKEN,
            "client-id": DHAN_CLIENT,
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=4) as r:
            data = json.loads(r.read().decode("utf-8"))
    except Exception:
        return {}
    # Dhan response: {"data": {"NSE_EQ": {"11536": {"last_price": 1360.8, ...}}}}
    out = {}
    for seg, per_seg in (data.get("data") or {}).items():
        for sid_str, info in per_seg.items():
            try:
                sid = int(sid_str)
            except (TypeError, ValueError):
                continue
            sym = id_to_sym.get((seg, sid))
            if not sym:
                continue
            price = info.get("last_price") or info.get("ltp")
            if price is None:
                continue
            prev = info.get("previous_close") or info.get("close") or price
            out[sym] = {
                "symbol": sym,
                "price": float(price),
                "prev_close": float(prev),
                "change_pct": ((float(price) - float(prev)) / float(prev)) if prev else 0.0,
                "day_high": float(info.get("high") or price),
                "day_low": float(info.get("low") or price),
                "volume": int(info.get("volume") or 0),
                "ts_ms": int(time.time() * 1000),
                "source": "dhan",
                "currency": "INR",
            }
    return out


# --------------------------------------------------------------------------
# Yahoo fallback (mirrors api/quotes.py fetch_one but inlined + concurrent)
# --------------------------------------------------------------------------

def fetch_yahoo_one(symbol):
    ticker = symbol if "." in symbol else f"{symbol}.NS"
    for base in YAHOO_HOSTS:
        try:
            url = f"{base}/{url_quote(ticker, safe='.')}?interval=1d&range=5d"
            req = urllib.request.Request(url, headers={
                "User-Agent": _UA,
                "Accept": "application/json,text/plain,*/*",
                "Accept-Language": "en-US,en;q=0.9",
            })
            with urllib.request.urlopen(req, timeout=3.5) as r:
                data = json.loads(r.read())
            result = (data.get("chart") or {}).get("result") or [{}]
            if not result:
                continue
            meta = result[0].get("meta") or {}
            price = meta.get("regularMarketPrice")
            if price is None:
                continue
            # Yahoo strips regularMarketPreviousClose + previousClose when
            # rate-limiting Vercel's IP pool. Fall back to the chart closes[]
            # array — second-to-last non-null value is yesterday's close
            # (last entry is today's in-progress bar).
            closes_arr = ((result[0].get("indicators", {}).get("quote") or [{}])[0]
                          .get("close") or [])
            prev_from_chart = None
            for i in range(len(closes_arr) - 2, -1, -1):
                if closes_arr[i] is not None:
                    prev_from_chart = closes_arr[i]
                    break
            prev = (meta.get("regularMarketPreviousClose")
                    or meta.get("previousClose")
                    or prev_from_chart
                    or meta.get("chartPreviousClose")
                    or price)
            ts_ms = int((meta.get("regularMarketTime") or 0)) * 1000 or int(time.time() * 1000)
            return {
                "symbol": symbol,
                "price": float(price),
                "prev_close": float(prev),
                "change_pct": ((float(price) - float(prev)) / float(prev)) if prev else 0.0,
                "day_high": float(meta.get("regularMarketDayHigh") or price),
                "day_low": float(meta.get("regularMarketDayLow") or price),
                "volume": int(meta.get("regularMarketVolume") or 0),
                "ts_ms": ts_ms,
                "source": "yahoo",
                "currency": meta.get("currency") or "INR",
            }
        except Exception:
            continue
    return None


def fetch_yahoo_batch(symbols):
    out = {}
    if not symbols:
        return out
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(40, len(symbols))) as ex:
        futures = {ex.submit(fetch_yahoo_one, s): s for s in symbols}
        for f in concurrent.futures.as_completed(futures, timeout=8):
            s = futures[f]
            try:
                r = f.result()
                if r:
                    out[s] = r
            except Exception:
                pass
    return out


# --------------------------------------------------------------------------
# HTTP handler
# --------------------------------------------------------------------------

def _to_cache_row(q):
    """Convert a fetched quote dict to a quote_cache row.
    ts_ms  = upstream market time (Yahoo regularMarketTime / Dhan trade ts).
    cached_at_ms = when OUR server wrote this row. Used for TTL eviction.
    """
    return {
        "symbol": q["symbol"],
        "price_paise": int(round(q["price"] * 100)),
        "prev_close_paise": int(round(q["prev_close"] * 100)),
        "day_high_paise": int(round(q["day_high"] * 100)),
        "day_low_paise": int(round(q["day_low"] * 100)),
        "volume": q.get("volume", 0),
        "change_pct": q.get("change_pct", 0.0),
        "ts_ms": q["ts_ms"],
        "cached_at_ms": int(time.time() * 1000),
        "source": q.get("source", "yahoo"),
    }


def _quote_from_cache_row(row):
    """Convert a cache row back into the public API shape (rupees, not paise)."""
    return {
        "symbol": row["symbol"],
        "price": row["price_paise"] / 100.0,
        "prev_close": (row.get("prev_close_paise") or 0) / 100.0,
        "change_pct": row.get("change_pct") or 0.0,
        "day_high": (row.get("day_high_paise") or 0) / 100.0,
        "day_low": (row.get("day_low_paise") or 0) / 100.0,
        "volume": row.get("volume") or 0,
        "ts_ms": row["ts_ms"],
        "source": row.get("source") or "yahoo",
        "currency": "INR",
        "cached": True,
    }


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        q = parse_qs(urlparse(self.path).query)
        raw = (q.get("symbols") or [""])[0]
        raw_syms = [s.strip().upper() for s in raw.split(",") if s.strip()][:MAX_SYMBOLS]
        syms = [s for s in raw_syms if _SYMBOL_RE.match(s)]
        if not syms:
            self._json(400, {"ok": False, "error": "no_valid_symbols"})
            return

        t0 = time.time()

        # 1. Cache sweep
        cached = read_cache(syms)
        missing = [s for s in syms if s not in cached]

        # 2. Source chain for misses: Dhan → Yahoo
        fresh = {}
        if missing:
            if DHAN_TOKEN:
                fresh = fetch_dhan_ltp(missing)
            yahoo_targets = [s for s in missing if s not in fresh]
            if yahoo_targets:
                y = fetch_yahoo_batch(yahoo_targets)
                fresh.update(y)

        # 3. Write fresh rows back to cache (best-effort, no await)
        if fresh:
            write_cache([_to_cache_row(q) for q in fresh.values()])

        # 4. Build response
        quotes = {}
        for s in syms:
            if s in fresh:
                quotes[s] = fresh[s]
            elif s in cached:
                quotes[s] = _quote_from_cache_row(cached[s])
            else:
                quotes[s] = None

        hits = sum(1 for v in quotes.values() if v)
        latency_ms = int((time.time() - t0) * 1000)
        self._json(200, {
            "ok": True,
            "quotes": quotes,
            "hits": hits,
            "total": len(syms),
            "cached_count": len(cached),
            "fresh_count": len(fresh),
            "latency_ms": latency_ms,
            "cache_ttl_ms": CACHE_TTL_MS,
            "sources_enabled": {
                "dhan": bool(DHAN_TOKEN),
                "yahoo": True,
                "cache": bool(SUPA_URL and SUPA_SRV),
            },
        })

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
        self.send_header("X-Content-Type-Options", "nosniff")
        # Cache at the Vercel edge for the same TTL — extra user-less fanout
        # without even hitting our function. Safe because our own cache has
        # matching TTL.
        self.send_header("Cache-Control", f"public, max-age={CACHE_TTL_MS // 1000}")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)
