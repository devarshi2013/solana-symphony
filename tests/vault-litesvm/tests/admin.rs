//! Integration tests for initialize_vault, update_config, set_keeper and set_paused,
//! running the compiled program (target/deploy/vault.so) in LiteSVM.
//! Build it first: `anchor build`. Run: `cd tests/vault-litesvm && cargo test`.

mod common;

use anchor_lang::prelude::Pubkey;
use common::*;
use solana_signer::Signer;
use vault::{error::VaultError, UpdateConfigArgs, VAULT_SEED};

// ---------------------------------------------------------------- initialize_vault

#[test]
fn initialize_stores_config_and_emits_event() {
    let mut env = Env::new();
    let owner = env.owner.pubkey();
    let ix = env.init_ix(&owner, env.default_args(2), &env.mints[..2].to_vec());
    let owner_kp = env.owner.insecure_clone();
    let logs = env.send(ix, &owner_kp).unwrap();
    assert!(emitted_event(&logs));

    let address = env.vault_address(&owner, 7);
    let account = env.svm.get_account(&address).unwrap();
    assert_eq!(account.owner, vault::ID);
    assert_eq!(account.data.len(), 836);

    let v = env.vault(&address);
    assert_eq!(v.owner, owner);
    assert_eq!(v.vault_id, 7);
    assert_eq!(v.keeper, env.keeper.pubkey());
    assert_eq!(v.allowed_mints, env.allowed(2));
    assert_eq!((v.max_slippage_bps, v.max_oracle_staleness_secs), (50, 60));
    assert_eq!(v.strategy_hash, [42; 32]);
    assert_eq!(
        (
            v.max_daily_loss_usd,
            v.loss_window_start,
            v.loss_in_window_usd
        ),
        (25_000_000, 0, 0)
    );
    assert!(!v.paused);
    assert_eq!(v.last_swap_ts, 0);
    let expected_bump = Pubkey::find_program_address(
        &[VAULT_SEED, owner.as_ref(), &7u64.to_le_bytes()],
        &vault::ID,
    )
    .1;
    assert_eq!(v.bump, expected_bump);
}

#[test]
fn initialize_accepts_ten_mints_and_max_slippage() {
    let mut env = Env::new();
    let owner = env.owner.pubkey();
    let mut args = env.default_args(10);
    args.max_slippage_bps = 500;
    let ix = env.init_ix(&owner, args, &env.mints[..10].to_vec());
    let owner_kp = env.owner.insecure_clone();
    env.send(ix, &owner_kp).unwrap();
}

#[test]
fn initialize_rejects_bad_slippage_and_staleness() {
    let mut env = Env::new();
    let owner = env.owner.pubkey();
    let owner_kp = env.owner.insecure_clone();
    for (bps, secs, err) in [
        (501, 60, VaultError::SlippageAboveCap),
        (0, 60, VaultError::SlippageAboveCap),
        (50, 121, VaultError::StalenessAboveCap),
        (50, 0, VaultError::StalenessAboveCap),
    ] {
        let mut args = env.default_args(2);
        args.max_slippage_bps = bps;
        args.max_oracle_staleness_secs = secs;
        let ix = env.init_ix(&owner, args, &env.mints[..2].to_vec());
        assert_err(env.send(ix, &owner_kp), err);
    }
}

#[test]
fn initialize_rejects_bad_mint_lists() {
    let mut env = Env::new();
    let owner = env.owner.pubkey();
    let owner_kp = env.owner.insecure_clone();

    // none, and more than 10
    let ix = env.init_ix(&owner, env.default_args(0), &[]);
    assert_err(env.send(ix, &owner_kp), VaultError::InvalidMintCount);
    let ix = env.init_ix(&owner, env.default_args(11), &env.mints.clone());
    assert_err(env.send(ix, &owner_kp), VaultError::InvalidMintCount);

    // the same mint twice, or the same Pyth feed for two mints
    let mut args = env.default_args(2);
    args.allowed_mints[1].mint = args.allowed_mints[0].mint;
    let ix = env.init_ix(&owner, args, &[env.mints[0], env.mints[0]]);
    assert_err(env.send(ix, &owner_kp), VaultError::DuplicateMint);
    let mut args = env.default_args(2);
    args.allowed_mints[1].pyth_feed_id = args.allowed_mints[0].pyth_feed_id;
    let ix = env.init_ix(&owner, args, &env.mints[..2].to_vec());
    assert_err(env.send(ix, &owner_kp), VaultError::DuplicateFeed);
}

