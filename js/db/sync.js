// =============================================================================
// SYNC — mirrors local state to Supabase in real time (when enabled).
// If Supabase is enabled at boot, this hooks into state changes + runs an
// initial load from DB so the portfolio, holdings, transactions, friends,
// transfers, watchlist all come from the server.
// =============================================================================

import { sb, isSupabaseEnabled } from "./supabase.js";
import { getState, setState, subscribe as subscribeState } from "../state.js";
import { refreshCurrentUser, currentUser } from "../auth/accounts.js";

let _booted = false;
let _syncing = false;

// 5-second race around any supabase-js auth call. The internal GoTrue
// `_acquireLock` mutex can deadlock in supabase-js 2.45.4 when
// autoRefreshToken collides with a stale refresh token. Pre-v137, a
// stuck auth call here would hang `loadAllFromDb` forever — portfolio
// state never got populated, UI stuck at DEFAULT_STATE (₹1L cash, no
// coach messages, no holdings) until a hard refresh let supabase-js
// re-initialize. That manifested as "my data disappeared after a
// deploy" — it wasn't actually wiped server-side, just the local
// hydrate was hung. Bounded race lets us fail fast and bail gracefully.
async function authWithTimeout(fn, name, ms = 5000) {
  const p = fn();
  const t = new Promise((_, rej) =>
    setTimeout(() => rej(new Error(`auth_timeout:${name}`)), ms));
  return Promise.race([p, t]);
}

export async function bootSync() {
  if (_booted) return;
  _booted = true;
  // 10-s ultimate failsafe — even if everything below hangs or throws,
  // the coach-chat save gate (_hydrateAttempted) opens 10 seconds after
  // the first bootSync call so rapid-fire saves can't be lost forever
  // just because the boot path had some unforeseen issue.
  _scheduleHydrateFailsafe();
  const client = await sb();
  if (!client) {
    // Local mode — no Supabase at all. Open the gate immediately; there's
    // nothing to hydrate, and writes from dbSaveCoachChatsSoon would be
    // no-ops anyway (sb() returns null inside _flushCoachSync).
    _hydrateAttempted = true;
    return;
  }

  // Refresh user profile cache on auth changes
  client.auth.onAuthStateChange(async (event, session) => {
    await refreshCurrentUser();
    if (session?.user) {
      await loadAllFromDb();
    } else {
      // sign-out — state will be cleared by the UI
      _hydrateAttempted = true;
    }
  });

  // Initial boot — if already logged in, load everything. Bounded
  // 5-s timeout on getSession so a stuck GoTrue lock doesn't block
  // the entire app boot. If it times out, the onAuthStateChange
  // handler above will pick up any real session on the next refresh.
  try {
    const { data: sessData } = await authWithTimeout(() => client.auth.getSession(), "boot_getSession");
    if (sessData?.session?.user) {
      await refreshCurrentUser();
      await loadAllFromDb();
    } else {
      // No active session at boot — open the gate so that if the user
      // signs in later, saves fired BEFORE loadAllFromDb races back
      // aren't gated. The content-check guard in _flushCoachSync
      // still protects against blank-envelope uploads.
      _hydrateAttempted = true;
    }
  } catch (e) {
    console.warn("[sync] bootSync getSession failed:", e?.message || e);
    // Even on failure, open the gate — the 10-s failsafe would have
    // done it anyway, but doing it now avoids the 10-s write-silence
    // window after a login that happens to hit this error path.
    _hydrateAttempted = true;
  }
}

/**
 * Pull portfolio / holdings / transactions / watchlist / friends / transfers
 * from the DB into local state. Called on auth + periodically.
 */
