# Vault program design

Status: **draft for approval**. No Rust is written until this is approved.

## 1. Purpose and trust model

Each user owns their own vault. The owner deposits tokens; an off-chain keeper bot
rebalances the vault by swapping between the vault's own token accounts through Jupiter.
The program's job is to make the keeper powerless to take funds, even if the keeper key is
stolen or the keeper software is buggy.

| Actor       | Trusted for                                           | Not trusted for                                        |
| ----------- | ----------------------------------------------------- | ------------------------------------------------------ |
| Owner       | Everything about their own vault; can always withdraw | Nothing beyond their vault                             |
| Keeper      | Choosing _when_ and _what_ to swap, within limits     | Custody; prices; destinations; programs called         |
| Pyth oracle | USD prices, within staleness and confidence limits    | Prices that are stale, uncertain or for the wrong feed |
| Jupiter     | Executing a route                                     | Delivering a fair amount (checked by balance deltas)   |

The one-line rule, from CLAUDE.md: **the keeper can never withdraw user funds.** Every
check in §6 exists to keep that true.

Because each vault has a single owner, there is no share accounting: the vault's token
balances simply belong to its owner. Pooled multi-depositor vaults are out of scope.

## 2. Accounts

### 2.1 `Vault` (PDA)

Seeds: `["vault", owner, vault_id.to_le_bytes()]`, bump stored.

| Field                       | Type                       | Notes                                                                                            |
| --------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------ |
| `owner`                     | `Pubkey`                   | Signs every instruction except `swap`. Immutable.                                                |
| `vault_id`                  | `u64`                      | **Added:** needed to re-derive the PDA from the account alone. Immutable.                        |
| `keeper`                    | `Pubkey`                   | `Pubkey::default()` means no keeper (swaps disabled).                                            |
| `allowed_mints`             | `Vec<AllowedMint>`, max 10 | See 2.2. No duplicates.                                                                          |
| `max_slippage_bps`          | `u16`                      | Swap output may be at most this far below the oracle value. 1 ≤ x ≤ `MAX_SLIPPAGE_CAP_BPS` (5%). |
| `max_oracle_staleness_secs` | `u32`                      | 1 ≤ x ≤ `MAX_STALENESS_CAP_SECS`.                                                                |
| `strategy_hash`             | `[u8; 32]`                 | SHA-256 of the strategy JSON the keeper should run. **Informational only** (§7).                 |
| `paused`                    | `bool`                     | Blocks `swap` only.                                                                              |
| `last_swap_ts`              | `i64`                      | **Added (open question Q5):** for a swap cooldown.                                               |
| `bump`                      | `u8`                       | Canonical bump.                                                                                  |
| `max_daily_loss_usd`        | `u64`                      | **Added (security review H-1):** most the vault may lose to swaps per 24 h, micro-USD.           |
| `loss_window_start`         | `i64`                      | Start of the current 24 h loss window.                                                           |
| `loss_in_window_usd`        | `u64`                      | Losses counted in the current window, micro-USD.                                                 |
| `_reserved`                 | `[u8; 40]`                 | Space for future fields without reallocating.                                                    |

Size: 8 (discriminator) + 32 + 8 + 32 + (4 + 10 × 64) + 2 + 4 + 32 + 1 + 8 + 1 + 8 + 8 + 8 + 40 = **836 bytes**,
allocated at the maximum (10 mints) so `update_config` never needs to reallocate.

### 2.2 `AllowedMint`

