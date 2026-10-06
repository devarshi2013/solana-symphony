//! Integration tests for deposit and withdraw, running the compiled program
//! (target/deploy/vault.so) in LiteSVM with the real SPL Token and ATA programs.
//! Build it first: `anchor build`. Run: `cd tests/vault-litesvm && cargo test`.

mod common;

use anchor_lang::prelude::Pubkey;
use common::*;
use solana_keypair::Keypair;
use solana_signer::Signer;
use vault::{
    error::VaultError,
    events::{Deposited, Withdrawn},
    UpdateConfigArgs,
};

/// A vault with 2 allowed mints, and an owner holding 1_000 of mint 0 in their ATA.
struct Setup {
    env: Env,
    owner: Keypair,
    vault: Pubkey,
    mint: Pubkey,
    owner_ata: Pubkey,
    vault_ata: Pubkey,
}

fn setup() -> Setup {
    let mut env = Env::new();
    let vault = env.init_default();
    let owner = env.owner.insecure_clone();
    let mint = env.mints[0];
    let owner_ata = env.fund(owner.pubkey(), mint, 1_000);
    let vault_ata = env.ata(&vault, &mint);
    Setup {
        env,
        owner,
        vault,
        mint,
        owner_ata,
        vault_ata,
    }
}

impl Setup {
    fn deposit(&mut self, amount: u64) -> Result<Vec<String>, String> {
        let ix = self.env.deposit_ix(
            &self.owner.pubkey(),
            self.vault,
            self.mint,
            self.owner_ata,
            self.vault_ata,
            amount,
        );
        self.env.send(ix, &self.owner)
    }

    fn withdraw(&mut self, amount: u64) -> Result<Vec<String>, String> {
        let ix = self.env.withdraw_ix(
            &self.owner.pubkey(),
            self.vault,
            self.mint,
            self.vault_ata,
            self.owner_ata,
            amount,
        );
        self.env.send(ix, &self.owner)
    }

    fn pause(&mut self) {
        let ix = self
            .env
            .set_paused_ix(&self.owner.pubkey(), self.vault, true);
        self.env.send(ix, &self.owner).unwrap();
    }

    fn balances(&self) -> (Option<u64>, Option<u64>) {
        (
            self.env.balance(&self.owner_ata),
            self.env.balance(&self.vault_ata),
        )
    }
}

// ---------------------------------------------------------------- deposit

#[test]
fn first_deposit_creates_the_vault_ata_and_moves_tokens() {
    let mut s = setup();
    assert_eq!(s.balances(), (Some(1_000), None));

    let logs = s.deposit(400).unwrap();
    assert_eq!(s.balances(), (Some(600), Some(400)));
    let ata = s.env.svm.get_account(&s.vault_ata).unwrap();
    assert_eq!(ata.owner, anchor_spl::token::ID);
    let event: Deposited = find_event(&logs).expect("Deposited event");
    assert_eq!(
        (event.vault, event.mint, event.amount, event.vault_balance),
        (s.vault, s.mint, 400, 400)
    );

    // The second deposit reuses the existing ATA.
    let logs = s.deposit(100).unwrap();
    assert_eq!(s.balances(), (Some(500), Some(500)));
    assert_eq!(find_event::<Deposited>(&logs).unwrap().vault_balance, 500);
}

#[test]
fn deposit_works_while_paused() {
    let mut s = setup();
    s.pause();
    s.deposit(250).unwrap();
    assert_eq!(s.balances(), (Some(750), Some(250)));
}

#[test]
fn deposit_rejects_zero_and_more_than_the_owner_holds() {
    let mut s = setup();
    assert_err(s.deposit(0), VaultError::ZeroAmount);
    assert_err(s.deposit(1_001), VaultError::InsufficientBalance);
    s.deposit(1_000).unwrap();
    assert_eq!(s.balances(), (Some(0), Some(1_000)));
}

#[test]
fn deposit_rejects_a_mint_that_is_not_allowed() {
    let mut s = setup();
    let other = s.env.mints[5];
    let from = s.env.fund(s.owner.pubkey(), other, 1_000);
    let to = s.env.ata(&s.vault, &other);
    let ix = s
        .env
        .deposit_ix(&s.owner.pubkey(), s.vault, other, from, to, 10);
    assert_err(s.env.send(ix, &s.owner), VaultError::MintNotAllowed);
    assert_eq!(s.env.balance(&to), None);
}

#[test]
fn deposit_rejects_a_non_canonical_vault_token_account() {
    // A token account whose authority is the vault but which is not its ATA.
    let mut s = setup();
    let fake = Pubkey::new_unique();
    s.env.set_token_account(fake, s.mint, s.vault, 0);
    let ix = s
        .env
        .deposit_ix(&s.owner.pubkey(), s.vault, s.mint, s.owner_ata, fake, 10);
    assert!(s.env.send(ix, &s.owner).is_err());
    assert_eq!(s.env.balance(&fake), Some(0));
    assert_eq!(s.env.balance(&s.owner_ata), Some(1_000));
}

