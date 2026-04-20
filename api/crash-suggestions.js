// =============================================================================
// /api/crash-suggestions  —  Returns 8-12 short suggestion phrases the
// crash-replay page uses to rotate in its input placeholder and in a
// suggestions chip-bar. Cached by week so the site warms the cache once
// per week (new user sees same rotation as previous user).
// =============================================================================

export const config = { runtime: "edge" };

function allowed(o){
  if(!o)return null;
  const s=new Set(["https://stocksaathi.co.in","https://www.stocksaathi.co.in","http://localhost:7348","http://127.0.0.1:7348"]);
  if(s.has(o))return o;
  if(o.startsWith("https://")&&o.endsWith(".vercel.app"))return o;
  return null;
}
function cors(o){const h=new Headers({"Content-Type":"application/json","Cache-Control":"public, max-age=86400"});const a=allowed(o);if(a){h.set("Access-Control-Allow-Origin",a);h.set("Vary","Origin");}return h;}
function j(s,b,o){return new Response(JSON.stringify(b),{status:s,headers:cors(o)});}
function base(){const v=globalThis.process?.env?.VERCEL_URL;return v?`https://${v}`:"https://stocksaathi.co.in";}

function weekKey(){
  // ISO-ish week bucket
  const d = new Date();
  const jan1 = Date.UTC(d.getUTCFullYear(), 0, 1);
  const weeks = Math.floor((d.getTime() - jan1) / (7 * 86400000));
  return `${d.getUTCFullYear()}_w${weeks}`;
}
async function cacheGet(key){
  try{const r=await fetch(base()+`/api/ai-cache?bucket=crash_sugg&key=${encodeURIComponent(key)}`,{headers:{"Origin":"https://stocksaathi.co.in"}});if(!r.ok)return null;const d=await r.json();return d?.hit?d.payload:null;}catch{return null;}
}
function cachePut(key,payload){
  fetch(base()+"/api/ai-cache",{method:"POST",headers:{"Content-Type":"application/json","Origin":"https://stocksaathi.co.in"},body:JSON.stringify({bucket:"crash_sugg",key,payload})}).catch(()=>{});
}

const SYSTEM = `Return a strict JSON object:
{ "suggestions": ["…", "…", ...] }

10 short (4-7 word) phrases a teen might type into a "describe any Indian market event" input. Mix famous events, niche events, meme-energy phrasings, decades, and sectors. Examples of the vibe (do NOT reuse these; generate new ones):
- "Harshad Mehta 1992"
- "Satyam accounting scandal"
- "that pani puri scare"
- "Demonetisation night shock"
- "Adani Hindenburg"

Rules: no duplicates, no buy/sell advice, no emojis, Indian context only.`;

export default async function handler(req){
  const origin=req.headers.get("Origin")||"";
  if(origin&&!allowed(origin))return j(403,{error:"forbidden_origin"},origin);
  if(req.method==="OPTIONS"){
    const h=cors(origin);h.set("Access-Control-Allow-Methods","GET, OPTIONS");h.set("Access-Control-Allow-Headers","Content-Type");
    return new Response(null,{status:204,headers:h});
  }
  if(req.method!=="GET")return j(405,{error:"method_not_allowed"},origin);

  const key = weekKey();
  const cached = await cacheGet(key);
  if(cached?.suggestions?.length) return j(200,{...cached,source:"cache"},origin);

  try{
    const r=await fetch(base()+"/api/chat",{method:"POST",headers:{"Content-Type":"application/json","Origin":"https://stocksaathi.co.in"},body:JSON.stringify({
      messages:[{role:"system",content:SYSTEM},{role:"user",content:"Generate 10 suggestions."}],
      max_tokens:300,temperature:0.8,response_format:{type:"json_object"},profile:"fast",
    })});
    if(!r.ok)return j(502,{error:`chat_http_${r.status}`},origin);
    const d=await r.json();
    const text=d?.choices?.[0]?.message?.content;
    if(!text)return j(502,{error:"empty"},origin);
    let parsed; try{parsed=JSON.parse(text);}catch{return j(502,{error:"non_json"},origin);}
    const suggestions = Array.isArray(parsed.suggestions) ? parsed.suggestions.filter(s => typeof s === "string" && s.trim().length >= 3).slice(0,12).map(s=>s.trim().slice(0,80)) : [];
    if(!suggestions.length)return j(502,{error:"no_suggestions"},origin);
    const payload = { suggestions };
    cachePut(key,payload);
    return j(200,{...payload,source:"fresh"},origin);
  }catch(e){
    return j(502,{error:"generation_failed",detail:String(e.message).slice(0,100)},origin);
  }
}
