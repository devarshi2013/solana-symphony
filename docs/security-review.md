# Security review: `programs/vault`

|              |                                                                                                                                                                                                                                                                                                                             |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scope        | `programs/vault/src/**` (all 15 files, about 1,600 lines). The mock venue `programs/mock-swap` is TEST-ONLY and out of scope, apart from how the vault calls it.                                                                                                                                                            |
| Version      | Working tree on 2026-10-06, Anchor 1.2.0, `pyth-solana-receiver-sdk` 2.0.0                                                                                                                                                                                                                                                  |
| Threat model | From `docs/vault-design.md` §1. The **owner** is trusted with their own vault. The **keeper key may be stolen**, and the vault must keep a compromised keeper from taking funds. **Pyth** is trusted for prices within its staleness and confidence bounds. **Jupiter** is trusted to execute, not to deliver a fair price. |
| Method       | Line-by-line reading of every instruction against the ten vulnerability classes below. Each finding is proven with a failing test before its fix, then the fix is mutation-tested.                                                                                                                                          |

## Summary

| ID        | Severity   | Title                                                                                           | Status                           |
| --------- | ---------- | ----------------------------------------------------------------------------------------------- | -------------------------------- |
| H-1       | **High**   | A compromised keeper can drain the vault through many in-tolerance losing swaps                 | **Fixed**                        |
| M-1       | **Medium** | The keeper picks which Pyth updates to use and can pair prices from different moments           | **Fixed**                        |
| L-1       | Low        | The daily loss limit is a fixed window: up to 2× the limit can be lost around a window boundary | Accepted, documented             |
| L-2       | Low        | Oracle drift inside the staleness window is not counted as loss                                 | Mitigated by M-1; owner guidance |
| L-3       | Low        | A `devnet-mock` build deployed to mainnet would refuse all swaps and could cause confusion      | Recommendation                   |
| L-4       | Low        | Anchor `emit!` events are log lines that other programs in the same transaction can imitate     | Recommendation                   |
| L-5       | Low        | No way to close a vault and recover its rent                                                    | Accepted (design §7)             |
| I-1 – I-6 | Info       | See below                                                                                       | No action                        |

No critical issues were found. None of the ten classes yields a direct theft path, and each is
covered by at least one test (see "Checklist").

## High

### H-1: A compromised keeper can drain the vault through many in-tolerance losing swaps

**Location:** `instructions/swap.rs`, `handle_swap`. Before the fix, steps 10–11 checked each
swap in isolation: `received >= min_out` with `min_out = oracle_out × (1 − max_slippage_bps)`,
and `MIN_SWAP_INTERVAL_SECS = 60` between swaps.

**Issue:** each swap may lose up to `max_slippage_bps` against the oracle, and nothing
limits the total. A thief holding the keeper key can:

- route through a venue that pays them, such as their own AMM pool reachable through
  Jupiter, or Jupiter's `platformFeeBps` paid to their fee account;
- swap the whole balance back and forth once a minute, losing just under the allowance each
  time.

At the default 0.5% slippage that is about 26% of the vault per hour; at the 5% cap, about
95% per hour. Both are faster than any off-chain alert (design §6.15) could react. This
breaks the vault's central promise that the keeper cannot take funds.

**Proof:** `h1_keeper_cannot_bleed_the_vault_through_repeated_small_losses`
(`tests/vault-litesvm/tests/swap_mock.rs`). The venue prices each swap 0.4% against the
vault, alternating direction every minute. On the unfixed program all 20 swaps succeeded,
and the vault lost **$38.44 of $500 (7.7%) in 20 minutes**.

**Fix:** a per-vault daily loss limit, set by the owner in USD.

- **New fields:**
  - `Vault.max_daily_loss_usd` (micro-USD), set at `initialize_vault`, changeable with
    `update_config`
  - `loss_window_start` and `loss_in_window_usd`

  The three fields take 24 of the 64 reserved bytes, so the account size is unchanged at
  836 bytes.

- **Each swap's loss:** the shortfall `oracle_out − received`, valued at the validated output
  price and **rounded up** (`price::usd_value_micro`). It is added to the current 24-hour
  window's total.
- **Enforcement:** a swap that would take the total above `max_daily_loss_usd` fails with
  `DailyLossLimitExceeded` (`swap.rs:169–193`).
- **No netting:** gains are never netted against losses, so alternating directions gains
  nothing.
- **Events:** `Swapped` now reports `loss_usd` and `loss_in_window_usd`, so monitoring sees
  the budget being used.

