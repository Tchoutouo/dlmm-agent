"use client";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer,
  ReferenceLine, CartesianGrid,
} from "recharts";
import type { EquityPoint } from "@/lib/queries";

interface Props {
  readonly data: EquityPoint[];
  /** Gains latents (PnL non réalisé + fees accumulées) des positions ouvertes */
  readonly unrealizedGain?: number;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" });
}

function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" })
    + " " + d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

export default function EquityChart({ data, unrealizedGain = 0 }: Props) {
  if (data.length === 0) {
    return (
      <div style={{ padding: "24px 0", textAlign: "center" }}>
        <p className="empty">Pas encore d&apos;issues réalisées.</p>
        {unrealizedGain !== 0 && (
          <p className="tiny" style={{ marginTop: 8 }}>
            Gains latents actuels :{" "}
            <span className={unrealizedGain >= 0 ? "pos" : "neg"}>
              {unrealizedGain >= 0 ? "+" : ""}{unrealizedGain.toFixed(2)} $
            </span>
          </p>
        )}
      </div>
    );
  }

  const lastPnl = data[data.length - 1]!.pnl;
  const totalGain = lastPnl + unrealizedGain;

  // Série graphique : PnL réalisé cumulé
  const series = data.map((d) => ({
    t: d.t,
    pnl: Number(d.pnl.toFixed(2)),
    label: fmtDate(d.t),
  }));

  // Couleur dynamique selon tendance
  const lineColor = lastPnl >= 0 ? "#5fb98c" : "#d96a6a";
  const fillColor = lastPnl >= 0 ? "rgba(95,185,140,0.12)" : "rgba(217,106,106,0.12)";

  return (
    <div>
      {/* Mini-stats au-dessus du graphe */}
      <div style={{ display: "flex", gap: 20, marginBottom: 12, flexWrap: "wrap" }}>
        <div>
          <div className="label">Réalisé cumulé</div>
          <div className={`val num ${lastPnl >= 0 ? "pos" : "neg"}`} style={{ fontSize: 20 }}>
            {lastPnl >= 0 ? "+" : ""}{lastPnl.toFixed(2)} $
          </div>
        </div>
        {unrealizedGain !== 0 && (
          <>
            <div style={{ color: "var(--border)", alignSelf: "center", fontSize: 18 }}>+</div>
            <div>
              <div className="label">Latent ouvert</div>
              <div className={`val num ${unrealizedGain >= 0 ? "accent" : "neg"}`} style={{ fontSize: 20 }}>
                {unrealizedGain >= 0 ? "+" : ""}{unrealizedGain.toFixed(2)} $
              </div>
            </div>
            <div style={{ color: "var(--border)", alignSelf: "center", fontSize: 18 }}>=</div>
            <div>
              <div className="label">Total estimé</div>
              <div className={`val num ${totalGain >= 0 ? "pos" : "neg"}`} style={{ fontSize: 20, fontWeight: 600 }}>
                {totalGain >= 0 ? "+" : ""}{totalGain.toFixed(2)} $
              </div>
            </div>
          </>
        )}
      </div>

      <ResponsiveContainer width="100%" height={200}>
        <AreaChart data={series} margin={{ top: 4, right: 8, bottom: 0, left: -12 }}>
          <defs>
            <linearGradient id="pnlGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={lineColor} stopOpacity={0.3} />
              <stop offset="100%" stopColor={lineColor} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="rgba(255,255,255,0.03)" vertical={false} />
          <XAxis
            dataKey="label"
            stroke="transparent"
            tick={{ fontSize: 10, fill: "#888d97", fontFamily: "var(--font-mono)" }}
            tickLine={false}
            interval="preserveStartEnd"
          />
          <YAxis
            stroke="#888d97"
            tick={{ fontSize: 11, fontFamily: "var(--font-mono)" }}
            tickLine={false}
            axisLine={{ stroke: "#262a31" }}
            width={56}
            tickFormatter={(v: number) => `$${v}`}
          />
          <ReferenceLine y={0} stroke="#262a31" strokeDasharray="4 3" />
          {/* Ligne de référence pour les gains latents */}
          {unrealizedGain !== 0 && (
            <ReferenceLine
              y={totalGain}
              stroke="#d8a23a"
              strokeDasharray="6 3"
              strokeOpacity={0.5}
              label={{
                value: `Total ${totalGain >= 0 ? "+" : ""}${totalGain.toFixed(0)}$`,
                fill: "#d8a23a",
                fontSize: 10,
                position: "insideTopRight",
              }}
            />
          )}
          <Tooltip
            contentStyle={{
              background: "#181b21",
              border: "1px solid #262a31",
              borderRadius: 4,
              fontFamily: "var(--font-mono)",
              fontSize: 12,
            }}
            labelStyle={{ color: "#888d97", marginBottom: 4 }}
            labelFormatter={(_, payload) => {
              const iso = (payload?.[0]?.payload as { t: string } | undefined)?.t;
              return iso ? fmtDateTime(iso) : "";
            }}
            formatter={(v: number) => [`${v >= 0 ? "+" : ""}$${v.toFixed(2)}`, "PnL réalisé cumulé"]}
          />
          <Area
            type="monotone"
            dataKey="pnl"
            stroke={lineColor}
            strokeWidth={2}
            fill="url(#pnlGradient)"
            dot={false}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
