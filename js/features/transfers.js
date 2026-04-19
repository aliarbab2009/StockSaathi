// =============================================================================
// TRANSFERS — Peer-to-peer virtual cash between StockSaathi accounts.
//
// Since there's no central server, transfers work by directly writing to the
// recipient's localStorage state — all accounts are local on the same device.
// This gives the full functional UX (send by username, receive instantly,
// inbox, history) in a single-device demo. In a real deployment with multi-
// device, the same API surface would be backed by a server.
//
// Money is PAISE (integer).
// =============================================================================

import { currentUser, findAccountByHandle, listAccountsPublic } from "../auth/accounts.js";
import { getState, setState, genId } from "../state.js";

const USERSTATE_PREFIX = "ss.userstate.";

function readOtherUserState(userId) {
  try {
    const raw = localStorage.getItem(USERSTATE_PREFIX + userId);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function writeOtherUserState(userId, st) {
  localStorage.setItem(USERSTATE_PREFIX + userId, JSON.stringify(st));
}

// --------------------------------------------------------------------------
// Send money to another StockSaathi user
// --------------------------------------------------------------------------

export function sendTransfer({ recipientHandle, amountPaise, note = "" }) {
  const me = currentUser();
  if (!me) throw new Error("Log in to send money.");
  if (!Number.isFinite(amountPaise) || amountPaise <= 0) throw new Error("Enter a valid amount.");

  const state = getState();
  if (amountPaise > state.portfolio.cashPaise) {
    throw new Error(`Not enough cash. You have ₹${(state.portfolio.cashPaise / 100).toLocaleString("en-IN")}.`);
  }

  const recipient = findAccountByHandle(recipientHandle);
  if (!recipient) throw new Error(`No StockSaathi user found with handle "${recipientHandle}".`);
  if (recipient.id === me.id) throw new Error("You can't send money to yourself.");

  const transferId = genId();
  const ts = Date.now();
  const amount = Math.round(amountPaise);

  // 1. Debit sender
  setState(s => ({
    ...s,
    portfolio: { ...s.portfolio, cashPaise: s.portfolio.cashPaise - amount },
    transfers: [...s.transfers, {
      id: transferId, direction: "out", counterpartyId: recipient.id,
      counterpartyHandle: recipient.username, counterpartyName: recipient.displayName,
      amountPaise: amount, ts, note, status: "completed",
    }],
  }));

  // 2. Credit recipient (direct write to their state)
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
    // Recipient has no state yet — pre-create a minimal state for them.
    writeOtherUserState(recipient.id, {
      version: 2,
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

/**
 * Generate a shareable transfer code (for when the recipient isn't on this
 * device). Reserves the funds as "pending" in the sender's account.
 * The recipient redeems via `redeemTransferCode()` on their device.
 */
export function createTransferCode({ amountPaise, note = "" }) {
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

/**
 * Redeem a transfer code into the current user's cash balance.
 * For this single-device demo, the code matches any pending transfer in ANY
 * user's state (signed in or not). In production this would hit a server.
 */
export function redeemTransferCode(code) {
  const me = currentUser();
  if (!me) throw new Error("Log in to redeem.");
  if (!code || typeof code !== "string") throw new Error("Invalid code.");

  const cleanCode = code.trim().toUpperCase();

  // Scan all other accounts for a matching pending transfer
  let found = null;
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k?.startsWith(USERSTATE_PREFIX)) continue;
    const userId = k.slice(USERSTATE_PREFIX.length);
    if (userId === me.id) continue;
    const st = readOtherUserState(userId);
    if (!st?.transfers) continue;
    const match = st.transfers.find(t => t.code === cleanCode && t.status === "pending");
    if (match) {
      found = { userId, state: st, transfer: match };
      break;
    }
  }

  if (!found) throw new Error("Code not found or already redeemed.");

  const { userId: senderId, state: senderState, transfer } = found;

  // Mark sender's transfer as completed
  senderState.transfers = senderState.transfers.map(t =>
    t.id === transfer.id ? { ...t, status: "completed", counterpartyId: me.id, counterpartyHandle: me.username, counterpartyName: me.displayName } : t
  );
  writeOtherUserState(senderId, senderState);

  // Credit recipient (me)
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
// Friends
// --------------------------------------------------------------------------

export function addFriend(handle) {
  const me = currentUser();
  if (!me) throw new Error("Log in first.");
  const acc = findAccountByHandle(handle);
  if (!acc) throw new Error(`No StockSaathi user found with handle "${handle}".`);
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

export function removeFriend(friendId) {
  setState(s => ({ ...s, friends: s.friends.filter(f => f.id !== friendId) }));
}

export function searchUsers(query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return [];
  const me = currentUser();
  return listAccountsPublic()
    .filter(a =>
      a.id !== me?.id && (
        a.username.toLowerCase().includes(q) ||
        a.displayName.toLowerCase().includes(q) ||
        a.email.toLowerCase().includes(q)
      )
    )
    .slice(0, 10);
}

// --------------------------------------------------------------------------
// Utils
// --------------------------------------------------------------------------

function generateCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 8; i++) {
    s += chars[Math.floor(Math.random() * chars.length)];
  }
  return s.slice(0, 4) + "-" + s.slice(4);
}
