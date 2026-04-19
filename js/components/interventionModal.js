// =============================================================================
// INTERVENTION MODAL — Appears before a panic-sell. Shows historical analog.
// Two choices: "Sell anyway" (proceeds) or "Hold and breathe" (cancels).
// =============================================================================

import { formatAnalog } from "../coach/historicalAnalog.js";

export function showInterventionModal({ analog, biasResult, instrument, trade }, { onProceed, onHold }) {
  const modalRoot = document.getElementById("modal-root");
  if (!modalRoot) return;

  const sev = biasResult?.severity ?? 0;
  const dropPct = analog?.drawdownPct ?? Math.abs(biasResult?.evidence?.drop_3d_pct ?? 0);
  const context = analog ? formatAnalog(analog) : "";
  const recoveryDays = analog?.recoveryDays;

  modalRoot.innerHTML = `
    <div class="modal-overlay" id="intervention-overlay" role="dialog" aria-modal="true" aria-labelledby="intervention-title">
      <div class="modal">
        <div class="modal-head">
          <div class="modal-icon ${sev >= 0.7 ? "danger" : "warn"}">${sev >= 0.7 ? "🛑" : "⚠"}</div>
          <div>
            <div style="font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--yellow);">Pattern detected · Panic-sell signal</div>
            <h2 id="intervention-title">Before you sell, a moment of data.</h2>
          </div>
        </div>
        <div class="modal-body">
          <p>
            You are about to sell <strong>${escapeHtml(instrument.name)}</strong> after
            a <strong>${dropPct.toFixed(1)}%</strong> drop in recent sessions, within
            <strong>${daysSince(trade.holding?.firstBoughtAt)}</strong> of buying it.
          </p>
          ${recoveryDays ? `
            <div class="intervention-data">
              <div class="dim" style="font-size: 12px; letter-spacing: 0.04em; text-transform: uppercase;">Historical analog</div>
              <div class="big-num tabular">${recoveryDays}</div>
              <div class="sublabel">
                Median trading days to recovery in the <strong>last ${analog.sampleSize} dips of ≥${analog.bucket}%</strong>
                on ${analog.source === "nifty" ? "the Nifty 50 index" : instrument.name}.
                Worst observed: ${analog.maxRecoveryDays} days.
              </div>
            </div>
          ` : ""}
          <p class="dim" style="font-size: 13px; line-height: 1.6;">
            This is not advice. This is pattern-matched history.
            If your thesis for owning ${instrument.symbol} hasn't changed, the drop itself isn't the signal to sell.
            If your thesis has changed — that's a different conversation.
          </p>
        </div>
        <div class="modal-foot">
          <button class="btn btn-outline" id="intervention-proceed">Sell anyway</button>
          <button class="btn btn-primary" id="intervention-hold">Hold and breathe</button>
        </div>
      </div>
    </div>
  `;

  const overlay = modalRoot.querySelector("#intervention-overlay");
  const close = () => { modalRoot.innerHTML = ""; };

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) { close(); onHold?.(); }
  });
  document.addEventListener("keydown", onKey);
  function onKey(e) {
    if (e.key === "Escape") { close(); onHold?.(); document.removeEventListener("keydown", onKey); }
  }

  modalRoot.querySelector("#intervention-proceed").addEventListener("click", () => {
    close();
    document.removeEventListener("keydown", onKey);
    onProceed?.();
  });
  modalRoot.querySelector("#intervention-hold").addEventListener("click", () => {
    close();
    document.removeEventListener("keydown", onKey);
    onHold?.();
  });

  // Focus the recommended button
  setTimeout(() => modalRoot.querySelector("#intervention-hold")?.focus(), 50);
}

function daysSince(ts) {
  if (!ts) return "a short time";
  const d = Math.max(1, Math.floor((Date.now() - ts) / 86400000));
  return `${d} day${d === 1 ? "" : "s"}`;
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = String(s ?? "");
  return d.innerHTML;
}
