"""GET /api/screener?metric=fifty_two_week_high&order=desc&limit=12

Deterministic sort across `fundamentals_cache` for the Ask-Saathi sortable
queries ("highest 52w high", "biggest market cap", "lowest PE", etc.).
Bypasses the LLM â€” the LLM has no actual numeric data to sort on, so
asking it "which stocks have the highest 52-week high" produced random
results (the LLM defaulted to whatever was top-ranked by index prominence
in the prefilter, ignoring the actual numeric question).

The frontend's `runAiSearch` detects sortable patterns via regex and
routes here instead of /api/ai. Returns the same shape as
opMarketSearch ({ matches: [SYMBOL...], rationale: "..." }) so the
existing aiSearch render path Just Works.

Allowlisted metrics (must match a column in fundamentals_cache):
  fifty_two_week_high   highest stock has touched in past year
  fifty_two_week_low    lowest stock has touched in past year
  market_cap            total market value
  pe_ratio              trailing P/E
  pb_ratio              price-to-book
  dividend_yield        annualized yield (fraction, e.g. 0.025 = 2.5%)
  beta                  vs Nifty 50
  roe                   return on equity
  eps                   trailing EPS

Rejects unknown metrics with 400. No LLM calls. Sub-100 ms typical.
"""

import json
import os
import time
import urllib.request
import urllib.error
from urllib.parse import urlparse, parse_qs, quote as url_quote


SUPA_URL = os.environ.get("SUPABASE_URL", "").strip().rstrip("/")
SUPA_KEY = os.environ.get("SUPABASE_ANON_KEY", "").strip() or os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()

# Whitelist of metrics that map directly to fundamentals_cache columns.
# Anything not in this set is rejected with 400 to prevent SQL-style
# injection via the metric param (PostgREST still URL-encodes, but a
# typo'd metric would just return an empty list silently â€” louder
# rejection is friendlier).
ALLOWED_METRICS = {
    "fifty_two_week_high", "fifty_two_week_low",
    "market_cap", "pe_ratio", "pb_ratio",
    "dividend_yield", "beta", "roe", "eps",
}
ALLOWED_ORDER = {"asc", "desc"}
DEFAULT_LIMIT = 12
MAX_LIMIT = 50

# Pretty-print labels for the rationale text. Keys must match ALLOWED_METRICS.
METRIC_LABELS = {
    "fifty_two_week_high": "52-week high",
    "fifty_two_week_low":  "52-week low",
    "market_cap":          "market cap",
    "pe_ratio":            "P/E ratio",
    "pb_ratio":            "P/B ratio",
    "dividend_yield":      "dividend yield",
    "beta":                "beta",
    "roe":                 "return on equity",
    "eps":                 "earnings per share",
}


def _allowed_origin(req_headers):
    origin = req_headers.get("origin", "") or req_headers.get("Origin", "")
    # Mirror the same allowlist as ai.js. Hardcoded for sub-handler simplicity.
    if origin in (
        "https://stocksaathi.co.in",
        "https://www.stocksaathi.co.in",
        "https://stocksaathi.vercel.app",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    ):
        return origin
    return ""


def _cors_headers(origin):
    return {
        "Access-Control-Allow-Origin": origin or "*",
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Cache-Control": "no-store",
        "Vary": "Origin",
    }


def _send_json(self, status, body, origin):
    self.send_response(status)
    for k, v in _cors_headers(origin).items():
        self.send_header(k, v)
    self.send_header("Content-Type", "application/json")
    payload = json.dumps(body).encode("utf-8")
    self.send_header("Content-Length", str(len(payload)))
    self.end_headers()
    self.wfile.write(payload)


