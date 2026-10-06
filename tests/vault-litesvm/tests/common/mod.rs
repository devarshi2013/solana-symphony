//! Shared LiteSVM setup for the vault integration tests.
#![allow(dead_code)]

use anchor_lang::{
    prelude::{AccountMeta, Pubkey},
    solana_program::{instruction::Instruction, system_program},
    AccountDeserialize, Event, InstructionData, ToAccountMetas,
};
use anchor_spl::{
    associated_token::get_associated_token_address,
    token::spl_token::state::{Account as TokenAccountState, AccountState},
};
use base64::{engine::general_purpose::STANDARD, Engine};
use litesvm::LiteSVM;
use solana_keypair::Keypair;
use solana_program_option::COption;
use solana_program_pack::Pack;
use solana_signer::Signer;
use solana_transaction::Transaction;
use vault::{
    error::VaultError, AllowedMint, InitializeVaultArgs, UpdateConfigArgs, Vault, VAULT_SEED,
};

/// The normal vault build (`anchor build --arch v0`).
pub const PROGRAM_SO: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../target/deploy/vault.so"
));
/// The TEST-ONLY vault build whose swap calls mock-swap (`pnpm build:program:devnet-mock`).
pub const DEVNET_MOCK_VAULT_SO: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../target/deploy-devnet-mock/vault.so"
));
/// The TEST-ONLY mock swap venue.
pub const MOCK_SWAP_SO: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../target/deploy/mock_swap.so"
));

pub struct Env {
    pub svm: LiteSVM,
    pub owner: Keypair,
    pub keeper: Keypair,
    pub attacker: Keypair,
    pub mints: Vec<Pubkey>,
}

impl Env {
    pub fn new() -> Self {
        Self::with_vault_program(PROGRAM_SO)
    }

    /// Like `new`, with the given vault binary plus the mock-swap program.
    pub fn with_vault_program(vault_so: &[u8]) -> Self {
        let mut svm = LiteSVM::new();
        svm.add_program(vault::ID, vault_so).unwrap();
        svm.add_program(mock_swap::ID, MOCK_SWAP_SO).unwrap();
        let (owner, keeper, attacker) = (Keypair::new(), Keypair::new(), Keypair::new());
        for k in [&owner, &keeper, &attacker] {
            svm.airdrop(&k.pubkey(), 10_000_000_000).unwrap();
        }
        let mut env = Self {
            svm,
            owner,
            keeper,
            attacker,
            mints: vec![],
        };
        env.mints = (0..11)
            .map(|_| env.create_mint(anchor_spl::token::ID))
            .collect();
        env
    }

    /// Writes an initialized 6-decimal SPL mint account owned by `token_program`.
    pub fn create_mint(&mut self, token_program: Pubkey) -> Pubkey {
        self.create_mint_with_decimals(token_program, 6)
    }

    pub fn create_mint_with_decimals(&mut self, token_program: Pubkey, decimals: u8) -> Pubkey {
        let address = Pubkey::new_unique();
        let mut data = vec![0u8; anchor_spl::token::spl_token::state::Mint::LEN];
        anchor_spl::token::spl_token::state::Mint {
            mint_authority: COption::Some(Pubkey::new_unique()),
            supply: 0,
            decimals,
            is_initialized: true,
            freeze_authority: COption::None,
        }
        .pack_into_slice(&mut data);
        self.svm
            .set_account(
                address,
                solana_account(
                    token_program,
                    data,
                    self.svm.minimum_balance_for_rent_exemption(82),
                ),
            )
            .unwrap();
        address
    }

    pub fn allowed(&self, n: usize) -> Vec<AllowedMint> {
        self.mints[..n]
            .iter()
            .enumerate()
            .map(|(i, m)| AllowedMint {
                mint: *m,
                pyth_feed_id: [i as u8 + 1; 32],
            })
            .collect()
    }

    pub fn vault_address(&self, owner: &Pubkey, vault_id: u64) -> Pubkey {
        Pubkey::find_program_address(
            &[VAULT_SEED, owner.as_ref(), &vault_id.to_le_bytes()],
            &vault::ID,
        )
        .0
    }

    pub fn send(&mut self, ix: Instruction, signer: &Keypair) -> Result<Vec<String>, String> {
        self.svm.expire_blockhash();
        let blockhash = self.svm.latest_blockhash();
        let tx =
            Transaction::new_signed_with_payer(&[ix], Some(&signer.pubkey()), &[signer], blockhash);
        self.svm
            .send_transaction(tx)
            .map(|meta| meta.logs)
            .map_err(|failed| format!("{:?} {:?}", failed.err, failed.meta.logs))
    }

