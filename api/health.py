"""GET /api/health  —  Vercel serverless function."""

import os
import json
from http.server import BaseHTTPRequestHandler


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        body = json.dumps({
            "ok": True,
            "runtime": "vercel",
            "providers": {
                "smtp": bool(os.environ.get("SMTP_USER") and os.environ.get("SMTP_PASS")),
                "resend": bool(os.environ.get("RESEND_API_KEY")),
                "supabase": bool(os.environ.get("SUPABASE_URL") and os.environ.get("SUPABASE_ANON_KEY")),
                "groq": bool(os.environ.get("GROQ_API_KEY")),
                "anthropic": bool(os.environ.get("ANTHROPIC_API_KEY")),
                "upstream": bool(os.environ.get("UPSTREAM_EMAIL_URL")),
            },
        }).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.end_headers()
