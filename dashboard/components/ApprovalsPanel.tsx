"use client";
import { useEffect, useState, useCallback } from "react";

interface Pending {
  id: number;
  poolName: string;
  sizeUsd: number;
  verdict: string;
  regime: string;
  expectedNetApr: number;
  volAnnual: number;
  hedged: boolean;
  rationale: string;
}

export default function ApprovalsPanel() {
  const [pending, setPending] = useState<Pending[]>([]);
  const [busy, setBusy] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/approvals", { cache: "no-store" });
      const json = await res.json();
      setPending(json.pending ?? []);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 10_000);
    return () => clearInterval(id);
  }, [load]);

  async function decide(id: number, approved: boolean) {
    setBusy(id);
    try {
      await fetch("/api/approvals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, approved }),
      });
      await load();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="panel">
      <h2>Approbations superviseur</h2>
      {pending.length === 0 ? (
        <p className="empty">Aucune proposition en attente.</p>
      ) : (
        <ul className="clean">
          {pending.map((p) => (
            <li key={p.id}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <strong>{p.poolName}</strong>
                <span className="accent num">${p.sizeUsd.toFixed(0)}</span>
              </div>
              <div className="tiny muted" style={{ margin: "4px 0 8px" }}>
                {p.verdict} · régime {p.regime} · vol {(p.volAnnual * 100).toFixed(0)}% ·
                APR net {(p.expectedNetApr * 100).toFixed(0)}%{p.hedged ? " · hedge conseillé" : ""}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="btn approve" disabled={busy === p.id} onClick={() => decide(p.id, true)}>
                  Approuver
                </button>
                <button className="btn reject" disabled={busy === p.id} onClick={() => decide(p.id, false)}>
                  Rejeter
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