#[test]
fn only_the_owner_can_deposit() {
    let mut s = setup();
    for signer in [
        s.env.keeper.insecure_clone(),
        s.env.attacker.insecure_clone(),
    ] {
        let from = s.env.fund(signer.pubkey(), s.mint, 100);
        let ix = s
            .env
            .deposit_ix(&signer.pubkey(), s.vault, s.mint, from, s.vault_ata, 10);
        assert_err(s.env.send(ix, &signer), VaultError::Unauthorized);
    }
    assert_eq!(s.env.balance(&s.vault_ata), None);
}

// ---------------------------------------------------------------- withdraw

#[test]
fn owner_withdraws_to_their_ata() {
    let mut s = setup();
    s.deposit(400).unwrap();
    let logs = s.withdraw(150).unwrap();
    assert_eq!(s.balances(), (Some(750), Some(250)));
    let event: Withdrawn = find_event(&logs).expect("Withdrawn event");
    assert_eq!(
        (
            event.vault,
            event.mint,
            event.amount,
            event.destination,
            event.vault_balance
        ),
        (s.vault, s.mint, 150, s.owner_ata, 250)
    );

    s.withdraw(250).unwrap();
    assert_eq!(s.balances(), (Some(1_000), Some(0)));
}

#[test]
fn withdraw_works_while_paused() {
    let mut s = setup();
    s.deposit(400).unwrap();
    s.pause();
    s.withdraw(400).unwrap();
    assert_eq!(s.balances(), (Some(1_000), Some(0)));
}

#[test]
fn withdraw_works_for_a_mint_no_longer_allowed() {
    let mut s = setup();
    s.deposit(400).unwrap();
    // Remove mint 0 from the allowed list while the vault still holds it.
    let mut allowed = s.env.allowed(2);
    allowed.remove(0);
    let ix = s.env.update_ix(
        &s.owner.pubkey(),
        s.vault,
        UpdateConfigArgs {
            allowed_mints: Some(allowed),
            ..NO_UPDATE()
        },
        &[s.env.mints[1]],
    );
    s.env.send(ix, &s.owner).unwrap();
    assert_err(s.deposit(1), VaultError::MintNotAllowed);
    s.withdraw(400).unwrap();
    assert_eq!(s.balances(), (Some(1_000), Some(0)));
}

#[test]
fn withdraw_rejects_zero_and_more_than_the_vault_holds() {
    let mut s = setup();
    s.deposit(400).unwrap();
    assert_err(s.withdraw(0), VaultError::ZeroAmount);
    assert_err(s.withdraw(401), VaultError::InsufficientBalance);
    assert_eq!(s.balances(), (Some(600), Some(400)));
}

#[test]
fn keeper_and_strangers_cannot_withdraw() {
    let mut s = setup();
    s.deposit(400).unwrap();
    for signer in [
        s.env.keeper.insecure_clone(),
        s.env.attacker.insecure_clone(),
    ] {
        let to = s.env.fund(signer.pubkey(), s.mint, 0);
        let ix = s
            .env
            .withdraw_ix(&signer.pubkey(), s.vault, s.mint, s.vault_ata, to, 400);
        assert_err(s.env.send(ix, &signer), VaultError::Unauthorized);
        assert_eq!(s.env.balance(&to), Some(0));
    }
    assert_eq!(s.env.balance(&s.vault_ata), Some(400));
}

#[test]
fn withdraw_only_pays_the_owners_ata() {
    let mut s = setup();
    s.deposit(400).unwrap();

    // Someone else's ATA, even with the owner's signature.
    let attacker_ata = s.env.fund(s.env.attacker.pubkey(), s.mint, 0);
    // A token account the owner controls that is not their ATA.
    let owner_other = Pubkey::new_unique();
    s.env
        .set_token_account(owner_other, s.mint, s.owner.pubkey(), 0);

    for to in [attacker_ata, owner_other] {
        let ix = s
            .env
            .withdraw_ix(&s.owner.pubkey(), s.vault, s.mint, s.vault_ata, to, 400);
        assert!(s.env.send(ix, &s.owner).is_err());
        assert_eq!(s.env.balance(&to), Some(0));
    }
    assert_eq!(s.env.balance(&s.vault_ata), Some(400));
}

#[test]
fn an_owner_cannot_withdraw_from_someone_elses_vault() {
    let mut s = setup();
    s.deposit(400).unwrap();
    let attacker = s.env.attacker.insecure_clone();
    let ix = s.env.init_ix(
        &attacker.pubkey(),
        s.env.default_args(2),
        &s.env.mints[..2].to_vec(),
    );
    s.env.send(ix, &attacker).unwrap();

    let to = s.env.fund(attacker.pubkey(), s.mint, 0);
    let ix = s
        .env
        .withdraw_ix(&attacker.pubkey(), s.vault, s.mint, s.vault_ata, to, 400);
    assert_err(s.env.send(ix, &attacker), VaultError::Unauthorized);
    assert_eq!(s.env.balance(&s.vault_ata), Some(400));
}
