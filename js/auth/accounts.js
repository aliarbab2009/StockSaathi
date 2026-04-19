// =============================================================================
// ACCOUNTS — dual-mode.
//   If Supabase is configured → real auth (email/password, cross-device).
//   Else → localStorage fallback (PBKDF2 hashed, single-device).
// Same public API so pages don't need to know which mode they're in.
// =============================================================================

import { sb, isSupabaseEnabled } from "../db/supabase.js";

// ---------- localStorage fallback (unchanged legacy path) -----------------
const ACCOUNTS_KEY = "ss.accounts.v1";
const SESSION_KEY = "ss.session.v1";
const PBKDF2_ITER = 100_000;
const SALT_BYTES = 16;

function readLocalAccounts() {
  try { const raw = localStorage.getItem(ACCOUNTS_KEY); return raw ? JSON.parse(raw) : []; }
  catch { return []; }
}
function writeLocalAccounts(list) { localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(list)); }
function readSession() {
  try { const raw = localStorage.getItem(SESSION_KEY); return raw ? JSON.parse(raw) : null; }
  catch { return null; }
}
function writeSession(s) {
  if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  else localStorage.removeItem(SESSION_KEY);
}

function bytesToHex(buf) { return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,"0")).join(""); }
function hexToBytes(hex) { const a = new Uint8Array(hex.length/2); for (let i=0;i<a.length;i++) a[i]=parseInt(hex.substr(i*2,2),16); return a; }
async function hashPassword(password, saltHex = null) {
  const salt = saltHex ? hexToBytes(saltHex) : crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const keyMat = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), { name: "PBKDF2" }, false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: PBKDF2_ITER, hash: "SHA-256" }, keyMat, 256);
  return { hash: bytesToHex(bits), salt: saltHex || bytesToHex(salt) };
}
async function verifyPassword(password, expectedHex, saltHex) {
  const { hash } = await hashPassword(password, saltHex);
  return hash === expectedHex;
}

// ---------- Validation (shared) ------------------------------------------
export function validateEmail(email) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim()); }
export function validatePassword(pw) {
  if (!pw || pw.length < 8) return "Password must be at least 8 characters.";
  if (!/[A-Za-z]/.test(pw)) return "Password must contain a letter.";
  if (!/[0-9]/.test(pw)) return "Password must contain a number.";
  return null;
}
export function validateUsername(u) {
  const s = String(u || "").trim();
  if (s.length < 3) return "Username must be at least 3 characters.";
  if (s.length > 24) return "Username must be at most 24 characters.";
  if (!/^[a-z0-9_.]+$/i.test(s)) return "Only letters, numbers, _ and . allowed.";
  return null;
}

function pickAvatarColor(username) {
  const palette = ["green", "saffron", "purple", "blue"];
  let sum = 0;
  for (let i = 0; i < username.length; i++) sum += username.charCodeAt(i);
  return palette[sum % palette.length];
}

// =========================================================================
// Public API — detects mode at call time
// =========================================================================

