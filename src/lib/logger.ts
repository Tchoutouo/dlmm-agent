/**
 * Logger structuré léger — sortie JSON sur stdout/stderr, sans dépendance externe.
 *
 * Chaque ligne est un objet JSON valide, lisible par Datadog, Loki, Splunk, etc.
 * Le niveau minimum est contrôlé par la variable LOG_LEVEL (défaut: info).
 * En mode debug, les champs de contexte additionnels sont inclus dans l'objet.
 */

type Level = "debug" | "info" | "warn" | "error";

const WEIGHT: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function minLevel(): Level {
  const env = process.env["LOG_LEVEL"]?.toLowerCase();
  if (env === "debug" || env === "info" || env === "warn" || env === "error") return env;
  return "info";
}

function emit(level: Level, msg: string, ctx: Record<string, unknown>): void {
  if (WEIGHT[level] < WEIGHT[minLevel()]) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...ctx });
  if (level === "error" || level === "warn") {
    process.stderr.write(line + "\n");
  } else {
    process.stdout.write(line + "\n");
  }
}

export type Logger = {
  debug: (msg: string, ctx?: Record<string, unknown>) => void;
  info:  (msg: string, ctx?: Record<string, unknown>) => void;
  warn:  (msg: string, ctx?: Record<string, unknown>) => void;
  error: (msg: string, ctx?: Record<string, unknown>) => void;
  child: (base: Record<string, unknown>) => Logger;
};

function makeLogger(base: Record<string, unknown> = {}): Logger {
  return {
    debug: (msg, ctx = {}) => emit("debug", msg, { ...base, ...ctx }),
    info:  (msg, ctx = {}) => emit("info",  msg, { ...base, ...ctx }),
    warn:  (msg, ctx = {}) => emit("warn",  msg, { ...base, ...ctx }),
    error: (msg, ctx = {}) => emit("error", msg, { ...base, ...ctx }),
    child: (extra)         => makeLogger({ ...base, ...extra }),
  };
}

export const logger = makeLogger();
