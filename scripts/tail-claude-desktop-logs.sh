#!/usr/bin/env bash
# Tail Claude Desktop's MCP server logs for our hpp-x402 bridge so you
# can watch the bridge's stderr in real time during a demo.
#
#   ./scripts/tail-claude-desktop-logs.sh
#
# Claude Desktop writes per-MCP-server stderr to ~/Library/Logs/Claude/
# on macOS. The exact filename includes the server name we set in
# claude_desktop_config.json — "hpp-x402" — so the log is:
#   ~/Library/Logs/Claude/mcp-server-hpp-x402.log
# General MCP runtime errors land in ~/Library/Logs/Claude/mcp.log

set -euo pipefail

LOG_DIR="$HOME/Library/Logs/Claude"
SERVER_LOG="$LOG_DIR/mcp-server-hpp-x402.log"
RUNTIME_LOG="$LOG_DIR/mcp.log"

if [[ ! -d "$LOG_DIR" ]]; then
  echo "Log dir not found: $LOG_DIR"
  echo "Has Claude Desktop been launched at least once?"
  exit 1
fi

# Touch missing logs so tail -F doesn't error before Claude creates them.
touch "$SERVER_LOG" "$RUNTIME_LOG" 2>/dev/null || true

echo "tailing:"
echo "  $SERVER_LOG   (bridge stderr)"
echo "  $RUNTIME_LOG  (Claude MCP runtime)"
echo ""
exec tail -F "$SERVER_LOG" "$RUNTIME_LOG"
