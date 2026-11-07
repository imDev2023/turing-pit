#!/usr/bin/env bash
# Prints the house's public addresses as JSON (needs PIT_SEED). Pass
# --write <deployer> <program> [<deploy buffer>] to also write the keypair files the Solana CLI
# needs; never commit those.
set -euo pipefail
cd "$(dirname "$0")/../apps/runner"
exec ./node_modules/.bin/tsx src/print-keys.ts "$@"
