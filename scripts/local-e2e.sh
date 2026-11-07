#!/usr/bin/env bash
# Full local test: builds the program with a throwaway seed, starts solana-test-validator with
# three fake Pyth price accounts, and runs apps/runner/src/e2e-local.ts against it.
# Needs the Solana CLI (cargo-build-sbf, solana-test-validator) on PATH and `pnpm install` done.
set -euo pipefail
cd "$(dirname "$0")/.."
export PIT_SEED="${PIT_SEED:-local-e2e-throwaway-seed}"
work="$(mktemp -d)"
program_id="$(scripts/house-keys.sh | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).programId))')"

cp programs/turing_pit/src/lib.rs "$work/lib.rs.orig"
cleanup() {
  cp "$work/lib.rs.orig" programs/turing_pit/src/lib.rs
  [[ -n "${validator:-}" ]] && kill "$validator" 2>/dev/null || true
}
trap cleanup EXIT

scripts/set-program-id.sh "$program_id"
cargo-build-sbf --manifest-path programs/turing_pit/Cargo.toml

(cd apps/runner && ./node_modules/.bin/tsx src/e2e-local.ts --accounts "$work/accounts") > "$work/accounts.txt"
args=()
while read -r address file; do args+=(--account "$address" "$file"); done < "$work/accounts.txt"

solana-test-validator --reset --quiet --ledger "$work/ledger" \
  --bpf-program "$program_id" target/deploy/turing_pit.so "${args[@]}" > "$work/validator.log" 2>&1 &
validator=$!
for _ in $(seq 1 60); do
  solana cluster-version -u http://127.0.0.1:8899 >/dev/null 2>&1 && break
  sleep 1
done

(cd apps/runner && RPC_URL=http://127.0.0.1:8899 ./node_modules/.bin/tsx src/e2e-local.ts)