export async function loadAllFromDb() {
  if (_syncing) return;
  _syncing = true;
  try {
    const client = await sb();
    if (!client) return;
    // Prefer the synchronous currentUser() cache — no auth call, no
    // lock acquisition. Only fall back to client.auth.getUser() (with
    // a 5-s timeout) if the cache is genuinely empty. This is the
    // single biggest source of "my data vanished on deploy" bug: a
    // stuck getUser call in v135 left loadAllFromDb hung forever,
    // so setState at line 121 never ran and the UI sat on
    // DEFAULT_STATE (₹1L cash, no coach messages). The cache is
    // populated by refreshCurrentUser(), which bootSync + the
    // onAuthStateChange handler both call.
    let uid = currentUser()?.id || null;
    if (!uid) {
      try {
        const { data: userData } = await authWithTimeout(
          () => client.auth.getUser(), "loadAllFromDb_getUser"
        );
        uid = userData?.user?.id || null;
      } catch (e) {
        console.warn("[sync] loadAllFromDb getUser failed:", e?.message || e);
        // CRITICAL: return WITHOUT calling setState. Bail gracefully
        // so the existing populated state (from a previous successful
        // load, persisted in localStorage) stays intact. Users don't
        // see ₹1L defaults just because auth is temporarily stuck.
        return;
      }
    }
    if (!uid) return;

    // Friends and transfers go through SECURITY DEFINER RPCs so the
    // counterparty's username + display name come back even though the new
    // profiles RLS blocks anon cross-user reads. The Postgrest join approach
    // used previously silently returned empty profile objects under RLS.
    const [pf, holdings, txns, wl, friendsRpc, transfersRpc, msgs] = await Promise.all([
      client.from("portfolios").select("*").eq("user_id", uid).maybeSingle(),
      client.from("holdings").select("*").eq("user_id", uid),
      client.from("transactions").select("*").eq("user_id", uid).order("created_at", { ascending: false }).limit(200),
      client.from("watchlist").select("symbol").eq("user_id", uid),
      client.rpc("list_my_friends"),
      client.rpc("list_my_transfers", { p_limit: 100 }),
      client.from("coach_messages").select("*").eq("user_id", uid).order("created_at", { ascending: false }).limit(50),
    ]);
    const friends = { data: friendsRpc.data || [], error: friendsRpc.error };
    const transfers = { data: transfersRpc.data || [], error: transfersRpc.error };

    const state = getState();
    const nextPortfolio = pf.data
      ? { cashPaise: Number(pf.data.cash_paise), startingCashPaise: Number(pf.data.starting_cash_paise) }
      : state.portfolio;

    const nextHoldings = {};
    for (const h of (holdings.data || [])) {
      nextHoldings[h.symbol] = {
        qty: Number(h.qty),
        avgCostPaise: Number(h.avg_cost_paise),
        firstBoughtAt: new Date(h.first_bought_at).getTime(),
      };
    }

    const nextTxns = (txns.data || []).reverse().map(t => ({
      id: t.id, idempotencyKey: t.idempotency_key, ts: new Date(t.created_at).getTime(),
      symbol: t.symbol, side: t.side, qty: Number(t.qty),
      pricePaise: Number(t.price_paise), valuePaise: Number(t.value_paise),
      biasFlags: t.bias_flags || [],
    }));

    const nextWatchlist = (wl.data || []).map(w => w.symbol);

    const nextFriends = (friends.data || []).map(f => ({
      id: f.friend_id,
      username: f.username,
      displayName: f.display_name,
      avatarColor: f.avatar_color,
      school: f.school,
      addedAt: f.added_at ? new Date(f.added_at).getTime() : Date.now(),
    }));

    const nextTransfers = (transfers.data || []).map(tr => ({
      id: tr.id,
      direction: tr.direction,
      counterpartyId: tr.counterparty_id,
      counterpartyHandle: tr.counterparty_username,
      counterpartyName: tr.counterparty_display_name || tr.counterparty_username || null,
      counterpartyAvatarColor: tr.counterparty_avatar_color,
      amountPaise: Number(tr.amount_paise),
      note: tr.note,
      status: tr.status,
      code: tr.code,
      ts: new Date(tr.created_at).getTime(),
    }));

    const nextCoachMessages = (msgs.data || []).reverse().map(m => ({
      id: m.id, ts: new Date(m.created_at).getTime(),
      eventType: m.event_type, triggerSymbol: m.trigger_symbol,
      payload: m.payload, model: m.model,
    }));

    setState(s => ({
      ...s,
      portfolio: nextPortfolio,
      holdings: nextHoldings,
      transactions: nextTxns,
      watchlist: nextWatchlist,
      friends: nextFriends,
      transfers: nextTransfers,
      coachMessages: nextCoachMessages,
    }));

    // Best-effort coach-chat sync — won't block this function if it hangs
    // or the coach_chats table doesn't exist yet on this Supabase project.
    // Fire-and-forget; hydrateCoachChatsFromDb dispatches 'ss:coach-sync'
    // when it actually touched localStorage so live chat views reload.
    hydrateCoachChatsFromDb().catch(e => console.warn("[sync] coach hydrate:", e?.message || e));
  } finally {
    _syncing = false;
    // Open the dbSaveCoachChatsSoon() gate regardless of how loadAllFromDb
    // exited. v139 only flipped the flag inside hydrateCoachChatsFromDb()'s
    // own finally — but loadAllFromDb has six early-return paths (no
    // client, no uid, getUser timeout, Promise.all throw, _syncing
    // reentrancy) that bail BEFORE hydrate is even called. When that
    // happened the flag stayed false forever and every single coach-chat
    // save silently no-op'd via the gate at dbSaveCoachChatsSoon. Moving
    // the flip here ensures the gate opens after ANY loadAllFromDb
    // invocation, success or failure — so the race window the gate was
    // protecting against (a ~500 ms period between module-load blank-save
    // and successful hydrate) is the ONLY thing it gates against, not
    // the entire session.
    _hydrateAttempted = true;
  }
}

