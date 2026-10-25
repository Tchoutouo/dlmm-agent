import { describe, it, expect, vi, afterEach } from "vitest";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
} from "@solana/web3.js";
import { NATIVE_MINT, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { checkQuote, checkSwapMessage, JUPITER_PROGRAM_ID } from "../src/execution/swapGuard.js";
import { jupiterSwap, SOL_MINT, USDC_MINT } from "../src/execution/jupiterSwap.js";

const wallet = Keypair.generate();
const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, wallet.publicKey);
const attacker = Keypair.generate().publicKey;
const jupiterIx = new TransactionInstruction({
  programId: new PublicKey(JUPITER_PROGRAM_ID),
  keys: [{ pubkey: wallet.publicKey, isSigner: true, isWritable: true }],
  data: Buffer.from([1, 2, 3]),
});

function txOf(instructions: TransactionInstruction[], payer = wallet.publicKey): VersionedTransaction {
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions,
  }).compileToV0Message();
  return new VersionedTransaction(message);
}

const legit = () =>
  txOf([
    ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
    SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: wsolAta, lamports: 1_000_000 }),
    jupiterIx,
  ]);

const quote = (o: Record<string, unknown> = {}) => ({
  inputMint: SOL_MINT, outputMint: USDC_MINT, inAmount: "1000000000", outAmount: "101734571",
  otherAmountThreshold: "101225899", priceImpactPct: "0", ...o,
});

describe("checkQuote (faille H5)", () => {
  const expected = { inputMint: SOL_MINT, outputMint: USDC_MINT, amount: 1e9 };
  it("accepte un devis conforme à la demande", () => expect(checkQuote(quote(), expected)).toBeNull());
  it("refuse d'autres tokens ou un autre montant", () => {
    expect(checkQuote(quote({ outputMint: "autre" }), expected)).toContain("autres tokens");
    expect(checkQuote(quote({ inAmount: "2000000000" }), expected)).toContain("au lieu de");
  });
  it("refuse un slippage non borné", () => expect(checkQuote(quote({ otherAmountThreshold: "0" }), expected)).toContain("minimal"));
  it("refuse un impact de prix > 1 % (fraction renvoyée par Jupiter)", () => {
    expect(checkQuote(quote({ priceImpactPct: "0.0108" }), expected)).toContain("impact");
    expect(checkQuote(quote({ priceImpactPct: "0.0006" }), expected)).toBeNull();
  });
});

describe("checkSwapMessage : la transaction de l'API ne fait que le swap (faille H5)", () => {
  it("accepte compute budget + enveloppement du SOL vers notre WSOL + Jupiter", () => {
    expect(checkSwapMessage(legit().message, wallet.publicKey)).toBeNull();
  });
  it("refuse un virement de SOL vers un compte tiers glissé dans la transaction", () => {
    const evil = txOf([jupiterIx, SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: attacker, lamports: 5e9 })]);
    expect(checkSwapMessage(evil.message, wallet.publicKey)).toContain("compte tiers");
  });
  it("refuse un programme inconnu au premier niveau", () => {
    const rogue = new TransactionInstruction({ programId: Keypair.generate().publicKey, keys: [], data: Buffer.alloc(0) });
    expect(checkSwapMessage(txOf([jupiterIx, rogue]).message, wallet.publicKey)).toContain("non autorisé");
  });
  it("refuse une transaction dont un autre compte paie les frais", () => {
    expect(checkSwapMessage(txOf([jupiterIx], attacker).message, wallet.publicKey)).toContain("payeur");
  });
});

describe("jupiterSwap : contrôles de bout en bout (API et RPC simulés)", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubApi(q: Record<string, unknown>, tx: VersionedTransaction) {
    vi.stubGlobal("fetch", async (url: string) =>
      String(url).includes("/quote")
        ? new Response(JSON.stringify(q))
        : new Response(JSON.stringify({ swapTransaction: Buffer.from(tx.serialize()).toString("base64"), lastValidBlockHeight: 10 }))
    );
  }
  function connection(o: { simErr?: unknown; confErr?: unknown } = {}) {
    return {
      simulateTransaction: vi.fn(async () => ({ value: { err: o.simErr ?? null } })),
      sendRawTransaction: vi.fn(async () => "sig"),
      confirmTransaction: vi.fn(async () => ({ value: { err: o.confErr ?? null } })),
      getLatestBlockhash: vi.fn(async () => ({ blockhash: "x", lastValidBlockHeight: 10 })),
    };
  }
  const swap = (conn: ReturnType<typeof connection>) =>
    jupiterSwap(conn as unknown as Connection, wallet, SOL_MINT, USDC_MINT, 1e9, false);

  it("swap légitime : simulé, envoyé une fois, confirmé", async () => {
    const conn = connection();
    stubApi(quote(), legit());
    const r = await swap(conn);
    expect(r.ok).toBe(true);
    expect(conn.simulateTransaction).toHaveBeenCalledOnce();
    expect(conn.sendRawTransaction).toHaveBeenCalledOnce();
  });

  it("transaction piégée par l'API : jamais signée ni envoyée", async () => {
    const conn = connection();
    stubApi(quote(), txOf([jupiterIx, SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: attacker, lamports: 5e9 })]));
    const r = await swap(conn);
    expect(r.ok).toBe(false);
    expect(conn.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("simulation en échec : rien n'est envoyé", async () => {
    const conn = connection({ simErr: { InstructionError: [2, "Custom"] } });
    stubApi(quote(), legit());
    expect((await swap(conn)).ok).toBe(false);
    expect(conn.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("transaction confirmée mais en échec on-chain : rapportée comme échec", async () => {
    const conn = connection({ confErr: { InstructionError: [2, "SlippageToleranceExceeded"] } });
    stubApi(quote(), legit());
    const r = await swap(conn);
    expect(r.ok).toBe(false);
    expect(r.note).toContain("on-chain");
  });

  it("devis non conforme : arrêt avant même de demander la transaction", async () => {
    const conn = connection();
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify(quote({ inAmount: "5" }))));
    vi.stubGlobal("fetch", fetchSpy);
    expect((await swap(conn)).ok).toBe(false);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });
});
