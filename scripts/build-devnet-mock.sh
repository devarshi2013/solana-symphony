#!/usr/bin/env bash
# TEST-ONLY build for devnet. Builds:
#   target/deploy/vault.so, target/deploy/mock_swap.so      normal build (anchor build)
#   target/deploy-devnet-mock/vault.so                       vault with the devnet-mock
#                                                            feature: swap -> mock-swap
# The devnet-mock vault must never be deployed to mainnet. It is written to its own
# directory so it can never replace the normal target/deploy/vault.so.
# Deploy it with the real program keypair:
#   solana program deploy target/deploy-devnet-mock/vault.so \
#     --program-id target/deploy/vault-keypair.json --url devnet
set -euo pipefail
cd "$(dirname "$0")/.."

anchor build --arch v0
cargo-build-sbf --arch v0 \
  --manifest-path programs/vault/Cargo.toml \
  --features devnet-mock \
  --sbf-out-dir target/deploy-devnet-mock
# cargo-build-sbf generates a fresh random keypair next to the .so; it is not the vault's
# program ID, so remove it to avoid deploying under the wrong address.
rm -f target/deploy-devnet-mock/vault-keypair.json
echo "TEST-ONLY devnet-mock vault: target/deploy-devnet-mock/vault.so"
