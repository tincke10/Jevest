#!/usr/bin/env bash
# Smoke test of the Action bundle (dist/main.mjs). Run by the Release workflow
# before tagging and by CI on every push; it never publishes anything.
# Needs RUNNER_TEMP (falls back to a temp dir).
set -euo pipefail
fail() { echo "::error::bundle smoke test: $1"; exit 1; }
no_module_errors() {
  if grep -Eq "Dynamic require|Cannot find module|ERR_MODULE_NOT_FOUND|ERR_REQUIRE_ESM|ERR_AMBIGUOUS_MODULE_SYNTAX|ReferenceError" "$1"; then
    fail "module/runtime error in $1"
  fi
}
RUNNER_TEMP="${RUNNER_TEMP:-$(mktemp -d)}"
logs="$RUNNER_TEMP/smoke"
mkdir -p "$logs"

# 1. No inputs at all: must stop on the clean input error, not crash.
set +e
env -i PATH="$PATH" HOME="$HOME" node --enable-source-maps dist/main.mjs >"$logs/no-env.log" 2>&1
code=$?
set -e
cat "$logs/no-env.log"
[ "$code" -ne 0 ] || fail "expected a non-zero exit without inputs"
grep -qF 'missing required input "github-token"' "$logs/no-env.log" \
  || fail "expected the missing github-token input error"
no_module_errors "$logs/no-env.log"

# 2. Loads config/jevest.example.yml (the built-in defaults) from the
#    bundle layout: an unknown key in a local .jevest.yml is only
#    reported after the defaults were read and merged.
ws="$RUNNER_TEMP/smoke-workspace"
mkdir -p "$ws"
printf 'jevestSmokeUnknownKey: 1\n' >"$ws/.jevest.yml"
printf '%s\n' '{"pull_request":{"number":1,"head":{"sha":"0000000000000000000000000000000000000001"},"base":{"sha":"0000000000000000000000000000000000000002"}},"repository":{"name":"jevest-smoke","owner":{"login":"jevest-smoke"}}}' >"$ws/event.json"
set +e
env -i PATH="$PATH" HOME="$HOME" \
  INPUT_GITHUB_TOKEN=not-a-token INPUT_TYPESAFE_API_KEY=not-a-key \
  INPUT_CONFIG_FROM_CHECKOUT=true GITHUB_WORKSPACE="$ws" GITHUB_EVENT_PATH="$ws/event.json" \
  node --enable-source-maps dist/main.mjs >"$logs/config.log" 2>&1
set -e
cat "$logs/config.log"
grep -qF "jevestSmokeUnknownKey" "$logs/config.log" \
  || fail "expected the config validation error naming the unknown key"
if grep -qF "jevest.example.yml not found" "$logs/config.log"; then
  fail "the built-in defaults were not found from dist/"
fi
no_module_errors "$logs/config.log"
