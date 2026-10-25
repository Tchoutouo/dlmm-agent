export type ExecutionMode = "REFUSE" | "DRY_RUN" | "LIVE";

/** Réseau effectivement servi par le RPC (via son hash de genèse). */
export type DetectedNetwork = "devnet" | "mainnet-beta" | "testnet" | "unknown";

/** Hash de genèse de chaque cluster Solana : identifie le réseau RÉEL d'un RPC. */
export const GENESIS_HASHES: Record<Exclude<DetectedNetwork, "unknown">, string> = {
  "mainnet-beta": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  testnet: "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY",
};

export function networkFromGenesis(hash: string): DetectedNetwork {
  for (const [net, h] of Object.entries(GENESIS_HASHES)) {
    if (h === hash) return net as DetectedNetwork;
  }
  return "unknown";
}

/** Interroge le RPC (lecture seule). Toute erreur → "unknown" (jamais LIVE). */
export async function detectRpcNetwork(connection: {
  getGenesisHash(): Promise<string>;
}): Promise<DetectedNetwork> {
  try {
    return networkFromGenesis(await connection.getGenesisHash());
  } catch {
    return "unknown";
  }
}

export interface GateInput {
  network: "devnet" | "mainnet-beta";
  /** Réseau réellement servi par SOLANA_RPC_URL (detectRpcNetwork). */
  rpcNetwork: DetectedNetwork;
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
 *  1. Pas de wallet chargé                    → REFUSE (rien ne peut signer).
 *  2. RPC sur un autre réseau que NETWORK     → REFUSE (config incohérente).
 *  3. DRY_RUN actif (défaut)                  → DRY_RUN (on construit/log, on n'envoie pas).
 *  4. Réseau du RPC non vérifiable            → REFUSE (jamais d'envoi à l'aveugle).
 *  5. Intention LIVE sur mainnet              → REFUSE sauf accusé de réception explicite.
 *  6. Sinon (devnet, ou mainnet+ACK)          → LIVE.
 *
 * NETWORK seul est déclaratif : c'est le RPC qui détermine où partent les
 * transactions. Le contrôle 2 empêche qu'un RPC mainnet déclaré « devnet »
 * contourne l'accusé de réception. Pour envoyer sur mainnet, il faut donc
 * DRY_RUN=false ET NETWORK=mainnet-beta ET un RPC mainnet ET ACKNOWLEDGE_REAL_FUNDS=true.
 */
export function executionGate(g: GateInput): GateResult {
  if (!g.walletLoaded) {
    return { mode: "REFUSE", reason: "Aucun wallet chargé (WALLET_SECRET_KEY absent)" };
  }
  if (g.rpcNetwork !== "unknown" && g.rpcNetwork !== g.network) {
    return {
      mode: "REFUSE",
      reason: `SOLANA_RPC_URL pointe sur ${g.rpcNetwork} alors que NETWORK=${g.network} — corriger la configuration`,
    };
  }
  if (g.dryRun) {
    return { mode: "DRY_RUN", reason: "DRY_RUN actif : transaction construite mais non envoyée" };
  }
  if (g.rpcNetwork === "unknown") {
    return {
      mode: "REFUSE",
      reason: "Réseau du RPC non vérifiable (getGenesisHash) : aucun envoi à l'aveugle",
    };
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
