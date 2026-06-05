"use client";
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine,
} from "recharts";
import type { EquityPoint } from "@/lib/queries";

export default function EquityChart({ data }: { data: EquityPoint[] }) {
  if (data.length === 0) {
    return <p className="empty">Pas encore d&apos;issues réalisées — lancez le paper trading.</p>;
  }
  const series = data.map((d, i) => ({ i, pnl: Number(d.pnl.toFixed(2)) }));
  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={series} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
        <XAxis dataKey="i" hide />
        <YAxis
          stroke="#888d97"
          tick={{ fontSize: 11, fontFamily: "var(--font-mono)" }}
          tickLine={false}
          axisLine={{ stroke: "#262a31" }}
          width={56}
        />
        <ReferenceLine y={0} stroke="#262a31" />
        <Tooltip
          contentStyle={{
            background: "#181b21", border: "1px solid #262a31", borderRadius: 4,
            fontFamily: "var(--font-mono)", fontSize: 12,
          }}
          labelStyle={{ display: "none" }}
          formatter={(v: number) => [`$${v}`, "PnL cumulé"]}
        />
        <Line
          type="monotone" dataKey="pnl" stroke="#d8a23a" strokeWidth={2} dot={false}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
