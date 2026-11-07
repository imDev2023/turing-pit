#!/usr/bin/env bash
# Live-path test: builds the program with a throwaway seed and starts solana-test-validator with it
# plus copies of Pyth's receiver, push oracle and Wormhole programs from devnet, then runs
# apps/runner/src/live-local.ts: the real price keeper against Hermes and, with ANTHROPIC_API_KEY
# set, real Claude agents. Needs network access to devnet (for the copies) and to Hermes.
# SKIP_BUILD=1 reuses target/deploy/turing_pit.so when it was built for the throwaway seed.
set -euo pipefail
cd "$(dirname "$0")/.."
export PIT_SEED="local-e2e-throwaway-seed"
work="$(mktemp -d)"
program_id="$(scripts/house-keys.sh | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).programId))')"

cp programs/turing_pit/src/lib.rs "$work/lib.rs.orig"
cleanup() {
  cp "$work/lib.rs.orig" programs/turing_pit/src/lib.rs
  [[ -n "${validator:-}" ]] && kill "$validator" 2>/dev/null || true
}
trap cleanup EXIT

if [[ "${SKIP_BUILD:-}" != 1 ]]; then
  scripts/set-program-id.sh "$program_id"
  cargo-build-sbf --manifest-path programs/turing_pit/Cargo.toml
fi

mapfile -t clone < <(cd apps/runner && ./node_modules/.bin/tsx src/live-local.ts --clone-args)
solana-test-validator --reset --quiet --ledger "$work/ledger" --url "${CLONE_URL:-https://api.devnet.solana.com}" \
  --bpf-program "$program_id" target/deploy/turing_pit.so "${clone[@]}" > "$work/validator.log" 2>&1 &
validator=$!
for _ in $(seq 1 120); do
  solana cluster-version -u http://127.0.0.1:8899 >/dev/null 2>&1 && break
  if ! kill -0 "$validator" 2>/dev/null; then
    echo "the validator stopped:"
    cat "$work/validator.log"
    exit 1
  fi
  sleep 1
done

(cd apps/runner && RPC_URL=http://127.0.0.1:8899 ./node_modules/.bin/tsx src/live-local.ts)