| Field          | Type       | Notes                                                                                                                                                                                                                     |
| -------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mint`         | `Pubkey`   | Must be owned by the classic SPL Token program (§6.8).                                                                                                                                                                    |
| `pyth_feed_id` | `[u8; 32]` | **Added:** the Pyth USD feed for this mint (e.g. SOL/USD for wSOL). The swap uses it to pick the right price account; without it the keeper could pass any price. Values come from the dsl token registry (`pythFeedId`). |

### 2.3 Vault token accounts

One associated token account (ATA) per mint, with **authority = the vault PDA**:
`ATA(owner = vault, mint, token_program = SPL Token)`.

- Created by `deposit` with Anchor's `init_if_needed` the first time a mint is deposited
  (the owner pays the rent). This is safe here: the account is an ATA, whose address is
  fixed by (vault, mint, token program). Only the ATA program can create it and no one can
  re-initialise it. When it already exists, Anchor checks the address, mint and authority
  before use. Anyone may also pre-create it with `create_idempotent`; that changes nothing.
- Every instruction that touches one **re-derives the ATA address** and requires an exact
  match. A token account merely _owned_ by the vault PDA is not enough (an attacker could
  create a second, non-canonical account with the same authority).
- wSOL is held as wrapped SOL in its ATA; the program never handles native SOL.

## 3. Constants

| Name                       | Value                 | Why                                                                                                                                                         |
| -------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MAX_ALLOWED_MINTS`        | 10                    | Per the spec; bounds account size and compute.                                                                                                              |
| `MAX_SLIPPAGE_CAP_BPS`     | 500 (5%)              | Hard ceiling an owner cannot exceed, limiting the loss per swap if the keeper is compromised. **Q2**                                                        |
| `MAX_STALENESS_CAP_SECS`   | 120                   | Daily strategies do not need older prices. **Q2**                                                                                                           |
| `MAX_CONFIDENCE_BPS`       | 200 (2%)              | Reject a price whose Pyth confidence interval is wider than 2% of the price. **Q3**                                                                         |
| `JUPITER_PROGRAM_ID`       | Jupiter v6 aggregator | The only program `swap` may call. Pinned in code; the exact address is taken from Jupiter's official docs at implementation time.                           |
| `PYTH_RECEIVER_PROGRAM_ID` | Pyth Solana Receiver  | Owner of valid price-update accounts. Confirm the current program and account type against Pyth's docs before coding: Pyth changed its APIs in August 2026. |

## 4. Instructions

Notation: **S** = signer, **W** = writable.

### 4.1 `initialize_vault(vault_id, keeper, allowed_mints, max_slippage_bps, max_oracle_staleness_secs, strategy_hash)`

| Account                                | S   | W   | Constraint                                             |
| -------------------------------------- | --- | --- | ------------------------------------------------------ |
| `owner`                                | ✓   | ✓   | Pays rent.                                             |
| `vault`                                |     | ✓   | `init`, seeds `["vault", owner, vault_id]`, space 836. |
| `system_program`                       |     |     | System program.                                        |
| remaining: one `mint` per allowed mint |     |     | Read-only, in the same order as `allowed_mints`.       |

Checks:

1. `allowed_mints.len()` is 1–10; no duplicate mints; no duplicate feed IDs.
2. Each passed mint account's key equals `allowed_mints[i].mint` and the account is owned by the SPL Token program (rejects Token-2022, §6.8).
3. `max_slippage_bps` and `max_oracle_staleness_secs` within the caps in §3.
4. `keeper` may be default (no keeper). It may equal the owner.
5. `init` fails if the PDA exists, so a vault can't be re-initialised.

Effects: write all fields, `paused = false`, `last_swap_ts = 0`. Emit `VaultInitialized`.

### 4.2 `update_config(allowed_mints?, max_slippage_bps?, max_oracle_staleness_secs?, strategy_hash?)`

| Account                                    | S   | W   | Constraint                                       |
| ------------------------------------------ | --- | --- | ------------------------------------------------ |
| `owner`                                    | ✓   |     | `vault.owner == owner` (`has_one`).              |
| `vault`                                    |     | ✓   | Seeds re-derived with stored `vault_id`, `bump`. |
| remaining: mints for a new `allowed_mints` |     |     | As in 4.1, only if `allowed_mints` is given.     |

Checks: as 4.1 for any field given. Removing a mint is allowed even if the vault still
holds it, because `withdraw` does not require the mint to be allowed (§4.6). Emit
`ConfigUpdated` with old and new values.

