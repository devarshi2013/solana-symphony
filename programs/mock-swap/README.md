# mock-swap — TEST-ONLY, devnet only

> **Never deploy this program to mainnet, and never point a real vault at it.** It exists so
> the vault's `swap` can be tested end to end on devnet with test mints, before Jupiter is
> wired in. It is not safe for real funds.

A stand-in for Jupiter: one global `Market` PDA (`["market"]`) holding liquidity in its
associated token accounts, trading at prices an admin sets by hand.

| Instruction                        | Who                          | Effect                                                                                                                                      |
| ---------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `init_market`                      | anyone, once                 | Creates the market; the signer becomes admin.                                                                                               |
| `set_price(mint, price, exponent)` | admin                        | USD price per whole token = `price × 10^exponent` (Pyth's convention).                                                                      |
| `swap(amount_in, min_out)`         | anyone (signs for its input) | Pays `amount_in × p_in / p_out`, scaled by mint decimals, rounded down. Fails if that is 0, below `min_out`, or more than the market holds. |

Why it is unsafe, on purpose: whoever calls `init_market` first is admin; prices are whatever
the admin types; there are no fees, no oracle and no way to withdraw liquidity.

**Funding liquidity:** create the market PDA's ATA for each test mint
(`create_idempotent`) and transfer test tokens into it.

**How the vault uses it:** only a vault built with the `devnet-mock` feature
(`pnpm build:program:devnet-mock`) sends its `swap` here. The keeper passes this program's
`swap` instruction (data as `route_data`, accounts as remaining accounts, with the vault as
`user`) exactly as it would pass Jupiter's. The vault's own checks (oracle minimum, balance deltas, route
screening) still apply, so a mock price that is worse than the Pyth price by more than the
vault's slippage makes the vault reject the swap. That is how the slippage protection is
tested. The default vault build cannot call this program.

Program ID: `pG9QphRAdj8stz3vLU4W7MHkmg3c5ehp9Q779xroqjP` (keypair in
`target/deploy/mock_swap-keypair.json`, gitignored).
