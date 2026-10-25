import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { JobLock } from "../src/lib/jobLock.js";
import { processCloseRequests, recoverStuckCloseRequests } from "../src/execution/closeRequests.js";
import type { RealExecutor } from "../src/execution/realExecutor.js";
import type { TradeJournal } from "../src/journal/journal.js";

describe("JobLock : un seul job on-chain à la fois (faille M5)", () => {
  it("ignore un job qui arrive pendant qu'un autre tourne", async () => {
    const lock = new JobLock();
    let release!: () => void;
    const slow = lock.runExclusive("scan", () => new Promise<void>((r) => (release = r)));
    const second = vi.fn(async () => {});
    expect(await lock.runExclusive("marquage", second)).toBe(false);
    expect(second).not.toHaveBeenCalled();
    release();
    expect(await slow).toBe(true);
    expect(await lock.runExclusive("marquage", second)).toBe(true);
  });

  it("se libère même si le job échoue", async () => {
    const lock = new JobLock();
    await expect(lock.runExclusive("scan", async () => { throw new Error("RPC"); })).rejects.toThrow("RPC");
    expect(lock.busy).toBeNull();
  });
});

describe("demandes de clôture : reprise après arrêt du démon (faille M5)", () => {
  function db() {
    const path = join(mkdtempSync(join(tmpdir(), "dlmm-close-")), "j.db");
    recoverStuckCloseRequests(path); // crée la table
    const add = (status: string) =>
      new Database(path)
        .prepare(`INSERT INTO close_requests (pool_address, position_pubkey, pool_name, requested_at, status) VALUES ('p','pos','P',datetime(),?)`)
        .run(status);
    const statuses = () => (new Database(path).prepare(`SELECT status FROM close_requests ORDER BY id`).all() as Array<{ status: string }>).map((r) => r.status);
    return { path, add, statuses };
  }

  it("une demande restée PROCESSING repasse PENDING au démarrage", () => {
    const { path, add, statuses } = db();
    add("PROCESSING");
    add("DONE");
    expect(recoverStuckCloseRequests(path)).toBe(1);
    expect(statuses()).toEqual(["PENDING", "DONE"]);
  });

  it("traite les demandes PENDING et enregistre le résultat", async () => {
    const { path, add, statuses } = db();
    add("PENDING");
    add("PENDING");
    const manager = {
      closeByRequest: vi
        .fn()
        .mockResolvedValueOnce({ ok: true, note: "fermée", txHash: "tx" })
        .mockResolvedValueOnce({ ok: false, note: "Position non suivie par l'agent" }),
    };
    const n = await processCloseRequests(path, manager, {} as RealExecutor, {} as TradeJournal);
    expect(n).toBe(2);
    expect(statuses()).toEqual(["DONE", "ERROR"]);
  });
});
