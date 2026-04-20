// =============================================================================
// /api/command  —  Unified natural-language command router for Command-K.
// User types ANYTHING ("buy 5 TCS", "what's a P/E", "go to portfolio", "show
// me pharma stocks", "why did RELIANCE drop"). Model returns a structured
// intent the client can act on:
//
//   { action: "navigate", target: "/stocks/TCS", response: "Pulling up TCS" }
//   { action: "answer",   response: "P/E is …" }
//   { action: "search",   query: "pharma stocks" }
//   { action: "trade",    side: "BUY"|"SELL", symbol: "TCS", qty: 5,
//                          response: "Opening buy screen for TCS" }
//
// Stateless; not cached — commands are varied.
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

const SYSTEM = `You are Saathi's command router on StockSaathi. A user types a command or question. Return a strict JSON object describing the intent.

Schema (always return one of these shapes):
  { "action": "navigate", "target": "<hash path like /portfolio or /stocks/TCS>", "response": "<short ack>" }
  { "action": "answer",   "response": "<60-120 word answer in Saathi voice>" }
  { "action": "search",   "query": "<the search intent>", "response": "<short ack>" }
  { "action": "trade",    "side": "BUY" | "SELL", "symbol": "<NSE ticker>", "qty": <int>, "response": "<short ack>" }

Available navigation targets: /portfolio /stocks /news /chat /crash-replay /leaderboard /friends /report-card /settings /stocks/<TICKER>

Rules:
- If they ask a factual / educational question, use 'answer' and reply in the Saathi coach voice (warm, dry, Indian teen audience, no emojis, no buy/sell advice).
- If they want to go somewhere, use 'navigate' (target is a hash path starting with /).
- If they want to filter stocks by criteria ("cheap IT", "pharma winners"), use 'search'.
- If they want to place a trade, use 'trade'. qty must be integer ≥ 1.
- If the input is garbage / out of scope, use 'answer' and redirect briefly.
- Return only the JSON. No prose outside it.`;

export default async function handler(req){
  const origin=req.headers.get("Origin")||"";
  if(origin&&!allowed(origin))return j(403,{error:"forbidden_origin"},origin);
  if(req.method==="OPTIONS"){
    const h=cors(origin);h.set("Access-Control-Allow-Methods","POST, OPTIONS");h.set("Access-Control-Allow-Headers","Content-Type");
    return new Response(null,{status:204,headers:h});
  }
  if(req.method!=="POST")return j(405,{error:"method_not_allowed"},origin);

  let body; try{body=await req.json();}catch{return j(400,{error:"bad_body"},origin);}
  const query = String(body.query||"").trim().slice(0,400);
  if(!query)return j(400,{error:"missing_query"},origin);
  const context = String(body.context||"").slice(0,200);

  const userMsg = context ? `Current page: ${context}\nCommand: ${query}` : `Command: ${query}`;

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
    return j(200,parsed,origin);
  }catch(e){
    return j(502,{error:"generation_failed",detail:String(e.message).slice(0,100)},origin);
  }
}
