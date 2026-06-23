"use client";
import { useState, useEffect } from "react";
import type { OpenPosition } from "@/lib/queries";

interface Props {
  position: OpenPosition;
  onClose: () => void;
}

type Step = "risk" | "confirming" | "done" | "error";

const GAS_ESTIMATE_USD = 0.15;

function formatHolding(openedAtSec: number): string {
  if (!openedAtSec) return "—";
  const diffSec = Date.now() / 1000 - openedAtSec;
  if (diffSec < 3600) return `${Math.round(diffSec / 60)} min`;
  if (diffSec < 86400) return `${(diffSec / 3600).toFixed(1)} h`;
  return `${(diffSec / 86400).toFixed(1)} j`;
}

export default function CloseModal({ position, onClose }: Props) {
  const [step, setStep] = useState<Step>("risk");
  const [resultNote, setResultNote] = useState("");

  const unrealizedPnl = position.valueUsd - position.sizeUsd;
  const totalGain = unrealizedPnl + position.accruedFees;
  const netAfterGas = totalGain - GAS_ESTIMATE_USD;
  const ilPct = position.sizeUsd > 0 ? (unrealizedPnl / position.sizeUsd) * 100 : 0;
  const isInRange = position.outOfRangeSinceSec === null;
  const holdingLabel = formatHolding(position.openedAtSec);
  const holdingHours = position.openedAtSec
    ? (Date.now() / 1000 - position.openedAtSec) / 3600
    : null;

  const risks: { level: "warn" | "danger"; msg: string }[] = [];
  if (isInRange)
    risks.push({ level: "warn", msg: "Position actuellement en range — vous abandonnez des fees futures" });
  if (ilPct < -5)
    risks.push({ level: "danger", msg: `IL significatif : ${ilPct.toFixed(1)}% — prix éloigné du centre de range` });
  if (holdingHours !== null && holdingHours < 24)
    risks.push({ level: "warn", msg: `Position récente (${holdingLabel}) — les fees n'ont peut-être pas compensé l'IL` });
  if (netAfterGas < 0)
    risks.push({ level: "danger", msg: `Gain net négatif après gas : ${netAfterGas.toFixed(2)} USD` });

  const riskLevel = risks.some((r) => r.level === "danger")
    ? "danger"
    : risks.length > 0
      ? "warn"
      : "ok";

  const handleConfirm = async () => {
    setStep("confirming");
    try {
      const res = await fetch("/api/positions/close", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          poolAddress: position.poolAddress,
          positionPubkey: position.positionPubkey,
          poolName: position.poolName,
        }),
      });
      const data = (await res.json()) as { requestId?: number; error?: string };
      if (!data.requestId) throw new Error(data.error ?? "Erreur serveur");
      pollStatus(data.requestId);
    } catch (err) {
      setResultNote(err instanceof Error ? err.message : "Erreur inconnue");
      setStep("error");
    }
  };

  const pollStatus = (id: number) => {
    let attempts = 0;
    const MAX = 90; // 90 × 3s = 4,5 min timeout
    const interval = setInterval(async () => {
      attempts++;
      try {
        const res = await fetch(`/api/positions/close?id=${id}`);
        const data = (await res.json()) as { status: string; resultNote: string | null };
        if (data.status === "DONE") {
          clearInterval(interval);
          setResultNote(data.resultNote ?? "Clôture effectuée avec succès");
          setStep("done");
        } else if (data.status === "ERROR") {
          clearInterval(interval);
          setResultNote(data.resultNote ?? "Erreur lors de la clôture");
          setStep("error");
        }
      } catch { /* ignore réseau transitoire */ }
      if (attempts >= MAX) {
        clearInterval(interval);
        setResultNote("Timeout — le daemon n'a pas répondu en 5 min. Vérifiez les logs.");
        setStep("error");
      }
    }, 3_000);
  };

  // Fermer avec Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-header">
          <h3>Clôturer <span className="accent">{position.poolName}</span></h3>
          <button className="modal-x" onClick={onClose}>✕</button>
        </div>

        {step === "risk" && (
          <>
            <div className="risk-table">
              <div className="risk-row">
                <span>Investissement initial</span>
                <span className="num">${position.sizeUsd.toFixed(2)}</span>
              </div>
              <div className="risk-row">
                <span>Valeur actuelle</span>
                <span className={`num ${unrealizedPnl >= 0 ? "pos" : "neg"}`}>
                  ${position.valueUsd.toFixed(2)}
                </span>
              </div>
              <div className="risk-row indent">
                <span>dont PnL non réalisé</span>
                <span className={`num ${unrealizedPnl >= 0 ? "pos" : "neg"}`}>
                  {unrealizedPnl >= 0 ? "+" : ""}{unrealizedPnl.toFixed(2)} $
                </span>
              </div>
              <div className="risk-row">
                <span>Fees accumulées</span>
                <span className="num accent">+{position.accruedFees.toFixed(2)} $</span>
              </div>
              <div className="risk-row">
                <span>Gas estimé (clôture)</span>
                <span className="num muted">≈ −{GAS_ESTIMATE_USD.toFixed(2)} $</span>
              </div>
              <div className="risk-row risk-total">
                <span>Gain net estimé</span>
                <span className={`num ${netAfterGas >= 0 ? "pos" : "neg"}`}>
                  {netAfterGas >= 0 ? "+" : ""}{netAfterGas.toFixed(2)} $
                </span>
              </div>
              <div className="risk-row muted tiny" style={{ paddingTop: 4 }}>
                <span>Durée de détention</span>
                <span>{holdingLabel}</span>
              </div>
            </div>

            {risks.length > 0 && (
              <div className={`risk-alerts risk-${riskLevel}`}>
                <div className="risk-alert-title">
                  {riskLevel === "danger" ? "⛔ Risques importants" : "⚠ Points d'attention"}
                </div>
                <ul>
                  {risks.map((r, i) => (
                    <li key={i} className={r.level === "danger" ? "neg" : "accent"}>
                      {r.msg}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="modal-actions">
              <button className="btn" onClick={onClose}>Annuler</button>
              <button
                className={`btn btn-close-confirm ${riskLevel}`}
                onClick={handleConfirm}
              >
                {riskLevel === "danger" ? "⛔ Confirmer quand même" : "Confirmer la clôture"}
              </button>
            </div>
          </>
        )}

        {step === "confirming" && (
          <div className="modal-status">
            <div className="spinner" />
            <p>Demande envoyée au daemon...</p>
            <p className="muted tiny">La clôture sera traitée dans les 2 prochaines minutes.</p>
          </div>
        )}

        {step === "done" && (
          <div className="modal-status">
            <div className="status-icon pos">✓</div>
            <p className="pos">{resultNote}</p>
            <button className="btn" style={{ marginTop: 16 }} onClick={onClose}>Fermer</button>
          </div>
        )}

        {step === "error" && (
          <div className="modal-status">
            <div className="status-icon neg">✕</div>
            <p className="neg" style={{ fontSize: 12, maxWidth: 320, textAlign: "center" }}>{resultNote}</p>
            <button className="btn" style={{ marginTop: 16 }} onClick={onClose}>Fermer</button>
          </div>
        )}
      </div>
    </div>
  );
}
