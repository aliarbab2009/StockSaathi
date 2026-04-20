// =============================================================================
// /api/stock-why  —  "Why is TCS moving today?" AI explanation.
// POST body: { symbol, name, sector, pricePaise, changePct, newsItems[] }
// Returns:   { explanation: "…", source: "cache"|"fresh" }
// Cache bucket 'stock_why' keyed on (symbol + sign(changePct) + date).
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

function dayKey(){
  const p=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Kolkata",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date()).reduce((a,p)=>(a[p.type]=p.value,a),{});
  return `${p.year}-${p.month}-${p.day}`;
}

async function cacheGet(key){
  try{
    const r=await fetch(base()+`/api/ai-cache?bucket=stock_why&key=${encodeURIComponent(key)}`,{headers:{"Origin":"https://stocksaathi.co.in"}});
    if(!r.ok)return null;
    const d=await r.json(); return d?.hit?d.payload:null;
  }catch{return null;}
}
function cachePut(key,display,payload){
  fetch(base()+"/api/ai-cache",{method:"POST",headers:{"Content-Type":"application/json","Origin":"https://stocksaathi.co.in"},body:JSON.stringify({bucket:"stock_why",key,display,payload})}).catch(()=>{});
}

const SYSTEM = `You are Saathi. The user wants to understand why a stock is moving today. Write a tight 50-80 word paragraph that:
- Opens with the numbers the user sees (ticker + price + today's %).
- Explains the likely driver by connecting today's relevant news headlines (which we pass you) to the move.
- If headlines don't explain the move, say the move might be sector rotation / macro / profit-booking / no news-driven reason, plainly.
- Ends with one observation about what to watch next. No predictions. No buy/sell.
- Indian retail context. No markdown, no bullets, no quotes. Just prose.
Return strict JSON: { "explanation": "…" }. Nothing else.`;

export default async function handler(req){
  const origin=req.headers.get("Origin")||"";
  if(origin&&!allowed(origin))return j(403,{error:"forbidden_origin"},origin);
  if(req.method==="OPTIONS"){
    const h=cors(origin); h.set("Access-Control-Allow-Methods","POST, OPTIONS"); h.set("Access-Control-Allow-Headers","Content-Type");
    return new Response(null,{status:204,headers:h});
  }
  if(req.method!=="POST")return j(405,{error:"method_not_allowed"},origin);

  let body; try{body=await req.json();}catch{return j(400,{error:"bad_body"},origin);}
  const sym = String(body.symbol||"").toUpperCase().slice(0,24);
  if(!sym) return j(400,{error:"missing_symbol"},origin);
  const changePct = Number(body.changePct)||0;
  const dir = changePct>=0?"up":"down";
  const key = `${sym.toLowerCase()}_${dir}_${dayKey()}`;

  const cached = await cacheGet(key);
  if(cached?.explanation){
    return j(200,{explanation:cached.explanation,source:"cache"},origin);
  }

  const news = Array.isArray(body.newsItems)?body.newsItems.slice(0,8):[];
  const userMsg = [
    `Ticker: ${sym}`,
    body.name?`Name: ${body.name}`:null,
    body.sector?`Sector: ${body.sector}`:null,
    body.pricePaise!=null?`Current price: ₹${(body.pricePaise/100).toFixed(2)}`:null,
    `Today's move: ${changePct>=0?"+":""}${changePct.toFixed(2)}%`,
    news.length?`\nRecent related headlines:\n${news.map(n=>`- [${n.source||"?"}] ${n.headline}`).join("\n")}`:"No specific headlines on this ticker found today.",
  ].filter(Boolean).join("\n");

  try{
    const r=await fetch(base()+"/api/chat",{method:"POST",headers:{"Content-Type":"application/json","Origin":"https://stocksaathi.co.in"},body:JSON.stringify({
      messages:[{role:"system",content:SYSTEM},{role:"user",content:userMsg}],
      max_tokens:240,temperature:0.35,response_format:{type:"json_object"},profile:"reasoning",
    })});
    if(!r.ok)return j(502,{error:`chat_http_${r.status}`},origin);
    const d=await r.json();
    const text=d?.choices?.[0]?.message?.content;
    if(!text)return j(502,{error:"empty"},origin);
    let parsed; try{parsed=JSON.parse(text);}catch{return j(502,{error:"non_json"},origin);}
    const explanation=typeof parsed.explanation==="string"?parsed.explanation.trim().slice(0,700):"";
    if(!explanation)return j(502,{error:"no_explanation"},origin);
    cachePut(key, sym, { explanation });
    return j(200,{explanation,source:"fresh"},origin);
  }catch(e){
    return j(502,{error:"generation_failed",detail:String(e.message).slice(0,100)},origin);
  }
}
