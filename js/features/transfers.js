// =============================================================================
// TRANSFERS — P2P virtual cash.
//   Supabase mode: atomic via the apply_transfer RPC, cross-device.
//   Local mode:   writes both sides' localStorage state (single-device demo).
// =============================================================================

import { currentUser, findAccountByHandle, listAccountsPublic } from "../auth/accounts.js";
import { getState, setState, genId } from "../state.js";
import { sb } from "../db/supabase.js";
import { dbSendTransfer } from "../db/sync.js";

const USERSTATE_PREFIX = "ss.userstate.";

// Local-mode P2P relies on reading other users' state from the same device.
// This is ONLY used when there is no Supabase session (demo mode on a shared
// laptop). The Supabase path is strongly preferred and runs in real RLS,
// so we never reach here for authed users.
function readOtherUserState(userId) {
  try { const raw = localStorage.getItem(USERSTATE_PREFIX + userId); return raw ? JSON.parse(raw) : null; }
  catch { return null; }
}
function writeOtherUserState(userId, st) {
  const stamped = { ...st, _persistedAt: Date.now() };
  try { localStorage.setItem(USERSTATE_PREFIX + userId, JSON.stringify(stamped)); }
  catch (e) { console.warn("writeOtherUserState failed:", e?.name || e); }
}

// Crypto-strong transfer code (8 chars from a 32-char alphabet → ~10^12
// space). Replaces Math.random() which is predictable enough that a sibling
// on the same computer could guess recent codes.
function cryptoCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const out = new Uint32Array(8);
  (window.crypto || window.msCrypto).getRandomValues(out);
  let s = "";
  for (let i = 0; i < 8; i++) s += chars[out[i] % chars.length];
  return s.slice(0, 4) + "-" + s.slice(4);
}

// --------------------------------------------------------------------------
export async function sendTransfer({ recipientHandle, amountPaise, note = "" }) {
  const me = currentUser();
  if (!me) throw new Error("Log in to send money.");
  if (!Number.isFinite(amountPaise) || amountPaise <= 0) throw new Error("Enter a valid amount.");

  const client = await sb();
  if (client) {
    const amt = Math.round(amountPaise);
    const cleanHandle = recipientHandle.replace(/^@/, "");
    let res;
    try {
      res = await dbSendTransfer({
        recipientHandle: cleanHandle,
        amountPaise: amt, note,
      });
    } catch (e) {
      throw new Error(prettifyTransferError(e));
    }
    // Resolve the recipient's display name so the history row doesn't show
    // a raw @handle forever. Cheap SECURITY DEFINER RPC; no RLS issues.
    let displayName = cleanHandle;
    let friendId = null;
    try {
      const { data: prof } = await client.rpc("profile_by_username",
        { p_username: cleanHandle });
      const row = Array.isArray(prof) ? prof[0] : prof;
      if (row) { displayName = row.display_name || cleanHandle; friendId = row.id; }
    } catch {}

    setState(s => ({
      ...s,
      portfolio: { ...s.portfolio, cashPaise: s.portfolio.cashPaise - amt },
      transfers: [
        {
          id: res.transfer_id || genId(),
          direction: "out",
          counterpartyId: friendId,
          counterpartyHandle: cleanHandle,
          counterpartyName: displayName,
          amountPaise: amt,
          ts: Date.now(),
          note,
          status: "completed",
        },
        ...s.transfers,
      ],
    }));
    return { ok: true, recipient: { username: cleanHandle, displayName }, amountPaise: amt };
  }

  // Local fallback
  const state = getState();
  if (amountPaise > state.portfolio.cashPaise) {
    throw new Error(`Not enough cash. You have ₹${(state.portfolio.cashPaise / 100).toLocaleString("en-IN")}.`);
  }
  const recipient = await findAccountByHandle(recipientHandle);
  if (!recipient) throw new Error(`No StockSaathi user with handle "${recipientHandle}".`);
  if (recipient.id === me.id) throw new Error("You can't send money to yourself.");

  const transferId = genId();
  const ts = Date.now();
  const amount = Math.round(amountPaise);

  setState(s => ({
    ...s,
    portfolio: { ...s.portfolio, cashPaise: s.portfolio.cashPaise - amount },
    transfers: [...s.transfers, {
      id: transferId, direction: "out", counterpartyId: recipient.id,
      counterpartyHandle: recipient.username, counterpartyName: recipient.displayName,
      amountPaise: amount, ts, note, status: "completed",
    }],
  }));

  // Local-mode credit: only if the recipient actually has existing state on
  // this device. Refuse to conjure a new account with ₹1 lakh starter cash —
  // that was a bug: sending to a typo'd handle would create a phantom user
  // and burn sender cash into it.
  const recState = readOtherUserState(recipient.id);
  if (!recState) {
    // Roll back the sender-side debit we just applied.
    setState(s => ({
      ...s,
      portfolio: { ...s.portfolio, cashPaise: s.portfolio.cashPaise + amount },
      transfers: s.transfers.filter(t => t.id !== transferId),
    }));
    throw new Error("Recipient hasn't signed in on this device yet. Ask them to open StockSaathi first, then retry.");
  }
  // Build a new state object rather than mutating the one we just read from
  // localStorage — if a second tab reads the same key between our read and
  // write, mutation could leak an intermediate view to that tab.
  const nextRecState = {
    ...recState,
    portfolio: {
      ...recState.portfolio,
      cashPaise: (recState.portfolio?.cashPaise || 0) + amount,
    },
    transfers: [
      ...(recState.transfers || []),
      {
        id: transferId + "_in", direction: "in",
        counterpartyId: me.id, counterpartyHandle: me.username, counterpartyName: me.displayName,
        amountPaise: amount, ts, note, status: "completed",
      },
    ],
  };
  writeOtherUserState(recipient.id, nextRecState);

  return {
    ok: true,
    recipient: { id: recipient.id, displayName: recipient.displayName, username: recipient.username },
    amountPaise: amount,
  };
}

