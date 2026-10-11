#!/usr/bin/env bash
# Sets up a Claude Code cloud session: Franco's plugins, the Codex CLI, and
# the Codex partner. A cloud environment's setup script runs it from the
# marketplace clone:
#
#   claude plugin marketplace add fgilio/claude-plugins || true
#   bash ~/.claude/plugins/marketplaces/fgilio/cloud-setup.sh
#
# Claude Code caches the environment only when setup finishes in about five
# minutes, so the Codex CLI installs while the plugins do. Every step is best
# effort: a failure prints its log and the session still starts.

set -uo pipefail

readonly FGILIO_PLUGINS=(coding polish fgilio-review codex-partner)
readonly CODEX_CONFIG="$HOME/.codex/config.toml"

work_directory=$(mktemp -d)
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

run_step "Codex CLI" npm install --global @openai/codex &
codex_install=$!

# Plugin installs write the same settings file, so they run one at a time.
for plugin in "${FGILIO_PLUGINS[@]}"; do
  run_step "$plugin@fgilio" claude plugin install "$plugin@fgilio"
done

run_step "codex@openai-codex" claude plugin install codex --marketplace openai/codex-plugin-cc

# An environment that ships its own Codex config keeps it.
if [[ -f "$CODEX_CONFIG" ]]; then
  printf 'skip  Codex config (%s exists)\n' "$CODEX_CONFIG"
else
  run_step "Codex config" write_codex_config
fi

wait "$codex_install"

failed=$(grep -c '^FAIL' "$results")
printf 'cloud-setup: %s steps, %s failed\n' "$(wc -l <"$results" | tr -d ' ')" "$failed"
rm -rf "$work_directory"
exit 0
