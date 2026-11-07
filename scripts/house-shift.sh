#!/usr/bin/env bash
# One shift of the house on a GitHub runner (.github/workflows/runner.yml). Runs the runner for
# about 5 h 40 min (SHIFT_MIN, default 340; tests can set the end as a unix time in SHIFT_END),
# restarts it if it crashes, and publishes its log to the ci-runner branch every two minutes.
# The shift ends five minutes into a round, so the next shift takes over while a round is under
# way rather than while one opens or settles.
# Writes next=true to $GITHUB_OUTPUT when the next shift should start: not when PIT_SEED is
# missing, and not when the program isn't deployed yet (CI starts the house after the deploy).
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
out="${GITHUB_OUTPUT:-/dev/null}"
if [ -z "${PIT_SEED:-}" ]; then echo "PIT_SEED is not set"; exit 0; fi

mkdir -p runner-out && touch runner-out/runner.log
publish() { tail -n 3000 runner-out/runner.log > runner-out/recent.log 2>/dev/null; scripts/publish-branch.sh ci-runner runner-out > /dev/null 2>&1 || true; }
(while sleep 120; do publish; done) &
publisher=$!
trap 'kill "$publisher" 2>/dev/null' EXIT

round=900 # ROUND_SECONDS in the SDK
start=$(date +%s)
end=${SHIFT_END:-$(( (start + ${SHIFT_MIN:-340} * 60 - 300) / round * round + 300 ))}
echo "shift from $(date -u -d @"$start" +%H:%M:%S) to $(date -u -d @"$end" +%H:%M:%S) UTC" | tee -a runner-out/runner.log

while [ "$(date +%s)" -lt $(( end - 60 )) ]; do
  DURATION_MIN=$(awk -v s=$(( end - $(date +%s) )) 'BEGIN { printf "%.2f", s / 60 }')
  export DURATION_MIN
  pnpm --silent --filter @turing-pit/runner start 2>&1 | tee -a runner-out/runner.log
  code=${PIPESTATUS[0]}
  if [ "$code" = 3 ]; then
    echo "nothing to run until the program is deployed; CI starts the house after the deploy" | tee -a runner-out/runner.log
    exit 0
  fi
  [ "$code" = 0 ] || echo "the house stopped with code $code; restarting" | tee -a runner-out/runner.log
  sleep 10
done
echo "shift over at $(date -u +%H:%M:%S) UTC; starting the next one" | tee -a runner-out/runner.log
echo "next=true" >> "$out"
