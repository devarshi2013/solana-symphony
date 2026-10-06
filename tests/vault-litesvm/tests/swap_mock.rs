//! Integration tests for the vault's swap, routed through the TEST-ONLY mock-swap program
//! (vault built with the `devnet-mock` feature), in LiteSVM with real SPL Token programs and
//! fake but correctly owned Pyth price accounts.
//! Build first: `pnpm build:program:devnet-mock`. Run: `cd tests/vault-litesvm && cargo test`.

mod common;

use anchor_lang::prelude::{AccountMeta, Pubkey};
use common::*;
use mock_swap::MockSwapError;
use solana_keypair::Keypair;
use solana_signer::Signer;
use vault::{error::VaultError, events::Swapped, AllowedMint, InitializeVaultArgs};

const USDC_PRICE: i64 = 100_000_000; // $1.00, exponent -8
const SOL_PRICE: i64 = 15_000_000_000; // $150.00, exponent -8
const BONK_PRICE: i64 = 250_000; // $0.000025, exponent -10
const SLIPPAGE_BPS: u16 = 50;
const MAX_AGE: u32 = 60;
const MAX_DAILY_LOSS_USD: u64 = 5_000_000; // $5

fn vault_code(e: VaultError) -> u32 {
    anchor_lang::error::ERROR_CODE_OFFSET + e as u32
}

fn mock_code(e: MockSwapError) -> u32 {
    anchor_lang::error::ERROR_CODE_OFFSET + e as u32
}

/// A vault allowing USDC (6 dp), SOL (9 dp) and BONK (5 dp), holding 500 USDC, with Pyth
/// prices published at NOW and a funded mock market priced exactly at the oracle.
struct Setup {
    env: Env,
    keeper: Keypair,
    admin: Keypair,
    vault: Pubkey,
    usdc: Pubkey,
    sol: Pubkey,
    bonk: Pubkey,
    usdc_price: Pubkey,
    sol_price: Pubkey,
    swap: SwapAccounts,
}

fn setup() -> Setup {
    setup_with(DEVNET_MOCK_VAULT_SO)
}

fn setup_with(vault_so: &[u8]) -> Setup {
    let mut env = Env::with_vault_program(vault_so);
    env.set_time(NOW);
    let token = anchor_spl::token::ID;
    let usdc = env.create_mint_with_decimals(token, 6);
    let sol = env.create_mint_with_decimals(token, 9);
    let bonk = env.create_mint_with_decimals(token, 5);
    let owner = env.owner.insecure_clone();
    let keeper = env.keeper.insecure_clone();

    // The vault.
    let args = InitializeVaultArgs {
        vault_id: 7,
        keeper: keeper.pubkey(),
        allowed_mints: [usdc, sol, bonk]
            .iter()
            .enumerate()
            .map(|(i, m)| AllowedMint {
                mint: *m,
                pyth_feed_id: [i as u8 + 1; 32],
            })
            .collect(),
        max_slippage_bps: SLIPPAGE_BPS,
        max_oracle_staleness_secs: MAX_AGE,
        strategy_hash: [0; 32],
        max_daily_loss_usd: MAX_DAILY_LOSS_USD,
    };
    let ix = env.init_ix(&owner.pubkey(), args, &[usdc, sol, bonk]);
    env.send(ix, &owner).unwrap();
    let vault = env.vault_address(&owner.pubkey(), 7);

    // 500 of the owner's 1,000 USDC deposited; empty SOL and BONK vault accounts.
    let owner_usdc = env.fund(owner.pubkey(), usdc, 1_000_000_000);
    let ix = env.deposit_ix(
        &owner.pubkey(),
        vault,
        usdc,
        owner_usdc,
        env.ata(&vault, &usdc),
        500_000_000,
    );
    env.send(ix, &owner).unwrap();
    env.fund(vault, sol, 0);
    env.fund(vault, bonk, 0);

    // Pyth prices.
    let (usdc_price, sol_price, bonk_price) = (
        Pubkey::new_unique(),
        Pubkey::new_unique(),
        Pubkey::new_unique(),
    );
    env.set_price_update(usdc_price, [1; 32], USDC_PRICE, -8, NOW);
    env.set_price_update(sol_price, [2; 32], SOL_PRICE, -8, NOW);
    env.set_price_update(bonk_price, [3; 32], BONK_PRICE, -10, NOW);

    // The mock market, priced at the oracle, with plenty of liquidity.
    let admin = Keypair::new();
    env.svm.airdrop(&admin.pubkey(), 1_000_000_000).unwrap();
    let ix = env.init_market_ix(&admin.pubkey());
    env.send(ix, &admin).unwrap();
    for (mint, price, expo) in [
        (usdc, USDC_PRICE, -8),
        (sol, SOL_PRICE, -8),
        (bonk, BONK_PRICE, -10),
    ] {
        let ix = env.set_mock_price_ix(&admin.pubkey(), mint, price as u64, expo);
        env.send(ix, &admin).unwrap();
    }
    let market = env.market_address();
    let market_usdc = env.fund(market, usdc, 1_000_000_000_000);
    let market_sol = env.fund(market, sol, 1_000_000_000_000);
    env.fund(market, bonk, 1_000_000_000_000_000);

    let swap = SwapAccounts {
        keeper: keeper.pubkey(),
        vault,
        input_mint: usdc,
        output_mint: sol,
        vault_input_account: env.ata(&vault, &usdc),
        vault_output_account: env.ata(&vault, &sol),
        input_price_update: usdc_price,
        output_price_update: sol_price,
        swap_program: mock_swap::ID,
        route: SwapAccounts::mock_route(vault, usdc, sol, market, market_usdc, market_sol),
        route_amount_in: None,
        route_data: None,
    };
    Setup {
        env,
        keeper,
        admin,
        vault,
        usdc,
        sol,
        bonk,
        usdc_price,
        sol_price,
        swap,
    }
}

