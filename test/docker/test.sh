#!/usr/bin/env bash
# CLI verification — runs inside the container against the installed hpp-x402.
set -u

# Run under a dbus session with an unlocked gnome-keyring so @napi-rs/keyring works.
if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ]; then
  exec dbus-run-session -- "$0" "$@"
fi
eval "$(printf 'testpass\n' | gnome-keyring-daemon --unlock --components=secrets 2>/dev/null)" 2>/dev/null || true
gnome-keyring-daemon --start --components=secrets >/dev/null 2>&1 || true
sleep 1

PASS=0; FAIL=0
ck() { # ck "label" "regex" "command"
  local label="$1" pat="$2" cmd="$3" out
  out=$(bash -c "$cmd" 2>&1)
  if echo "$out" | grep -qiE "$pat"; then
    echo "✅ $label"; PASS=$((PASS+1))
  else
    echo "❌ $label"; echo "     └ got: $(echo "$out" | head -1 | cut -c1-110)"; FAIL=$((FAIL+1))
  fi
}
# Well-known PUBLIC anvil/hardhat test key #0 — NOT a secret (never fund it).
TESTKEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
PAYTO="0x26907E8d732F4abe3E120ef1743352d12738c116" # public receiver address

echo "=================== INSTALL ==================="
ck "installed globally (which hpp-x402)"      "hpp-x402"        "which hpp-x402"
ck "hpp-x402 --version (semver)"              "^[0-9]+\\.[0-9]+\\.[0-9]+$" "hpp-x402 --version"
ck "hpp-x402 --help lists commands"           "setup|wallet|discover" "hpp-x402 --help"
ck "server bin present (x402-mcp-bridge)"      "x402-mcp-bridge" "which x402-mcp-bridge"

echo "=================== WALLET (keychain) ==================="
ck "wallet generate"           "generated 0x[0-9a-fA-F]{40}" "hpp-x402 wallet generate -a t1"
ck "wallet address"            "^0x[0-9a-fA-F]{40}"          "hpp-x402 wallet address -a t1"
ck "wallet balance (on-chain)" "USDC\\.e"                    "hpp-x402 wallet balance -a t1"
ck "wallet import"             "imported 0x"                 "hpp-x402 wallet import $TESTKEY -a t2"
ck "wallet remove"             "removed"                     "hpp-x402 wallet remove -a t1"

echo "=================== SETUP ==================="
ck "setup --print-key (no keychain)" "raw key|generated"     "hpp-x402 setup --print-key -a p1"
ck "setup (keychain + fund line)"    "Fund|wallet"           "hpp-x402 setup -a s1"

echo "=================== FUND / STATUS ==================="
ck "fund (address + gasless note)"   "Send USDC.e|no native gas" "hpp-x402 fund -a s1"
ck "status (network + wallet)"       "network|wallet"        "hpp-x402 status -a s1"

echo "=================== INSTALL <host> ==================="
ck "install cursor writes config"    "cursor|mcp.json"       "hpp-x402 install cursor -a s1"
ck "  → ~/.cursor/mcp.json has entry" "hpp-x402"             "cat ~/.cursor/mcp.json"
ck "install windsurf"                "windsurf|mcp_config"   "hpp-x402 install windsurf -a s1"
ck "install openclaw"                "openclaw|config"       "hpp-x402 install openclaw -a s1"
ck "install claude (desktop)"        "claude|config"         "hpp-x402 install claude -a s1"
ck "install claude-code graceful (no claude CLI)" "not found on PATH" "hpp-x402 install claude-code -a s1"
ck "  → prints the manual claude mcp add command"  "claude mcp add hpp-x402" "hpp-x402 install claude-code -a s1"

echo "=================== DISCOVER (live) ==================="
ck "discover (browse)"               "service|count|resourceId|no services" "hpp-x402 discover --limit 3"
ck "discover search"                 "service|count|no services"            "hpp-x402 discover compute -t http"

echo "=================== POLICY / CHANNEL ==================="
ck "policy path"                     "\\.hpp-x402/policy.json" "hpp-x402 policy path"
ck "policy show"                     "_defaults|\\{"           "hpp-x402 policy show"
ck "policy set + list"               "set|host"               "hpp-x402 policy set api.example.com --max-per-call 0.01; hpp-x402 policy list"
ck "channel ls"                      "channels"               "hpp-x402 channel ls"

echo "=================== SAFE / SERVE / CALL ==================="
ck "safe (usage)"                    "usage|setup|revoke"     "hpp-x402 safe"
# serve: start, probe 402 + healthz, stop
bash -c "hpp-x402 serve --pay-to $PAYTO --port 4030 >/tmp/serve.log 2>&1 &" ; sleep 3
ck "serve → /paid/echo returns 402"  "402"  "curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:4030/paid/echo"
ck "serve → /healthz ok"             "ok|200" "curl -s http://localhost:4030/healthz"
pkill -f 'hpp-x402 serve' 2>/dev/null; pkill -f 'cli/serve' 2>/dev/null
ck "call (graceful error, no funds)" "insufficient|blocked|discovery lookup failed|error" "hpp-x402 call bogus-id-123 -a s1 --body '{}'"

echo "=================== MCP SERVER (zero-config bare boot) ==================="
ck "x402-mcp-bridge boots + auto-wallet" "wallet (created|ready)" "echo '' | timeout 6 env -u DELEGATE_PRIVATE_KEY -u USDCE_ADDRESS -u HPP_RPC_URL -u HPP_NETWORK x402-mcp-bridge 2>&1 | head -20"

echo ""
echo "================================================"
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && echo "ALL CLI CHECKS PASS ✅" || echo "SOME CHECKS FAILED ❌"
exit "$FAIL"
