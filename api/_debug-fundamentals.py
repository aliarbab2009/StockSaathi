"""GET /api/_debug-fundamentals?symbol=RELIANCE — diagnostic endpoint.

Returns each tier's individual result (or error) so we can see which tier is
failing on Vercel egress. Used to debug why production only returns v8_chart
data when local tests (residential IP) succeed across all 4 tiers.

Auth-gated by ADMIN_TOKEN — never exposed publicly because it dumps stack
traces and request internals.
"""

import os
import json
import sys
import time
import traceback
import urllib.request
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

ADMIN_TOKEN = os.environ.get("ADMIN_TOKEN", "").strip()


def _auth_ok(authz_header):
    if not authz_header:
        return False
    raw = authz_header
    if raw.lower().startswith("bearer "):
        raw = raw[7:]
    raw = raw.strip()
    if not raw or not ADMIN_TOKEN:
        return False
    if len(raw) != len(ADMIN_TOKEN):
        return False
    diff = 0
    for a, b in zip(raw, ADMIN_TOKEN):
        diff |= ord(a) ^ ord(b)
    return diff == 0


def _try(label, fn):
    t0 = time.time()
    try:
        result = fn()
        return {
            "tier": label,
            "ms": int((time.time() - t0) * 1000),
            "ok": result is not None,
            "result_keys": list(result.keys())[:6] if isinstance(result, dict) else None,
            "result_sample": {k: result.get(k) for k in ("name", "market_cap", "pe_ratio", "pb_ratio", "beta", "dividend_yield", "sector") if isinstance(result, dict) and k in result},
        }
    except Exception as e:
        return {
            "tier": label,
            "ms": int((time.time() - t0) * 1000),
            "ok": False,
            "error": f"{type(e).__name__}: {e}",
            "trace_tail": traceback.format_exc().splitlines()[-3:],
        }


def _diag(symbol):
    out = {
        "symbol": symbol,
        "ticker": symbol if "." in symbol else f"{symbol}.NS",
        "tiers": [],
        "env": {
            "supa_url": bool(os.environ.get("SUPABASE_URL")),
            "supa_anon": bool(os.environ.get("SUPABASE_ANON_KEY")),
            "supa_srv":  bool(os.environ.get("SUPABASE_SERVICE_ROLE_KEY")),
            "admin_token": bool(os.environ.get("ADMIN_TOKEN")),
        },
    }

    sys.path.insert(0, os.path.dirname(__file__))

    # Tier 0 — cache
    try:
        from fundamentals import read_cache
        out["tiers"].append(_try("cache", lambda: read_cache(symbol)))
    except Exception as e:
        out["tiers"].append({"tier": "cache", "ok": False, "error": f"import_fail: {e}"})

    # Yahoo crumb session — try to warm + get crumb
    try:
        from _yahoo_session import _warm_session, get_crumb, fetch_with_crumb
        warm_t0 = time.time()
        warmed = _warm_session()
        out["tiers"].append({"tier": "yahoo_warmup", "ok": warmed, "crumb": (get_crumb() or "")[:8] + "...", "ms": int((time.time() - warm_t0) * 1000)})

        # Tier 1 — v7
        out["tiers"].append(_try("yahoo_v7_authed", lambda: __import__("fundamentals").fetch_v7(out["ticker"])))

        # Tier 2 — v10
        out["tiers"].append(_try("yahoo_v10_authed", lambda: __import__("fundamentals").fetch_v10(out["ticker"])))
    except Exception as e:
        out["tiers"].append({"tier": "yahoo_session_imports", "ok": False, "error": f"{type(e).__name__}: {e}"})

    # Tier 3 — Tickertape
    try:
        from _tickertape import fetch_ratios, lookup_sid
        sid_t0 = time.time()
        sid = lookup_sid(symbol)
        out["tiers"].append({"tier": "tickertape_sid_lookup", "ok": bool(sid), "sid": sid, "ms": int((time.time() - sid_t0) * 1000)})
        out["tiers"].append(_try("tickertape_ratios", lambda: fetch_ratios(symbol, sid=sid)))
    except Exception as e:
        out["tiers"].append({"tier": "tickertape_imports", "ok": False, "error": f"{type(e).__name__}: {e}"})

    # Tier 4 — v8 chart anonymous (control)
    try:
        from fundamentals import fetch_v8_chart
        out["tiers"].append(_try("yahoo_v8_chart_anon", lambda: fetch_v8_chart(out["ticker"])))
    except Exception as e:
        out["tiers"].append({"tier": "v8_chart", "ok": False, "error": f"{type(e).__name__}: {e}"})

    # Bonus: raw outbound test — can we reach api.tickertape.in at all?
    try:
        req = urllib.request.Request(
            "https://api.tickertape.in/stocks/search?text=RELIANCE&types=stock&pageNumber=0",
            headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"},
        )
        t0 = time.time()
        with urllib.request.urlopen(req, timeout=8) as r:
            body = r.read()[:200]
        out["tiers"].append({"tier": "raw_tickertape_reach", "ok": True, "ms": int((time.time() - t0) * 1000), "preview": body.decode("utf-8", "replace")[:120]})
    except Exception as e:
        out["tiers"].append({"tier": "raw_tickertape_reach", "ok": False, "error": f"{type(e).__name__}: {e}"})

    # Bonus: raw fc.yahoo.com reach
    try:
        req = urllib.request.Request("https://fc.yahoo.com/", headers={"User-Agent": "Mozilla/5.0"})
        t0 = time.time()
        with urllib.request.urlopen(req, timeout=8) as r:
            r.read(100)
        out["tiers"].append({"tier": "raw_fc_yahoo_reach", "ok": True, "ms": int((time.time() - t0) * 1000)})
    except urllib.error.HTTPError as e:
        out["tiers"].append({"tier": "raw_fc_yahoo_reach", "ok_http": e.code, "note": "404 expected, sets cookies"})
    except Exception as e:
        out["tiers"].append({"tier": "raw_fc_yahoo_reach", "ok": False, "error": f"{type(e).__name__}: {e}"})

    return out


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if not _auth_ok(self.headers.get("Authorization")):
            self._json(401, {"ok": False, "error": "unauthorized"})
            return
        q = parse_qs(urlparse(self.path).query)
        symbol = (q.get("symbol") or ["RELIANCE"])[0].strip().upper()
        try:
            out = _diag(symbol)
            self._json(200, {"ok": True, **out})
        except Exception as e:
            self._json(500, {"ok": False, "error": "diag_failed", "detail": str(e)})

    def _json(self, code, obj):
        body = json.dumps(obj, default=str, indent=2).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)