impl Setup {
    fn swap(&mut self, amount_in: u64, keeper_min_out: u64) -> Result<Vec<String>, String> {
        self.swap_with(&self.swap.clone(), amount_in, keeper_min_out)
    }

    fn swap_with(
        &mut self,
        accounts: &SwapAccounts,
        amount_in: u64,
        keeper_min_out: u64,
    ) -> Result<Vec<String>, String> {
        let ix = accounts.ix(amount_in, keeper_min_out);
        let keeper = self.keeper.insecure_clone();
        self.env.send(ix, &keeper)
    }

    fn set_mock_price(&mut self, mint: Pubkey, price: u64) {
        let ix = self
            .env
            .set_mock_price_ix(&self.admin.pubkey(), mint, price, -8);
        let admin = self.admin.insecure_clone();
        self.env.send(ix, &admin).unwrap();
    }

    /// (vault USDC, vault SOL)
    fn balances(&self) -> (u64, u64) {
        (
            self.env.balance(&self.swap.vault_input_account).unwrap(),
            self.env.balance(&self.swap.vault_output_account).unwrap(),
        )
    }
}

// ---------------------------------------------------------------- happy path

#[test]
fn keeper_swaps_usdc_for_sol_at_the_oracle_price() {
    let mut s = setup();
    let logs = s.swap(150_000_000, 0).unwrap();
    assert_eq!(s.balances(), (350_000_000, 1_000_000_000));

    let e: Swapped = find_event(&logs).expect("Swapped event");
    assert_eq!((e.vault, e.keeper), (s.vault, s.keeper.pubkey()));
    assert_eq!((e.input_mint, e.output_mint), (s.usdc, s.sol));
    assert_eq!((e.spent, e.received), (150_000_000, 1_000_000_000));
    assert_eq!((e.oracle_out, e.min_out), (1_000_000_000, 995_000_000));
    assert_eq!((e.price_in, e.price_in_expo), (USDC_PRICE, -8));
    assert_eq!((e.price_out, e.price_out_expo), (SOL_PRICE, -8));
    assert_eq!(s.env.vault(&s.vault).last_swap_ts, NOW);
}

#[test]
fn accepts_a_venue_price_within_the_slippage_allowance() {
    // Venue SOL at $150.60 (0.4% worse): 0.996 SOL >= the 0.995 SOL minimum.
    let mut s = setup();
    let sol = s.sol;
    s.set_mock_price(sol, 15_060_000_000);
    s.swap(150_000_000, 0).unwrap();
    assert_eq!(s.balances(), (350_000_000, 996_015_936));
}

