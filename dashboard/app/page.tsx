import {
  getPortfolio, getOpenPositions, getDecisions, getEquityCurve, getLearning,
} from "@/lib/queries";
import EquityChart from "@/components/EquityChart";
import ApprovalsPanel from "@/components/ApprovalsPanel";
import AutoRefresh from "@/components/AutoRefresh";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const usd = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const pct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;

export default function Page() {
  const pf = getPortfolio();
  const positions = getOpenPositions();
  const decisions = getDecisions(25);
  const equity = getEquityCurve();
  const learning = getLearning();
  const netPnl = equity.length ? equity[equity.length - 1].pnl : 0;
  const winRate = learning.overall.winRate;

  return (
    <div className="wrap">
      <AutoRefresh seconds={15} />

      <div className="masthead">
        <div>
          <h1>DLMM Terminal<span className="dot">.</span></h1>
          <div className="sub">Gestionnaire de liquidité · paper trading</div>
        </div>
        <div className="sub">maj auto · 15s</div>
      </div>

      {/* Statistiques */}
      <div className="grid-stats">
        <div className="card">
          <div className="label">NAV</div>
          <div className="val num">{usd(pf.navUsd)}</div>
        </div>
        <div className="card">
          <div className="label">Cash</div>
          <div className="val num">{usd(pf.cashUsd)}</div>
        </div>
        <div className="card">
          <div className="label">PnL cumulé</div>
          <div className={`val num ${netPnl >= 0 ? "pos" : "neg"}`}>
            {netPnl >= 0 ? "+" : ""}{usd(netPnl)}
          </div>
        </div>
        <div className="card">
          <div className="label">Drawdown</div>
          <div className={`val num ${pf.drawdownPct > 0 ? "neg" : ""}`}>{pf.drawdownPct.toFixed(1)}%</div>
        </div>
        <div className="card">
          <div className="label">Win rate</div>
          <div className="val num accent">{winRate === null ? "—" : `${(winRate * 100).toFixed(0)}%`}</div>
        </div>
      </div>

      <div className="cols">
        {/* Colonne gauche */}
        <div>
          <div className="panel">
            <h2>Courbe de PnL</h2>
            <EquityChart data={equity} />
          </div>

          <div className="panel">
            <h2>Positions ouvertes ({positions.length})</h2>
            {positions.length === 0 ? (
              <p className="empty">Aucune position ouverte.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Pool</th><th className="right">Taille</th><th className="right">Valeur</th>
                    <th className="right">Fees</th><th className="right">Range</th>
                  </tr>
                </thead>
                <tbody>
                  {positions.map((p, i) => (
                    <tr key={i}>
                      <td>{p.poolName}</td>
                      <td className="right num">{usd(p.sizeUsd)}</td>
                      <td className={`right num ${p.valueUsd >= p.sizeUsd ? "pos" : "neg"}`}>{usd(p.valueUsd)}</td>
                      <td className="right num accent">${p.accruedFees.toFixed(2)}</td>
                      <td className="right num muted tiny">
                        {p.rangeLow.toFixed(3)}–{p.rangeHigh.toFixed(3)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="panel">
            <h2>Journal des décisions</h2>
            {decisions.length === 0 ? (
              <p className="empty">Aucune décision journalisée.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Pool</th><th>Décision</th><th>Régime</th>
                    <th className="right">Taille</th><th className="right">PnL</th>
                  </tr>
                </thead>
                <tbody>
                  {decisions.map((d) => (
                    <tr key={d.id}>
                      <td>{d.poolName}</td>
                      <td><span className={`tag ${d.decision.toLowerCase()}`}>{d.decision}</span></td>
                      <td className="muted tiny">{d.regime ?? "—"}</td>
                      <td className="right num">{d.sizeUsd ? usd(d.sizeUsd) : "—"}</td>
                      <td className={`right num ${d.realizedPnlUsd == null ? "muted" : d.realizedPnlUsd >= 0 ? "pos" : "neg"}`}>
                        {d.realizedPnlUsd == null ? "—" : `${d.realizedPnlUsd >= 0 ? "+" : ""}$${d.realizedPnlUsd.toFixed(1)}`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* Colonne droite */}
        <div>
          <ApprovalsPanel />

          <div className="panel">
            <h2>Apprentissage (Agent 5)</h2>
            <div className="label">Performance par régime</div>
            {Object.keys(learning.byRegime).length === 0 ? (
              <p className="empty tiny">Pas encore de données.</p>
            ) : (
              <table style={{ marginTop: 8, marginBottom: 14 }}>
                <thead>
                  <tr><th>Régime</th><th className="right">Issues</th><th className="right">Win</th><th className="right">PnL moy</th></tr>
                </thead>
                <tbody>
                  {Object.entries(learning.byRegime).map(([k, m]) => (
                    <tr key={k}>
                      <td>{k}</td>
                      <td className="right num">{m.withOutcome}</td>
                      <td className="right num">{m.winRate === null ? "—" : `${(m.winRate * 100).toFixed(0)}%`}</td>
                      <td className={`right num ${(m.avgPnlUsd ?? 0) >= 0 ? "pos" : "neg"}`}>
                        {m.avgPnlUsd === null ? "—" : `$${m.avgPnlUsd.toFixed(1)}`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {learning.calibration.correlation !== null && (
              <p className="tiny muted" style={{ marginBottom: 10 }}>
                Calibration : corrélation prédit↔réalisé {learning.calibration.correlation.toFixed(2)}
                {" "}({learning.calibration.samples} pts)
              </p>
            )}

            {learning.recurringErrors.length > 0 && (
              <>
                <div className="label" style={{ marginTop: 6 }}>Erreurs récurrentes</div>
                <ul className="clean tiny">
                  {learning.recurringErrors.map((e, i) => <li key={i} className="neg">{e}</li>)}
                </ul>
              </>
            )}

            <div className="label" style={{ marginTop: 12 }}>Suggestions</div>
            <ul className="clean tiny">
              {learning.suggestions.map((s, i) => <li key={i} className="accent">{s}</li>)}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
