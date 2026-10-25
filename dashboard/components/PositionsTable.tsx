"use client";
import { useState } from "react";
import type { OpenPosition } from "@/lib/queries";
import CloseModal from "./CloseModal";

interface Props {
  positions: OpenPosition[];
}

const usd = (n: number) =>
  `${n >= 0 ? "+" : ""}$${Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;

export default function PositionsTable({ positions }: Props) {
  const [closing, setClosing] = useState<OpenPosition | null>(null);

  if (positions.length === 0) {
    return <p className="empty">Aucune position ouverte.</p>;
  }

  return (
    <>
      <table>
        <thead>
          <tr>
            <th>Pool</th>
            <th className="right">Investi</th>
            <th className="right">Valeur</th>
            <th className="right">PnL</th>
            <th className="right">Fees</th>
            <th className="right">Total</th>
            <th className="right">Range</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {positions.map((p, i) => {
            const unrealized = p.valueUsd - p.sizeUsd;
            const total = unrealized + p.accruedFees;
            const totalPct = p.sizeUsd > 0 ? (total / p.sizeUsd) * 100 : 0;
            const outMin = p.outOfRangeSinceSec
              ? Math.round((Date.now() / 1000 - p.outOfRangeSinceSec) / 60)
              : null;

            return (
              <tr
                key={i}
                style={outMin !== null ? { background: "rgba(255,80,80,0.05)" } : {}}
              >
                <td>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                    <span style={{ whiteSpace: "nowrap" }}>{p.poolName}</span>
                    {p.isLive && (
                      <span className="tag accent" style={{ fontSize: 9, whiteSpace: "nowrap" }}>LIVE</span>
                    )}
                    {p.shape === "sol_bidask" ? (
                      <span
                        className="tag hold"
                        style={{ fontSize: 9, whiteSpace: "nowrap" }}
                        title="Bid-ask d'un seul côté : liquidité en SOL/stable sous le prix d'entrée"
                      >
                        BID-ASK
                      </span>
                    ) : (
                      <span
                        className="tag skip"
                        style={{ fontSize: 9, whiteSpace: "nowrap" }}
                        title="Spot : liquidité des deux côtés, centrée sur le prix"
                      >
                        SPOT
                      </span>
                    )}
                    {outMin !== null && (
                      <span
                        className="tag neg"
                        style={{ fontSize: 9, whiteSpace: "nowrap" }}
                        title={`Hors range depuis ${outMin} min`}
                      >
                        OUT {outMin}m
                      </span>
                    )}
                  </div>
                </td>
                <td className="right num muted">${p.sizeUsd.toFixed(0)}</td>
                <td className={`right num ${unrealized >= 0 ? "pos" : "neg"}`}>
                  ${p.valueUsd.toFixed(2)}
                </td>
                <td className={`right num ${unrealized >= 0 ? "pos" : "neg"}`}>
                  {usd(unrealized)}
                </td>
                <td className="right num accent">+${p.accruedFees.toFixed(2)}</td>
                <td className={`right num ${total >= 0 ? "pos" : "neg"}`} style={{ fontWeight: 500 }}>
                  {usd(total)}
                  <span className="muted tiny" style={{ marginLeft: 4 }}>
                    ({totalPct >= 0 ? "+" : ""}{totalPct.toFixed(1)}%)
                  </span>
                </td>
                <td className="right num muted tiny">
                  {outMin !== null ? (
                    <span className="neg">Hors range</span>
                  ) : (
                    <span className="pos">En range</span>
                  )}
                </td>
                <td className="right">
                  {p.isLive && p.positionPubkey && p.poolAddress && (
                    <button
                      className="btn btn-close"
                      onClick={() => setClosing(p)}
                      title="Clôturer cette position"
                    >
                      Clôturer
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {/* Résumé total */}
      {positions.length > 1 && (() => {
        const totalInvested = positions.reduce((s, p) => s + p.sizeUsd, 0);
        const totalValue = positions.reduce((s, p) => s + p.valueUsd, 0);
        const totalFees = positions.reduce((s, p) => s + p.accruedFees, 0);
        const totalGain = totalValue - totalInvested + totalFees;
        return (
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 24, marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--border)", fontSize: 12 }}>
            <span className="muted">Total investi : <span className="num">${totalInvested.toFixed(0)}</span></span>
            <span className="muted">Total valeur : <span className={`num ${totalValue >= totalInvested ? "pos" : "neg"}`}>${totalValue.toFixed(0)}</span></span>
            <span className="muted">Fees totales : <span className="num accent">+${totalFees.toFixed(2)}</span></span>
            <span className="muted">Gain net : <span className={`num ${totalGain >= 0 ? "pos" : "neg"}`}>{usd(totalGain)}</span></span>
          </div>
        );
      })()}

      {closing && (
        <CloseModal position={closing} onClose={() => setClosing(null)} />
      )}
    </>
  );
}
