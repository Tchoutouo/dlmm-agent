/**
 * Protection du dashboard (fonctions pures, testées depuis la suite de l'agent).
 *
 * Le dashboard peut approuver des trades et demander des clôtures : il ne doit
 * être utilisable ni par un tiers sur le réseau, ni par un site malveillant
 * ouvert dans le navigateur (CSRF).
 *
 *  - DASHBOARD_PASSWORD défini → authentification HTTP Basic sur tout le site.
 *  - Sinon → accès réservé à la machine locale (Host localhost / 127.0.0.1 / ::1),
 *    ce qui bloque aussi le DNS rebinding.
 *  - Toute requête qui modifie (/api, hors GET/HEAD/OPTIONS) doit venir de la
 *    même origine et être du JSON : un formulaire ou un fetch « text/plain »
 *    venu d'un autre site est refusé.
 */

export interface RequestFacts {
  method: string;
  pathname: string;
  host: string | null;
  origin: string | null;
  contentType: string | null;
  authorization: string | null;
}

export type GuardVerdict =
  | { ok: true }
  | { ok: false; status: 401 | 403 | 415; message: string };

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Nom d'hôte sans le port (gère « [::1]:3000 »). */
export function hostnameOf(host: string): string {
  if (host.startsWith("[")) return host.slice(0, host.indexOf("]") + 1).toLowerCase();
  return (host.split(":")[0] ?? "").toLowerCase();
}

/** Comparaison en temps constant (ne révèle pas la position du premier écart). */
export function safeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

/** En-tête « Authorization: Basic … » valide pour ce mot de passe (identifiant libre). */
export function checkBasicAuth(authorization: string | null, password: string): boolean {
  if (!authorization?.startsWith("Basic ")) return false;
  let decoded: string;
  try {
    decoded = atob(authorization.slice(6).trim());
  } catch {
    return false;
  }
  const sep = decoded.indexOf(":");
  return sep >= 0 && safeEqual(decoded.slice(sep + 1), password);
}

export function guardRequest(f: RequestFacts, password: string | undefined): GuardVerdict {
  // 1. Qui peut accéder au dashboard
  if (password) {
    if (!checkBasicAuth(f.authorization, password)) {
      return { ok: false, status: 401, message: "Authentification requise" };
    }
  } else if (!f.host || !LOCAL_HOSTNAMES.has(hostnameOf(f.host))) {
    return {
      ok: false,
      status: 403,
      message: "Accès distant refusé : définir DASHBOARD_PASSWORD pour exposer le dashboard",
    };
  }

  // 2. Anti-CSRF sur toute requête qui modifie l'état
  if (!SAFE_METHODS.has(f.method.toUpperCase()) && f.pathname.startsWith("/api/")) {
    let originHost: string | null = null;
    try {
      originHost = f.origin ? new URL(f.origin).host.toLowerCase() : null;
    } catch {
      originHost = null;
    }
    if (!originHost || !f.host || originHost !== f.host.toLowerCase()) {
      return { ok: false, status: 403, message: "Origine de la requête refusée" };
    }
    if (!f.contentType?.toLowerCase().startsWith("application/json")) {
      return { ok: false, status: 415, message: "Content-Type application/json requis" };
    }
  }

  return { ok: true };
}

/** Clé publique Solana en base58 (32 octets → 32 à 44 caractères). */
const BASE58_PUBKEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export interface CloseRequestInput {
  poolAddress: string;
  positionPubkey: string;
  poolName: string;
}

/**
 * Valide le corps d'une demande de clôture : adresses base58 valides, nom
 * court sans caractères de contrôle. Renvoie la demande nettoyée ou le motif.
 */
export function validateCloseRequest(
  body: unknown
): { ok: true; value: CloseRequestInput } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "Corps JSON attendu" };
  const b = body as Record<string, unknown>;
  const { poolAddress, positionPubkey, poolName } = b;
  if (typeof poolAddress !== "string" || !BASE58_PUBKEY.test(poolAddress)) {
    return { ok: false, error: "poolAddress invalide (clé publique base58 attendue)" };
  }
  if (typeof positionPubkey !== "string" || !BASE58_PUBKEY.test(positionPubkey)) {
    return { ok: false, error: "positionPubkey invalide (clé publique base58 attendue)" };
  }
  if (typeof poolName !== "string") return { ok: false, error: "poolName requis" };
  const name = poolName.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 64);
  if (!name) return { ok: false, error: "poolName requis" };
  return { ok: true, value: { poolAddress, positionPubkey, poolName: name } };
}
