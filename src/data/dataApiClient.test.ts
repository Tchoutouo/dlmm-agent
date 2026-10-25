import { describe, it, expect, vi, afterEach } from "vitest";
import { DataApiClient, MAX_OHLCV_RANGE_SECONDS } from "./dataApiClient.js";

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

function okOhlcv(candles: Array<{ timestamp: number; open: number; high: number; low: number; close: number; volume: number }>): Response {
  return new Response(
    JSON.stringify({
      start_time: candles[0]?.timestamp ?? 0,
      end_time: candles[candles.length - 1]?.timestamp ?? 0,
      timeframe: "1h",
      data: candles.map((c) => ({ ...c, timestamp_str: new Date(c.timestamp * 1000).toISOString() })),
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

const CANDLES = [
  { timestamp: 1_700_000_000, open: 100, high: 110, low: 90, close: 105, volume: 500 },
  { timestamp: 1_700_003_600, open: 105, high: 115, low: 100, close: 112, volume: 700 },
  { timestamp: 1_700_007_200, open: 112, high: 120, low: 108, close: 118, volume: 600 },
];

describe("DataApiClient — cas nominaux", () => {
  it("getOhlcv() retourne des bougies triées par timestamp asc", async () => {
    const shuffled = [...CANDLES].reverse();
    mockFetch([okOhlcv(shuffled)]);
    const client = new DataApiClient("https://fake.api");
    const candles = await client.getOhlcv("pool1", "1h", 96);
    expect(candles).toHaveLength(3);
    expect(candles[0]!.timestamp).toBeLessThan(candles[1]!.timestamp);
    expect(candles[1]!.timestamp).toBeLessThan(candles[2]!.timestamp);
  });

  it("tous les champs OHLCV sont présents", async () => {
    mockFetch([okOhlcv(CANDLES)]);
    const client = new DataApiClient("https://fake.api");
    const [c] = await client.getOhlcv("pool1", "1h", 96);
    expect(c).toMatchObject({ timestamp: expect.any(Number), open: expect.any(Number), high: expect.any(Number), low: expect.any(Number), close: expect.any(Number), volume: expect.any(Number) });
  });

  it("retourne un tableau vide si l'API renvoie data: []", async () => {
    mockFetch([okOhlcv([])]);
    const client = new DataApiClient("https://fake.api");
    const candles = await client.getOhlcv("pool1");
    expect(candles).toHaveLength(0);
  });
});

describe("DataApiClient — fenêtre max de l'API (4 jours)", () => {
  it("découpe 168 bougies 1h (7 jours) en 2 requêtes ≤ 4 jours et fusionne sans doublon", async () => {
    const urls: string[] = [];
    const responses = [okOhlcv([CANDLES[0]!, CANDLES[1]!]), okOhlcv([CANDLES[1]!, CANDLES[2]!])];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      return responses[urls.length - 1]!;
    });
    const client = new DataApiClient("https://fake.api");
    const candles = await client.getOhlcv("pool1", "1h", 168);

    expect(urls).toHaveLength(2);
    for (const u of urls) {
      const q = new URL(u).searchParams;
      const span = Number(q.get("end_time")) - Number(q.get("start_time"));
      expect(span).toBeLessThanOrEqual(MAX_OHLCV_RANGE_SECONDS);
    }
    // Tranches contiguës : la 2e commence où finit la 1re
    expect(new URL(urls[1]!).searchParams.get("start_time")).toBe(new URL(urls[0]!).searchParams.get("end_time"));
    expect(candles.map((c) => c.timestamp)).toEqual(CANDLES.map((c) => c.timestamp));
  });

  it("une seule requête quand la période tient dans 4 jours", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      return okOhlcv(CANDLES);
    });
    const client = new DataApiClient("https://fake.api");
    await client.getOhlcv("pool1", "1h", 96);
    expect(calls).toBe(1);
  });
});

describe("DataApiClient — gestion des erreurs et retry", () => {
  it("retry sur HTTP 429 et réussit à la 2e tentative", async () => {
    mockFetch([
      new Response("", { status: 429 }),
      okOhlcv(CANDLES),
    ]);
    const client = new DataApiClient("https://fake.api");
    const candles = await client.getOhlcv("pool1");
    expect(candles).toHaveLength(3);
  });

  it("retry 3 fois puis lève une erreur sur erreurs persistantes", async () => {
    mockFetch([
      new Response("", { status: 503 }),
      new Response("", { status: 503 }),
      new Response("", { status: 503 }),
    ]);
    const client = new DataApiClient("https://fake.api");
    await expect(client.getOhlcv("pool1")).rejects.toThrow("Data API OHLCV");
  });

  it("ne réessaie pas une erreur 400 (requête invalide)", async () => {
    mockFetch([new Response("", { status: 400 })]); // un 2e appel ferait échouer le mock
    const client = new DataApiClient("https://fake.api");
    await expect(client.getOhlcv("pool1")).rejects.toThrow("HTTP 400");
  });

  it("retry sur TypeError réseau", async () => {
    mockFetch([
      new TypeError("fetch failed"),
      okOhlcv(CANDLES),
    ]);
    const client = new DataApiClient("https://fake.api");
    const candles = await client.getOhlcv("pool1");
    expect(candles).toHaveLength(3);
  });

  it("lève une erreur après 3 TypeErrors consécutives", async () => {
    mockFetch([
      new TypeError("fetch failed"),
      new TypeError("fetch failed"),
      new TypeError("fetch failed"),
    ]);
    const client = new DataApiClient("https://fake.api");
    await expect(client.getOhlcv("pool1")).rejects.toThrow();
  });
});

describe("DataApiClient — rate limiter", () => {
  it("rate limiter token bucket : acquiert le premier token sans délai", async () => {
    mockFetch([okOhlcv(CANDLES)]);
    const client = new DataApiClient("https://fake.api");
    const t0 = Date.now();
    await client.getOhlcv("pool1");
    // Premier appel doit être quasi-instantané (< 200 ms)
    expect(Date.now() - t0).toBeLessThan(200);
  });
});
