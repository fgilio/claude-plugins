#!/usr/bin/env bash
# Sets up a Claude Code cloud session: Franco's plugins, the official Codex
# plugin, the Codex CLI, and a default Codex config. A cloud environment's
# setup script runs it, see README.md#cloud-sessions.

set -uo pipefail

readonly FGILIO_PLUGINS=(coding polish fgilio-review codex-partner)
readonly CODEX_CONFIG="$HOME/.codex/config.toml"

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

# shellcheck disable=SC2317,SC2329 # run_step calls it through "$@"
write_codex_config() {
  mkdir -p "$(dirname "$CODEX_CONFIG")"
  cat >"$CODEX_CONFIG" <<'EOF'
model = "gpt-6.1-sol"
model_reasoning_effort = "xhigh"
EOF
}

# Claude Code caches the environment only when setup finishes in about five
# minutes, so the CLI installs while the plugins do, and a stalled registry fails.
run_step "Codex CLI" timeout --kill-after=10 240 npm install --global --no-audit --no-fund @openai/codex &
codex_install=$!

# Plugin installs write the same settings file, so they run one at a time.
for plugin in "${FGILIO_PLUGINS[@]}"; do
  run_step "$plugin@fgilio" claude plugin install "$plugin@fgilio"
done

run_step "codex@openai-codex" claude plugin install codex --marketplace openai/codex-plugin-cc

if [[ -f "$CODEX_CONFIG" ]]; then
  printf 'skip  Codex config (%s exists)\n' "$CODEX_CONFIG"
else
  run_step "Codex config" write_codex_config
fi

wait "$codex_install"

failed=$(grep -c '^FAIL' "$results")
printf 'cloud-setup: %s steps, %s failed\n' "$(wc -l <"$results" | tr -d ' ')" "$failed"
exit 0
