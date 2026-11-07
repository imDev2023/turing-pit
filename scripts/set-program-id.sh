#!/usr/bin/env bash
# Writes a program address into declare_id!. The address is derived from PIT_SEED, so CI and
# local tests set it right before building instead of committing a keypair.
set -euo pipefail
cd "$(dirname "$0")/.."
id="$1"
sed -i -E "s/declare_id!\(\"[1-9A-HJ-NP-Za-km-z]+\"\)/declare_id!(\"$id\")/" programs/turing_pit/src/lib.rs
grep -q "declare_id!(\"$id\")" programs/turing_pit/src/lib.rs