A compromised keeper can now cost the vault at most `max_daily_loss_usd` per day (see L-1
for the boundary case), instead of everything. The vault-client makes the limit a required
argument of `createVault`.

**Tests:**

- **The proof test above now passes:** the third swap is refused, the total loss is
  $3.98, under the $5 limit, and swaps work again after 24 hours.
- **Unit tests:** `usd_value_across_decimals` (6, 9 and 5 decimals),
  `usd_value_rounds_up_so_losses_are_never_undercounted` and
  `usd_value_overflow_is_an_error`.
- **Config tests:** `initialize_stores_config_and_emits_event` and
  `owner_updates_config_and_emits_event` check the new fields.
- **Mutation:** replacing the limit with `u64::MAX` makes the H-1 test fail.

## Medium

### M-1: The keeper picks which Pyth updates to use, and can pair prices from different moments

**Location:** `price.rs` `read_price` (line 42) and `swap.rs` step 6 (line 112ff).

**Issue:** the keeper supplies both price accounts. Any fully verified `PriceUpdateV2` for
the right feed and no older than `max_oracle_staleness_secs` (up to 120 s) is accepted, and
anyone can post one. So the keeper can:

- take the input price from the moment within the window when the input was dearest, and
- take the output price from the moment when the output was cheapest.

That inflates `oracle_out` and `min_out` in the keeper's favour on both sides. The
over-statement can be as large as both assets' moves over two minutes. H-1's loss limit
measures losses against these chosen prices, so it would also undercount.

**Proof:** `m1_price_updates_must_be_published_close_together`. An output price published
31 s before the input price was accepted by the unfixed program.

**Fix:** `read_price` now returns the publish time, and `check_price_skew` (`price.rs:65`,
called at `swap.rs:115`) requires the two updates to be published at most
`MAX_PRICE_SKEW_SECS` = 30 s apart. Otherwise the swap fails with `PriceSkewTooLarge`.

30 s was chosen from measurement. Mainnet's sponsored SOL/USD and USDC/USD feeds each update
about every 40 s and sit about 21 s apart, so a tighter limit would break swaps that use
sponsored feeds. A keeper that posts both updates itself, from one Pyth update, gets
near-identical publish times. That is the recommended setup: see I-6.

**Tests:**

- the proof test now passes: 31 s apart is refused, 30 s is accepted
- unit test `price_skew_up_to_30_seconds_either_way`, including extreme timestamps that must
  error rather than panic
- the real-Jupiter mainnet-fork test passes with the check in place
- **Mutation:** removing the check makes the M-1 test fail.

## Low

### L-1: The daily loss limit is a fixed window

**Location:** `swap.rs:169–193`. The window restarts at the first swap at least 24 h after
the previous window started, so losses just before and just after a restart can add up to
2 × `max_daily_loss_usd` in a short time. That is still a bounded, owner-chosen amount, and
a sliding window would need per-swap history on chain. Owners should set the limit with
this in mind.

### L-2: Oracle drift inside the staleness window is not counted as loss

Even with M-1 fixed, both prices can be up to `max_oracle_staleness_secs` old. A keeper can
choose a moment within that window, and losses are measured against it. M-1 stops it mixing
two moments; it does not stop it choosing one.

**Recommendation:** owners should use the lowest staleness their keeper can meet. A keeper
that posts its own updates can meet 30 s. The 120 s cap is the user's design decision (Q2).

### L-3: A `devnet-mock` build on mainnet

**Location:** `swap.rs:313–318`. With the feature enabled, swaps go to mock-swap's program
ID. On mainnet nothing is deployed there, and only the holder of that keypair could deploy
anything, so every swap would fail. That is a denial of service, not theft: the oracle
minimum and loss limit still apply.

**Recommendation:** before a mainnet deploy, check the build's hash (`deployments/*.json`
records `sha256` and the `build`), or use a verifiable build, and check in CI that the
mainnet artifact was built without the feature.

### L-4: Events are imitable log lines

`emit!` writes `Program data:` log lines. Another program invoked in the same transaction
can write identical lines. Indexers must attribute each log line to this program's
invocation (by invoke depth in the logs), or the program could switch to `emit_cpi!`,
which records events as self-CPI instruction data.

### L-5: No `close_vault`

The vault account (836 bytes, about 0.0067 SOL) and its token accounts keep their rent
forever. This is accepted in design §7; it could be added later, owner only and with all
balances zero.

## Informational