// ---------------------------------------------------------------------------
// Write-side helpers — called by state.js / features when user mutates data.
// ---------------------------------------------------------------------------

/** Add a stock to watchlist */
export async function dbAddWatchlist(symbol) {
  const client = await sb();
  if (!client) return;
  const { data: u } = await client.auth.getUser();
  if (!u?.user) return;
  await client.from("watchlist").upsert({ user_id: u.user.id, symbol }).select();
}

export async function dbRemoveWatchlist(symbol) {
  const client = await sb();
  if (!client) return;
  const { data: u } = await client.auth.getUser();
  if (!u?.user) return;
  await client.from("watchlist").delete().eq("user_id", u.user.id).eq("symbol", symbol);
}

export async function dbAddCoachMessage(msg) {
  const client = await sb();
  if (!client) return;
  const { data: u } = await client.auth.getUser();
  if (!u?.user) return;
  await client.from("coach_messages").insert({
    user_id: u.user.id,
    event_type: msg.eventType,
    trigger_symbol: msg.triggerSymbol || null,
    payload: msg.payload || {},
    model: msg.model || null,
  });
}

export async function dbAddFriend(friendUsername) {
  const client = await sb();
  if (!client) throw new Error("Backend not configured.");
  await ensureAuthedOrRedirect(client);
  const { data, error } = await client.rpc("add_friend_by_username",
    { p_username: friendUsername.trim() });
  if (error) {
    const msg = String(error.message || "");
    if (/recipient not found/i.test(msg)) throw new Error(`No StockSaathi user "@${friendUsername}".`);
    if (/cannot add yourself/i.test(msg)) throw new Error("You can't add yourself.");
    if (/not logged in/i.test(msg)) {
      await handleSessionLost();
      throw new Error("Your session expired. Please log in again.");
    }
    throw new Error(prettifyErr(msg));
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new Error(`No StockSaathi user "@${friendUsername}".`);
  return {
    id: row.friend_id,
    username: row.username,
    displayName: row.display_name,
    avatarColor: row.avatar_color,
  };
}

export async function dbRemoveFriend(friendId) {
  const client = await sb();
  if (!client) return;
  const { data: u } = await client.auth.getUser();
  if (!u?.user) return;
  await client.from("friends").delete().eq("user_id", u.user.id).eq("friend_id", friendId);
}

/** Send money via the apply_transfer RPC (atomic) */
export async function dbSendTransfer({ recipientHandle, amountPaise, note }) {
  const client = await sb();
  if (!client) throw new Error("Backend not configured.");
  await ensureAuthedOrRedirect(client);
  const { data, error } = await client.rpc("apply_transfer", {
    p_recipient_username: recipientHandle,
    p_amount_paise: amountPaise,
    p_note: note || "",
  });
  if (error) {
    if (/not logged in/i.test(error.message)) await handleSessionLost();
    throw new Error(prettifyErr(error.message));
  }
  return data;
}

/** Apply a trade via the apply_trade RPC (atomic) */
export async function dbApplyTrade({ symbol, side, qty, pricePaise, idempotencyKey, biasFlags }) {
  const client = await sb();
  if (!client) throw new Error("Backend not configured.");
  await ensureAuthedOrRedirect(client);
  // Race the RPC against a 10 s timeout. apply_trade has occasionally hung
  // on SELL when earlier failed calls left row-locks queued in the pool —
  // without this, the confirm modal would sit forever and the UI looks
  // dead. 10 s is generous (usually completes in <200ms); anything longer
  // is either a real problem or a transient lock that'll clear in a minute.
  const { data, error } = await Promise.race([
    client.rpc("apply_trade", {
      p_symbol: symbol,
      p_side: side,
      p_qty: qty,
      p_price_paise: pricePaise,
      p_idempotency_key: idempotencyKey,
      p_bias_flags: biasFlags || [],
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("trade_timeout")), 10_000)),
  ]);
  if (error) {
    if (/not logged in/i.test(error.message)) await handleSessionLost();
    throw new Error(prettifyErr(error.message));
  }
  return data;
}

