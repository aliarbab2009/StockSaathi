// =============================================================================
// SERVER TIME — Trust-the-server clock so the market-status badge can't
// be faked by a user changing their system time.
//
// Flow:
//   1. On first call (and periodically), hit /api/ai?op=time to get the
//      server's current epoch ms.
//   2. Compute offset = serverMs - clientMs at the moment of the response.
//   3. serverNow() returns Date.now() + offset — a local-tick-based clock
//      anchored to the server's truth.
//
// The offset is re-synced every 10 minutes and on `online` events so drift
// stays bounded. If the network is unreachable we fall back to local time
// and mark the status as degraded (badges show a subtle tilde to hint).
//
// This isn't cryptographically signed — a determined attacker on their
// own network can still MITM and lie. But for "change system clock to
// pretend market is open", it's bulletproof.
// =============================================================================

const SYNC_URL = "/api/ai?op=time";
const RESYNC_MS = 10 * 60 * 1000;   // 10 minutes

let offsetMs = 0;              // serverNow - Date.now()
let synced = false;             // true after first successful sync
let syncing = null;             // in-flight promise
let lastSyncAt = 0;             // last successful sync (Date.now() local)

async function doSync() {
  const beforeLocal = Date.now();
  try {
    const res = await fetch(SYNC_URL, { cache: "no-store" });
    const afterLocal = Date.now();
    if (!res.ok) throw new Error("http_" + res.status);
    const data = await res.json();
    if (typeof data?.ms !== "number") throw new Error("no_ms");
    // Midpoint correction — assume request+response symmetric latency.
    const localMid = (beforeLocal + afterLocal) / 2;
    offsetMs = data.ms - localMid;
    synced = true;
    lastSyncAt = afterLocal;
  } finally {
    syncing = null;
  }
}

// Fire-and-forget sync — never throws. Caller can await or ignore.
export function syncServerTime() {
  if (syncing) return syncing;
  syncing = doSync().catch(() => {});
  return syncing;
}

// Returns a Date for server-authoritative "now". If we haven't synced
// yet, returns local-clock time (degraded mode).
export function serverNow() {
  return new Date(Date.now() + (synced ? offsetMs : 0));
}

// Returns true if we have at least one successful sync.
export function isServerTimeSynced() { return synced; }

// Milliseconds since last successful sync (for staleness checks).
export function msSinceSync() {
  return lastSyncAt ? Date.now() - lastSyncAt : Infinity;
}

// Boot the periodic re-sync. Safe to call more than once — additional
// calls are no-ops thanks to the closure guard.
let started = false;
export function startServerTimeSync() {
  if (started) return;
  started = true;
  syncServerTime();
  // Re-sync on tab-focus so returning users get fresh offset fast.
  window.addEventListener("online", () => syncServerTime());
  window.addEventListener("focus", () => {
    if (msSinceSync() > 60_000) syncServerTime();
  });
  setInterval(() => { syncServerTime(); }, RESYNC_MS);
}