- **I-1, Jupiter is upgradeable** by Jupiter's team. The vault does not trust its behaviour:
  balance deltas, the oracle minimum, the loss limit and the post-conditions judge every
  swap.
- **I-2, Mint freeze authority.** Mints such as USDC have a freeze authority that can
  freeze the vault's token accounts. This is part of choosing the allowed mints.
- **I-3, Future publish times** pass the SDK's staleness check. Updates are signed by Pyth
  and fully verified, so this cannot be forged.
- **I-4, Confidence** only gates (≤ 2% of price); it does not widen or narrow `min_out`.
  Real confidence intervals for majors are about 0.05%.
- **I-5, Keeper signatures** are forwarded to the venue if the keeper's key appears in the
  route (`invoke_route` keeps `is_signer`). That only exposes the keeper's own accounts,
  not the vault's.
- **I-6, Operational: post your own prices.** Sponsored feeds alone go stale (devnet
  USDC/USD was 5 minutes old) and update about 20 s apart on mainnet. The keeper should
  post fresh updates for both feeds in the swap transaction.

## Checklist: the ten classes, line by line

| Class                         | Where it could arise                         | What the code does                                                                                                                                                                                                                                                                                                                                                                                     | Covered by                                                                                                                                                                              |
| ----------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Missing signer checks**     | every instruction                            | `owner: Signer` in `initialize_vault`, `update_config`, `set_keeper`, `set_paused`, `deposit` and `withdraw`; `keeper: Signer` in `swap`. The vault PDA's signature exists only inside `withdraw`'s Token CPI and `swap`'s pinned venue CPI.                                                                                                                                                           | `naming_the_owner_without_their_signature_fails`, `keeper_and_strangers_cannot_*`, `only_the_keeper_can_swap`                                                                           |
| **Missing owner checks**      | typed accounts and remaining accounts        | `Account<Vault>` (this program), `Account<Mint>` and `Account<TokenAccount>` (SPL Token), `Account<PriceUpdateV2>` (Pyth receiver `rec5…`), `Program<Token/AssociatedToken/System>`. Mint accounts passed as remaining accounts: owner == SPL Token (`validation.rs:54`).                                                                                                                              | `rejects_a_price_account_not_owned_by_pyth`, `initialize_checks_the_mint_accounts`                                                                                                      |
| **Account substitution**      | vault, token accounts, prices                | Every vault account has `seeds + bump` and `has_one = owner` (or the keeper constraint). Every token account is an `associated_token` constraint, which re-derives the address. The withdraw destination is the owner's own ATA. Price accounts are bound to the allowed mint's `pyth_feed_id`.                                                                                                        | `a_vault_cannot_be_reached_through_someone_elses_pda`, `deposit_rejects_a_non_canonical_vault_token_account`, `withdraw_only_pays_the_owners_ata`, `rejects_a_price_for_the_wrong_feed` |
| **PDA seed collisions**       | vault PDA                                    | Seeds `["vault", owner (32), vault_id (8 LE)]` are fixed-length, so two vaults cannot share an address. The canonical bump is stored at `init` and reused. Token accounts are ATAs under a different program.                                                                                                                                                                                          | `one_owner_can_have_several_vaults`                                                                                                                                                     |
| **Arithmetic overflow**       | balances, price maths, cooldown, loss window | `overflow-checks = true` in the release profile. Explicit `checked_*` in deposit, withdraw and swap. Price maths in u128 with checked operations and a single rounding (down for `min_out`, **up** for loss). `price as u64/i64` casts happen only after `price > 0`.                                                                                                                                  | `overflow_is_an_error_not_a_wrap`, `usd_value_overflow_is_an_error`, `rounds_down`, `usd_value_rounds_up_…`                                                                             |
| **Unchecked CPI program IDs** | Token CPIs, venue CPI                        | Token CPIs use `Program<Token>`. The venue CPI is built with the **constant** `SWAP_PROGRAM_ID` (`swap.rs:290`), not the account's key, after `require_keys_eq!` on the account.                                                                                                                                                                                                                       | `rejects_a_fake_swap_program`. With the check removed, a Token `TransferChecked` to the attacker ran, and the balance check still reverted it (two layers).                             |
| **Reinitialisation**          | vault, token accounts                        | The vault uses `init`, which fails on an existing account. `init_if_needed` is used only for the vault's **canonical ATA** in `deposit`, whose address the ATA program fixes, and Anchor validates mint and authority when the account exists. No `realloc`.                                                                                                                                           | `initialize_cannot_overwrite_an_existing_vault`, `first_deposit_creates_the_vault_ata_…`                                                                                                |
| **Closing accounts**          | vault, vault ATAs                            | Nothing closes the vault. The venue could only close a vault ATA through Jupiter's fixed code. Screening keeps other vault token accounts out of the route, and after the CPI both ATAs are reloaded (which fails if closed) and checked for owner, delegate and close authority.                                                                                                                      | `route_may_not_include_other_vault_accounts`; post-conditions in `swap.rs:195ff`                                                                                                        |
| **remaining_accounts abuse**  | `initialize_vault`, `update_config`, `swap`  | Config: the count, order and identity must match `allowed_mints`, and each must be an initialised SPL Token mint (`validation.rs:43`). Swap: screened (`swap.rs:230`). The vault's other ATAs and **any token account whose authority is the vault** are refused (checked from account data, since anyone can create such accounts). The vault PDA is passed to the venue as signer and **read-only**. | `initialize_rejects_bad_mint_lists`, `…checks_the_mint_accounts`, `keeper_cannot_redirect_the_output`, `route_may_not_spend_more_than_amount_in`                                        |
| **Oracle manipulation**       | `swap` prices                                | Pyth `PriceUpdateV2` with **Full** verification, owner `rec5…`, the feed fixed per mint by the owner, the staleness cap, confidence ≤ 2%, price > 0, **publish times ≤ 30 s apart (M-1)**, and **daily loss limit (H-1)**. Losses are measured on balances, not on the venue's claims.                                                                                                                 | `rejects_stale_prices`, `rejects_partially_verified_updates`, `m1_…`, `h1_…`, `rejects_a_venue_price_worse_than_…`                                                                      |

