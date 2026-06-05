export type ExecutionMode = "REFUSE" | "DRY_RUN" | "LIVE";

export interface GateInput {
  network: "devnet" | "mainnet-beta";
  dryRun: boolean;
  walletLoaded: boolean;
  acknowledgeRealFunds: boolean;
}

export interface GateResult {
  mode: ExecutionMode;
  reason: string;
}

/**
 * Décide si une transaction réelle peut être envoyée. Plusieurs couches, du
 * plus restrictif au moins :
 *
 *  1. Pas de wallet chargé        → REFUSE (rien ne peut signer).
 *  2. DRY_RUN actif (défaut)      → DRY_RUN (on construit/log, on n'envoie pas).
 *  3. Intention LIVE sur mainnet  → REFUSE sauf accusé de réception explicite.
 *  4. Sinon (devnet, ou mainnet+ACK) → LIVE.
 *
 * Conçu pour qu'il soit IMPOSSIBLE d'envoyer accidentellement sur mainnet :
 * il faut DRY_RUN=false ET NETWORK=mainnet-beta ET ACKNOWLEDGE_REAL_FUNDS=true.
 */
export function executionGate(g: GateInput): GateResult {
  if (!g.walletLoaded) {
    return { mode: "REFUSE", reason: "Aucun wallet chargé (WALLET_SECRET_KEY absent)" };
  }
  if (g.dryRun) {
    return { mode: "DRY_RUN", reason: "DRY_RUN actif : transaction construite mais non envoyée" };
  }
  if (g.network === "mainnet-beta" && !g.acknowledgeRealFunds) {
    return {
      mode: "REFUSE",
      reason: "Exécution mainnet refusée : exige ACKNOWLEDGE_REAL_FUNDS=true (capital réel)",
    };
  }
  return {
    mode: "LIVE",
    reason:
      g.network === "devnet"
        ? "LIVE sur devnet (pas de capital réel)"
        : "LIVE sur mainnet (capital réel — accusé de réception fourni)",
  };
}
