// =============================================================================
// /api/report-card  —  Full AI narrative for /#/report-card.
// POST: { totalTrades, winRate, biggestWin, biggestLoss, avgHoldDays,
//         biasFlags[], portfolioReturnPct, topSectors[], startedAt }
// Returns: { narrative, strengths[], watchouts[] }
// Not cached (per user).
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

const SYSTEM = `You are Saathi writing a student's behavioural-investing report card. From the stats and bias flags you receive, write a warm + honest summary of how they've been trading in their StockSaathi simulator. Return strict JSON:

{
  "narrative": "<80-120 word paragraph, second person, specific to their numbers>",
  "strengths": ["short bullet 1","short bullet 2","short bullet 3"],
  "watchouts": ["short bullet 1","short bullet 2","short bullet 3"]
}

Rules:
- Quote the actual numbers. No invented stats.
- 3 strengths + 3 watchouts, each ≤ 10 words.
- Strengths and watchouts must be substantive — no 'great job keep going'.
- Zero emojis, zero markdown, zero buy/sell advice.
- Teen-readable English. Dry honesty > diplomatic hedging.`;

export default async function handler(req){
  const origin=req.headers.get("Origin")||"";
  if(origin&&!allowed(origin))return j(403,{error:"forbidden_origin"},origin);
  if(req.method==="OPTIONS"){
    const h=cors(origin);h.set("Access-Control-Allow-Methods","POST, OPTIONS");h.set("Access-Control-Allow-Headers","Content-Type");
    return new Response(null,{status:204,headers:h});
  }
  if(req.method!=="POST")return j(405,{error:"method_not_allowed"},origin);

  let body; try{body=await req.json();}catch{return j(400,{error:"bad_body"},origin);}
  const userMsg = [
    `Started using simulator: ${body.startedAt||"recently"}`,
    `Total trades: ${body.totalTrades||0}`,
    `Win rate: ${(body.winRate*100).toFixed(0)}%`,
    `Biggest win: ₹${body.biggestWin||0}`,
    `Biggest loss: ₹${body.biggestLoss||0}`,
    `Avg hold time: ${body.avgHoldDays||0} days`,
    `Portfolio return: ${body.portfolioReturnPct>=0?"+":""}${body.portfolioReturnPct?.toFixed(2)||"0"}%`,
    `Top sectors held: ${(body.topSectors||[]).join(", ")||"none yet"}`,
    `Behavioural flags raised by the engine: ${(body.biasFlags||[]).length?(body.biasFlags||[]).join(", "):"none"}`,
  ].join("\n");

  try{
    const r=await fetch(base()+"/api/chat",{method:"POST",headers:{"Content-Type":"application/json","Origin":"https://stocksaathi.co.in"},body:JSON.stringify({
      messages:[{role:"system",content:SYSTEM},{role:"user",content:userMsg}],
      max_tokens:360,temperature:0.45,response_format:{type:"json_object"},profile:"reasoning",
    })});
    if(!r.ok)return j(502,{error:`chat_http_${r.status}`},origin);
    const d=await r.json();
    const text=d?.choices?.[0]?.message?.content;
    if(!text)return j(502,{error:"empty"},origin);
    let parsed; try{parsed=JSON.parse(text);}catch{return j(502,{error:"non_json"},origin);}
    const narrative=typeof parsed.narrative==="string"?parsed.narrative.trim().slice(0,1000):"";
    const strengths=Array.isArray(parsed.strengths)?parsed.strengths.filter(x=>typeof x==="string").slice(0,5).map(x=>x.slice(0,120)):[];
    const watchouts=Array.isArray(parsed.watchouts)?parsed.watchouts.filter(x=>typeof x==="string").slice(0,5).map(x=>x.slice(0,120)):[];
    if(!narrative)return j(502,{error:"no_narrative"},origin);
    return j(200,{narrative,strengths,watchouts},origin);
  }catch(e){
    return j(502,{error:"generation_failed",detail:String(e.message).slice(0,100)},origin);
  }
}
