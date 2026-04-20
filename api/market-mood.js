// =============================================================================
// /api/market-mood  —  One-paragraph AI commentary on today's market mood
// based on sector-level percent changes the client sends. Cached server-side
// per (date + top-movers hash) so the whole site shares one generation.
// POST body: { sectors: [{ name, avgPct, count, topUp, topDown }], asOf }
// Returns: { narrative, temperature: "hot"|"warm"|"mild"|"cold" }
// =============================================================================

export const config = { runtime: "edge" };

function allowed(o){
  if(!o)return null;
  const s=new Set(["https://stocksaathi.co.in","https://www.stocksaathi.co.in","http://localhost:7348","http://127.0.0.1:7348"]);
  if(s.has(o))return o;
  if(o.startsWith("https://")&&o.endsWith(".vercel.app"))return o;
  return null;
}
function cors(o){const h=new Headers({"Content-Type":"application/json","Cache-Control":"no-store"});const a=allowed(o);if(a){h.set("Access-Control-Allow-Origin",a);h.set("Vary","Origin");}return h;}
function j(s,b,o){return new Response(JSON.stringify(b),{status:s,headers:cors(o)});}
function base(){const v=globalThis.process?.env?.VERCEL_URL;return v?`https://${v}`:"https://stocksaathi.co.in";}

function dayKey(){
  const p=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Kolkata",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date()).reduce((a,p)=>(a[p.type]=p.value,a),{});
  return `${p.year}-${p.month}-${p.day}`;
}

async function cacheGet(key){
  try{const r=await fetch(base()+`/api/ai-cache?bucket=market_mood&key=${encodeURIComponent(key)}`,{headers:{"Origin":"https://stocksaathi.co.in"}});if(!r.ok)return null;const d=await r.json();return d?.hit?d.payload:null;}catch{return null;}
}
function cachePut(key,payload){
  fetch(base()+"/api/ai-cache",{method:"POST",headers:{"Content-Type":"application/json","Origin":"https://stocksaathi.co.in"},body:JSON.stringify({bucket:"market_mood",key,payload})}).catch(()=>{});
}

const SYSTEM = `You are Saathi. Summarise today's Indian stock market in one 50-70 word paragraph for a teen investor. Use the sector data the user sends. Call out the 2-3 most notable sector moves by name. Give a one-word overall temperature (hot / warm / mild / cold). Plain prose, Indian context, no emojis, no markdown, no predictions, no buy/sell advice.

Return strict JSON: { "narrative": "…", "temperature": "hot" | "warm" | "mild" | "cold" }.`;

export default async function handler(req){
  const origin=req.headers.get("Origin")||"";
  if(origin&&!allowed(origin))return j(403,{error:"forbidden_origin"},origin);
  if(req.method==="OPTIONS"){
    const h=cors(origin);h.set("Access-Control-Allow-Methods","POST, OPTIONS");h.set("Access-Control-Allow-Headers","Content-Type");
    return new Response(null,{status:204,headers:h});
  }
  if(req.method!=="POST")return j(405,{error:"method_not_allowed"},origin);

  let body; try{body=await req.json();}catch{return j(400,{error:"bad_body"},origin);}
  const sectors = Array.isArray(body.sectors)?body.sectors.slice(0,12):[];
  if(!sectors.length)return j(400,{error:"no_sectors"},origin);

  // Key on day + top-movers signature so cache refreshes only when sector
  // leaderboard actually reshuffles.
  const sig = sectors
    .slice(0, 6)
    .map(s => `${String(s.name).toLowerCase().slice(0,10)}:${(Number(s.avgPct)||0).toFixed(1)}`)
    .join("|");
  const key = `${dayKey()}_${sig}`;

  const cached = await cacheGet(key);
  if(cached?.narrative) return j(200,{...cached,source:"cache"},origin);

  const userMsg = [
    `Today (${dayKey()}) Indian market sector moves:`,
    ...sectors.map(s => `  ${s.name}: avg ${s.avgPct>=0?"+":""}${s.avgPct.toFixed(2)}% across ${s.count} names (top up: ${s.topUp||"-"}, top down: ${s.topDown||"-"})`),
  ].join("\n");

  try{
    const r=await fetch(base()+"/api/chat",{method:"POST",headers:{"Content-Type":"application/json","Origin":"https://stocksaathi.co.in"},body:JSON.stringify({
      messages:[{role:"system",content:SYSTEM},{role:"user",content:userMsg}],
      max_tokens:200,temperature:0.35,response_format:{type:"json_object"},profile:"fast",
    })});
    if(!r.ok)return j(502,{error:`chat_http_${r.status}`},origin);
    const d=await r.json();
    const text=d?.choices?.[0]?.message?.content;
    if(!text)return j(502,{error:"empty"},origin);
    let parsed; try{parsed=JSON.parse(text);}catch{return j(502,{error:"non_json"},origin);}
    const narrative=typeof parsed.narrative==="string"?parsed.narrative.trim().slice(0,500):"";
    const temperature=["hot","warm","mild","cold"].includes(parsed.temperature)?parsed.temperature:"mild";
    if(!narrative)return j(502,{error:"no_narrative"},origin);
    const payload={narrative,temperature};
    cachePut(key,payload);
    return j(200,{...payload,source:"fresh"},origin);
  }catch(e){
    return j(502,{error:"generation_failed",detail:String(e.message).slice(0,100)},origin);
  }
}