    pub fn vault(&self, address: &Pubkey) -> Vault {
        let account = self.svm.get_account(address).unwrap();
        Vault::try_deserialize(&mut &account.data[..]).unwrap()
    }

    pub fn init_ix(
        &self,
        owner: &Pubkey,
        args: InitializeVaultArgs,
        mint_accounts: &[Pubkey],
    ) -> Instruction {
        let mut accounts = vault::accounts::InitializeVault {
            owner: *owner,
            vault: self.vault_address(owner, args.vault_id),
            system_program: system_program::ID,
        }
        .to_account_metas(None);
        accounts.extend(
            mint_accounts
                .iter()
                .map(|m| AccountMeta::new_readonly(*m, false)),
        );
        Instruction::new_with_bytes(
            vault::ID,
            &vault::instruction::InitializeVault { args }.data(),
            accounts,
        )
    }

    pub fn default_args(&self, n_mints: usize) -> InitializeVaultArgs {
        InitializeVaultArgs {
            vault_id: 7,
            keeper: self.keeper.pubkey(),
            allowed_mints: self.allowed(n_mints),
            max_slippage_bps: 50,
            max_oracle_staleness_secs: 60,
            strategy_hash: [42; 32],
            max_daily_loss_usd: 25_000_000, // $25
        }
    }

    /// Creates the default vault (2 mints) and returns its address.
    pub fn init_default(&mut self) -> Pubkey {
        let owner = self.owner.pubkey();
        let ix = self.init_ix(&owner, self.default_args(2), &self.mints[..2].to_vec());
        let owner_kp = self.owner.insecure_clone();
        self.send(ix, &owner_kp).expect("initialize_vault");
        self.vault_address(&owner, 7)
    }

    pub fn update_ix(
        &self,
        signer: &Pubkey,
        vault: Pubkey,
        args: UpdateConfigArgs,
        mint_accounts: &[Pubkey],
    ) -> Instruction {
        let mut accounts = vault::accounts::UpdateConfig {
            owner: *signer,
            vault,
        }
        .to_account_metas(None);
        accounts.extend(
            mint_accounts
                .iter()
                .map(|m| AccountMeta::new_readonly(*m, false)),
        );
        Instruction::new_with_bytes(
            vault::ID,
            &vault::instruction::UpdateConfig { args }.data(),
            accounts,
        )
    }

    pub fn set_keeper_ix(&self, signer: &Pubkey, vault: Pubkey, new_keeper: Pubkey) -> Instruction {
        Instruction::new_with_bytes(
            vault::ID,
            &vault::instruction::SetKeeper { new_keeper }.data(),
            vault::accounts::SetKeeper {
                owner: *signer,
                vault,
            }
            .to_account_metas(None),
        )
    }

    pub fn set_paused_ix(&self, signer: &Pubkey, vault: Pubkey, paused: bool) -> Instruction {
        Instruction::new_with_bytes(
            vault::ID,
            &vault::instruction::SetPaused { paused }.data(),
            vault::accounts::SetPaused {
                owner: *signer,
                vault,
            }
            .to_account_metas(None),
        )
    }

    /// The canonical associated token account of `authority` for `mint`.
    pub fn ata(&self, authority: &Pubkey, mint: &Pubkey) -> Pubkey {
        get_associated_token_address(authority, mint)
    }

    /// Writes an initialized SPL token account holding `amount` at `address`.
    pub fn set_token_account(
        &mut self,
        address: Pubkey,
        mint: Pubkey,
        authority: Pubkey,
        amount: u64,
    ) {
        let mut data = vec![0u8; TokenAccountState::LEN];
        TokenAccountState {
            mint,
            owner: authority,
            amount,
            delegate: COption::None,
            state: AccountState::Initialized,
            is_native: COption::None,
            delegated_amount: 0,
            close_authority: COption::None,
        }
        .pack_into_slice(&mut data);
        let rent = self
            .svm
            .minimum_balance_for_rent_exemption(TokenAccountState::LEN);
        self.svm
            .set_account(address, solana_account(anchor_spl::token::ID, data, rent))
            .unwrap();
    }

    /// Creates `authority`'s ATA for `mint` holding `amount` and returns its address.
    pub fn fund(&mut self, authority: Pubkey, mint: Pubkey, amount: u64) -> Pubkey {
        let address = self.ata(&authority, &mint);
        self.set_token_account(address, mint, authority, amount);
        address
    }

