// =============================================================================
// /api/trade-nudge  —  Pre-trade AI context card. Before user confirms a
// buy/sell order, the server receives { action, symbol, qty, priceRupees,
// portfolioSummary } and returns a short contextual nudge:
//   - Diversification state ("this makes ITC 42% of your portfolio")
//   - First-trade milestone ("your first ever trade — exciting, here's the one
//     thing to watch for")
//   - Recent panic-sell / pump-chase pattern flag
//   - Or a quiet 'looks fine' when nothing stands out
// Not cached — each trade is different.
// =============================================================================

export const config = { runtime: "edge" };

function allowed(o){
  if(!o)return null;
  const s=new Set(["https://stocksaathi.co.in","https://www.stocksaathi.co.in","http://localhost:7348","http://127.0.0.1:7348"]);
  if(s.has(o))return o;
  if(o.startsWith("https://")&&o.endsWith(".vercel.app"))return o;
  return null;
}
function cors(o){
  const h=new Headers({"Content-Type":"application/json","Cache-Control":"no-store"});
  const a=allowed(o); if(a){h.set("Access-Control-Allow-Origin",a);h.set("Vary","Origin");}
  return h;
}
function j(s,b,o){return new Response(JSON.stringify(b),{status:s,headers:cors(o)});}
function base(){const v=globalThis.process?.env?.VERCEL_URL;return v?`https://${v}`:"https://stocksaathi.co.in";}

const SYSTEM = `You are Saathi. The user is about to place a trade. Write a tight 1-2 sentence pre-trade observation (40-60 words max) that notices ONE meaningful thing about this specific trade given their portfolio state. Options:

- Concentration: if this trade makes ONE ticker > 35% of portfolio, flag it plainly.
- Cash runway: if this trade drains cash below 10% of portfolio, mention it.
- Sector overweight: if they'll be >50% in one sector after this trade, flag it.
- Doubling down on a losing position: if they already own it and it's down >10%, note that honestly.
- First trade in this ticker / first trade ever: frame the milestone calmly.
- Otherwise: say something genuinely neutral ('looks reasonable for your size') — don't invent a concern.

Rules:
- NEVER say 'should buy' / 'should sell' / 'recommend' / 'target price'. You can observe; you can't advise.
- No emojis. No bullets. One warm, honest paragraph. If you flag a concern, give the reason in the same sentence.
- End with a short line offering Socratic reflection ('something to sit with: ...') ONLY if you raised a concern. Otherwise end clean.

Return strict JSON: { "nudge": "<paragraph>", "severity": "neutral" | "note" | "warn" }.`;

export default async function handler(req){
  const origin=req.headers.get("Origin")||"";
  if(origin&&!allowed(origin))return j(403,{error:"forbidden_origin"},origin);
  if(req.method==="OPTIONS"){
    const h=cors(origin); h.set("Access-Control-Allow-Methods","POST, OPTIONS"); h.set("Access-Control-Allow-Headers","Content-Type");
    return new Response(null,{status:204,headers:h});
  }
  if(req.method!=="POST")return j(405,{error:"method_not_allowed"},origin);

  let body; try{body=await req.json();}catch{return j(400,{error:"bad_body"},origin);}
  if(!body?.action||!body?.symbol)return j(400,{error:"bad_payload"},origin);

  const userMsg = [
    `Action: ${body.action}`,
    `Ticker: ${body.symbol} (${body.name||""}, ${body.sector||""})`,
    `Quantity: ${body.qty}`,
    `Price per share: ₹${body.priceRupees?.toFixed(2)}`,
    `Trade value: ₹${(Number(body.qty)*Number(body.priceRupees)).toFixed(2)}`,
    ``,
    `Before-trade portfolio:`,
    `  Total: ₹${body.portfolio.totalRupees?.toLocaleString("en-IN")}`,
    `  Cash: ₹${body.portfolio.cashRupees?.toLocaleString("en-IN")} (${((body.portfolio.cashRupees/body.portfolio.totalRupees)*100).toFixed(0)}%)`,
    body.portfolio.existingQty ? `  Already owns ${body.portfolio.existingQty} units at avg ₹${body.portfolio.existingAvgRupees?.toFixed(2)}, currently ${body.portfolio.existingPlPct>=0?"+":""}${(body.portfolio.existingPlPct*100).toFixed(1)}% P/L` : `  Doesn't own this ticker yet`,
    body.portfolio.tradeCountInSymbol != null ? `  Trades in this ticker so far: ${body.portfolio.tradeCountInSymbol}` : null,
    body.portfolio.totalTradeCount != null ? `  Total trades ever: ${body.portfolio.totalTradeCount}` : null,
    body.portfolio.sectorAllocPct != null ? `  Current ${body.sector} sector weight: ${body.portfolio.sectorAllocPct.toFixed(0)}%` : null,
  ].filter(Boolean).join("\n");

  try{
    const r=await fetch(base()+"/api/chat",{method:"POST",headers:{"Content-Type":"application/json","Origin":"https://stocksaathi.co.in"},body:JSON.stringify({
      messages:[{role:"system",content:SYSTEM},{role:"user",content:userMsg}],
      max_tokens:220,temperature:0.4,response_format:{type:"json_object"},profile:"fast",
    })});
    if(!r.ok)return j(502,{error:`chat_http_${r.status}`},origin);
    const d=await r.json();
    const text=d?.choices?.[0]?.message?.content;
    if(!text)return j(502,{error:"empty"},origin);
    let parsed; try{parsed=JSON.parse(text);}catch{return j(502,{error:"non_json"},origin);}
    const nudge = typeof parsed.nudge==="string" ? parsed.nudge.trim().slice(0,500) : "";
    const severity = ["neutral","note","warn"].includes(parsed.severity) ? parsed.severity : "neutral";
    if(!nudge)return j(502,{error:"no_nudge"},origin);
    return j(200,{nudge,severity},origin);
  }catch(e){
    return j(502,{error:"generation_failed",detail:String(e.message).slice(0,100)},origin);
  }
}