#[test]
fn keeper_minimum_above_the_oracle_minimum_is_enforced_too() {
    let mut s = setup();
    s.swap(150_000_000, 999_999_999).unwrap(); // the venue gives exactly 1 SOL
    let mut s = setup();
    assert_code(
        s.swap(150_000_000, 1_000_000_001),
        mock_code(MockSwapError::SlippageExceeded),
    );
    assert_eq!(s.balances(), (500_000_000, 0));
}

// ---------------------------------------------------------------- oracle protection

#[test]
fn rejects_a_venue_price_worse_than_the_slippage_allowance() {
    // Venue SOL at $151.50 (1% worse): 0.990 SOL < 0.995 SOL minimum. The keeper asked for
    // nothing (keeper_min_out = 0); the vault's oracle check alone rejects it.
    let mut s = setup();
    let sol = s.sol;
    s.set_mock_price(sol, 15_150_000_000);
    assert_code(
        s.swap(150_000_000, 0),
        vault_code(VaultError::OutputBelowMinimum),
    );
    assert_eq!(s.balances(), (500_000_000, 0));
}

#[test]
fn rejects_stale_prices() {
    let mut s = setup();
    let sol_price = s.sol_price;
    s.env
        .set_price_update(sol_price, [2; 32], SOL_PRICE, -8, NOW - 61);
    assert_code(s.swap(150_000_000, 0), vault_code(VaultError::StalePrice));
}

#[test]
fn rejects_a_price_for_the_wrong_feed() {
    let mut s = setup();
    let mut accounts = s.swap.clone();
    accounts.input_price_update = s.sol_price; // SOL's price passed as USDC's
    assert_code(
        s.swap_with(&accounts, 150_000_000, 0),
        vault_code(VaultError::OracleFeedMismatch),
    );
}

#[test]
fn rejects_a_price_account_not_owned_by_pyth() {
    let mut s = setup();
    let fake = Pubkey::new_unique();
    s.env.set_price_update(fake, [1; 32], USDC_PRICE, -8, NOW);
    let mut account = s.env.svm.get_account(&fake).unwrap();
    account.owner = s.keeper.pubkey(); // same bytes, wrong owner
    s.env.svm.set_account(fake, account).unwrap();
    let mut accounts = s.swap.clone();
    accounts.input_price_update = fake;
    // Anchor's AccountOwnedByWrongProgram.
    assert_code(s.swap_with(&accounts, 150_000_000, 0), 3007);
}

// ---------------------------------------------------------------- vault rules

#[test]
fn cooldown_between_swaps() {
    let mut s = setup();
    s.swap(150_000_000, 0).unwrap();
    assert_code(s.swap(10_000_000, 0), vault_code(VaultError::SwapCooldown));
    s.env.set_time(NOW + 59);
    assert_code(s.swap(10_000_000, 0), vault_code(VaultError::SwapCooldown));
    // 60 s later: the cooldown is over and the prices are exactly at their max age.
    s.env.set_time(NOW + 60);
    s.swap(10_000_000, 0).unwrap();
}

#[test]
fn no_swaps_while_paused() {
    let mut s = setup();
    let owner = s.env.owner.insecure_clone();
    let ix = s.env.set_paused_ix(&owner.pubkey(), s.vault, true);
    s.env.send(ix, &owner).unwrap();
    assert_code(s.swap(150_000_000, 0), vault_code(VaultError::VaultPaused));
    assert_eq!(s.balances(), (500_000_000, 0));
}

#[test]
fn only_the_keeper_can_swap() {
    let mut s = setup();
    for signer in [
        s.env.owner.insecure_clone(),
        s.env.attacker.insecure_clone(),
    ] {
        let mut accounts = s.swap.clone();
        accounts.keeper = signer.pubkey();
        let ix = accounts.ix(150_000_000, 0);
        assert_code(s.env.send(ix, &signer), vault_code(VaultError::NotKeeper));
    }
    assert_eq!(s.balances(), (500_000_000, 0));
}

#[test]
fn rejects_bad_amounts() {
    let mut s = setup();
    assert_code(s.swap(0, 0), vault_code(VaultError::ZeroAmount));
    assert_code(
        s.swap(500_000_001, 0),
        vault_code(VaultError::InsufficientBalance),
    );
}

