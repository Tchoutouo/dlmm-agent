import type { Pool, HedgeRecommendation, FeeRegime, QuoteProfile } from "../types.js";
import { directionalExposure } from "../analytics/impermanentLoss.js";

/**
 * Recommandation de couverture (delta hedge), à deux composantes :
 *
 *  1. Exposition au token volatil X (jambe directionnelle de la position).
 *     hedgeRatio = valeur jambe X / valeur totale. On shorte ce notionnel.
 *
 *  2. Exposition au QUOTE (Y). Pour une paire TOKEN/SOL, la valeur USD de toute
 *     la position suit SOL (élasticité 1) : un short SOL du montant total
 *     neutralise ce risque. Pour un quote stable, cette exposition est nulle.
 *
 * NOTE : l'EXÉCUTION du hedge (short perp) sort du périmètre de cet agent — c'est
 * une guidance. Le branchement sur un venue (Drift, Jupiter Perps) viendra avec
 * l'agent d'exécution.
 */
export function recommendHedge(
  pool: Pool,
  range: { priceLow: number; priceHigh: number },
  sizeUsd: number,
  feeRegime: FeeRegime,
  quoteProfile?: QuoteProfile,
  threshold = 0.4
): HedgeRecommendation {
  const hedgeRatio = directionalExposure(
    pool.currentPrice,
    range.priceLow,
    range.priceHigh
  );
  const notionalUsd = sizeUsd * hedgeRatio;

  // Exposition au quote : toute la position si le quote n'est pas stable
  const quoteExposureUsd = quoteProfile && !quoteProfile.isStable ? sizeUsd : 0;

  const recommended =
    (hedgeRatio > threshold && feeRegime.label === "volatile") || quoteExposureUsd > 0;

  const parts: string[] = [];
  parts.push(
    `Jambe volatile ${(hedgeRatio * 100).toFixed(0)}%` +
      (hedgeRatio > threshold && feeRegime.label === "volatile"
        ? ` → short ~$${notionalUsd.toFixed(0)} sur ${pool.mintX.slice(0, 6)}…`
        : " (couverture optionnelle)")
  );
  if (quoteExposureUsd > 0) {
    parts.push(
      `Quote non-stable : position exposée à SOL/USD → short ~$${quoteExposureUsd.toFixed(0)} sur le quote`
    );
  }

  return { recommended, hedgeRatio, notionalUsd, quoteExposureUsd, note: parts.join(" ; ") };
}
