import type { Connection, Keypair } from "@solana/web3.js";
import { VersionedTransaction } from "@solana/web3.js";
import { checkQuote, checkSwapMessage } from "./swapGuard.js";

export const SOL_MINT  = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// quote-api.jup.ag inaccessible sur certains réseaux → on utilise api.jup.ag
const JUP_QUOTE_URL = "https://api.jup.ag/swap/v1/quote";
const JUP_SWAP_URL  = "https://api.jup.ag/swap/v1/swap";
const SLIPPAGE_BPS  = 50; // 0.5 %
const MAX_RETRIES  = 3;

/**
 * fetch avec retries exponentiels.
 * - Erreurs réseau (TypeError/AbortError) : 1.5 s, 3 s
 * - HTTP 429 (rate limit) : 5 s fixe — API Gateway exige un délai long
 * - HTTP 503 (service indisponible) : 1.5 s, 3 s
 * - Tout autre statut non-2xx : retourné sans retry (erreur définitive)
 */
async function fetchRetry(url: string, init?: RequestInit, retries = MAX_RETRIES): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(url, init);
      if ((res.status === 429 || res.status === 503) && attempt < retries - 1) {
        const delay = res.status === 429 ? 5_000 : 1_500 * (attempt + 1);
        console.log(`  ↻ Jupiter HTTP ${res.status} (tentative ${attempt + 1}/${retries}) — retry dans ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt === retries - 1) break;
      const delay = (attempt + 1) * 1_500;
      console.log(`  ↻ Jupiter fetch échec réseau (tentative ${attempt + 1}/${retries}) — retry dans ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr ?? new Error("Max retries Jupiter atteint");
}

export interface SwapResult {
  ok: boolean;
  note: string;
  txHash?: string;
}

/**
 * Swap via Jupiter V6 Aggregator.
 *
 * `inputAmountUnits` est en base units : lamports pour SOL (1e9),
 * micro-USDC pour USDC (1e6), etc.
 *
 * La transaction vient d'une API distante : avant de la signer, on vérifie le
 * devis (tokens, montant, slippage borné, impact ≤ 1 %), chaque instruction
 * (swapGuard), puis on la simule. Après envoi, le résultat on-chain est lu :
 * une transaction confirmée mais en échec n'est jamais rapportée comme réussie.
 *
 * En mode `dryRun` : récupère et contrôle uniquement le devis, n'envoie rien.
 */
export async function jupiterSwap(
  connection: Connection,
  keypair: Keypair,
  inputMint: string,
  outputMint: string,
  inputAmountUnits: number,
  dryRun = false
): Promise<SwapResult> {
  try {
    // 1. Meilleur itinéraire de swap
    const params = new URLSearchParams({
      inputMint,
      outputMint,
      amount: String(Math.round(inputAmountUnits)),
      slippageBps: String(SLIPPAGE_BPS),
    });
    const quoteRes = await fetchRetry(`${JUP_QUOTE_URL}?${params}`);
    if (!quoteRes.ok) {
      return { ok: false, note: `Jupiter quote: ${(await quoteRes.text()).slice(0, 120)}` };
    }
    const quote = (await quoteRes.json()) as Record<string, unknown>;
    const quoteIssue = checkQuote(quote, { inputMint, outputMint, amount: inputAmountUnits });
    if (quoteIssue) return { ok: false, note: `Swap refusé : ${quoteIssue}` };

    if (dryRun) {
      const inAmt  = Number(quote.inAmount);
      const outAmt = Number(quote.outAmount);
      return {
        ok: true,
        note: `[DRY_RUN] Swap simulé : ${inAmt} → ${outAmt} (non envoyé)`,
      };
    }

    // 2. Transaction sérialisée
    const swapRes = await fetchRetry(JUP_SWAP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: keypair.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: 2_000,
      }),
    });
    if (!swapRes.ok) {
      return { ok: false, note: `Jupiter swap: ${(await swapRes.text()).slice(0, 120)}` };
    }
    const { swapTransaction, lastValidBlockHeight } = (await swapRes.json()) as {
      swapTransaction: string;
      lastValidBlockHeight?: number;
    };

    // 3. Inspecter → simuler → signer → envoyer → lire le résultat on-chain
    const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
    const txIssue = checkSwapMessage(tx.message, keypair.publicKey);
    if (txIssue) return { ok: false, note: `Swap refusé : ${txIssue}` };

    const sim = await connection.simulateTransaction(tx, { sigVerify: false });
    if (sim.value.err) {
      return { ok: false, note: `Swap refusé : la simulation échoue (${JSON.stringify(sim.value.err).slice(0, 80)})` };
    }

    tx.sign([keypair]);
    const txHash = await connection.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
    const conf = await connection.confirmTransaction(
      {
        signature: txHash,
        blockhash: tx.message.recentBlockhash,
        lastValidBlockHeight: lastValidBlockHeight ?? (await connection.getLatestBlockhash()).lastValidBlockHeight,
      },
      "confirmed"
    );
    if (conf.value.err) {
      return { ok: false, note: `Swap échoué on-chain (${JSON.stringify(conf.value.err).slice(0, 80)})`, txHash };
    }

    return { ok: true, note: `Swap confirmé`, txHash };
  } catch (err) {
    const msg = (err instanceof Error ? err.message.split("\n")[0] : String(err)) ?? "";
    return { ok: false, note: `Swap échoué : ${msg.slice(0, 120)}` };
  }
}
