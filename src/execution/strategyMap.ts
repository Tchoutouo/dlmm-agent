import type { FeeRegimeLabel } from "../types.js";

export type DlmmStrategyName = "Spot" | "Curve" | "BidAsk";

/**
 * Choisit la forme de liquidité DLMM selon le régime de marché détecté par
 * l'Agent 1, conformément aux usages officiels Meteora :
 *
 *  - calm     → Curve   : liquidité concentrée autour du prix actif (fees max,
 *                          adapté quand le prix bouge peu).
 *  - active   → Spot    : répartition uniforme, polyvalente.
 *  - volatile → BidAsk  : liquidité repoussée vers les bords (capte les grands
 *                          mouvements, réduit le risque de concentration au centre).
 */
export function strategyForRegime(regime: FeeRegimeLabel): DlmmStrategyName {
  switch (regime) {
    case "calm":
      return "Curve";
    case "volatile":
      return "BidAsk";
    default:
      return "Spot";
  }
}
