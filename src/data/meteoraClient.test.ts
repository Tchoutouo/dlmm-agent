import { describe, it, expect, vi, afterEach } from "vitest";
import { MeteoraClient } from "./meteoraClient.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function mockFetch(responses: Array<Response | Error>) {
  let call = 0;
  vi.stubGlobal("fetch", async () => {
    const r = responses[call++];
    if (!r) throw new Error("fetch called more times than expected");
    if (r instanceof Error) throw r;
    return r;
  });
}

function okJson(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function errResponse(status: number): Response {
  return new Response("", { status });
}

const POOL_STUB = {
  address: "pool1",
  name: "SOL-USDC",
  token_x: { address: "mintX", is_verified: true },
  token_y: { address: "mintY", is_verified: false },
  pool_config: { bin_step: 25, base_fee_pct: 0.25 },
  tvl: "100000",
  current_price: "150",
  apr: "50",
  volume: { "24h": "500000" },
  fees: { "24h": "1500" },
  fee_tvl_ratio: { "24h": "0.0015", "1h": "0.00006" },
  is_blacklisted: false,
};

describe("MeteoraClient — cas nominaux", () => {
  it("getAllPairs() normalise et retourne les pools", async () => {
    mockFetch([okJson({ data: [POOL_STUB], total: 1, pages: 1, current_page: 1, page_size: 1000 })]);
    const client = new MeteoraClient("https://fake.api");
    const pools = await client.getAllPairs();
    expect(pools).toHaveLength(1);
    expect(pools[0]!.address).toBe("pool1");
    expect(pools[0]!.currentPrice).toBe(150);
    expect(pools[0]!.isVerified).toBe(true);
  });

  it("getPair() retourne une pool normalisée", async () => {
    mockFetch([okJson(POOL_STUB)]);
    const client = new MeteoraClient("https://fake.api");
    const pool = await client.getPair("pool1");
    expect(pool.address).toBe("pool1");
    expect(pool.liquidityUsd).toBe(100_000);
  });
});

describe("MeteoraClient — gestion des erreurs et retry", () => {
  it("retry sur HTTP 503 et réussit à la 2e tentative", async () => {
    mockFetch([
      errResponse(503),
      okJson({ data: [POOL_STUB], total: 1, pages: 1, current_page: 1, page_size: 1000 }),
    ]);
    const client = new MeteoraClient("https://fake.api");
    const pools = await client.getAllPairs();
    expect(pools).toHaveLength(1);
  });

  it("retry jusqu'à 3 fois puis lève une erreur", async () => {
    mockFetch([errResponse(500), errResponse(500), errResponse(500)]);
    const client = new MeteoraClient("https://fake.api");
    await expect(client.getAllPairs()).rejects.toThrow("Meteora API");
  });

  it("retry sur erreur réseau (TypeError fetch failed)", async () => {
    mockFetch([
      new TypeError("fetch failed"),
      okJson({ data: [], total: 0, pages: 1, current_page: 1, page_size: 1000 }),
    ]);
    const client = new MeteoraClient("https://fake.api");
    const pools = await client.getAllPairs();
    expect(pools).toHaveLength(0);
  });

  it("lève une erreur après 3 erreurs réseau consécutives", async () => {
    mockFetch([
      new TypeError("fetch failed"),
      new TypeError("fetch failed"),
      new TypeError("fetch failed"),
    ]);
    const client = new MeteoraClient("https://fake.api");
    await expect(client.getAllPairs()).rejects.toThrow();
  });

  it("données manquantes (null) converties en 0 par toNum", async () => {
    const partial = {
      ...POOL_STUB,
      tvl: null,
      current_price: null,
      volume: null,
      fees: null,
      fee_tvl_ratio: null,
    };
    mockFetch([okJson({ data: [partial], total: 1, pages: 1, current_page: 1, page_size: 1000 })]);
    const client = new MeteoraClient("https://fake.api");
    const [pool] = await client.getAllPairs();
    expect(pool!.liquidityUsd).toBe(0);
    expect(pool!.currentPrice).toBe(0);
  });
});