#[test]
fn initialize_checks_the_mint_accounts() {
    let mut env = Env::new();
    let owner = env.owner.pubkey();
    let owner_kp = env.owner.insecure_clone();

    // missing, or in the wrong order
    let ix = env.init_ix(&owner, env.default_args(2), &env.mints[..1].to_vec());
    assert_err(env.send(ix, &owner_kp), VaultError::MintAccountsMismatch);
    let ix = env.init_ix(&owner, env.default_args(2), &[env.mints[1], env.mints[0]]);
    assert_err(env.send(ix, &owner_kp), VaultError::MintAccountsMismatch);

    // a Token-2022 mint
    let token_2022_mint = env.create_mint(anchor_spl::token_2022::ID);
    let mut args = env.default_args(1);
    args.allowed_mints[0].mint = token_2022_mint;
    let ix = env.init_ix(&owner, args, &[token_2022_mint]);
    assert_err(env.send(ix, &owner_kp), VaultError::UnsupportedTokenProgram);

    // an account owned by the token program that is not a mint
    let not_a_mint = Pubkey::new_unique();
    let rent = env.svm.minimum_balance_for_rent_exemption(10);
    env.svm
        .set_account(
            not_a_mint,
            solana_account(anchor_spl::token::ID, vec![1; 10], rent),
        )
        .unwrap();
    let mut args = env.default_args(1);
    args.allowed_mints[0].mint = not_a_mint;
    let ix = env.init_ix(&owner, args, &[not_a_mint]);
    assert_err(env.send(ix, &owner_kp), VaultError::InvalidMint);
}

#[test]
fn initialize_cannot_overwrite_an_existing_vault() {
    let mut env = Env::new();
    let address = env.init_default();
    let owner = env.owner.pubkey();
    let mut args = env.default_args(2);
    args.keeper = env.attacker.pubkey();
    let ix = env.init_ix(&owner, args, &env.mints[..2].to_vec());
    let owner_kp = env.owner.insecure_clone();
    assert!(env.send(ix, &owner_kp).is_err());
    assert_eq!(env.vault(&address).keeper, env.keeper.pubkey());
}

#[test]
fn one_owner_can_have_several_vaults() {
    let mut env = Env::new();
    env.init_default();
    let owner = env.owner.pubkey();
    let mut args = env.default_args(2);
    args.vault_id = 8;
    let ix = env.init_ix(&owner, args, &env.mints[..2].to_vec());
    let owner_kp = env.owner.insecure_clone();
    env.send(ix, &owner_kp).unwrap();
    assert_eq!(env.vault(&env.vault_address(&owner, 8)).vault_id, 8);
}

// ---------------------------------------------------------------- update_config

#[test]
fn owner_updates_config_and_emits_event() {
    let mut env = Env::new();
    let address = env.init_default();
    let owner = env.owner.pubkey();
    let new_mints = env.allowed(3);
    let args = UpdateConfigArgs {
        allowed_mints: Some(new_mints.clone()),
        max_slippage_bps: Some(100),
        max_oracle_staleness_secs: Some(30),
        strategy_hash: Some([7; 32]),
        max_daily_loss_usd: Some(1_000_000),
    };
    let ix = env.update_ix(&owner, address, args, &env.mints[..3].to_vec());
    let owner_kp = env.owner.insecure_clone();
    assert!(emitted_event(&env.send(ix, &owner_kp).unwrap()));

    let v = env.vault(&address);
    assert_eq!(v.allowed_mints, new_mints);
    assert_eq!(v.max_daily_loss_usd, 1_000_000);
    assert_eq!(
        (
            v.max_slippage_bps,
            v.max_oracle_staleness_secs,
            v.strategy_hash
        ),
        (100, 30, [7; 32])
    );
}

#[test]
fn update_config_leaves_omitted_fields_unchanged() {
    let mut env = Env::new();
    let address = env.init_default();
    let owner = env.owner.pubkey();
    let ix = env.update_ix(
        &owner,
        address,
        UpdateConfigArgs {
            max_slippage_bps: Some(200),
            ..NO_UPDATE()
        },
        &[],
    );
    let owner_kp = env.owner.insecure_clone();
    env.send(ix, &owner_kp).unwrap();
    let v = env.vault(&address);
    assert_eq!(v.max_slippage_bps, 200);
    assert_eq!(v.allowed_mints, env.allowed(2));
    assert_eq!(
        (v.max_oracle_staleness_secs, v.strategy_hash),
        (60, [42; 32])
    );
}

