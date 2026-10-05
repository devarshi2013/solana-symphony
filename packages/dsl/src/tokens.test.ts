import { describe, expect, it } from "vitest";
import { validateStrategy } from "./schema.js";
import {
  TOKENS,
  TOKEN_SYMBOLS,
  checkTokenSymbol,
  isSupportedSymbol,
  isTodo,
  type TokenInfo,
} from "./tokens.js";
import type { Node, Strategy } from "./types.js";

const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const PYTH_FEED_ID = /^0x[0-9a-f]{64}$/;

describe("token registry", () => {
  it("contains exactly the supported tokens", () => {
    expect(TOKEN_SYMBOLS).toEqual(["SOL", "USDC", "JUP", "JTO", "BONK", "JitoSOL", "mSOL", "WIF"]);
  });

  it.each(Object.entries(TOKENS))("%s has well-formed fields", (key, token: TokenInfo) => {
    expect(token.symbol).toBe(key);
    expect(token.name).not.toBe("");
    if (!isTodo(token.decimals)) {
      expect(Number.isInteger(token.decimals) && token.decimals >= 0).toBe(true);
    }
    if (!isTodo(token.mainnetMint)) expect(token.mainnetMint).toMatch(BASE58_ADDRESS);
    if (token.devnetMint !== null) expect(token.devnetMint).toMatch(BASE58_ADDRESS);
    if (!isTodo(token.pythFeedId)) expect(token.pythFeedId).toMatch(PYTH_FEED_ID);
  });

  it("has no duplicate mints or feed IDs", () => {
    const tokens: TokenInfo[] = Object.values(TOKENS);
    const confirmed = (values: Array<string | number>) =>
      values.filter((v): v is string => typeof v === "string" && !isTodo(v));
    const mints = confirmed(tokens.map((t) => t.mainnetMint));
    const feeds = confirmed(tokens.map((t) => t.pythFeedId));
    expect(new Set(mints).size).toBe(mints.length);
    expect(new Set(feeds).size).toBe(feeds.length);
  });

  it("marks only the unconfirmed WIF mint and decimals as TODO", () => {
    const todos = Object.values(TOKENS).flatMap((t: TokenInfo) =>
      Object.entries(t)
        .filter(([, v]) => isTodo(v))
        .map(([field]) => `${t.symbol}.${field}`),
    );
    expect(todos).toEqual(["WIF.decimals", "WIF.mainnetMint"]);
  });
});

describe("isTodo", () => {
  it("recognises TODO placeholders only", () => {
    expect(isTodo("TODO: confirm")).toBe(true);
    expect(isTodo("So11111111111111111111111111111111111111112")).toBe(false);
    expect(isTodo(9)).toBe(false);
  });
});

describe("checkTokenSymbol", () => {
  it("accepts registered symbols", () => {
    for (const symbol of TOKEN_SYMBOLS) {
      expect(isSupportedSymbol(symbol)).toBe(true);
      expect(checkTokenSymbol(symbol)).toBeUndefined();
    }
  });

  it("suggests the registered spelling when only the case differs", () => {
    expect(checkTokenSymbol("jitosol")).toBe(
      'unsupported token "jitosol"; did you mean "JitoSOL"?',
    );
  });

  it("lists supported symbols for an unknown one", () => {
    expect(checkTokenSymbol("USDT")).toBe(
      'unsupported token "USDT"; supported: SOL, USDC, JUP, JTO, BONK, JitoSOL, mSOL, WIF',
    );
  });

  it("does not treat object prototype keys as tokens", () => {
    expect(isSupportedSymbol("toString")).toBe(false);
  });
});

describe("validateStrategy rejects unsupported tokens", () => {
  const strategy = (root: Node): Strategy => ({
    id: "t",
    name: "T",
    description: "",
    version: 1,
    rebalance: "weekly",
    root,
  });

  it("in asset nodes, with the node's path", () => {
    const result = validateStrategy(
      strategy({
        type: "weight",
        mode: "equal",
        children: [
          { type: "asset", symbol: "SOL" },
          { type: "asset", symbol: "USDT" },
        ],
      }),
    );
    expect(result).toEqual({
      ok: false,
      errors: [
        'root.children[1].symbol: unsupported token "USDT"; supported: SOL, USDC, JUP, JTO, BONK, JitoSOL, mSOL, WIF',
      ],
    });
  });

  it("in condition indicators", () => {
    const result = validateStrategy(
      strategy({
        type: "if",
        condition: {
          lhs: { type: "indicator", name: "price", symbol: "msol" },
          op: ">",
          rhs: { type: "number", value: 1 },
        },
        then: { type: "asset", symbol: "mSOL" },
        else: { type: "asset", symbol: "SOL" },
      }),
    );
    expect(result).toEqual({
      ok: false,
      errors: ['root.condition.lhs.symbol: unsupported token "msol"; did you mean "mSOL"?'],
    });
  });

  it("but ignores the unused symbol on a filter's sortBy", () => {
    const result = validateStrategy(
      strategy({
        type: "filter",
        sortBy: { type: "indicator", name: "rsi", symbol: "anything", window: 14 },
        order: "top",
        select: 1,
        children: [
          { type: "asset", symbol: "JUP" },
          { type: "asset", symbol: "JTO" },
        ],
      }),
    );
    expect(result.ok).toBe(true);
  });
});
