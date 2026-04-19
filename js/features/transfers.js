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

function readOtherUserState(userId) {
  try { const raw = localStorage.getItem(USERSTATE_PREFIX + userId); return raw ? JSON.parse(raw) : null; }
  catch { return null; }
}
function writeOtherUserState(userId, st) { localStorage.setItem(USERSTATE_PREFIX + userId, JSON.stringify(st)); }

// --------------------------------------------------------------------------
export async function sendTransfer({ recipientHandle, amountPaise, note = "" }) {
  const me = currentUser();
  if (!me) throw new Error("Log in to send money.");
  if (!Number.isFinite(amountPaise) || amountPaise <= 0) throw new Error("Enter a valid amount.");

  const client = await sb();
  if (client) {
    const res = await dbSendTransfer({ recipientHandle: recipientHandle.replace(/^@/, ""), amountPaise: Math.round(amountPaise), note });
    // Optimistic local update — subtract cash immediately
    setState(s => ({
      ...s,
      portfolio: { ...s.portfolio, cashPaise: s.portfolio.cashPaise - Math.round(amountPaise) },
      transfers: [
        {
          id: res.transfer_id || genId(),
          direction: "out",
          counterpartyHandle: recipientHandle,
          counterpartyName: recipientHandle,
          amountPaise: Math.round(amountPaise),
          ts: Date.now(),
          note,
          status: "completed",
        },
        ...s.transfers,
      ],
    }));
    return { ok: true, recipient: { username: recipientHandle }, amountPaise: Math.round(amountPaise) };
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

  const recState = readOtherUserState(recipient.id);
  if (recState) {
    recState.portfolio = {
      ...recState.portfolio,
      cashPaise: (recState.portfolio?.cashPaise || 0) + amount,
    };
    recState.transfers = [
      ...(recState.transfers || []),
      {
        id: transferId + "_in", direction: "in",
        counterpartyId: me.id, counterpartyHandle: me.username, counterpartyName: me.displayName,
        amountPaise: amount, ts, note, status: "completed",
      },
    ];
    writeOtherUserState(recipient.id, recState);
  } else {
    writeOtherUserState(recipient.id, {
      version: 3,
      portfolio: { cashPaise: 1_00_00_000 + amount, startingCashPaise: 1_00_00_000 },
      holdings: {}, transactions: [],
      transfers: [{
        id: transferId + "_in", direction: "in",
        counterpartyId: me.id, counterpartyHandle: me.username, counterpartyName: me.displayName,
        amountPaise: amount, ts, note, status: "completed",
      }],
      inbox: [], coachMessages: [], watchlist: [], friends: [], badges: [],
      profile: { onboarded: false }, demo: { crashReplayCompleted: [], firstTradeDone: false },
    });
  }

  return {
    ok: true,
    recipient: { id: recipient.id, displayName: recipient.displayName, username: recipient.username },
    amountPaise: amount,
  };
}

// --------------------------------------------------------------------------
export async function createTransferCode({ amountPaise, note = "" }) {
  // Transfer codes are kept as a local-mode feature (simpler UX for demo).
  const me = currentUser();
  if (!me) throw new Error("Log in to create a transfer.");
  if (!Number.isFinite(amountPaise) || amountPaise <= 0) throw new Error("Enter a valid amount.");
  const state = getState();
  if (amountPaise > state.portfolio.cashPaise) {
    throw new Error(`Not enough cash. You have ₹${(state.portfolio.cashPaise / 100).toLocaleString("en-IN")}.`);
  }
  const code = generateCode();
  const amount = Math.round(amountPaise);
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
  // Local-only for now — codes are in local state.
  const me = currentUser();
  if (!me) throw new Error("Log in to redeem.");
  const cleanCode = String(code || "").trim().toUpperCase();
  let found = null;
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k?.startsWith(USERSTATE_PREFIX)) continue;
    const userId = k.slice(USERSTATE_PREFIX.length);
    if (userId === me.id) continue;
    const st = readOtherUserState(userId);
    if (!st?.transfers) continue;
    const match = st.transfers.find(t => t.code === cleanCode && t.status === "pending");
    if (match) { found = { userId, state: st, transfer: match }; break; }
  }
  if (!found) throw new Error("Code not found or already redeemed.");
  const { userId: senderId, state: senderState, transfer } = found;
  senderState.transfers = senderState.transfers.map(t =>
    t.id === transfer.id ? { ...t, status: "completed", counterpartyId: me.id, counterpartyHandle: me.username, counterpartyName: me.displayName } : t
  );
  writeOtherUserState(senderId, senderState);
  setState(s => ({
    ...s,
    portfolio: { ...s.portfolio, cashPaise: s.portfolio.cashPaise + transfer.amountPaise },
    transfers: [...s.transfers, {
      id: genId(), direction: "in", code: cleanCode,
      counterpartyId: senderId, counterpartyHandle: null, counterpartyName: "Code redeemed",
      amountPaise: transfer.amountPaise, ts: Date.now(), note: transfer.note, status: "completed",
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
  if (!q) return [];
  const me = currentUser();
  const all = await listAccountsPublic();
  return all
    .filter(a => a.id !== me?.id && (
      a.username.toLowerCase().includes(q) ||
      a.displayName.toLowerCase().includes(q) ||
      a.email.toLowerCase().includes(q)
    ))
    .slice(0, 10);
}

function generateCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s.slice(0, 4) + "-" + s.slice(4);
}