#[test]
fn rejects_an_output_mint_that_is_not_allowed() {
    // A mint the vault does not allow, with a fully working mock market for it: only the
    // allowed-mint check stands between the keeper and the swap.
    let mut s = setup();
    let other = s.env.create_mint_with_decimals(anchor_spl::token::ID, 6);
    let other_price = Pubkey::new_unique();
    s.env
        .set_price_update(other_price, [9; 32], USDC_PRICE, -8, NOW);
    let ix = s
        .env
        .set_mock_price_ix(&s.admin.pubkey(), other, USDC_PRICE as u64, -8);
    let admin = s.admin.insecure_clone();
    s.env.send(ix, &admin).unwrap();
    let market = s.env.market_address();
    let market_other = s.env.fund(market, other, 1_000_000_000_000);
    let vault_other = s.env.fund(s.vault, other, 0);

    let mut accounts = s.swap.clone();
    accounts.output_mint = other;
    accounts.vault_output_account = vault_other;
    accounts.output_price_update = other_price;
    accounts.route = SwapAccounts::mock_route(
        s.vault,
        s.usdc,
        other,
        market,
        s.swap.route[6].pubkey,
        market_other,
    );
    assert_code(
        s.swap_with(&accounts, 150_000_000, 0),
        vault_code(VaultError::MintNotAllowed),
    );
    assert_eq!(s.env.balance(&vault_other), Some(0));
    assert_eq!(s.balances(), (500_000_000, 0));
}

#[test]
fn rejects_swapping_a_mint_for_itself() {
    // The same mint means the same vault account twice as writable: Anchor rejects that
    // (ConstraintDuplicateMutableAccount) before the handler's own SameMint check.
    let mut s = setup();
    let mut accounts = s.swap.clone();
    accounts.output_mint = s.usdc;
    accounts.vault_output_account = accounts.vault_input_account;
    accounts.output_price_update = s.usdc_price;
    assert_code(s.swap_with(&accounts, 150_000_000, 0), 2040);
}

// ---------------------------------------------------------------- venue and route

#[test]
fn rejects_a_fake_swap_program() {
    // The attack: name the SPL Token program as the "swap program" and pass a TransferChecked
    // of all the vault's USDC to the attacker as the route. The vault signs its CPI, so if it
    // ever invoked this the transfer would succeed. The route passes screening (the vault's
    // USDC account is the input account); only the pinned program ID stops it.
    use anchor_spl::token::spl_token::instruction::transfer_checked;
    let mut s = setup();
    let attacker = s.env.attacker.pubkey();
    let attacker_usdc = s.env.fund(attacker, s.usdc, 0);
    let steal = transfer_checked(
        &anchor_spl::token::ID,
        &s.swap.vault_input_account,
        &s.usdc,
        &attacker_usdc,
        &s.vault,
        &[],
        500_000_000,
        6,
    )
    .unwrap();
    let mut accounts = s.swap.clone();
    accounts.swap_program = anchor_spl::token::ID;
    accounts.route = steal
        .accounts
        .iter()
        .map(|m| AccountMeta {
            is_signer: false, // the vault PDA cannot sign the outer transaction
            ..m.clone()
        })
        .collect();
    accounts.route_data = Some(steal.data);
    assert_code(
        s.swap_with(&accounts, 1, 0),
        vault_code(VaultError::InvalidSwapProgram),
    );
    assert_eq!(s.env.balance(&attacker_usdc), Some(0));
    assert_eq!(s.balances(), (500_000_000, 0));

    // A program at any other address is refused the same way, deployed or not.
    for fake in [Pubkey::new_unique(), anchor_spl::associated_token::ID] {
        let mut accounts = s.swap.clone();
        accounts.swap_program = fake;
        assert_code(
            s.swap_with(&accounts, 150_000_000, 0),
            vault_code(VaultError::InvalidSwapProgram),
        );
    }
}

#[test]
fn route_may_not_include_other_vault_accounts() {
    let mut s = setup();
    // A token account the vault controls that is not its ATA (anyone can create one).
    let stray = Pubkey::new_unique();
    let (vault, usdc) = (s.vault, s.usdc);
    s.env.set_token_account(stray, usdc, vault, 1_000);
    let bonk_ata = s.env.ata(&s.vault, &s.bonk);
    for forbidden in [
        AccountMeta::new(bonk_ata, false), // another vault ATA
        AccountMeta::new(stray, false),    // any other vault-controlled token account
    ] {
        let mut accounts = s.swap.clone();
        accounts.route.push(forbidden);
        assert_code(
            s.swap_with(&accounts, 150_000_000, 0),
            vault_code(VaultError::ForbiddenRouteAccount),
        );
    }
}

