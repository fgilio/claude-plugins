#!/usr/bin/env bash
# Sets up a Claude Code cloud session: Franco's plugins, the Codex and
# Cloudflare CLIs, a default Codex config, and user instructions. A cloud
# environment's setup script runs it, see README.md#cloud-sessions.

set -uo pipefail

readonly FGILIO_PLUGINS=(coding polish fgilio-review codex-partner)
readonly CODEX_CONFIG="$HOME/.codex/config.toml"
readonly USER_SETTINGS="$HOME/.claude/settings.json"
readonly USER_INSTRUCTIONS="$HOME/.claude/CLAUDE.md"

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

# Node's fetch skips the agent proxy unless told otherwise, so a Node CLI
# never gets the environment's network secrets.
# shellcheck disable=SC2317,SC2329 # run_step calls it through "$@"
route_node_through_proxy() {
  mkdir -p "$(dirname "$USER_SETTINGS")"
  node - "$USER_SETTINGS" <<'EOF'
const fs = require("node:fs")
const path = process.argv[2]
const settings = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, "utf8")) : {}
settings.env = { ...settings.env, NODE_USE_ENV_PROXY: "1" }
fs.writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`)
EOF
}

# shellcheck disable=SC2317,SC2329 # run_step calls it through "$@"
write_user_instructions() {
  mkdir -p "$(dirname "$USER_INSTRUCTIONS")"
  cat >"$USER_INSTRUCTIONS" <<'EOF'
# Cloudflare

When `CLOUDFLARE_API_TOKEN` is set, it reads every Cloudflare account and zone and cannot write. Call `https://api.cloudflare.com/client/v4` with curl and `Authorization: Bearer $CLOUDFLARE_API_TOKEN`, or use the `cf` CLI. The value can be a placeholder that the environment's network secret replaces on the way out, so never print it or judge it by its value.
EOF
}

# Claude Code caches the environment only when setup finishes in about five
# minutes, so the CLIs install while the plugins do, and a stalled registry fails.
run_step "Codex CLI" timeout --kill-after=10 240 npm install --global --no-audit --no-fund @openai/codex &
run_step "Cloudflare CLI" timeout --kill-after=10 240 npm install --global --no-audit --no-fund cf &

# Plugin installs write the same settings file, so they run one at a time.
for plugin in "${FGILIO_PLUGINS[@]}"; do
  run_step "$plugin@fgilio" claude plugin install "$plugin@fgilio"
done

if [[ -f "$CODEX_CONFIG" ]]; then
  printf 'skip  Codex config (%s exists)\n' "$CODEX_CONFIG"
else
  run_step "Codex config" write_codex_config
fi

run_step "Node proxy setting" route_node_through_proxy

if [[ -f "$USER_INSTRUCTIONS" ]]; then
  printf 'skip  User instructions (%s exists)\n' "$USER_INSTRUCTIONS"
else
  run_step "User instructions" write_user_instructions
fi

wait

failed=$(grep -c '^FAIL' "$results")
printf 'cloud-setup: %s steps, %s failed\n' "$(wc -l <"$results" | tr -d ' ')" "$failed"
exit 0