#[test]
fn update_config_validates_and_changes_nothing_on_error() {
    let mut env = Env::new();
    let address = env.init_default();
    let owner = env.owner.pubkey();
    let owner_kp = env.owner.insecure_clone();

    // a valid hash together with an invalid slippage: the hash must not be applied either
    let args = UpdateConfigArgs {
        strategy_hash: Some([9; 32]),
        max_slippage_bps: Some(501),
        ..NO_UPDATE()
    };
    let ix = env.update_ix(&owner, address, args, &[]);
    assert_err(env.send(ix, &owner_kp), VaultError::SlippageAboveCap);
    assert_eq!(env.vault(&address).strategy_hash, [42; 32]);

    let ix = env.update_ix(
        &owner,
        address,
        UpdateConfigArgs {
            max_oracle_staleness_secs: Some(121),
            ..NO_UPDATE()
        },
        &[],
    );
    assert_err(env.send(ix, &owner_kp), VaultError::StalenessAboveCap);

    let mut dup = env.allowed(2);
    dup[1].mint = dup[0].mint;
    let ix = env.update_ix(
        &owner,
        address,
        UpdateConfigArgs {
            allowed_mints: Some(dup),
            ..NO_UPDATE()
        },
        &[env.mints[0], env.mints[0]],
    );
    assert_err(env.send(ix, &owner_kp), VaultError::DuplicateMint);

    let ix = env.update_ix(
        &owner,
        address,
        UpdateConfigArgs {
            allowed_mints: Some(env.allowed(3)),
            ..NO_UPDATE()
        },
        &[],
    );
    assert_err(env.send(ix, &owner_kp), VaultError::MintAccountsMismatch);
}

// ---------------------------------------------------------------- set_keeper / set_paused

#[test]
fn owner_sets_and_removes_the_keeper() {
    let mut env = Env::new();
    let address = env.init_default();
    let owner = env.owner.pubkey();
    let owner_kp = env.owner.insecure_clone();
    let new_keeper = Pubkey::new_unique();

    let ix = env.set_keeper_ix(&owner, address, new_keeper);
    assert!(emitted_event(&env.send(ix, &owner_kp).unwrap()));
    assert_eq!(env.vault(&address).keeper, new_keeper);

    let ix = env.set_keeper_ix(&owner, address, Pubkey::default());
    env.send(ix, &owner_kp).unwrap();
    assert!(!env.vault(&address).has_keeper());
}

#[test]
fn owner_pauses_and_resumes() {
    let mut env = Env::new();
    let address = env.init_default();
    let owner = env.owner.pubkey();
    let owner_kp = env.owner.insecure_clone();

    let ix = env.set_paused_ix(&owner, address, true);
    assert!(emitted_event(&env.send(ix, &owner_kp).unwrap()));
    assert!(env.vault(&address).paused);
    let ix = env.set_paused_ix(&owner, address, false);
    env.send(ix, &owner_kp).unwrap();
    assert!(!env.vault(&address).paused);
}

// ---------------------------------------------------------------- only the owner

#[test]
fn keeper_and_strangers_cannot_configure_the_vault() {
    let mut env = Env::new();
    let address = env.init_default();
    for signer in [env.keeper.insecure_clone(), env.attacker.insecure_clone()] {
        let me = signer.pubkey();
        let ix = env.update_ix(
            &me,
            address,
            UpdateConfigArgs {
                max_slippage_bps: Some(500),
                ..NO_UPDATE()
            },
            &[],
        );
        assert_err(env.send(ix, &signer), VaultError::Unauthorized);
        let ix = env.set_keeper_ix(&me, address, me);
        assert_err(env.send(ix, &signer), VaultError::Unauthorized);
        let ix = env.set_paused_ix(&me, address, true);
        assert_err(env.send(ix, &signer), VaultError::Unauthorized);
    }
    let v = env.vault(&address);
    assert_eq!(
        (v.max_slippage_bps, v.keeper, v.paused),
        (50, env.keeper.pubkey(), false)
    );
}

#[test]
fn naming_the_owner_without_their_signature_fails() {
    // The attacker passes the real owner's key but cannot sign for it.
    let mut env = Env::new();
    let address = env.init_default();
    let owner = env.owner.pubkey();
    let mut ix = env.set_keeper_ix(&owner, address, env.attacker.pubkey());
    ix.accounts[0].is_signer = false;
    let attacker = env.attacker.insecure_clone();
    assert!(env.send(ix, &attacker).is_err());
    assert_eq!(env.vault(&address).keeper, env.keeper.pubkey());
}

#[test]
fn a_vault_cannot_be_reached_through_someone_elses_pda() {
    // The attacker's own vault, used with the victim's vault account, still fails has_one.
    let mut env = Env::new();
    let victim_vault = env.init_default();
    let attacker = env.attacker.insecure_clone();
    let attacker_key = attacker.pubkey();
    let ix = env.init_ix(&attacker_key, env.default_args(2), &env.mints[..2].to_vec());
    env.send(ix, &attacker).unwrap();
    let ix = env.set_paused_ix(&attacker_key, victim_vault, true);
    assert_err(env.send(ix, &attacker), VaultError::Unauthorized);
    assert!(!env.vault(&victim_vault).paused);
}
