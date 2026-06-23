import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Liste les propositions en attente d'approbation. */
export function GET() {
  try {
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
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

/** Résout une proposition : { id, approved }. */
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { id?: unknown; approved?: unknown };
    if (typeof body.id !== "number" || typeof body.approved !== "boolean") {
      return NextResponse.json({ error: "id (number) et approved (boolean) requis" }, { status: 400 });
    }
    const changes = getDb()
      .prepare(`UPDATE approvals SET status=?, decided_at=? WHERE id=? AND status='PENDING'`)
      .run(body.approved ? "APPROVED" : "REJECTED", new Date().toISOString(), body.id);
    if (changes.changes === 0) {
      return NextResponse.json({ error: "Proposition introuvable ou déjà traitée" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
