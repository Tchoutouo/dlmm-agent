import { NextResponse, type NextRequest } from "next/server";
import { guardRequest } from "./lib/security";

/** Applique la protection du dashboard (voir lib/security.ts) à chaque requête. */
export function middleware(req: NextRequest) {
  const verdict = guardRequest(
    {
      method: req.method,
      pathname: req.nextUrl.pathname,
      host: req.headers.get("host"),
      origin: req.headers.get("origin"),
      contentType: req.headers.get("content-type"),
      authorization: req.headers.get("authorization"),
    },
    process.env.DASHBOARD_PASSWORD
  );
  if (verdict.ok) return NextResponse.next();
  return new NextResponse(verdict.message, {
    status: verdict.status,
    headers:
      verdict.status === 401
        ? { "WWW-Authenticate": 'Basic realm="DLMM dashboard", charset="UTF-8"' }
        : undefined,
  });
}

export const config = {
  // Tout sauf les ressources statiques ; runtime Node : DASHBOARD_PASSWORD lu au démarrage, pas au build
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
  runtime: "nodejs",
};
