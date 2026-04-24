// =============================================================================
// SYNC — mirrors local state to Supabase in real time (when enabled).
// If Supabase is enabled at boot, this hooks into state changes + runs an
// initial load from DB so the portfolio, holdings, transactions, friends,
// transfers, watchlist all come from the server.
// =============================================================================

import { sb, isSupabaseEnabled } from "./supabase.js";
import { getState, setState, subscribe as subscribeState } from "../state.js";
import { refreshCurrentUser } from "../auth/accounts.js";

let _booted = false;
let _syncing = false;

export async function bootSync() {
  if (_booted) return;
  _booted = true;
  const client = await sb();
  if (!client) return;   // local mode, nothing to do

  // Refresh user profile cache on auth changes
  client.auth.onAuthStateChange(async (event, session) => {
    await refreshCurrentUser();
    if (session?.user) {
      await loadAllFromDb();
    } else {
      // sign-out — state will be cleared by the UI
    }
  });

  // Initial boot — if already logged in, load everything
  const { data: sessData } = await client.auth.getSession();
  if (sessData?.session?.user) {
    await refreshCurrentUser();
    await loadAllFromDb();
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
    const { data: userData } = await client.auth.getUser();
    const uid = userData?.user?.id;
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
  } finally {
    _syncing = false;
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