### 4.3 `set_keeper(new_keeper: Pubkey)`

| Account | S   | W   | Constraint         |
| ------- | --- | --- | ------------------ |
| `owner` | ✓   |     | `has_one = owner`. |
| `vault` |     | ✓   | Seeds, bump.       |

`Pubkey::default()` removes the keeper. Takes effect immediately, so the owner can
revoke a compromised keeper in one transaction. Emit `KeeperChanged`.

### 4.4 `set_paused(paused: bool)`

| Account | S   | W   | Constraint         |
| ------- | --- | --- | ------------------ |
| `owner` | ✓   |     | `has_one = owner`. |
| `vault` |     | ✓   | Seeds, bump.       |

Pausing blocks `swap` only. Deposits and withdrawals keep working. Emit `PausedChanged`.

### 4.5 `deposit(amount: u64)`

| Account                    | S   | W   | Constraint                                        |
| -------------------------- | --- | --- | ------------------------------------------------- |
| `owner`                    | ✓   | ✓   | `has_one = owner`. Pays for the vault ATA.        |
| `vault`                    |     |     | Seeds, bump.                                      |
| `mint`                     |     |     | In `vault.allowed_mints`; owned by SPL Token.     |
| `owner_token_account`      |     | ✓   | `token::mint = mint`, `token::authority = owner`. |
| `vault_token_account`      |     | ✓   | `init_if_needed`, `== ATA(vault, mint)`.          |
| `token_program`            |     |     | SPL Token.                                        |
| `associated_token_program` |     |     | ATA program.                                      |
| `system_program`           |     |     | System program.                                   |

Checks: `amount > 0`; mint allowed; owner holds `amount`. After the transfer, the vault
balance must equal the old balance plus `amount` (checked add). Effect: `transfer_checked` from owner to vault
(owner signs). Allowed while paused (**Q4**). Emit `Deposited`.

### 4.6 `withdraw(amount: u64)`

| Account               | S   | W   | Constraint                                            |
| --------------------- | --- | --- | ----------------------------------------------------- |
| `owner`               | ✓   |     | `has_one = owner`. The keeper can never satisfy this. |
| `vault`               |     |     | Seeds, bump.                                          |
| `mint`                |     |     | Any SPL Token mint (**not** required to be allowed).  |
| `vault_token_account` |     | ✓   | `== ATA(vault, mint)`.                                |
| `owner_token_account` |     | ✓   | `== ATA(owner, mint)`. Never any other account.       |
| `token_program`       |     |     | SPL Token.                                            |

Checks: `amount > 0`; `amount <=` vault balance (checked subtraction). **No paused check**, and no allowed-mint check, so funds can never
be trapped by pausing or by removing a mint. The destination must belong to the owner, so
even a signed withdrawal can only send funds back to the owner. Effect: `transfer_checked`
signed by the vault PDA. The owner's ATA must already exist (the client creates it with
`create_idempotent` if needed). Emit `Withdrawn`.

### 4.7 `swap(amount_in: u64, keeper_min_out: u64, route_data: Vec<u8>)`

| Account                               | S   | W      | Constraint                                                                                      |
| ------------------------------------- | --- | ------ | ----------------------------------------------------------------------------------------------- |
| `keeper`                              | ✓   | ✓      | `vault.keeper == keeper` and not default. Pays fees for any temporary accounts Jupiter creates. |
| `vault`                               |     | ✓      | Seeds, bump (updates `last_swap_ts`).                                                           |
| `input_mint`                          |     |        | In `allowed_mints`.                                                                             |
| `output_mint`                         |     |        | In `allowed_mints`, `!= input_mint`.                                                            |
| `vault_input_account`                 |     | ✓      | `== ATA(vault, input_mint)`.                                                                    |
| `vault_output_account`                |     | ✓      | `== ATA(vault, output_mint)`.                                                                   |
| `input_price_update`                  |     |        | Owned by the Pyth receiver; feed ID == `input_mint`'s `pyth_feed_id`.                           |
| `output_price_update`                 |     |        | Owned by the Pyth receiver; feed ID == `output_mint`'s `pyth_feed_id`.                          |
| `swap_program`                        |     |        | `== JUPITER_PROGRAM_ID` (mock-swap in a TEST-ONLY `devnet-mock` build).                         |
| `token_program`                       |     |        | SPL Token.                                                                                      |
| remaining: the Jupiter route accounts |     | varies | Screened, see check 7.                                                                          |

