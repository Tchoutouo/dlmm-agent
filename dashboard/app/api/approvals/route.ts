import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Liste les propositions en attente d'approbation. */
export function GET() {
  const rows = getDb()
    .prepare(`SELECT * FROM approvals WHERE status='PENDING' ORDER BY id DESC`)
    .all() as Record<string, unknown>[];
  const pending = rows.map((r) => ({
    id: r.id,
    poolName: r.pool_name,
    sizeUsd: r.size_usd,
    verdict: r.verdict,
    regime: r.regime,
    expectedNetApr: r.expected_net_apr,
    volAnnual: r.vol_annual,
    hedged: Boolean(r.hedged),
    rationale: r.rationale,
    createdAt: r.created_at,
  }));
  return NextResponse.json({ pending });
}

/** Résout une proposition : { id, approved }. */
export async function POST(req: Request) {
  const body = (await req.json()) as { id?: number; approved?: boolean };
  if (typeof body.id !== "number" || typeof body.approved !== "boolean") {
    return NextResponse.json({ error: "id et approved requis" }, { status: 400 });
  }
  getDb()
    .prepare(`UPDATE approvals SET status=?, decided_at=? WHERE id=? AND status='PENDING'`)
    .run(body.approved ? "APPROVED" : "REJECTED", new Date().toISOString(), body.id);
  return NextResponse.json({ ok: true });
}