export async function registerAccount({ username, email, password, displayName }) {
  const client = await sb();
  if (client) {
    // Supabase Auth
    const avatar_color = pickAvatarColor(username);
    const { data, error } = await client.auth.signUp({
      email,
      password,
      options: {
        data: { username: username.trim(), display_name: displayName, avatar_color },
      },
    });
    if (error) throw new Error(prettifySbError(error.message));
    // If Supabase email-confirmation is ON, data.session is null — user is
    // created but not logged in. The caller branches on needsConfirmation.
    const hasSession = !!data.session;
    return {
      id: data.user?.id,
      username, email, displayName,
      hasSession,
      needsConfirmation: !hasSession,
    };
  }

  // Fallback: local mode
  const accs = readLocalAccounts();
  const emailL = email.trim().toLowerCase();
  const handleL = username.trim().toLowerCase();
  if (accs.some(a => a.email.toLowerCase() === emailL)) throw new Error("An account with this email already exists. Try logging in.");
  if (accs.some(a => a.username.toLowerCase() === handleL)) throw new Error("This username is taken. Try another.");
  const { hash, salt } = await hashPassword(password);
  const account = {
    id: `u_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    username: username.trim(), email: email.trim(), displayName: displayName || username.trim(),
    passwordHash: hash, passwordSalt: salt, createdAt: Date.now(),
    avatarColor: pickAvatarColor(username),
  };
  accs.push(account);
  writeLocalAccounts(accs);
  writeSession({ userId: account.id, startedAt: Date.now() });
  return account;
}

/**
 * Verify the 6-digit OTP code Supabase sends after signup. On success, the
 * user is signed in and we can proceed to onboarding. Throws on bad code.
 */
export async function verifySignupOtp({ email, code }) {
  const client = await sb();
  if (!client) throw new Error("Backend not configured.");
  const cleanCode = String(code).trim().replace(/\s+/g, "");
  if (!/^\d{4,10}$/.test(cleanCode)) throw new Error("Code must be a 4-10 digit number.");
  // Supabase accepts both 'signup' and 'email' OTP types; email is the newer one
  let { data, error } = await client.auth.verifyOtp({
    email, token: cleanCode, type: "signup",
  });
  if (error) {
    // Retry with the 'email' type (newer Supabase projects use this)
    const retry = await client.auth.verifyOtp({ email, token: cleanCode, type: "email" });
    if (retry.error) throw new Error(prettifySbError(error.message || retry.error.message));
    data = retry.data;
  }
  return { ok: true, user: data.user, session: data.session };
}

/**
 * Resend the signup OTP. Useful if the first email got lost.
 */
export async function resendSignupOtp(email) {
  const client = await sb();
  if (!client) throw new Error("Backend not configured.");
  const { error } = await client.auth.resend({ type: "signup", email });
  if (error) throw new Error(prettifySbError(error.message));
  return { ok: true };
}

export async function loginAccount({ emailOrUsername, password }) {
  const client = await sb();
  if (client) {
    // If the user provided a username, resolve email via profiles
    let email = emailOrUsername.trim();
    if (!email.includes("@")) {
      const { data } = await client.from("profiles").select("email").eq("username", email).maybeSingle();
      if (!data?.email) throw new Error("No account with that username.");
      email = data.email;
    }
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw new Error(prettifySbError(error.message));
    return { id: data.user?.id, email };
  }

  // Fallback: local
  const accs = readLocalAccounts();
  const q = emailOrUsername.trim().toLowerCase();
  const acc = accs.find(a => a.email.toLowerCase() === q || a.username.toLowerCase() === q);
  if (!acc) throw new Error("No account with that email or username.");
  const ok = await verifyPassword(password, acc.passwordHash, acc.passwordSalt);
  if (!ok) throw new Error("Incorrect password.");
  writeSession({ userId: acc.id, startedAt: Date.now() });
  return acc;
}

export async function logoutAccount() {
  const client = await sb();
  if (client) {
    await client.auth.signOut();
    return;
  }
  writeSession(null);
}

/**
 * SYNCHRONOUS check of the currently logged-in user.
 * Callers throughout the app use this — we cache the latest user in memory.
 */
let _cachedUser = null;
let _cachedAt = 0;

export function currentUser() {
  // In Supabase mode, we surface the cached profile (updated via refreshCurrentUser).
  // If no cache yet, return null (UI will handle).
  if (_cachedUser) return _cachedUser;
  // Local fallback
  const sess = readSession();
  if (!sess) return null;
  const accs = readLocalAccounts();
  const acc = accs.find(a => a.id === sess.userId);
  if (!acc) { writeSession(null); return null; }
  const { passwordHash, passwordSalt, ...safe } = acc;
  return safe;
}

/**
 * ASYNC — refreshes the current-user cache from Supabase (or local).
 * Call on boot + after any auth mutation.
 */
export async function refreshCurrentUser() {
  const client = await sb();
  if (client) {
    const { data: userData } = await client.auth.getUser();
    const u = userData?.user;
    if (!u) { _cachedUser = null; return null; }
    const { data: profile } = await client.from("profiles").select("*").eq("id", u.id).maybeSingle();
    if (!profile) {
      _cachedUser = {
        id: u.id, email: u.email, username: u.email?.split("@")[0] || "user",
        displayName: u.user_metadata?.display_name || "User",
        avatarColor: u.user_metadata?.avatar_color || "green",
      };
      return _cachedUser;
    }
    _cachedUser = {
      id: profile.id,
      username: profile.username,
      displayName: profile.display_name,
      email: profile.email,
      avatarColor: profile.avatar_color,
      school: profile.school,
      classCode: profile.class_code,
      age: profile.age,
      riskProfile: profile.risk_profile,
      onboarded: profile.onboarded,
      createdAt: profile.created_at,
      _supabase: true,
    };
    _cachedAt = Date.now();
    return _cachedUser;
  }

  // Local fallback
  const sess = readSession();
  if (!sess) { _cachedUser = null; return null; }
  const accs = readLocalAccounts();
  const acc = accs.find(a => a.id === sess.userId);
  if (!acc) { _cachedUser = null; writeSession(null); return null; }
  const { passwordHash, passwordSalt, ...safe } = acc;
  _cachedUser = safe;
  return safe;
}

export async function updateProfile(patch) {
  const client = await sb();
  if (client) {
    const user = await (await client.auth.getUser()).data?.user;
    if (!user) throw new Error("Not logged in.");
    const dbPatch = {};
    const map = {
      displayName: "display_name", school: "school", classCode: "class_code",
      city: "city", age: "age", riskProfile: "risk_profile",
      onboarded: "onboarded",
    };
    for (const [k, v] of Object.entries(patch || {})) {
      if (map[k]) dbPatch[map[k]] = v;
    }
    dbPatch.updated_at = new Date().toISOString();
    const { error } = await client.from("profiles").update(dbPatch).eq("id", user.id);
    if (error) throw new Error(error.message);
    await refreshCurrentUser();
    return _cachedUser;
  }
  // Local fallback — update accounts.js compatible
  const sess = readSession();
  if (!sess) throw new Error("Not logged in.");
  const accs = readLocalAccounts();
  const idx = accs.findIndex(a => a.id === sess.userId);
  if (idx === -1) throw new Error("Account not found.");
  accs[idx] = { ...accs[idx], ...patch, updatedAt: Date.now() };
  writeLocalAccounts(accs);
  const { passwordHash, passwordSalt, ...safe } = accs[idx];
  _cachedUser = safe;
  return safe;
}

export async function changePassword({ currentPassword, newPassword }) {
  const client = await sb();
  if (client) {
    // Supabase requires re-auth for security; use updateUser — signed-in user only
    const { error } = await client.auth.updateUser({ password: newPassword });
    if (error) throw new Error(error.message);
    return true;
  }
  // Local
  const sess = readSession();
  if (!sess) throw new Error("Not logged in.");
  const accs = readLocalAccounts();
  const idx = accs.findIndex(a => a.id === sess.userId);
  if (idx === -1) throw new Error("Account not found.");
  const ok = await verifyPassword(currentPassword, accs[idx].passwordHash, accs[idx].passwordSalt);
  if (!ok) throw new Error("Current password is incorrect.");
  const { hash, salt } = await hashPassword(newPassword);
  accs[idx].passwordHash = hash; accs[idx].passwordSalt = salt;
  writeLocalAccounts(accs);
  return true;
}

export async function deleteCurrentAccount() {
  const client = await sb();
  if (client) {
    // Supabase doesn't allow client-side delete of auth user; sign out + flag profile
    try {
      const user = await (await client.auth.getUser()).data?.user;
      if (user) await client.from("profiles").update({ onboarded: false }).eq("id", user.id);
    } catch {}
    await client.auth.signOut();
    _cachedUser = null;
    return;
  }
  const sess = readSession();
  if (!sess) return;
  let accs = readLocalAccounts();
  accs = accs.filter(a => a.id !== sess.userId);
  writeLocalAccounts(accs);
  writeSession(null);
  _cachedUser = null;
}

/**
 * List user handles for friend-search — works in BOTH modes.
 */
export async function listAccountsPublic() {
  const client = await sb();
  if (client) {
    const { data } = await client.from("profiles")
      .select("id, username, display_name, email, avatar_color, school")
      .limit(200);
    return (data || []).map(r => ({
      id: r.id, username: r.username, displayName: r.display_name,
      email: r.email, avatarColor: r.avatar_color, school: r.school,
    }));
  }
  return readLocalAccounts().map(a => ({
    id: a.id, username: a.username, displayName: a.displayName,
    email: a.email, avatarColor: a.avatarColor, school: a.school,
  }));
}

export async function findAccountByHandle(handleOrEmail) {
  const client = await sb();
  const q = handleOrEmail.trim().toLowerCase();
  if (client) {
    // Try both username and email
    const { data } = await client.from("profiles")
      .select("id, username, display_name, email, avatar_color, school")
      .or(`username.ilike.${q},email.ilike.${q}`)
      .limit(1)
      .maybeSingle();
    if (!data) return null;
    return {
      id: data.id, username: data.username, displayName: data.display_name,
      email: data.email, avatarColor: data.avatar_color, school: data.school,
    };
  }
  return readLocalAccounts().find(a =>
    a.username.toLowerCase() === q || a.email.toLowerCase() === q
  );
}

function prettifySbError(msg) {
  if (!msg) return "Something went wrong.";
  if (/already registered/i.test(msg) || /user already/i.test(msg)) return "An account with this email already exists. Try logging in.";
  if (/invalid login/i.test(msg)) return "Incorrect email or password.";
  if (/invalid email/i.test(msg)) return "That email doesn't look valid.";
  if (/password should be/i.test(msg)) return "Password must be at least 6 characters.";
  if (/rate limit/i.test(msg) || /too many requests/i.test(msg)) return "Too many signups from this address. Wait a few minutes and try again — or turn off email confirmation in Supabase (Authentication → Providers → Email).";
  if (/email.*disabled/i.test(msg)) return "Email signups are disabled in your Supabase project. Enable them in Authentication → Providers → Email.";
  return msg;
}

// Export the backward-compat synchronous signatures used by pages
export function listAccountsPublicSync() {
  if (_cachedUser?._supabase) return [];
  return readLocalAccounts().map(a => ({
    id: a.id, username: a.username, displayName: a.displayName,
    email: a.email, avatarColor: a.avatarColor, school: a.school,
  }));
}
