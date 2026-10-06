# vault

Anchor program for the on-chain vault. Design: [docs/vault-design.md](../../docs/vault-design.md).

Implemented: all instructions. `swap` invokes Jupiter v6
(`JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4`) with the keeper's route (Jupiter's
`swapInstruction` data and accounts from `GET /swap/v2/build`), signed by the vault PDA, and
enforces every check in the design around it: paused, cooldown, mints, Pyth prices, route
screening, balance deltas, oracle minimum and post-conditions. How the keeper builds the
transaction, and Jupiter's limits (transaction size, account count, CPI depth): design §4.8.

### `devnet-mock` feature (TEST-ONLY)

Building with `--features devnet-mock` pins [`programs/mock-swap`](../mock-swap), a
hand-priced test venue, instead of Jupiter, so swaps can be tested on devnet with test
mints. Only the pinned program ID changes: the keeper passes mock-swap's `swap` instruction
the same way it passes Jupiter's. **Never enable it for mainnet.** `pnpm build:program:devnet-mock`
writes that build to `target/deploy-devnet-mock/vault.so`, separate from the normal
`target/deploy/vault.so`, so it cannot replace it by accident. Every vault check still
applies in that build.

[`src/price.rs`](src/price.rs) reads Pyth prices (`pyth-solana-receiver-sdk` 2.0, the first
release for Anchor 1.x) and computes the oracle minimum output for `swap`: `read_price`
(fully verified, right feed, no older than `max_oracle_staleness_secs`, positive, confidence
≤ 2%) and `min_output_amount` (u128, one rounding down, overflow is an error). `swap` takes
its two price accounts as `Account<PriceUpdateV2>`, so Anchor checks they are owned by the
Pyth receiver program.

```sh
pnpm build:program     # anchor build --arch v0 (Rust 1.89, pinned in rust-toolchain.toml)
pnpm build:program:devnet-mock  # also the TEST-ONLY mock-swap vault build
pnpm test:program      # both builds, Rust unit tests, LiteSVM integration tests (no validator)
pnpm test:program:ts   # TypeScript tests via anchor test on a local solana-test-validator
```

**Always build with `--arch v0`.** Anchor 1.2 defaults to SBPF v3, but the SBPF v3 feature
(`BUwGLeF3Lxyfv1J1wY8biFHBB2hrk2QhbNftQf3VV3cC`) is inactive on devnet and mainnet, so a v3
build cannot be deployed or run there. The scripts above pass the flag; a plain
`anchor build` does not.

### Rust tests

[`tests/vault-litesvm`](../../tests/vault-litesvm) runs the compiled `target/deploy/vault.so`
in LiteSVM, covering every instruction and attack in detail. It is a separate crate on Rust
1.97.1 (needed by LiteSVM 0.17), so `anchor build` never compiles it.

### TypeScript tests

[`tests/vault.test.ts`](tests/vault.test.ts) (vitest + the Anchor TS client) runs end to end
on a real local validator: it creates two test SPL mints standing in for USDC and SOL, runs the
happy path and checks the main attacks fail with the right error. `anchor test` is configured
to run them; the script also forces `--provider.cluster localnet` (Anchor.toml's provider is
devnet), picks the legacy solana-test-validator (Anchor's default, Surfpool, is not installed)
and uses a throwaway wallet in `target/test-wallet.json` (gitignored), created on first run.
solana-bankrun was tried and cannot load the program: it is built on Solana 1.18.

### Optional: a real Jupiter swap on a mainnet fork

[`tests/jupiter-fork.test.ts`](tests/jupiter-fork.test.ts) runs one real swap, 10 USDC to
SOL, through the vault and Jupiter v6 on a local `solana-test-validator` that clones what
the route needs from mainnet. It is skipped in every other run.

```sh
pnpm test:jupiter-fork
# optional: MAINNET_RPC_URL=<your RPC>  JUP_API_KEY=<key>  JUPITER_FORK_DEXES=Whirlpool
```

What it does:

1. Asks Jupiter `GET /swap/v2/build` for a route with the vault PDA as taker (keyless API,
   0.5 requests/s; restricted to `JUPITER_FORK_DEXES`, default `Whirlpool`, because some
   proprietary AMMs inspect the calling transaction and refuse CPI callers).
2. Clones from mainnet:
   - Jupiter and the AMM programs (`--clone-upgradeable-program`)
   - every other route account, and the USDC and wSOL mints (`--clone`)
   - mainnet's feature set (`--clone-feature-set`)
   - the Pyth SOL/USD and USDC/USD sponsored price accounts, copied unmodified once both
     hold updates at most 30 s old, published within 25 s of each other (the vault allows 30)
3. Writes the vault's token accounts (20 USDC, empty wSOL) into genesis, deploys
   `target/deploy/vault.so` (the normal, Jupiter-pinned build) and creates the vault.
4. Builds the keeper transaction: Jupiter's `swapInstruction` data as `route_data`, its
   accounts as remaining accounts. It creates a lookup table and sends a v0 transaction, then
   checks the `Swapped` event and the balances.

A run takes about 80 s. Only throwaway keys and token mints are sent to Jupiter, and nothing
is sent to mainnet. The validator runs on port 18899 with its ledger in
`target/jupiter-fork/`, and its log is in `target/jupiter-fork/validator.log`.

It can fail for reasons outside the vault: no route on the chosen DEX, the public RPC's rate
limits (set `MAINNET_RPC_URL`), or Pyth updating slowly. Pyth's Hermes price API now needs a
key, which is why the test reads the on-chain accounts instead.

### Deploy to devnet

```sh
pnpm deploy:devnet
```

[`scripts/deploy-devnet.ts`](../../scripts/deploy-devnet.ts) builds and then:

1. **Checks the cluster.** It refuses anything but devnet (by genesis hash), apart from a
   local validator used for rehearsals: `DEVNET_RPC_URL=http://127.0.0.1:<port>` writes
   `deployments/localnet.json` instead.
2. **Checks the deployer's balance.** The deployer is `keypairs/devnet-deployer.json`
   (gitignored), created on first run; override it with `DEPLOYER_KEYPAIR`. The script
   airdrops if the balance is low. The devnet airdrop is often rate-limited; if it fails, the
   script stops and prints the address to fund at https://faucet.solana.com. A first deploy
   needs about 5 SOL and spends about 3.5; the upload buffers are refunded.
3. **Deploys the programs:** the vault (**TEST-ONLY `devnet-mock` build**, so swaps go to
   mock-swap) and mock-swap, with the program keypairs in `target/deploy/`. A program is
   skipped if its on-chain bytes already match the local build, and upgraded if they don't.
4. **Creates the test mints** tUSDC (6 decimals), tSOL (9) and tJUP (6). The deployer is the
   mint authority. Existing mints are reused.
5. **Seeds mock-swap:**
   - creates the market, with the deployer as admin
   - sets prices from Pyth's devnet price accounts for USDC/USD, SOL/USD and JUP/USD, falling
     back to fixed prices
   - tops each market token account up to its target liquidity
6. **Writes everything** to `deployments/devnet.json`: program IDs, build hashes, mints with
   their Pyth feed IDs and price accounts, the market and its token accounts. It saves after
   every step.

Re-running is safe: each step checks the chain and does only what is missing or out of
date. A second run with nothing to do sends no transactions (rehearsed on a local
validator). Re-run it to refresh the mock prices.

The program keypair is `target/deploy/vault-keypair.json` (gitignored). If you lose it, run
`anchor keys sync` to generate a new one and update the program ID in `src/lib.rs` and
`Anchor.toml`.