#[test]
fn route_may_not_spend_more_than_amount_in() {
    // The keeper declares 100 USDC but the route asks the venue for 150.
    let mut s = setup();
    let mut accounts = s.swap.clone();
    accounts.route_amount_in = Some(150_000_000);
    assert_code(
        s.swap_with(&accounts, 100_000_000, 0),
        vault_code(VaultError::SpentMoreThanAmountIn),
    );
    assert_eq!(s.balances(), (500_000_000, 0));
}

#[test]
fn keeper_cannot_redirect_the_input_to_itself() {
    // The keeper names its own USDC account as the market's input account.
    let mut s = setup();
    let keeper_usdc = s.env.fund(s.keeper.pubkey(), s.usdc, 0);
    let mut accounts = s.swap.clone();
    accounts.route[6] = AccountMeta::new(keeper_usdc, false); // market_input_account
    assert!(s.swap_with(&accounts, 150_000_000, 0).is_err());
    assert_eq!(s.env.balance(&keeper_usdc), Some(0));
    assert_eq!(s.balances(), (500_000_000, 0));
}

#[test]
fn keeper_cannot_redirect_the_output() {
    let mut s = setup();
    // To the keeper's own account: the venue requires the vault as its owner, so it fails.
    let keeper_sol = s.env.fund(s.keeper.pubkey(), s.sol, 0);
    let mut accounts = s.swap.clone();
    accounts.route[5] = AccountMeta::new(keeper_sol, false); // user_output_account
    assert!(s.swap_with(&accounts, 150_000_000, 0).is_err());
    assert_eq!(s.env.balance(&keeper_sol), Some(0));
    // To a second vault-controlled SOL account the keeper could later drain: screened out.
    let side = Pubkey::new_unique();
    let (vault, sol) = (s.vault, s.sol);
    s.env.set_token_account(side, sol, vault, 0);
    let mut accounts = s.swap.clone();
    accounts.route[5] = AccountMeta::new(side, false);
    assert_code(
        s.swap_with(&accounts, 150_000_000, 0),
        vault_code(VaultError::ForbiddenRouteAccount),
    );
    assert_eq!(s.balances(), (500_000_000, 0));
}

#[test]
fn swap_fails_when_the_venue_lacks_liquidity() {
    let mut s = setup();
    let market_sol = s.swap.route[7].pubkey;
    let (market, sol) = (s.env.market_address(), s.sol);
    s.env
        .set_token_account(market_sol, sol, market, 999_999_999);
    assert_code(
        s.swap(150_000_000, 0),
        mock_code(MockSwapError::InsufficientLiquidity),
    );
}

// ---------------------------------------------------------------- mock-swap itself

#[test]
fn only_the_mock_admin_sets_prices() {
    let mut s = setup();
    let attacker = s.env.attacker.insecure_clone();
    let ix = s.env.set_mock_price_ix(&attacker.pubkey(), s.sol, 1, -8);
    assert_code(
        s.env.send(ix, &attacker),
        mock_code(MockSwapError::Unauthorized),
    );
}

// ---------------------------------------------------------------- the normal build

#[test]
fn the_normal_build_only_calls_jupiter() {
    // Same setup, but the vault binary built without devnet-mock: the pinned venue is
    // Jupiter v6, so a route to mock-swap is refused before any CPI.
    let mut s = setup_with(PROGRAM_SO);
    assert_code(
        s.swap(150_000_000, 0),
        vault_code(VaultError::InvalidSwapProgram),
    );
    assert_eq!(s.balances(), (500_000_000, 0));
}

// ---------------------------------------------------------------- security review (docs/security-review.md)

