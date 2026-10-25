import { NextRequest, NextResponse } from "next/server";
import {
  MAX_ACTIVE_CLOSE_REQUESTS,
  activeCloseRequestId,
  countActiveCloseRequests,
  createCloseRequest,
  getCloseRequest,
  isTrackedLivePosition,
} from "@/lib/queries";
import { validateCloseRequest } from "@/lib/security";

/** Réponse d'erreur interne : le détail reste dans les logs serveur. */
function internalError(err: unknown) {
  console.error("[api/positions/close]", err);
  return NextResponse.json({ error: "Erreur interne" }, { status: 500 });
}

/**
 * POST /api/positions/close — crée une demande de clôture (traitée par le daemon).
 * Seules les positions réelles OUVERTES suivies par l'agent peuvent être visées ;
 * une même position n'a qu'une demande en cours ; le nombre de demandes en
 * attente est plafonné.
 */
export async function POST(req: NextRequest) {
  try {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Corps JSON invalide" }, { status: 400 });
    }
    const check = validateCloseRequest(body);
    if (!check.ok) return NextResponse.json({ error: check.error }, { status: 400 });
    const { poolAddress, positionPubkey, poolName } = check.value;

    if (!isTrackedLivePosition(poolAddress, positionPubkey)) {
      return NextResponse.json({ error: "Position non suivie par l'agent (ou déjà fermée)" }, { status: 404 });
    }
    const existing = activeCloseRequestId(positionPubkey);
    if (existing !== null) return NextResponse.json({ requestId: existing });
    if (countActiveCloseRequests() >= MAX_ACTIVE_CLOSE_REQUESTS) {
      return NextResponse.json({ error: "Trop de demandes de clôture en attente" }, { status: 429 });
    }
    return NextResponse.json({ requestId: createCloseRequest(poolAddress, positionPubkey, poolName) });
  } catch (err) {
    return internalError(err);
  }
}

/** GET /api/positions/close?id=X — état d'une demande de clôture */
export async function GET(req: NextRequest) {
  try {
    const id = Number(req.nextUrl.searchParams.get("id"));
    if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "id invalide" }, { status: 400 });
    const request = getCloseRequest(id);
    if (!request) return NextResponse.json({ error: "Demande introuvable" }, { status: 404 });
    return NextResponse.json(request);
  } catch (err) {
    return internalError(err);
  }
}
