import { NextRequest, NextResponse } from "next/server";
import { createCloseRequest, getCloseRequest } from "@/lib/queries";

/** POST /api/positions/close — crée une demande de clôture (traitée par le daemon) */
export async function POST(req: NextRequest) {
  try {
    const { poolAddress, positionPubkey, poolName } = (await req.json()) as Record<string, string>;
    if (!poolAddress || !positionPubkey || !poolName) {
      return NextResponse.json({ error: "Paramètres manquants" }, { status: 400 });
    }
    const requestId = createCloseRequest(poolAddress, positionPubkey, poolName);
    return NextResponse.json({ requestId });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

/** GET /api/positions/close?id=X — état d'une demande de clôture */
export async function GET(req: NextRequest) {
  try {
    const id = Number(req.nextUrl.searchParams.get("id"));
    if (!id) return NextResponse.json({ error: "id manquant" }, { status: 400 });
    const request = getCloseRequest(id);
    if (!request) return NextResponse.json({ error: "Demande introuvable" }, { status: 404 });
    return NextResponse.json(request);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