## File-by-file notes

| File                             | Notes                                                                                                                                                                                    |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib.rs`                         | Thin dispatch. Program ID matches `Anchor.toml` and the keypair.                                                                                                                         |
| `constants.rs`                   | Caps are enforced where used. New: `LOSS_WINDOW_SECS`, `MAX_PRICE_SKEW_SECS`, `USD_DECIMALS`. A stale comment saying `JUPITER_PROGRAM_ID` was still to be added now points to `swap.rs`. |
| `state.rs`                       | Fixed-size account (836 bytes) allocated for 10 mints, so there's no realloc path. New loss fields come out of the reserved space.                                                       |
| `validation.rs`                  | Ranges are inclusive and tested at their bounds. There's no check on `max_daily_loss_usd`: 0 is valid and means "no loss at all".                                                        |
| `initialize_vault.rs`            | `init` with owner-scoped seeds. Mint accounts are validated. Keeper may be default (no swaps).                                                                                           |
| `update_config.rs`               | Validates everything before writing anything. Tightening the loss limit takes effect immediately; losses already counted stay counted.                                                   |
| `set_keeper.rs`, `set_paused.rs` | `has_one = owner` plus seeds. Pausing affects only `swap`.                                                                                                                               |
| `deposit.rs`                     | Owner-only, allowed mints only, canonical ATA. The post-transfer balance check is defence in depth.                                                                                      |
| `withdraw.rs`                    | Owner-only, to the owner's ATA only. Deliberately ignores `paused` and the allowed list, so funds can't be trapped.                                                                      |
| `swap.rs`                        | Re-audited in full; H-1 and M-1 are here. The checks run in order, the vault is written only after all checks pass, and the PDA is signer and read-only in the CPI.                      |
| `price.rs`                       | `get_price_no_older_than` requires Full verification. Feed ID is enforced by the SDK. Maths is checked and tested across decimals and exponents.                                         |
| `events.rs`, `error.rs`          | New error codes are appended (`DailyLossLimitExceeded` 6032, `PriceSkewTooLarge` 6033), so existing codes don't move.                                                                    |

## Test evidence

| Suite                                                          | Result                                                                                |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Rust unit tests (`cargo test -p vault --lib`)                  | 30 passed (5 new)                                                                     |
| LiteSVM integration (`tests/vault-litesvm`)                    | 51 passed: admin 15, deposit/withdraw 13, swap 23 (2 new)                             |
| TypeScript on a local validator (`pnpm test:program:ts`)       | 10 passed                                                                             |
| Real Jupiter swap on a mainnet fork (`pnpm test:jupiter-fork`) | passed with both fixes: loss $0.0009, within a $5 limit                               |
| vault-client                                                   | 21 passed. The IDL is re-synced, and `maxDailyLossUsd` is required in `createVault`.  |
| Mutation checks                                                | Disabling the loss limit fails only `h1_…`; removing the skew check fails only `m1_…` |
