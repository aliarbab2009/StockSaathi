"""
Shared email-sending logic for Vercel serverless functions.
Same providers as the standalone backend.py: SMTP, Resend, upstream relay.
"""

import os
import json
import smtplib
import ssl
import urllib.request
import urllib.error
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from email.utils import formatdate


UPSTREAM_EMAIL_URL = os.environ.get(
    "UPSTREAM_EMAIL_URL",
    ""  # not set by default on Vercel prod (it IS the upstream)
).strip()

IS_UPSTREAM = os.environ.get("IS_UPSTREAM", "").strip() in ("1", "true", "yes")


def send_via_smtp(to_email, subject, body):
    host = os.environ.get("SMTP_HOST")
    port = int(os.environ.get("SMTP_PORT", 587))
    user = os.environ.get("SMTP_USER")
    pw = os.environ.get("SMTP_PASS")
    sender = os.environ.get("SMTP_FROM") or user
    if not (host and user and pw):
        return {"ok": False, "reason": "smtp_not_configured"}
    msg = MIMEMultipart("alternative")
    msg["From"] = sender
    msg["To"] = to_email
    msg["Subject"] = subject
    msg["Date"] = formatdate(localtime=True)
    msg.attach(MIMEText(body, "plain", "utf-8"))
    try:
        if port == 465:
            ctx = ssl.create_default_context()
            with smtplib.SMTP_SSL(host, port, context=ctx, timeout=15) as s:
                s.login(user, pw)
                s.send_message(msg)
        else:
            with smtplib.SMTP(host, port, timeout=15) as s:
                s.ehlo(); s.starttls(); s.ehlo()
                s.login(user, pw)
                s.send_message(msg)
        return {"ok": True, "provider": "smtp", "host": host}
    except Exception as e:
        return {"ok": False, "reason": "smtp_error", "error": str(e)}


def send_via_resend(to_email, subject, body):
    key = os.environ.get("RESEND_API_KEY")
    sender = os.environ.get("RESEND_FROM", "onboarding@resend.dev")
    if not key:
        return {"ok": False, "reason": "resend_not_configured"}
    payload = json.dumps({
        "from": sender, "to": to_email, "subject": subject, "text": body,
    }).encode("utf-8")
    req = urllib.request.Request(
        "https://api.resend.com/emails",
        data=payload,
        headers={
            "Authorization": f"Bearer {key.strip()}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "StockSaathi/1.0 (+https://stocksaathi.co.in)",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=12) as r:
            data = json.loads(r.read().decode("utf-8"))
            return {"ok": True, "provider": "resend", "id": data.get("id")}
    except urllib.error.HTTPError as e:
        try: err = json.loads(e.read().decode("utf-8"))
        except Exception: err = {"message": str(e)}
        return {"ok": False, "reason": "resend_http_error", "status": e.code, "error": err}
    except Exception as e:
        return {"ok": False, "reason": "resend_exception", "error": str(e)}


def send_via_upstream(to_email, teen, token, consent_url, relay_header=False):
    if not UPSTREAM_EMAIL_URL or IS_UPSTREAM or relay_header:
        return {"ok": False, "reason": "upstream_disabled"}
    payload = json.dumps({
        "to": to_email, "teenName": teen, "token": token, "consentUrl": consent_url,
    }).encode("utf-8")
    req = urllib.request.Request(
        UPSTREAM_EMAIL_URL,
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "StockSaathi-Relay/1.0",
            "X-StockSaathi-Relay": "1",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            data = json.loads(r.read().decode("utf-8"))
            if data.get("ok"):
                return {"ok": True, "provider": "upstream"}
            return {"ok": False, "reason": "upstream_rejected", "upstream": data}
    except Exception as e:
        return {"ok": False, "reason": "upstream_exception", "error": str(e)}


def consent_body(teen, parent_email, token, consent_url):
    lines = [
        "Hi,",
        "",
        f"{teen} is signing up for StockSaathi - a virtual-money investing simulator",
        "designed for Indian teens aged 13-18. Because they're under 18, we need your",
        "consent before they can begin.",
        "",
        "What StockSaathi is:",
        "  - A virtual Rs.1,00,000 portfolio. NO real money, NO real trades.",
        "  - Real Indian stock prices for learning.",
        "  - An AI coach that reflects on decisions - never recommends trades.",
        "",
        f"Your consent code: {token}",
        "",
    ]
    if consent_url:
        lines.append(f"To approve, share this code with {teen}, or visit: {consent_url}")
    else:
        lines.append(f"To approve, read this code to {teen} - they enter it to proceed.")
    lines += [
        "",
        "This code expires in 7 days. If you did not expect this email, ignore it.",
        "",
        "- StockSaathi",
        "(Built for the Masters' Union AI Buildathon 2026. No funds at risk.)",
    ]
    return "\n".join(lines)


def send_email(to_email, subject, body, token=None, teen=None, consent_url=None, relay_header=False):
    attempts = []
    if os.environ.get("SMTP_USER") and os.environ.get("SMTP_PASS"):
        r = send_via_smtp(to_email, subject, body)
        if r.get("ok"): return r
        attempts.append({"provider": "smtp", **r})
    if os.environ.get("RESEND_API_KEY"):
        r = send_via_resend(to_email, subject, body)
        if r.get("ok"): return r
        attempts.append({"provider": "resend", **r})
    if UPSTREAM_EMAIL_URL and not IS_UPSTREAM and not relay_header:
        r = send_via_upstream(to_email, teen or "your child", token or "", consent_url or "")
        if r.get("ok"): return r
        attempts.append({"provider": "upstream", **r})
    return {
        "ok": True,
        "provider": "devlog",
        "dev_token": token,
        "attempts": attempts,
        "warning": ("All delivery attempts failed — falling back to dev mode. "
                    "Your consent code is shown inline so you can still use the app."),
    }