// ---------------------------------------------------------------------------
// COACH CHATS — cross-device sync for the /chat page's multi-session history
// AND the coach panel's running log. Stored as one row per user in the
// coach_chats table (sessions_json + coach_log JSONB). Previously both lived
// only in localStorage; logging in on a new device / incognito window showed
// an empty coach. Migration: supabase/migrations/2026-04-24g_coach_chats_sync.sql
// ---------------------------------------------------------------------------
const SESSIONS_LS_KEY = "ss.chat.sessions.v1";
const COACHLOG_LS_KEY = "ss.coachchat.v1";

function safeParse(raw, fallback) {
  try { return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
}

// Functionally-empty detectors. A fresh loadSessions() envelope has one
// session titled "New chat" with zero messages — length > 0, but NO
// actual content. Before v139 we treated that as "real" on both read and
// write paths, which meant a slow-hydrate incognito boot could upsert
// the blank over the user's real DB row (write side), and a subsequent
// source-browser boot could overwrite its real localStorage from that
// blank DB row (read side). Both sides now gate on real content.
function hasRealSessionsJson(json) {
  return json && typeof json === "object" &&
    Array.isArray(json.sessions) &&
    json.sessions.some(s => Array.isArray(s?.messages) && s.messages.length > 0);
}
function hasRealCoachLog(log) {
  return Array.isArray(log) && log.length > 0;
}

// Resolve the user's uid from cache first, falling back to a bounded
// client.auth.getUser() call if the cache hasn't settled yet. Matches
// the pattern loadAllFromDb already uses. Cheap insurance so the sync
// never silently no-ops on a boot where refreshCurrentUser races.
// v140 — now logs the fallback + failure so silent no-ops are
// diagnosable from the browser console instead of invisible.
async function resolveUid(client) {
  let uid = currentUser()?.id || null;
  if (uid) return uid;
  try {
    const res = await authWithTimeout(() => client.auth.getUser(), "coach_sync_getUser", 3500);
    uid = res?.data?.user?.id || null;
    if (!uid) console.warn("[coach-sync] resolveUid: getUser returned no user — treating as signed-out");
  } catch (e) {
    console.warn("[coach-sync] resolveUid getUser failed:", e?.message || e);
  }
  return uid;
}

// 10-second failsafe: open the _hydrateAttempted gate no matter what
// else happens during boot. Separate from the setTimeout-based debounce.
// Defensive layer for any boot-path bug we haven't thought of — it's
// better for a bad hydrate to UPSERT-over-real-DB (still prevented by
// _flushCoachSync's blank-envelope content-check) than for the entire
// coach-chat sync to be permanently silenced like it was in v139.
let _hydrateFailsafeTimer = null;
function _scheduleHydrateFailsafe() {
  if (_hydrateFailsafeTimer) return;
  _hydrateFailsafeTimer = setTimeout(() => {
    _hydrateFailsafeTimer = null;
    if (!_hydrateAttempted) {
      console.warn("[coach-sync] hydrate failsafe fired — gate was still closed 10 s after bootSync started. Opening so saves can proceed.");
      _hydrateAttempted = true;
    }
  }, 10_000);
}

// Log "coach_chats table doesn't exist" exactly once per page load so
// users who forgot to run the migration actually see the message
// instead of the silent-swallow we had in v138.
let _migrationMissingWarned = false;
function logMigrationMissing() {
  if (_migrationMissingWarned) return;
  _migrationMissingWarned = true;
  console.warn(
    "[coach-sync] coach_chats table not found in Supabase.\n" +
    "Apply supabase/migrations/2026-04-24g_coach_chats_sync.sql in the\n" +
    "SQL editor or sync will stay local-only."
  );
}

/** Fetch the current user's coach-chat row. Returns null on error / missing. */
export async function dbLoadCoachChats() {
  const client = await sb();
  if (!client) return null;
  try {
    const uid = await resolveUid(client);
    if (!uid) return null;
    const { data, error } = await client
      .from("coach_chats")
      .select("sessions_json, coach_log, updated_at")
      .eq("user_id", uid)
      .maybeSingle();
    if (error) {
      if (/42P01|does not exist/i.test(String(error.message || ""))) {
        logMigrationMissing();
      } else {
        console.warn("[coach-sync] load:", error.message);
      }
      return null;
    }
    return data || null;
  } catch (e) {
    console.warn("[coach-sync] load threw:", e?.message || e);
    return null;
  }
}

// Debounced push of the current localStorage coach state up to Supabase.
// Snapshots from localStorage at FLUSH time so we always upsert the
// most-recent content. Gated behind _hydrateAttempted so the initial
// boot race can't overwrite real DB data with the blank envelope that
// chatSessions.loadSessions persists on a fresh-localStorage mount.
let _coachSyncTimer = null;
let _hydrateAttempted = false;
let _gateSuppressWarned = false;
export function dbSaveCoachChatsSoon() {
  if (!_hydrateAttempted) {
    // Should essentially never fire thanks to the unconditional flip in
    // loadAllFromDb's finally, bootSync's exit paths, and the 10 s
    // failsafe. If it does, log once so we can see it in the console
    // instead of the v139 bug where this was a silent no-op for the
    // entire session. The call itself is still gated — but the user's
    // localStorage write already happened in chatSessions.saveSessions,
    // so content isn't lost, just not pushed yet. The next save after
    // the gate opens will upsert whatever localStorage currently holds.
    if (!_gateSuppressWarned) {
      _gateSuppressWarned = true;
      console.warn("[coach-sync] save suppressed — boot hydrate gate still closed. Will retry on next save once gate opens.");
    }
    return;
  }
  if (_coachSyncTimer) clearTimeout(_coachSyncTimer);
  _coachSyncTimer = setTimeout(_flushCoachSync, 1500);
}

async function _flushCoachSync() {
  _coachSyncTimer = null;
  const client = await sb();
  if (!client) return;
  try {
    const uid = await resolveUid(client);
    if (!uid) {
      // v140: previously silent. Surface this so users whose auth
      // session is stale can actually see why writes aren't landing.
      console.warn("[coach-sync] save skipped — no authenticated user (resolveUid returned null)");
      return;
    }
    const sessions_json = safeParse(localStorage.getItem(SESSIONS_LS_KEY), {});
    const coach_log = safeParse(localStorage.getItem(COACHLOG_LS_KEY), []);
    // Blank-envelope guard: the default post-loadSessions state has ONE
    // "New chat" session with zero messages. Upserting that would blank
    // the user's real DB row on another device / earlier tab. Refuse.
    if (!hasRealSessionsJson(sessions_json) && !hasRealCoachLog(coach_log)) {
      return;
    }
    const { error } = await client.from("coach_chats").upsert({
      user_id: uid,
      sessions_json,
      coach_log,
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id" });
    if (error) {
      if (/42P01|does not exist/i.test(String(error.message || ""))) {
        logMigrationMissing();
      } else {
        console.warn("[coach-sync] save:", error.message);
      }
    }
  } catch (e) {
    console.warn("[coach-sync] save threw:", e?.message || e);
  }
}

// Best-effort flush on tab close. beforeunload can't reliably await a
// fetch, but the Supabase upsert is a single short POST that most
// browsers allow to complete if dispatched synchronously before unload.
// Users who close the tab within 1.5 s of a save still have a chance.
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    if (_coachSyncTimer) {
      clearTimeout(_coachSyncTimer);
      _coachSyncTimer = null;
      // Fire-and-forget. No await possible in beforeunload; browser
      // will usually let the fetch complete anyway.
      _flushCoachSync();
    }
  });
}

