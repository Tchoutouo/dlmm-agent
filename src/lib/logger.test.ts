import { describe, it, expect, vi, afterEach } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env["LOG_LEVEL"];
});

function captureStdout(): string[] {
  const lines: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    lines.push(String(chunk).trim());
    return true;
  });
  return lines;
}

function captureStderr(): string[] {
  const lines: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    lines.push(String(chunk).trim());
    return true;
  });
  return lines;
}

// Logger est importé après chaque test car LOG_LEVEL est lu dynamiquement
async function freshLogger() {
  // Vitest module cache — on re-importe le même module (singleton) ; suffit pour tester l'API
  const { logger } = await import("./logger.js");
  return logger;
}

describe("logger — structure JSON", () => {
  it("info produit une ligne JSON valide sur stdout", async () => {
    const lines = captureStdout();
    const log = await freshLogger();
    log.info("test message", { pool: "SOL-USDC" });
    expect(lines).toHaveLength(1);
    const obj = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(obj.level).toBe("info");
    expect(obj.msg).toBe("test message");
    expect(obj.pool).toBe("SOL-USDC");
  });

  it("le champ ts est une ISO 8601 valide", async () => {
    const lines = captureStdout();
    const log = await freshLogger();
    log.info("ts check");
    const obj = JSON.parse(lines[0]!) as { ts: string };
    expect(() => new Date(obj.ts).toISOString()).not.toThrow();
  });

  it("warn et error écrivent sur stderr, pas stdout", async () => {
    const outLines = captureStdout();
    const errLines = captureStderr();
    const log = await freshLogger();
    log.warn("attention");
    log.error("erreur critique", { code: 42 });
    expect(outLines).toHaveLength(0);
    expect(errLines).toHaveLength(2);
    expect(JSON.parse(errLines[0]!)).toMatchObject({ level: "warn" });
    expect(JSON.parse(errLines[1]!)).toMatchObject({ level: "error", code: 42 });
  });

  it("child() fusionne le contexte de base avec le contexte additionnel", async () => {
    const lines = captureStdout();
    const log = await freshLogger();
    const child = log.child({ module: "TestModule" });
    child.info("événement", { key: "value" });
    const obj = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(obj.module).toBe("TestModule");
    expect(obj.key).toBe("value");
    expect(obj.msg).toBe("événement");
  });

  it("debug est supprimé quand LOG_LEVEL=info (défaut)", async () => {
    process.env["LOG_LEVEL"] = "info";
    const lines = captureStdout();
    const log = await freshLogger();
    log.debug("debug caché");
    log.info("info visible");
    // Seule la ligne info doit apparaître
    expect(lines).toHaveLength(1);
    const obj = JSON.parse(lines[0]!) as { level: string };
    expect(obj.level).toBe("info");
  });

  it("debug apparaît quand LOG_LEVEL=debug", async () => {
    process.env["LOG_LEVEL"] = "debug";
    const lines = captureStdout();
    const log = await freshLogger();
    log.debug("debug visible");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: "debug" });
  });

  it("child().child() accumule le contexte sur plusieurs niveaux", async () => {
    const lines = captureStdout();
    const log = await freshLogger();
    const grandchild = log.child({ a: 1 }).child({ b: 2 });
    grandchild.info("deep");
    const obj = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(obj.a).toBe(1);
    expect(obj.b).toBe(2);
  });
});
