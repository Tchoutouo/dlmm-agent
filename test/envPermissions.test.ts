import { describe, it, expect } from "vitest";
import { envPermissionIssue } from "../src/execution/wallet.js";

describe("droits du .env qui contient la clé (faille M2)", () => {
  it("accepte 600 et 400 (propriétaire seul)", () => {
    expect(envPermissionIssue(0o100600, "linux")).toBeNull();
    expect(envPermissionIssue(0o100400, "linux")).toBeNull();
  });
  it("signale 664 et 644 (lisible par d'autres comptes)", () => {
    expect(envPermissionIssue(0o100664, "linux")).toContain("chmod 600");
    expect(envPermissionIssue(0o100644, "darwin")).toContain("644");
  });
  it("ignore Windows, où ces droits ne s'appliquent pas", () => {
    expect(envPermissionIssue(0o100666, "win32")).toBeNull();
  });
});