/**
 * Hydrate localStorage from the DB row. Called from loadAllFromDb on login
 * so a brand-new device / incognito window picks up the user's chat history
 * instead of showing an empty coach. Dispatches ss:coach-sync custom events
 * afterwards so any live-mounted chat/panel view reloads from fresh disk.
 *
 * Flips _hydrateAttempted = true on completion (success OR failure) so
 * dbSaveCoachChatsSoon unblocks. If the DB row exists but is functionally
 * empty (a prior buggy run blanked it), leaves localStorage alone — the
 * first real save after this will push local content UP to recover.
 */
export async function hydrateCoachChatsFromDb() {
  try {
    const row = await dbLoadCoachChats();
    if (!row) return;
    const dbHasSessions = hasRealSessionsJson(row.sessions_json);
    const dbHasCoachLog = hasRealCoachLog(row.coach_log);
    if (!dbHasSessions && !dbHasCoachLog) {
      // DB row exists but is blank. Don't overwrite local — if local has
      // content, the next debounced save will push it up automatically.
      return;
    }
    let touched = false;
    try {
      if (dbHasSessions) {
        localStorage.setItem(SESSIONS_LS_KEY, JSON.stringify(row.sessions_json));
        touched = true;
      }
    } catch (e) { console.warn("[coach-sync] hydrate sessions failed:", e); }
    try {
      if (dbHasCoachLog) {
        localStorage.setItem(COACHLOG_LS_KEY, JSON.stringify(row.coach_log));
        touched = true;
      }
    } catch (e) { console.warn("[coach-sync] hydrate coach_log failed:", e); }
    if (touched) {
      try { window.dispatchEvent(new CustomEvent("ss:coach-sync")); } catch {}
    }
  } finally {
    _hydrateAttempted = true;
  }
}

function prettifyErr(msg) {
  if (!msg) return "Something went wrong.";
  if (/insufficient cash/i.test(msg)) return "Not enough cash.";
  if (/insufficient holding/i.test(msg)) return "You don't have enough of that stock to sell.";
  if (/recipient not found/i.test(msg)) return "We couldn't find that StockSaathi user.";
  if (/cannot send to self/i.test(msg)) return "You can't send money to yourself.";
  if (/not logged in/i.test(msg)) return "Your session expired. Please log in again.";
  return msg;
}

// Guard against the silent ghost-session bug: a stale ss.session.v1 used to
// let users past needsAuth with no Supabase session at all. If that happens
// now we clear the phantom cache, nudge them to /login, and surface a clean
// error instead of the raw postgres "not logged in".
async function ensureAuthedOrRedirect(client) {
  try {
    const { data } = await client.auth.getSession();
    if (data?.session?.access_token) return;
  } catch {}
  await handleSessionLost();
  throw new Error("Your session expired. Please log in again.");
}

async function handleSessionLost() {
  try {
    const { logoutAccount } = await import("../auth/accounts.js");
    await logoutAccount();
  } catch {}
  try { window.location.hash = "#/login"; } catch {}
}
