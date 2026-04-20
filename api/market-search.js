// =============================================================================
// /api/market-search  —  Natural-language search over the stock universe.
// "cheap IT stocks with low debt", "pharma names down 5% today", "stocks
// trading below book value" — the AI reads the universe metadata the client
// sends + returns the matching tickers.
//
// POST body: {
//   query: "…",
//   candidates: [{ symbol, name, sector, marketCap, pe, pb, divYield, beta, risk, dayPct }]
// }
// Returns: { matches: ["TCS","INFY",...], rationale: "…" }
// Cached by (query slug + day) so repeat queries hit cache.
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
function slug(s){return String(s||"").toLowerCase().replace(/[^a-z0-9]+/g,"_").slice(0,80);}

async function cacheGet(key){
  try{const r=await fetch(base()+`/api/ai-cache?bucket=nl_search&key=${encodeURIComponent(key)}`,{headers:{"Origin":"https://stocksaathi.co.in"}});if(!r.ok)return null;const d=await r.json();return d?.hit?d.payload:null;}catch{return null;}
}
function cachePut(key,display,payload){
  fetch(base()+"/api/ai-cache",{method:"POST",headers:{"Content-Type":"application/json","Origin":"https://stocksaathi.co.in"},body:JSON.stringify({bucket:"nl_search",key,display,payload})}).catch(()=>{});
}

const SYSTEM = `You are Saathi helping a teen filter a universe of Indian stocks. The user gives a natural-language query; you return the best matching tickers from the provided candidate list.

Return strict JSON: { "matches": ["TICKER1", "TICKER2", ...], "rationale": "<one-sentence why these>" }.

Rules:
- Pick 3-12 tickers; more than 12 is noise, fewer than 3 is unhelpful unless there genuinely are fewer true matches.
- Tickers MUST come from the provided candidate list. Do not invent.
- Order the matches by closeness-to-intent (most relevant first).
- Rationale is one short sentence (15-25 words) — what was the filter?
- If no candidates fit, return matches=[] and a rationale saying so plainly.`;

export default async function handler(req){
  const origin=req.headers.get("Origin")||"";
  if(origin&&!allowed(origin))return j(403,{error:"forbidden_origin"},origin);
  if(req.method==="OPTIONS"){
    const h=cors(origin);h.set("Access-Control-Allow-Methods","POST, OPTIONS");h.set("Access-Control-Allow-Headers","Content-Type");
    return new Response(null,{status:204,headers:h});
  }
  if(req.method!=="POST")return j(405,{error:"method_not_allowed"},origin);

  let body; try{body=await req.json();}catch{return j(400,{error:"bad_body"},origin);}
  const query = String(body.query||"").trim().slice(0,200);
  if(!query)return j(400,{error:"missing_query"},origin);
  const candidates = Array.isArray(body.candidates)?body.candidates.slice(0,200):[];
  if(!candidates.length)return j(400,{error:"no_candidates"},origin);

  const key = `${slug(query)}_${dayKey()}`;
  const cached = await cacheGet(key);
  if(cached?.matches) return j(200,{...cached,source:"cache"},origin);

  // Compact table for the model — only the fields it'd actually use.
  const table = candidates.map(c => `${c.symbol} | ${c.name} | ${c.sector||""} | mcap:${c.marketCap||""} | pe:${c.pe??""} | pb:${c.pb??""} | div:${c.divYield??""} | beta:${c.beta??""} | risk:${c.risk||""} | today:${c.dayPct!=null?c.dayPct.toFixed(2)+"%":""}`).join("\n");
  const userMsg = `Query: ${query}\n\nCandidates:\n${table}`;

  try{
    const r=await fetch(base()+"/api/chat",{method:"POST",headers:{"Content-Type":"application/json","Origin":"https://stocksaathi.co.in"},body:JSON.stringify({
      messages:[{role:"system",content:SYSTEM},{role:"user",content:userMsg}],
      max_tokens:400,temperature:0.2,response_format:{type:"json_object"},profile:"reasoning",
    })});
    if(!r.ok)return j(502,{error:`chat_http_${r.status}`},origin);
    const d=await r.json();
    const text=d?.choices?.[0]?.message?.content;
    if(!text)return j(502,{error:"empty"},origin);
    let parsed; try{parsed=JSON.parse(text);}catch{return j(502,{error:"non_json"},origin);}
    const validSyms = new Set(candidates.map(c=>c.symbol));
    const matches = Array.isArray(parsed.matches) ? parsed.matches.filter(s => typeof s === "string" && validSyms.has(s)).slice(0,15) : [];
    const rationale = typeof parsed.rationale === "string" ? parsed.rationale.trim().slice(0,280) : "";
    const payload = { matches, rationale };
    cachePut(key, query, payload);
    return j(200,{...payload,source:"fresh"},origin);
  }catch(e){
    return j(502,{error:"generation_failed",detail:String(e.message).slice(0,100)},origin);
  }
}