// --------------------------------------------------------------------------
export async function createTransferCode({ amountPaise, note = "" }) {
  const me = currentUser();
  if (!me) throw new Error("Log in to create a transfer.");
  if (!Number.isFinite(amountPaise) || amountPaise <= 0) throw new Error("Enter a valid amount.");
  const amount = Math.round(amountPaise);
  const state = getState();
  if (amount > state.portfolio.cashPaise) {
    throw new Error(`Not enough cash. You have ₹${(state.portfolio.cashPaise / 100).toLocaleString("en-IN")}.`);
  }
  const code = generateCode();
  const client = await sb();

  // Server path — the transfers table is authoritative, which kills the
  // old cross-device "pending code on the sender's laptop only" limitation
  // AND removes the need to rummage through other users' localStorage on
  // redeem.
  if (client) {
    try {
      const { data: hasSession } = await client.auth.getSession();
      if (hasSession?.session?.access_token) {
        const { data, error } = await client.rpc("create_transfer_code", {
          p_amount_paise: amount, p_note: note, p_code: code,
        });
        if (error) throw error;
        const ts = Date.now();
        setState(s => ({
          ...s,
          portfolio: { ...s.portfolio, cashPaise: s.portfolio.cashPaise - amount },
          transfers: [...s.transfers, {
            id: data?.transfer_id || genId(), direction: "out", code, status: "pending",
            amountPaise: amount, ts, note,
            counterpartyId: null, counterpartyHandle: null, counterpartyName: `Code: ${code}`,
          }],
        }));
        return { code, amountPaise: amount };
      }
    } catch (e) {
      throw new Error(prettifyTransferError(e));
    }
  }

  // Local fallback: used only in pure-demo mode without Supabase.
  const ts = Date.now();
  setState(s => ({
    ...s,
    portfolio: { ...s.portfolio, cashPaise: s.portfolio.cashPaise - amount },
    transfers: [...s.transfers, {
      id: genId(), direction: "out", code, status: "pending",
      amountPaise: amount, ts, note,
      counterpartyId: null, counterpartyHandle: null, counterpartyName: `Code: ${code}`,
    }],
  }));
  return { code, amountPaise: amount };
}

