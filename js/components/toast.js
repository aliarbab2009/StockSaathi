// =============================================================================
// TOAST — Tiny ephemeral notifications. Stacks in bottom-center.
// Usage: toast({ kind: "success", message: "Bought 2 RELIANCE" })
// =============================================================================

let root;
function ensureRoot() {
  if (!root) root = document.getElementById("toast-root") || document.body;
  return root;
}

const ICONS = {
  success: "✓",
  error: "✕",
  warn: "⚠",
  info: "ⓘ",
};

export function toast({ kind = "info", message, duration = 3500 }) {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.innerHTML = `
    <span class="toast-icon">${ICONS[kind] || ICONS.info}</span>
    <span>${escapeHtml(message)}</span>
  `;
  ensureRoot().appendChild(el);
  setTimeout(() => {
    el.classList.add("leaving");
    setTimeout(() => el.remove(), 280);
  }, duration);
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = String(s ?? "");
  return d.innerHTML;
}