Checks, in order:

1. `!vault.paused`.
2. Signer is `vault.keeper`, and the keeper is set. The owner signing does **not** authorise a swap unless the owner is also the keeper.
3. Cooldown: `now - last_swap_ts >= MIN_SWAP_INTERVAL_SECS` (**Q5**).
4. Both mints allowed and different; both vault accounts are the exact ATAs.
5. `amount_in > 0` and `amount_in <= vault_input_account.amount`.
6. Oracle prices for both mints: account owner, feed ID, full verification, `publish_time >= now - max_oracle_staleness_secs`, `conf * 10_000 <= price * MAX_CONFIDENCE_BPS`, `price > 0`.
7. `swap_program == SWAP_PROGRAM_ID` (Jupiter v6; mock-swap in a `devnet-mock` build). Route screening over remaining accounts: none may be another vault ATA (any `ATA(vault, m)` for an allowed mint other than input and output) or **any other token account whose authority is the vault** (SPL Token or Token-2022, checked from the account data, since anyone can create such an account). The vault PDA itself may appear (it is Jupiter's `userTransferAuthority`).
8. Record balances of both vault accounts, then invoke `swap_program` with `route_data` as the instruction data and the remaining accounts, in order, as its accounts, signed by the vault PDA. The vault PDA is always passed to the venue as **signer and read-only**, whatever the outer transaction says (it is writable there because `swap` updates it).
9. Reload both vault accounts. Let `spent = before_in - after_in` and `received = after_out - before_out`. Require `spent <= amount_in` and `received > 0`.
10. Oracle minimum: `oracle_out = spent × price_in / price_out` (scaled by both mints' decimals and the price exponents, u128 checked math, rounded down). `min_out = oracle_out × (10_000 - max_slippage_bps) / 10_000`. Require `received >= max(min_out, keeper_min_out)`.
11. Post-conditions on both vault accounts: authority is still the vault PDA, no delegate, no close authority. (The CPI should not be able to change these; checking is cheap insurance.)

Effects: `last_swap_ts = now`; add the swap's USD shortfall to the daily loss window (fails past `max_daily_loss_usd`, security review H-1); the two price updates must be published ≤ 30 s apart (M-1). Emit `Swapped { input_mint, output_mint, spent, received, oracle_out, min_out, price_in, price_out, loss_usd, loss_in_window_usd }` so every swap can be audited against the oracle afterwards.

What "no tokens left the vault except `amount_in` of the input mint" rests on: the venue can
only touch accounts passed to it, and the only vault-controlled token accounts it may be
given are the input and output ATAs (check 7). The input may drop by at most `amount_in` and
the output may not drop at all (check 9), and both must still be plain vault accounts
afterwards (check 11).

**Devnet testing (TEST-ONLY):** the `devnet-mock` feature changes only `SWAP_PROGRAM_ID`, to
`programs/mock-swap`, a hand-priced test program. The keeper passes mock-swap's `swap`
instruction exactly as it would Jupiter's, so devnet exercises the same CPI code and checks
as mainnet. Never enable it for mainnet.

Why measure balances rather than trust Jupiter's arguments: whatever route data the keeper
supplies, the vault only accepts the swap if its own output account actually received at
least the oracle-based amount. Output sent anywhere else, or too little of it, makes check
9 or 10 fail and the whole transaction reverts.

### 4.8 Jupiter CPI: how the keeper builds a swap, and its limits

Checked against Jupiter's docs (developers.jup.ag) and mainnet on 2026-10-05.

**Program:** Jupiter v6 aggregator, `JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4`, the ID in
Jupiter's official CPI crate (github.com/jup-ag/jupiter-cpi) and a live, upgradeable
program on mainnet. It is upgradeable by Jupiter, so the vault does not trust what it does:
checks 9–11 judge the result.

**Which API:** Swap API V2 has two paths. The Meta-Aggregator (`/order` + `/execute`) can
route through JupiterZ RFQ market makers, and its transactions **cannot be modified**, so it
cannot be used from a program. The **Router** path, `GET https://api.jup.ag/swap/v2/build`,
returns raw instructions for "custom transactions, CPI, and composability" (Metis on-chain
routing only, no Jupiter swap fee). Jupiter recommends CPI over the older Flash Fill
approach since Solana's "loosen CPI restriction" feature.

**Keeper flow:**

1. `GET /swap/v2/build?inputMint=…&outputMint=…&amount=<amount_in>&taker=<vault PDA>`
   with:
   - `payer=<keeper>`: fees and rent default to the taker, and the vault PDA cannot sign
     outside the program.
   - `wrapAndUnwrapSol=false`: **the default is true**, and wrapping or unwrapping needs
     the taker's signature on separate instructions (§6.20).
   - `destinationTokenAccount` left unset (or set to the vault's output ATA). Anything else
     means the vault receives nothing and the swap fails (check 9).
   - `maxAccounts` to fit the transaction (below).
2. From the response, take `swapInstruction`. Its `data` (base64) becomes `route_data`, and
   its `accounts` become the remaining accounts, in order. Clear `isSigner` on the vault
   PDA (the vault signs it in the CPI).
3. Drop `setupInstructions` and `cleanupInstruction` that need the vault PDA's signature.
   The vault's ATAs must already exist, and `deposit` creates the input one.
   `createAssociatedTokenAccountIdempotent` paid by the keeper may stay.
4. Add the compute budget instructions. Build a **v0 transaction** using
   `addressesByLookupTableAddress`, simulate it, and set the CU limit to 1.2× the simulated
   use.
5. Sign with the keeper and send.

Any of Jupiter's swap instructions works (`route`, `shared_accounts_route`, …), because the
vault checks outcomes, not the route. Routes using a token ledger need an earlier
instruction in the transaction and are not supported.

**Limits:**

| Limit                           | Value                                                                                          | Effect here                                                                                                                                                                                                                                      |
| ------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Transaction size                | 1,232 bytes                                                                                    | Jupiter's route accounts plus the vault's 11 named accounts (several overlap: token program, mints, vault ATAs, the vault PDA) and `route_data`. Use the lookup tables Jupiter returns, and lower `maxAccounts` if the transaction is too large. |
| Route accounts, `maxAccounts`   | 1–64, default 64                                                                               | Jupiter warns that values "below 50" can mean no route or much worse prices. Reduce in small steps and watch the price.                                                                                                                          |
| Accounts locked per transaction | 64 on mainnet (the raise to 128 is not active)                                                 | Jupiter's accounts plus the vault's must fit in 64, which in practice means `maxAccounts` around 50 or less.                                                                                                                                     |
| CPI nesting                     | 4 levels below the top-level instruction (the raise to 8, SIMD-0268, is not active on mainnet) | vault → Jupiter → AMM → Token program uses 3, leaving one spare. An AMM that makes two further nested calls fails. Exclude it with `excludeDexes` and re-quote.                                                                                  |
| Compute                         | 1.4M CU per transaction                                                                        | The vault adds about 60k CU around the venue (measured with mock-swap). Simulate, as Jupiter advises.                                                                                                                                            |
| API rate limit                  | Keyless 0.5 RPS; free key 1 RPS                                                                | Enough for a keeper rebalancing every few minutes; use an API key in production.                                                                                                                                                                 |

**Measured** (mainnet fork, `pnpm test:jupiter-fork`, 2026-10-05): 10 USDC → SOL via
Whirlpool → Whirlpool. The swap transaction was 396 bytes with a lookup table,
used 143k CU in total, and received 0.03% less than the Pyth-implied amount, well inside a 1%
allowance.

**Quote vs. oracle:** Jupiter's `slippageBps` protects the quote; the vault's oracle minimum
(check 10) is independent and always applies. If Jupiter's best route is worse than the
oracle by more than `max_slippage_bps` (thin liquidity, an oracle lag), the swap fails; the
keeper should retry later or with a smaller `amount_in`, not raise the slippage.

## 5. Errors

`Unauthorized`, `KeeperNotSet`, `VaultPaused`, `MintNotAllowed`, `SameMint`,
`TooManyMints`, `DuplicateMint`, `UnsupportedTokenProgram`, `InvalidTokenAccount`,
`InvalidDestination`, `ZeroAmount`, `InsufficientBalance`, `SlippageAboveCap`,
`StalenessAboveCap`, `InvalidOracleAccount`, `OracleFeedMismatch`, `StalePrice`,
`PriceTooUncertain`, `NonPositivePrice`, `InvalidSwapProgram`, `ForbiddenRouteAccount`,
`SpentMoreThanAmountIn`, `NothingReceived`, `OutputBelowMinimum`,
`TokenAccountTampered`, `SwapCooldown`, `MathOverflow`.

## 6. Attacks and defences

| #    | Attack                                                                                                                                | Defence                                                                                                                                                                                                                                                                                                           |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 6.1  | **Keeper withdraws directly**                                                                                                         | `withdraw` requires the owner signature (`has_one = owner`); destination must be the owner's token account. The keeper has no instruction that moves tokens except `swap`.                                                                                                                                        |
| 6.2  | **Keeper routes swap output to its own account**                                                                                      | Output is measured on the vault's own ATA (checks 9–10). If it lands elsewhere, `received` is 0 and the swap reverts.                                                                                                                                                                                             |
| 6.3  | **Keeper calls an arbitrary program with the vault's signature** (e.g. SPL Token `transfer` or `set_authority`)                       | The only CPI the vault signs in `swap` is to the pinned `JUPITER_PROGRAM_ID`.                                                                                                                                                                                                                                     |
| 6.4  | **Keeper swaps into a worthless or attacker-minted token**                                                                            | Output mint must be in `allowed_mints`, which only the owner sets.                                                                                                                                                                                                                                                |
| 6.5  | **Bad route or sandwich attack** extracting value                                                                                     | Oracle-based minimum output with `max_slippage_bps` (owner-set, hard-capped at 5%).                                                                                                                                                                                                                               |
| 6.6  | **Fake price account**                                                                                                                | Account must be owned by the Pyth receiver program, fully verified, and carry the feed ID stored for that mint. The keeper cannot choose the feed.                                                                                                                                                                |
| 6.7  | **Stale or manipulated price**                                                                                                        | Staleness limit (owner-set, capped at 120 s); confidence-width limit; price must be positive.                                                                                                                                                                                                                     |
| 6.8  | **Token-2022 tricks**: transfer hooks running code during the swap, transfer fees breaking balance accounting, permanent delegates    | v1 accepts only classic SPL Token mints (every registry token is one: verified on-chain when building the registry).                                                                                                                                                                                              |
| 6.9  | **Keeper spends other vault balances** by putting other vault ATAs in the route                                                       | Route screening (check 7) rejects any vault ATA other than input and output.                                                                                                                                                                                                                                      |
| 6.10 | **Keeper takes more input than declared**                                                                                             | `spent <= amount_in`; the oracle minimum is computed from what was actually spent.                                                                                                                                                                                                                                |
| 6.11 | **Account substitution**: a fake vault, a non-canonical token account with the vault as authority, a token account for the wrong mint | PDA seeds and bump re-derived; ATAs must match the derived address exactly; mint constraints on every token account.                                                                                                                                                                                              |
| 6.12 | **CPI changes the vault accounts' authority, delegate or close authority**                                                            | Post-swap checks (check 11).                                                                                                                                                                                                                                                                                      |
| 6.13 | **Re-entrancy** via the Jupiter CPI back into the vault                                                                               | Solana does not allow a CPI chain to re-enter a program that is already on the stack (only direct self-calls). State is also written only after all checks.                                                                                                                                                       |
| 6.14 | **Funds trapped** by pausing, removing a mint or a lost keeper                                                                        | `withdraw` ignores `paused` and the allowed list; the owner can always withdraw.                                                                                                                                                                                                                                  |
| 6.15 | **Fee bleed**: compromised keeper churns valid swaps, losing up to the slippage allowance each time                                   | Slippage cap, a 60 s swap cooldown and, since the security review (H-1), a **daily loss limit** set by the owner: `max_daily_loss_usd`. Each swap's shortfall versus the oracle is valued in USD (rounded up) and summed per 24 h; a swap past the limit fails. Off-chain: alert on `Swapped.loss_in_window_usd`. |
| 6.16 | **Re-initialising** an existing vault                                                                                                 | Anchor `init` fails on an existing account; the owner and `vault_id` are part of the seeds.                                                                                                                                                                                                                       |
| 6.17 | **Integer overflow or rounding** in the minimum-output maths                                                                          | u128 with checked operations; round down the oracle amount (stricter for the keeper).                                                                                                                                                                                                                             |
| 6.18 | **Keeper key compromise**                                                                                                             | Owner calls `set_keeper(default)` or `set_paused(true)`; worst case before then is bounded by 6.5 and 6.15.                                                                                                                                                                                                       |
| 6.19 | **Owner key compromise**                                                                                                              | Out of scope: the owner can always withdraw, by design. Recommend a hardware wallet.                                                                                                                                                                                                                              |
| 6.20 | **Native SOL surprises** (Jupiter unwrapping SOL into the vault PDA)                                                                  | The keeper must request routes with SOL wrapping disabled; if output arrives as native SOL, the wSOL ATA shows no increase and the swap reverts.                                                                                                                                                                  |

## 7. Explicit non-goals

- **The strategy is not enforced on-chain.** `strategy_hash` records which strategy the owner
  approved, so the keeper and any viewer can check they agree. The program cannot evaluate
  the strategy; it only guarantees that whatever the keeper does is a fair swap between
  allowed tokens inside the vault.
- No pooled deposits or shares, no performance fees, no `close_vault` in v1 (it could be
  added later: owner only, all balances zero).
- No on-chain price for the strategy's indicators: those stay off-chain in the keeper.

## 8. Open questions (need your decision)

| #   | Question                                       | Proposal                                                                                                             |
| --- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Q1  | Store a Pyth feed ID per allowed mint?         | **Yes**: without it the oracle check in `swap` can be bypassed.                                                      |
| Q2  | Hard caps on owner settings                    | **Decided:** slippage ≤ 5% (500 bps), staleness ≤ 120 s.                                                             |
| Q3  | Price-confidence limit                         | Reject if the confidence interval is wider than 2% of the price.                                                     |
| Q4  | Allow deposits while paused?                   | **Yes**: harmless; pausing is about trading.                                                                         |
| Q5  | Swap cooldown                                  | Minimum 60 s between swaps per vault (enough for a rebalance of several legs). A daily volume cap is an alternative. |
| Q6  | Withdraw any held mint, not just allowed ones? | **Yes**: otherwise removing a mint traps funds.                                                                      |
| Q7  | Swap venue                                     | Jupiter v6 only, pinned. Adding another venue later means adding another pinned program.                             |
| Q8  | Token programs                                 | Classic SPL Token only in v1.                                                                                        |

## 9. Testing plan (for implementation)

- One test per check in §4 that fails when only that check is violated.
- One test per attack in §6 using a malicious keeper: output to the keeper's account,
  a non-allowed output mint, a fake price account, a stale price, a different program ID,
  an extra vault ATA in the route, and more input than declared.
- A mock swap program standing in for Jupiter in unit tests (with its program ID patched
  in for tests only), plus a devnet test against real Jupiter and Pyth before mainnet.