export async function redeemTransferCode(code) {
  const me = currentUser();
  if (!me) throw new Error("Log in to redeem.");
  const cleanCode = String(code || "").trim().toUpperCase();
  if (cleanCode.length < 6) throw new Error("Code is too short.");
  const client = await sb();

  // Server path — does NOT leak any other user's state. The RPC is
  // SECURITY DEFINER and only returns the amount of the redeemed code.
  if (client) {
    try {
      const { data: hasSession } = await client.auth.getSession();
      if (hasSession?.session?.access_token) {
        const { data, error } = await client.rpc("redeem_transfer_code",
          { p_code: cleanCode });
        if (error) throw error;
        const amount = Number(data?.amount_paise || 0);
        setState(s => ({
          ...s,
          portfolio: { ...s.portfolio, cashPaise: s.portfolio.cashPaise + amount },
          transfers: [...s.transfers, {
            id: data?.transfer_id || genId(), direction: "in", code: cleanCode,
            counterpartyId: null, counterpartyHandle: null,
            counterpartyName: "Code redeemed",
            amountPaise: amount, ts: Date.now(), status: "completed",
          }],
        }));
        return { ok: true, amountPaise: amount };
      }
    } catch (e) {
      throw new Error(prettifyTransferError(e));
    }
  }

  // Local fallback: ONLY look in accounts the user has explicitly added as
  // a friend. No more iterating every ss.userstate.* key. This still works
  // for the demo-day "two laptops, shared code" case because both students
  // would friend each other before redeeming.
  const state = getState();
  const friendIds = (state.friends || []).map(f => f.id).filter(Boolean);
  let found = null;
  for (const uid of friendIds) {
    if (uid === me.id) continue;
    const st = readOtherUserState(uid);
    if (!st?.transfers) continue;
    const match = st.transfers.find(t => t.code === cleanCode && t.status === "pending");
    if (match) { found = { userId: uid, state: st, transfer: match }; break; }
  }
  if (!found) throw new Error("Code not found or already redeemed. (In local-only mode, the sender must be in your friends list.)");
  const { userId: senderId, state: senderState, transfer } = found;
  senderState.transfers = senderState.transfers.map(t =>
    t.id === transfer.id
      ? { ...t, status: "completed", counterpartyId: me.id,
          counterpartyHandle: me.username, counterpartyName: me.displayName }
      : t
  );
  writeOtherUserState(senderId, senderState);
  setState(s => ({
    ...s,
    portfolio: { ...s.portfolio, cashPaise: s.portfolio.cashPaise + transfer.amountPaise },
    transfers: [...s.transfers, {
      id: genId(), direction: "in", code: cleanCode,
      counterpartyId: senderId, counterpartyHandle: null,
      counterpartyName: "Code redeemed",
      amountPaise: transfer.amountPaise, ts: Date.now(),
      note: transfer.note, status: "completed",
    }],
  }));
  return { ok: true, amountPaise: transfer.amountPaise };
}

// --------------------------------------------------------------------------
export async function addFriend(handle) {
  const me = currentUser();
  if (!me) throw new Error("Log in first.");
  const client = await sb();
  if (client) {
    const { dbAddFriend } = await import("../db/sync.js");
    const friend = await dbAddFriend(handle.replace(/^@/, ""));
    setState(s => ({
      ...s,
      friends: s.friends.some(f => f.id === friend.id)
        ? s.friends
        : [...s.friends, { ...friend, addedAt: Date.now() }],
    }));
    return { ok: true, friend };
  }

  const acc = await findAccountByHandle(handle);
  if (!acc) throw new Error(`No StockSaathi user with handle "${handle}".`);
  if (acc.id === me.id) throw new Error("You can't add yourself.");
  setState(s => {
    if (s.friends.some(f => f.id === acc.id)) return s;
    return {
      ...s,
      friends: [...s.friends, {
        id: acc.id, username: acc.username, displayName: acc.displayName,
        avatarColor: acc.avatarColor, addedAt: Date.now(),
      }],
    };
  });
  return { ok: true, friend: { id: acc.id, displayName: acc.displayName, username: acc.username } };
}

export async function removeFriend(friendId) {
  const client = await sb();
  if (client) {
    const { dbRemoveFriend } = await import("../db/sync.js");
    await dbRemoveFriend(friendId);
  }
  setState(s => ({ ...s, friends: s.friends.filter(f => f.id !== friendId) }));
}

export async function searchUsers(query) {
  const q = String(query || "").trim().toLowerCase();
  if (q.length < 2) return []; // avoid 1-char fishnet queries
  const me = currentUser();
  const client = await sb();
  // Supabase mode: use the SECURITY DEFINER RPC which returns ONLY safe
  // fields (id/username/display_name/school/avatar_color). Email is never
  // exposed through this path.
  if (client) {
    try {
      const { data, error } = await client.rpc("search_public_profiles", { p_query: q });
      if (error) throw error;
      return (data || [])
        .filter(r => r.id !== me?.id)
        .map(r => ({
          id: r.id,
          username: r.username,
          displayName: r.display_name,
          school: r.school,
          avatarColor: r.avatar_color,
        }));
    } catch (e) {
      console.warn("search_public_profiles RPC failed, falling back:", e?.message);
    }
  }
  // Local fallback: narrow fields, never emails.
  const all = await listAccountsPublic();
  return all
    .filter(a => a.id !== me?.id && (
      a.username?.toLowerCase().includes(q) ||
      a.displayName?.toLowerCase().includes(q)
    ))
    .map(({ email, ...safe }) => safe)  // strip email from returned shape
    .slice(0, 10);
}

function generateCode() {
  return cryptoCode();
}

function prettifyTransferError(e) {
  const msg = String(e?.message || e || "").toLowerCase();
  if (msg.includes("insufficient cash")) return "Not enough virtual cash for this transfer.";
  if (msg.includes("cannot send to self")) return "You can't send money to yourself.";
  if (msg.includes("recipient not found")) return "No StockSaathi user with that handle.";
  if (msg.includes("amount exceeds cap")) return "That amount is too large for a sim transfer.";
  if (msg.includes("rate")) return "Too many transfers in a row — wait a minute.";
  return e?.message || "Transfer failed. Please try again.";
}