    /// Token balance, or `None` if the account does not exist.
    pub fn balance(&self, address: &Pubkey) -> Option<u64> {
        let account = self.svm.get_account(address)?;
        if account.data.is_empty() {
            return None;
        }
        Some(TokenAccountState::unpack(&account.data).unwrap().amount)
    }

    pub fn deposit_ix(
        &self,
        signer: &Pubkey,
        vault: Pubkey,
        mint: Pubkey,
        from: Pubkey,
        vault_token_account: Pubkey,
        amount: u64,
    ) -> Instruction {
        Instruction::new_with_bytes(
            vault::ID,
            &vault::instruction::Deposit { amount }.data(),
            vault::accounts::Deposit {
                owner: *signer,
                vault,
                mint,
                owner_token_account: from,
                vault_token_account,
                token_program: anchor_spl::token::ID,
                associated_token_program: anchor_spl::associated_token::ID,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    }

    pub fn withdraw_ix(
        &self,
        signer: &Pubkey,
        vault: Pubkey,
        mint: Pubkey,
        vault_token_account: Pubkey,
        to: Pubkey,
        amount: u64,
    ) -> Instruction {
        Instruction::new_with_bytes(
            vault::ID,
            &vault::instruction::Withdraw { amount }.data(),
            vault::accounts::Withdraw {
                owner: *signer,
                vault,
                mint,
                vault_token_account,
                owner_token_account: to,
                token_program: anchor_spl::token::ID,
                associated_token_program: anchor_spl::associated_token::ID,
            }
            .to_account_metas(None),
        )
    }
}

pub fn solana_account(owner: Pubkey, data: Vec<u8>, lamports: u64) -> solana_account::Account {
    solana_account::Account {
        lamports,
        data,
        owner,
        executable: false,
        rent_epoch: 0,
    }
}

/// Asserts the transaction failed with exactly this vault error.
pub fn assert_err(result: Result<Vec<String>, String>, expected: VaultError) {
    let code = anchor_lang::error::ERROR_CODE_OFFSET + expected as u32;
    let err = result.expect_err("transaction should fail");
    assert!(
        err.contains(&format!("Custom({code})")),
        "expected {expected:?} ({code}), got: {err}"
    );
}

pub fn emitted_event(logs: &[String]) -> bool {
    logs.iter().any(|l| l.starts_with("Program data: "))
}

pub const NO_UPDATE: fn() -> UpdateConfigArgs = || UpdateConfigArgs {
    allowed_mints: None,
    max_slippage_bps: None,
    max_oracle_staleness_secs: None,
    strategy_hash: None,
    max_daily_loss_usd: None,
};

/// Decodes the first event of type `E` in the logs.
pub fn find_event<E: Event>(logs: &[String]) -> Option<E> {
    logs.iter().find_map(|line| {
        let data = STANDARD.decode(line.strip_prefix("Program data: ")?).ok()?;
        let rest = data.strip_prefix(E::DISCRIMINATOR)?;
        E::deserialize(&mut &rest[..]).ok()
    })
}

// ---------------------------------------------------------------- swap helpers

pub const NOW: i64 = 1_800_000_000;

impl Env {
    /// Sets the cluster clock's unix timestamp.
    pub fn set_time(&mut self, unix_timestamp: i64) {
        let mut clock: anchor_lang::prelude::Clock = self.svm.get_sysvar();
        clock.unix_timestamp = unix_timestamp;
        self.svm.set_sysvar(&clock);
    }

    /// Writes a fully verified Pyth `PriceUpdateV2` account owned by the Pyth receiver.
    pub fn set_price_update(
        &mut self,
        address: Pubkey,
        feed_id: [u8; 32],
        price: i64,
        exponent: i32,
        publish_time: i64,
    ) {
        use anchor_lang::AccountSerialize;
        use pyth_solana_receiver_sdk::price_update::{
            PriceFeedMessage, PriceUpdateV2, VerificationLevel,
        };
        let update = PriceUpdateV2 {
            write_authority: Pubkey::new_unique(),
            verification_level: VerificationLevel::Full,
            price_message: PriceFeedMessage {
                feed_id,
                price,
                conf: (price / 1_000) as u64, // 0.1%
                exponent,
                publish_time,
                prev_publish_time: publish_time - 1,
                ema_price: price,
                ema_conf: 0,
            },
            posted_slot: 1,
        };
        let mut data = Vec::with_capacity(PriceUpdateV2::LEN);
        update.try_serialize(&mut data).unwrap();
        let rent = self.svm.minimum_balance_for_rent_exemption(data.len());
        self.svm
            .set_account(
                address,
                solana_account(pyth_solana_receiver_sdk::ID, data, rent),
            )
            .unwrap();
    }

    pub fn market_address(&self) -> Pubkey {
        Pubkey::find_program_address(&[mock_swap::MARKET_SEED], &mock_swap::ID).0
    }

    pub fn init_market_ix(&self, admin: &Pubkey) -> Instruction {
        Instruction::new_with_bytes(
            mock_swap::ID,
            &mock_swap::instruction::InitMarket {}.data(),
            mock_swap::accounts::InitMarket {
                admin: *admin,
                market: self.market_address(),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    }

    pub fn set_mock_price_ix(
        &self,
        admin: &Pubkey,
        mint: Pubkey,
        price: u64,
        exponent: i32,
    ) -> Instruction {
        Instruction::new_with_bytes(
            mock_swap::ID,
            &mock_swap::instruction::SetPrice {
                mint,
                price,
                exponent,
            }
            .data(),
            mock_swap::accounts::SetPrice {
                admin: *admin,
                market: self.market_address(),
            }
            .to_account_metas(None),
        )
    }
}

/// Accounts for one vault swap. The route is the venue's own instruction (here mock-swap's
/// `swap`), passed through exactly as a keeper passes Jupiter's. Fields are public so tests
/// can tamper with them.
#[derive(Clone)]
pub struct SwapAccounts {
    pub keeper: Pubkey,
    pub vault: Pubkey,
    pub input_mint: Pubkey,
    pub output_mint: Pubkey,
    pub vault_input_account: Pubkey,
    pub vault_output_account: Pubkey,
    pub input_price_update: Pubkey,
    pub output_price_update: Pubkey,
    pub swap_program: Pubkey,
    /// The venue instruction's accounts, in order (remaining accounts).
    pub route: Vec<AccountMeta>,
    /// If set, the route asks the venue for this amount instead of the vault's `amount_in`.
    pub route_amount_in: Option<u64>,
    /// If set, replaces the mock-swap instruction data entirely (for non-mock routes).
    pub route_data: Option<Vec<u8>>,
}

impl SwapAccounts {
    /// mock-swap's `swap` accounts with the vault as `user`. The vault PDA cannot sign the
    /// outer transaction, so it is not a signer here; the vault signs the CPI.
    pub fn mock_route(
        vault: Pubkey,
        input_mint: Pubkey,
        output_mint: Pubkey,
        market: Pubkey,
        market_input_account: Pubkey,
        market_output_account: Pubkey,
    ) -> Vec<AccountMeta> {
        let mut metas = mock_swap::accounts::Swap {
            user: vault,
            market,
            input_mint,
            output_mint,
            user_input_account: get_associated_token_address(&vault, &input_mint),
            user_output_account: get_associated_token_address(&vault, &output_mint),
            market_input_account,
            market_output_account,
            token_program: anchor_spl::token::ID,
            associated_token_program: anchor_spl::associated_token::ID,
        }
        .to_account_metas(None);
        for meta in &mut metas {
            meta.is_signer = false;
        }
        metas
    }

    pub fn ix(&self, amount_in: u64, keeper_min_out: u64) -> Instruction {
        let mut accounts = vault::accounts::Swap {
            keeper: self.keeper,
            vault: self.vault,
            input_mint: self.input_mint,
            output_mint: self.output_mint,
            vault_input_account: self.vault_input_account,
            vault_output_account: self.vault_output_account,
            input_price_update: self.input_price_update,
            output_price_update: self.output_price_update,
            swap_program: self.swap_program,
            token_program: anchor_spl::token::ID,
            associated_token_program: anchor_spl::associated_token::ID,
        }
        .to_account_metas(None);
        accounts.extend(self.route.iter().cloned());
        let route_data = self.route_data.clone().unwrap_or_else(|| {
            mock_swap::instruction::Swap {
                amount_in: self.route_amount_in.unwrap_or(amount_in),
                min_out: keeper_min_out,
            }
            .data()
        });
        Instruction::new_with_bytes(
            vault::ID,
            &vault::instruction::Swap {
                amount_in,
                keeper_min_out,
                route_data,
            }
            .data(),
            accounts,
        )
    }
}

/// Asserts the transaction failed with exactly this Anchor error code.
pub fn assert_code(result: Result<Vec<String>, String>, code: u32) {
    let err = result.expect_err("transaction should fail");
    assert!(
        err.contains(&format!("Custom({code})")),
        "expected error {code}, got: {err}"
    );
}
