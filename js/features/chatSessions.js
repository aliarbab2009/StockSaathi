// =============================================================================
// CHAT SESSIONS — Multiple named conversations for the Coach Chat page.
//
// Persistence: single localStorage key "ss.chat.sessions.v1" with shape:
//   { activeId: "<id>", sessions: [{ id, title, messages: [...], createdAt, updatedAt }, ...] }
//
// Migration: on first load of v1, if the legacy single-log key
// "ss.chatlog.v1" exists, its entire history becomes one session so the
// user's previous conversation is preserved — never wiped by the upgrade.
//
// Titles: derived from the first user message (up to 42 chars) the first
// time a message gets sent. Stays "New chat" for empty sessions. Title
// is regenerated from the latest first-user-message after the first one,
// so it stays meaningful even if the user deletes the original prompt.
// =============================================================================

export const SESSIONS_KEY = "ss.chat.sessions.v1";
const LEGACY_LOG_KEY = "ss.chatlog.v1";

function genId() {
  return "c_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function createBlank() {
  const now = Date.now();
  return {
    id: genId(),
    title: "New chat",
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
}

function deriveTitle(messages) {
  if (!Array.isArray(messages)) return "New chat";
  const firstUser = messages.find(m => m && m.role === "user" && typeof m.text === "string" && m.text.trim());
  if (!firstUser) return "New chat";
  const clean = String(firstUser.text).replace(/\s+/g, " ").trim();
  return clean.slice(0, 42) || "New chat";
}

// Load sessions, migrating from legacy single-log if needed. ALWAYS returns
// a valid structure with at least one session.
export function loadSessions() {
  // Path 1: already on v1 — just load.
  try {
    const raw = localStorage.getItem(SESSIONS_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      if (data && Array.isArray(data.sessions) && data.sessions.length) {
        // Repair: ensure every session has required fields + activeId exists
        data.sessions = data.sessions.filter(s => s && s.id && Array.isArray(s.messages));
        if (!data.sessions.length) data.sessions = [createBlank()];
        if (!data.sessions.find(s => s.id === data.activeId)) {
          data.activeId = data.sessions[0].id;
        }
        return data;
      }
    }
  } catch {}

  // Path 2: legacy migration — pull the old single log into session #1.
  let migratedMessages = null;
  try {
    const legacy = localStorage.getItem(LEGACY_LOG_KEY);
    if (legacy) {
      const arr = JSON.parse(legacy);
      if (Array.isArray(arr) && arr.length) migratedMessages = arr;
    }
  } catch {}

  const firstSession = migratedMessages
    ? {
        id: genId(),
        title: deriveTitle(migratedMessages),
        messages: migratedMessages,
        createdAt: migratedMessages[0]?.ts || Date.now(),
        updatedAt: migratedMessages[migratedMessages.length - 1]?.ts || Date.now(),
      }
    : createBlank();

  const data = { activeId: firstSession.id, sessions: [firstSession] };
  saveSessions(data);
  return data;
}

export function saveSessions(data) {
  try { localStorage.setItem(SESSIONS_KEY, JSON.stringify(data)); } catch {}
  // Push to Supabase too so the user's chats follow them across devices /
  // browsers / incognito windows. Dynamically imported + debounced in
  // sync.js so we don't hammer the DB on every keystroke that re-saves.
  // Fire-and-forget — no-op if the user isn't signed in to Supabase.
  try {
    import("../db/sync.js").then(m => m.dbSaveCoachChatsSoon?.()).catch(() => {});
  } catch {}
}

export function getActiveSession(data) {
  return data.sessions.find(s => s.id === data.activeId) || data.sessions[0];
}

export function setActiveSession(data, id) {
  const match = data.sessions.find(s => s.id === id);
  if (!match) return false;
  data.activeId = id;
  saveSessions(data);
  return true;
}

// Create a fresh session and make it active. Returns the new session.
export function createNewSession(data) {
  const s = createBlank();
  data.sessions.unshift(s);
  data.activeId = s.id;
  saveSessions(data);
  return s;
}

// Delete a session by id. If it was active, pick the next one. If it was
// the last one, a fresh empty session replaces it so the UI always has
// something to render.
export function deleteSessionById(data, id) {
  const idx = data.sessions.findIndex(s => s.id === id);
  if (idx === -1) return;
  const wasActive = data.activeId === id;
  data.sessions.splice(idx, 1);
  if (!data.sessions.length) {
    const blank = createBlank();
    data.sessions = [blank];
    data.activeId = blank.id;
  } else if (wasActive) {
    data.activeId = data.sessions[0].id;
  }
  saveSessions(data);
}

// Call this after every append to the active session's messages. It updates
// the updatedAt timestamp and regenerates the title if it's still "New chat".
export function touchActive(data) {
  const s = getActiveSession(data);
  if (!s) return;
  s.updatedAt = Date.now();
  if (!s.title || s.title === "New chat") {
    s.title = deriveTitle(s.messages);
  }
  saveSessions(data);
}

// Force-rename the active session (e.g. if we want to regenerate title
// after significant edits). Currently unused but exported for future UI.
export function renameActive(data, title) {
  const s = getActiveSession(data);
  if (!s) return;
  s.title = String(title || "").slice(0, 80) || "New chat";
  saveSessions(data);
}

// Clear all messages in the active session (keeps the session, wipes history).
export function clearActiveMessages(data) {
  const s = getActiveSession(data);
  if (!s) return;
  s.messages = [];
  s.title = "New chat";
  s.updatedAt = Date.now();
  saveSessions(data);
}

// Pretty relative timestamp for the session picker list.
export function formatRelative(ts) {
  if (!ts) return "";
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3600_000) return Math.floor(diff / 60_000) + "m ago";
  if (diff < 86400_000) return Math.floor(diff / 3600_000) + "h ago";
  if (diff < 7 * 86400_000) return Math.floor(diff / 86400_000) + "d ago";
  return new Date(ts).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}
