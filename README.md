# solana-symphony

pnpm monorepo for strategy design, backtesting, and on-chain vault rebalancing on Solana.

## Layout

| Path                    | What it is                                       |
| ----------------------- | ------------------------------------------------ |
| `packages/dsl`          | Strategy language + evaluator                    |
| `packages/data`         | Historical price data loader                     |
| `packages/backtester`   | Backtest engine + `backtester` CLI               |
| `packages/vault-client` | TypeScript client for the on-chain vault (empty) |
| `programs/vault`        | Anchor program (empty)                           |
| `apps/keeper`           | Rebalancing bot (Node)                           |
| `apps/web`              | Next.js app (empty)                              |

## Requirements

Run `~/scripts/check-env.sh` — Node 20+, pnpm, Rust, Solana CLI, Anchor (via avm), git.
The Anchor program builds with the Rust version pinned in `rust-toolchain.toml`.

## Scripts

```sh
pnpm install
pnpm build          # build all TS packages and the web app
pnpm test           # vitest in every package
pnpm lint           # eslint over the whole repo
pnpm typecheck      # tsc --noEmit, tests included
pnpm format         # prettier --write
pnpm build:program  # anchor build
```
