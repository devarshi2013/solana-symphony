#!/usr/bin/env bash
# Runs the vault's TypeScript tests (programs/vault/tests) with `anchor test` on a fresh
# local solana-test-validator. Never touches devnet: the cluster is forced to localnet.
# Uses a throwaway wallet in target/ (gitignored), created on first run.
set -euo pipefail
cd "$(dirname "$0")/.."

WALLET=target/test-wallet.json
if [ ! -f "$WALLET" ]; then
  mkdir -p target
  solana-keygen new --no-bip39-passphrase --silent --outfile "$WALLET" >/dev/null
fi

# Anchor 1.2 builds SBPF v3 by default, which devnet and mainnet do not run yet (feature
# BUwGLeF3... inactive). Build v0 explicitly, then let anchor test deploy that build.
anchor build --arch v0

exec anchor test \
  --skip-build \
  --validator legacy \
  --provider.cluster localnet \
  --provider.wallet "$WALLET" \
  "$@"
