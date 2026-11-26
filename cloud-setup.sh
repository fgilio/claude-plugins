#!/usr/bin/env bash
# Installs Franco's plugins in a Claude Code cloud session. A cloud
# environment's setup script runs it, see README.md#cloud-sessions.

set -uo pipefail

readonly FGILIO_PLUGINS=(coding polish fgilio-review ship-it)

work_directory=$(mktemp -d) || {
  echo 'cloud-setup: mktemp failed, skipping setup'
  exit 0
}
trap 'rm -rf "$work_directory"' EXIT
results="$work_directory/results"

run_step() {
  local label=$1
  shift
  local log="$work_directory/${label//[^A-Za-z0-9]/-}.log"

  if "$@" >"$log" 2>&1; then
    printf 'ok    %s\n' "$label" | tee -a "$results"
  else
    printf 'FAIL  %s\n' "$label" | tee -a "$results"
    sed 's/^/      /' "$log"
  fi
}

# Plugin installs write the same settings file, so they run one at a time. Each
# is time-boxed: Claude Code caches the environment only when setup finishes in
# about five minutes.
for plugin in "${FGILIO_PLUGINS[@]}"; do
  run_step "$plugin@fgilio" timeout --kill-after=10 60 claude plugin install "$plugin@fgilio"
done

failed=$(grep -c '^FAIL' "$results")
printf 'cloud-setup: %s steps, %s failed\n' "$(wc -l <"$results" | tr -d ' ')" "$failed"
exit 0