def _query_supabase(metric, order, limit):
    """PostgREST query that selects symbol + name + sector + the metric,
    filters out null metric values (so a 'not yet fetched' row doesn't
    pollute the top 12), and orders + limits server-side."""
    if not (SUPA_URL and SUPA_KEY):
        return None, "supabase_not_configured"
    # `not.is.null` excludes rows where the column is NULL. Combined
    # with the metric ordering this gives a clean top-N of stocks
    # that actually have the data. nullslast is implicit on desc order
    # for PostgREST but we exclude nulls anyway for correctness.
    select_cols = f"symbol,name,sector,{metric}"
    url = (f"{SUPA_URL}/rest/v1/fundamentals_cache"
           f"?select={select_cols}"
           f"&{metric}=not.is.null"
           f"&order={metric}.{order}"
           f"&limit={limit}")
    req = urllib.request.Request(url, headers={
        "apikey": SUPA_KEY,
        "Authorization": f"Bearer {SUPA_KEY}",
        "Accept": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=4) as r:
            rows = json.loads(r.read())
        return rows, None
    except urllib.error.HTTPError as e:
        return None, f"supabase_http_{e.code}"
    except Exception as e:
        return None, f"supabase_err_{type(e).__name__}"


def _format_value(metric, val):
    """Human-readable rendering of a metric value for the rationale string."""
    if val is None:
        return ""
    if metric in ("fifty_two_week_high", "fifty_two_week_low"):
        return f"â‚¹{val:,.0f}"
    if metric == "market_cap":
        # market_cap is in INR. Render as crores (1 crore = 10M INR).
        crore = val / 1e7
        if crore >= 100000:
            return f"â‚¹{crore/100000:.1f}L cr"
        return f"â‚¹{crore:,.0f} cr"
    if metric == "dividend_yield":
        return f"{val*100:.2f}%"
    if metric in ("pe_ratio", "pb_ratio", "beta", "eps"):
        return f"{val:.2f}"
    if metric == "roe":
        return f"{val*100:.1f}%" if abs(val) < 1 else f"{val:.1f}%"
    return str(val)


def _build_rationale(metric, order, rows):
    if not rows:
        return f"No stocks with {METRIC_LABELS.get(metric, metric)} data in the universe yet."
    label = METRIC_LABELS.get(metric, metric)
    direction = "highest" if order == "desc" else "lowest"
    top_sample = rows[:3]
    bits = [f"{r['symbol']} ({_format_value(metric, r.get(metric))})" for r in top_sample]
    return f"Top {len(rows)} by {direction} {label}: {', '.join(bits)}"


from http.server import BaseHTTPRequestHandler


class handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        origin = _allowed_origin(self.headers)
        self.send_response(204)
        for k, v in _cors_headers(origin).items():
            self.send_header(k, v)
        self.end_headers()

    def do_GET(self):
        origin = _allowed_origin(self.headers)
        try:
            qs = parse_qs(urlparse(self.path).query)
            metric = (qs.get("metric", [""])[0] or "").strip().lower()
            order = (qs.get("order", ["desc"])[0] or "desc").strip().lower()
            try:
                limit = int(qs.get("limit", [str(DEFAULT_LIMIT)])[0])
            except (TypeError, ValueError):
                limit = DEFAULT_LIMIT
            limit = max(1, min(limit, MAX_LIMIT))

            if metric not in ALLOWED_METRICS:
                _send_json(self, 400, {
                    "error": "bad_metric",
                    "allowed": sorted(list(ALLOWED_METRICS)),
                }, origin)
                return
            if order not in ALLOWED_ORDER:
                _send_json(self, 400, {"error": "bad_order"}, origin)
                return

            rows, err = _query_supabase(metric, order, limit)
            if err:
                _send_json(self, 502, {"error": err}, origin)
                return
            matches = [r["symbol"] for r in (rows or []) if r.get("symbol")]
            rationale = _build_rationale(metric, order, rows or [])
            _send_json(self, 200, {
                "matches": matches,
                "rationale": rationale,
                "metric": metric,
                "order": order,
                "source": "screener",
            }, origin)
        except Exception as e:
            _send_json(self, 500, {"error": "handler_err", "detail": str(e)[:120]}, origin)
