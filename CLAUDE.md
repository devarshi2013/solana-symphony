# solana-symphony

A Composer.trade-style no-code strategy builder for Solana. Users build a strategy as a
JSON logic tree, backtest it against historical prices, then deposit into an on-chain vault
that a keeper bot rebalances via Jupiter swaps.

## Layout

- `packages/dsl` — strategy language: the JSON logic-tree format and its evaluator
- `packages/data` — loads and caches historical price data
- `packages/backtester` — backtest engine and the `backtester` CLI (uses dsl + data)
- `packages/config` — loads `.env` and validates it with zod into a typed config (`getConfig()`)
- `packages/vault-client` — TypeScript client for the on-chain vault program
- `programs/vault` — Anchor program that holds user deposits and enforces vault rules
- `apps/keeper` — Node bot that evaluates strategies and rebalances vaults via Jupiter
- `apps/web` — Next.js app for building, backtesting, and depositing

Most of these are empty scaffolds; check the code before assuming something exists.

## Stack

- pnpm workspaces (`pnpm-workspace.yaml`), Node 20+
- TypeScript in strict mode everywhere; shared `tsconfig.base.json` (NodeNext modules;
  `apps/web` overrides to Bundler for Next.js). Use `.js` extensions in relative imports.
- vitest for tests, colocated as `src/**/*.test.ts`
- ESLint (flat config) + Prettier
- Anchor 1.2.0 for the Rust program; Rust toolchain pinned in `rust-toolchain.toml`
- Next.js for the web app

## Commands

```sh
pnpm build          # all TS packages + web app
pnpm test           # vitest in every package
pnpm lint           # eslint over the repo
pnpm typecheck      # tsc --noEmit, tests included
pnpm format         # prettier --write
pnpm build:program  # anchor build
```

Run `pnpm lint`, `pnpm typecheck`, and `pnpm test` before calling work done.

## Rules

- **Keep functions pure where possible.** Strategy evaluation and backtesting must be
  deterministic: no I/O, clocks, or randomness inside them; pass data in as arguments.
  Put network, file, and chain access at the edges (data loader, keeper, CLI).
- **Every package has tests.** New behaviour ships with vitest tests in the same package.
- **Never commit secrets or keypairs.** No `.env` files, private keys, wallet JSON, or
  RPC/API keys in git. `.gitignore` covers these; don't override it.
- **Never let the keeper withdraw user funds.** The keeper may only trigger rebalancing
  swaps inside a vault. The vault program must enforce this on-chain: the keeper's
  authority must not be able to withdraw or transfer funds out of the vault, and only the
  depositor may withdraw their own funds.
