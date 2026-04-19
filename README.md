# StockSaathi

**An AI-coached investment simulator for Indian teens.**
Real Indian stocks. Virtual ₹1,00,000. Behavioral reflection — not advice.

Live at **https://stocksaathi.co.in**

---

## Run locally

**Windows (double-click):**
```
run.bat
```

**Mac / Linux / Git Bash:**
```bash
./run.sh
```

**Manual:**
```bash
cd app
python -m http.server 7351
# then open http://localhost:7351/
```

For full backend (email + LLM proxy), use `python backend.py` instead.

---

## Architecture

- **Frontend**: vanilla ES modules, custom SVG charts, no build step
- **Database**: Supabase (Postgres + Auth + Realtime + RLS)
- **LLM**: Groq Llama 3.3 70B via server proxy with tool-use
- **Email**: Resend with verified `accounts@stocksaathi.co.in` domain
- **Live prices**: Yahoo Finance via Vercel serverless proxy + localStorage cache
- **Hosting**: Vercel serverless functions + static frontend

See `SUPABASE_SETUP.md` for production deployment.

---

## Disclaimer

Virtual money only. StockSaathi provides behavioral reflection, not investment advice.
Past performance does not guarantee future returns. No actual trades are executed.
Not affiliated with SEBI, NSE, BSE, or any broker.
