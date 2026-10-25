import { describe, it, expect } from "vitest";
import {
  checkBasicAuth,
  guardRequest,
  hostnameOf,
  safeEqual,
  validateCloseRequest,
  type RequestFacts,
} from "../dashboard/lib/security.js";

const basic = (user: string, pass: string) => "Basic " + btoa(`${user}:${pass}`);
const req = (o: Partial<RequestFacts> = {}): RequestFacts => ({
  method: "GET",
  pathname: "/",
  host: "localhost:3000",
  origin: null,
  contentType: null,
  authorization: null,
  ...o,
});
const post = (o: Partial<RequestFacts> = {}) =>
  req({ method: "POST", pathname: "/api/approvals", origin: "http://localhost:3000", contentType: "application/json", ...o });

describe("dashboard — accès (faille C3)", () => {
  it("sans mot de passe : la machine locale seulement", () => {
    expect(guardRequest(req(), undefined).ok).toBe(true);
    expect(guardRequest(req({ host: "127.0.0.1:3000" }), undefined).ok).toBe(true);
    expect(guardRequest(req({ host: "[::1]:3000" }), undefined).ok).toBe(true);
    const remote = guardRequest(req({ host: "192.168.1.19:3000" }), undefined);
    expect(remote).toMatchObject({ ok: false, status: 403 });
  });

  it("sans mot de passe : un Host étranger (DNS rebinding) est refusé", () => {
    expect(guardRequest(req({ host: "attaquant.example:3000" }), undefined).ok).toBe(false);
  });

  it("avec mot de passe : HTTP Basic exigé partout, identifiant libre", () => {
    expect(guardRequest(req({ host: "vps.example" }), "pw")).toMatchObject({ ok: false, status: 401 });
    expect(guardRequest(req({ host: "vps.example", authorization: basic("x", "faux") }), "pw").ok).toBe(false);
    expect(guardRequest(req({ host: "vps.example", authorization: basic("admin", "pw") }), "pw").ok).toBe(true);
  });

  it("checkBasicAuth : mot de passe contenant « : », en-tête malformé", () => {
    expect(checkBasicAuth(basic("u", "a:b:c"), "a:b:c")).toBe(true);
    expect(checkBasicAuth("Basic !!!", "pw")).toBe(false);
    expect(checkBasicAuth("Bearer xyz", "pw")).toBe(false);
    expect(checkBasicAuth(null, "pw")).toBe(false);
  });
});

describe("dashboard — anti-CSRF sur les modifications", () => {
  it("accepte une requête JSON de même origine", () => {
    expect(guardRequest(post(), undefined).ok).toBe(true);
  });

  it("refuse une origine tierce, même avec des identifiants en cache", () => {
    const evil = post({ origin: "https://site-malveillant.example", host: "vps.example", authorization: basic("a", "pw") });
    expect(guardRequest(evil, "pw")).toMatchObject({ ok: false, status: 403 });
  });

  it("refuse l'absence d'Origin et le text/plain (requête « simple » cross-site)", () => {
    expect(guardRequest(post({ origin: null }), undefined)).toMatchObject({ ok: false, status: 403 });
    expect(guardRequest(post({ contentType: "text/plain" }), undefined)).toMatchObject({ ok: false, status: 415 });
  });

  it("les lectures (GET) ne demandent pas d'Origin", () => {
    expect(guardRequest(req({ pathname: "/api/approvals" }), undefined).ok).toBe(true);
  });
});

describe("dashboard — utilitaires", () => {
  it("hostnameOf retire le port, IPv6 compris", () => {
    expect(hostnameOf("LocalHost:3000")).toBe("localhost");
    expect(hostnameOf("[::1]:3000")).toBe("[::1]");
  });

  it("safeEqual compare sans court-circuit", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});

describe("validateCloseRequest (faille M1)", () => {
  const pk = "G6eJgyVdupYx23TD3auEr9PFtv2q98jk3pbg5nP58rdh";
  it("accepte des clés base58 et nettoie le nom", () => {
    const r = validateCloseRequest({ poolAddress: pk, positionPubkey: pk, poolName: "  RUSH-SOL\u0007 " });
    expect(r).toEqual({ ok: true, value: { poolAddress: pk, positionPubkey: pk, poolName: "RUSH-SOL" } });
  });
  it("refuse une adresse invalide ou du HTML", () => {
    expect(validateCloseRequest({ poolAddress: "pas-une-adresse", positionPubkey: pk, poolName: "x" }).ok).toBe(false);
    expect(validateCloseRequest({ poolAddress: pk, positionPubkey: "<script>alert(1)</script>", poolName: "x" }).ok).toBe(false);
  });
  it("refuse un corps absent ou un nom vide", () => {
    expect(validateCloseRequest(null).ok).toBe(false);
    expect(validateCloseRequest({ poolAddress: pk, positionPubkey: pk, poolName: "\u0000 " }).ok).toBe(false);
  });
});