impl Setup {
    /// Accounts for a swap of `input` into `output` (USDC or SOL), with fresh price accounts.
    fn direction(&self, input: Pubkey, output: Pubkey) -> SwapAccounts {
        let (market, market_usdc, market_sol) = (
            self.swap.route[1].pubkey,
            self.swap.route[6].pubkey,
            self.swap.route[7].pubkey,
        );
        let pick = |m: Pubkey| {
            if m == self.usdc {
                (self.usdc_price, market_usdc)
            } else {
                (self.sol_price, market_sol)
            }
        };
        let ((in_price, in_market), (out_price, out_market)) = (pick(input), pick(output));
        SwapAccounts {
            input_mint: input,
            output_mint: output,
            vault_input_account: self.env.ata(&self.vault, &input),
            vault_output_account: self.env.ata(&self.vault, &output),
            input_price_update: in_price,
            output_price_update: out_price,
            route: SwapAccounts::mock_route(
                self.vault, input, output, market, in_market, out_market,
            ),
            ..self.swap.clone()
        }
    }

    /// Moves the clock to `t` and republishes both oracle prices at `t`.
    fn advance_to(&mut self, t: i64) {
        self.env.set_time(t);
        let (usdc_price, sol_price) = (self.usdc_price, self.sol_price);
        self.env
            .set_price_update(usdc_price, [1; 32], USDC_PRICE, -8, t);
        self.env
            .set_price_update(sol_price, [2; 32], SOL_PRICE, -8, t);
    }

    /// Vault value in micro-USD at the oracle prices.
    fn value_usd_micro(&self) -> u128 {
        let (usdc, sol) = self.balances();
        u128::from(usdc) + u128::from(sol) * 150 / 1_000 // 1 lamport = $150e-9 = 150e-3 micro-USD
    }
}

/// H-1: a compromised keeper routes every swap through a venue that pays 0.4% less than the
/// oracle (inside the 0.5% slippage allowance), alternating direction each minute. Before the
/// fix nothing limits the total; the daily loss limit ($5 in this vault) must stop it.
#[test]
fn h1_keeper_cannot_bleed_the_vault_through_repeated_small_losses() {
    let mut s = setup();
    let start = s.value_usd_micro();
    let (usdc, sol) = (s.usdc, s.sol);
    let mut stopped = None;
    for i in 0..20 {
        let t = NOW + 60 * i;
        s.advance_to(t);
        // The "venue" prices SOL 0.4% against the vault in whichever direction it trades.
        let (input, output, venue_sol_price) = if i % 2 == 0 {
            (usdc, sol, 15_060_000_000) // buying SOL dear
        } else {
            (sol, usdc, 14_940_000_000) // selling SOL cheap
        };
        s.set_mock_price(sol, venue_sol_price);
        let accounts = s.direction(input, output);
        let balance = s.env.balance(&accounts.vault_input_account).unwrap();
        if let Err(e) = s.swap_with(&accounts, balance, 0) {
            assert!(
                e.contains(&format!(
                    "Custom({})",
                    vault_code(VaultError::DailyLossLimitExceeded)
                )),
                "swap {i} failed for another reason: {e}"
            );
            stopped = Some(i);
            break;
        }
    }
    let lost = start - s.value_usd_micro();
    let stopped =
        stopped.unwrap_or_else(|| panic!("20 losing swaps went through; lost {lost} micro-USD"));
    assert_eq!(stopped, 2, "the third $2 loss would pass the $5 limit");
    assert!(
        lost <= 5_000_000,
        "lost {lost} micro-USD, more than the $5 daily limit"
    );

    // A day later the limit resets.
    s.advance_to(NOW + 86_400 + 60);
    s.set_mock_price(sol, SOL_PRICE as u64);
    let accounts = s.direction(usdc, sol); // after a buy and a sell the vault holds only USDC
    let balance = s.env.balance(&accounts.vault_input_account).unwrap();
    s.swap_with(&accounts, balance, 0).unwrap();
}

/// M-1: the keeper chooses which Pyth updates to use and may pair a fresh input price with an
/// output price from up to `max_oracle_staleness_secs` earlier, picking the most favourable
/// moment for each side. The two updates must be published within 30 s of each other.
#[test]
fn m1_price_updates_must_be_published_close_together() {
    let mut s = setup();
    let sol_price = s.sol_price;
    s.env
        .set_price_update(sol_price, [2; 32], SOL_PRICE, -8, NOW - 31);
    assert_code(
        s.swap(150_000_000, 0),
        vault_code(VaultError::PriceSkewTooLarge),
    );
    s.env
        .set_price_update(sol_price, [2; 32], SOL_PRICE, -8, NOW - 30);
    s.swap(150_000_000, 0).unwrap();
}
