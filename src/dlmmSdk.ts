import { createRequire } from "node:module";

// tsx resolves @meteora-ag/dlmm via its "source" field, loading the package's
// TypeScript source. That source does `import { BN } from "@coral-xyz/anchor"`.
// Anchor's CJS module defines BN via Object.defineProperty — invisible to Node.js's
// named-export static analyzer — causing a SyntaxError at link time.
// createRequire bypasses tsx's resolver and loads CJS dist/index.js directly,
// which uses require('@coral-xyz/anchor') and avoids the static analysis entirely.
const _require = createRequire(import.meta.url);

// CJS dist/index.js: module.exports = exports.default (DLMM class),
// then every named export is copied onto it (for key in exports → module.exports[key]).
type _M = typeof import("@meteora-ag/dlmm");

const _sdk = _require("@meteora-ag/dlmm") as _M["default"] & {
  StrategyType: _M["StrategyType"];
  autoFillYByStrategy: _M["autoFillYByStrategy"];
};

export default _sdk as _M["default"];
export const StrategyType = _sdk.StrategyType;
export const autoFillYByStrategy = _sdk.autoFillYByStrategy;
