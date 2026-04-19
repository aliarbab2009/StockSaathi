// =============================================================================
// ACCOUNTS — Multi-user registration + session management in localStorage.
// Passwords hashed via PBKDF2 (WebCrypto). Never stored in plaintext.
// =============================================================================

const ACCOUNTS_KEY = "ss.accounts.v1";
const SESSION_KEY = "ss.session.v1";

const PBKDF2_ITER = 100_000;
const SALT_BYTES = 16;

// --------------------------------------------------------------------------
// Low-level storage
// --------------------------------------------------------------------------

function readAccounts() {
  try {
    const raw = localStorage.getItem(ACCOUNTS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function writeAccounts(list) {
  localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(list));
}

function readSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function writeSession(sess) {
  if (sess) localStorage.setItem(SESSION_KEY, JSON.stringify(sess));
  else localStorage.removeItem(SESSION_KEY);
}

// --------------------------------------------------------------------------
// Password hashing
// --------------------------------------------------------------------------

function bytesToHex(buf) {
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex) {
  const a = new Uint8Array(hex.length / 2);
  for (let i = 0; i < a.length; i++) a[i] = parseInt(hex.substr(i * 2, 2), 16);
  return a;
}

async function hashPassword(password, saltHex = null) {
  const salt = saltHex ? hexToBytes(saltHex) : crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const enc = new TextEncoder();
  const keyMat = await crypto.subtle.importKey(
    "raw", enc.encode(password), { name: "PBKDF2" }, false, ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITER, hash: "SHA-256" },
    keyMat, 256
  );
  return { hash: bytesToHex(bits), salt: saltHex || bytesToHex(salt) };
}

async function verifyPassword(password, expectedHex, saltHex) {
  const { hash } = await hashPassword(password, saltHex);
  return hash === expectedHex;
}

// --------------------------------------------------------------------------
// Validation helpers
// --------------------------------------------------------------------------

export function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
}

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

// --------------------------------------------------------------------------
// Public API
// --------------------------------------------------------------------------

/**
 * Register a new account. Idempotent by email (case-insensitive).
 */
export async function registerAccount({ username, email, password, displayName }) {
  const accs = readAccounts();
  const emailL = email.trim().toLowerCase();
  const handleL = username.trim().toLowerCase();

  if (accs.some(a => a.email.toLowerCase() === emailL)) {
    throw new Error("An account with this email already exists. Try logging in.");
  }
  if (accs.some(a => a.username.toLowerCase() === handleL)) {
    throw new Error("This username is taken. Try another.");
  }

  const { hash, salt } = await hashPassword(password);
  const account = {
    id: `u_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    username: username.trim(),
    email: email.trim(),
    displayName: displayName || username.trim(),
    passwordHash: hash,
    passwordSalt: salt,
    createdAt: Date.now(),
    avatarColor: pickAvatarColor(username),
  };
  accs.push(account);
  writeAccounts(accs);
  startSession(account);
  return account;
}

/**
 * Log in with email + password.
 */
export async function loginAccount({ emailOrUsername, password }) {
  const accs = readAccounts();
  const q = emailOrUsername.trim().toLowerCase();
  const acc = accs.find(a =>
    a.email.toLowerCase() === q || a.username.toLowerCase() === q
  );
  if (!acc) throw new Error("No account with that email or username.");
  const ok = await verifyPassword(password, acc.passwordHash, acc.passwordSalt);
  if (!ok) throw new Error("Incorrect password.");
  startSession(acc);
  return acc;
}

/**
 * Log out current user (clears session only; account remains).
 */
export function logoutAccount() {
  writeSession(null);
}

/**
 * Return the currently logged-in account record (without password).
 */
export function currentUser() {
  const sess = readSession();
  if (!sess) return null;
  const accs = readAccounts();
  const acc = accs.find(a => a.id === sess.userId);
  if (!acc) {
    writeSession(null);
    return null;
  }
  const { passwordHash, passwordSalt, ...safe } = acc;
  return safe;
}

/**
 * Update profile fields (not password).
 */
export function updateProfile(patch) {
  const sess = readSession();
  if (!sess) throw new Error("Not logged in.");
  const accs = readAccounts();
  const idx = accs.findIndex(a => a.id === sess.userId);
  if (idx === -1) throw new Error("Account not found.");
  const allowed = ["displayName", "school", "city", "age", "classCode", "parentEmail", "parentConsentAt"];
  const clean = {};
  for (const k of allowed) if (k in patch) clean[k] = patch[k];
  accs[idx] = { ...accs[idx], ...clean, updatedAt: Date.now() };
  writeAccounts(accs);
  const { passwordHash, passwordSalt, ...safe } = accs[idx];
  return safe;
}

/**
 * Return all registered accounts (public fields only — for friend-lookup).
 */
export function listAccountsPublic() {
  return readAccounts().map(a => ({
    id: a.id,
    username: a.username,
    displayName: a.displayName,
    email: a.email,
    avatarColor: a.avatarColor,
    school: a.school,
  }));
}

export function findAccountByHandle(handleOrEmail) {
  const q = handleOrEmail.trim().toLowerCase();
  return readAccounts().find(a =>
    a.username.toLowerCase() === q || a.email.toLowerCase() === q
  );
}

function startSession(acc) {
  writeSession({ userId: acc.id, startedAt: Date.now() });
}

function pickAvatarColor(username) {
  const palette = ["green", "saffron", "purple", "blue"];
  let sum = 0;
  for (let i = 0; i < username.length; i++) sum += username.charCodeAt(i);
  return palette[sum % palette.length];
}

/**
 * Password change flow.
 */
export async function changePassword({ currentPassword, newPassword }) {
  const sess = readSession();
  if (!sess) throw new Error("Not logged in.");
  const accs = readAccounts();
  const idx = accs.findIndex(a => a.id === sess.userId);
  if (idx === -1) throw new Error("Account not found.");
  const ok = await verifyPassword(currentPassword, accs[idx].passwordHash, accs[idx].passwordSalt);
  if (!ok) throw new Error("Current password is incorrect.");
  const { hash, salt } = await hashPassword(newPassword);
  accs[idx].passwordHash = hash;
  accs[idx].passwordSalt = salt;
  writeAccounts(accs);
  return true;
}

/**
 * Danger: delete the current account entirely.
 */
export function deleteCurrentAccount() {
  const sess = readSession();
  if (!sess) return;
  let accs = readAccounts();
  accs = accs.filter(a => a.id !== sess.userId);
  writeAccounts(accs);
  writeSession(null);
}
