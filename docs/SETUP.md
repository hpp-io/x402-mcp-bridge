# Setup Guide

End-to-end setup for `@hpp-io/x402-mcp-bridge`. After this, your MCP host
(Claude Desktop / OpenClaw) can call paid x402 services on HPP without
ever seeing a private key.

> **Read first**: this is the *MCP-host* path (Claude Desktop / OpenClaw).
> If you're writing your own agent in code, see the SDK Gallery instead:
> [hpp-io/hpp-x402-agent-sample](https://github.com/hpp-io/hpp-x402-agent-sample).

## What you'll end up with

```
[ Claude Desktop / OpenClaw ]
        │   stdio MCP
        ▼
[ @hpp-io/x402-mcp-bridge (this package) ]
   ─ delegate key from OS Keychain   (no plaintext on disk)
   ─ AutoTopup from your Safe        (chain-enforced daily cap)
   ─ EIP-3009 signs each x402 payment
        │   SSE / StreamableHTTP
        ▼
[ remote x402 MCP server ]
```

## Payment schemes supported

The bridge speaks **two** x402 payment schemes and picks one per call based
on what the remote server advertises:

| Scheme | When the bridge picks it | What happens onchain |
|---|---|---|
| `batch-settlement` *(default when offered)* | server advertises `batch-settlement` in its 402 — typical for high-frequency MCP servers (AI agent calls, micro-payments) | Buyer deposits once into a payment channel, then each call signs an off-chain cumulative voucher. Server claims periodically in batches. **~95% gas savings** at 100+ calls |
| `exact` *(fallback)* | server only advertises `exact` (legacy / one-shot endpoints) | Per-call on-chain EIP-3009 transfer. Same as before — unchanged for existing servers |

Both modes use the same Safe + AllowanceModule + delegate setup from Step 1.
The delegate signs vouchers (batch) or EIP-3009 (exact) — you don't need to
configure anything beyond the standard env block.

Channel state for batch-settlement persists at `~/.hpp-x402/client/`
(override with `HPP_X402_HOME`). The folder survives bridge restarts so
channels don't need to be re-deposited.

### Channel lifecycle (batch-settlement)

```
First paid call:    sign(deposit + voucher) → onchain deposit tx → channel opens
Subsequent calls:   sign(voucher)            → no onchain tx (fast, off-chain)
Server periodically: claim outstanding vouchers + settle to receiver (batched)
When balance low:   bridge auto-deposits again (silent, see logs)
End of day:         use `hpp-x402-channel refund` to reclaim unspent balance
Server uncooperative? use `hpp-x402-channel withdraw` (15min-1day delay)
```

The auto-deposit size = `depositMultiplier × per-call price` (SDK default
`5`). For a long-running agent making many calls to one server, a larger
multiplier means fewer mid-call onchain top-ups (and lower gas amortised).
Override at scheme construction time if you embed the SDK directly — the
bridge currently uses the SDK default.

## Prerequisites

- Node.js 20+
- HPP Sepolia ETH (gas) and USDC.e (payment) — from a faucet or DEX
- An MCP host: Claude Desktop or OpenClaw

## Step 1 — Run the one-shot setup CLI

This deploys a Safe, generates a delegate, enables AllowanceModule, and
sets a daily spend cap. ~30 seconds.

```bash
npx -y -p @hpp-io/x402-mcp-bridge hpp-x402-safe-setup \
  --owner-pk 0xYOUR_OWNER_KEY_USED_ONCE \
  --allowance 1                 # 1 USDC.e/day chain-enforced cap
  --fund-usdc 5                 # seed the Safe with 5 USDC.e
  --fund-eth 0.001              # seed the delegate with gas
  --resource-server-url https://YOUR_X402_MCP_SERVER/mcp/sse
```

You'll see something like:

```
✓ Safe deployed         : 0xc8638b…
✓ Delegate generated    : 0x1717aa…
✓ AllowanceModule enabled
✓ addDelegate / setAllowance done
✓ Funded
```

The CLI prints a copy-pasteable env block at the end. **Don't paste it
yet** — Step 2 replaces the `DELEGATE_PRIVATE_KEY` line with a keychain
reference instead.

## Step 2 — Move the delegate key into the OS keychain

The setup output includes `--delegate-pk 0x…`. Move that key into the
OS keychain (macOS Keychain / Windows Credential Vault / Linux libsecret)
so it never lives in a config file.

```bash
echo "0xPASTE_DELEGATE_PK_HERE" | \
  npx -y -p @hpp-io/x402-mcp-bridge hpp-x402-keychain set --stdin
```

Output:

```
✓ stored
  uri      : keychain://hpp-x402/delegate-default
  address  : 0x1717aa…    ← matches the delegate address from Step 1
```

Verify:

```bash
npx -y -p @hpp-io/x402-mcp-bridge hpp-x402-keychain show
# → prints uri + address (never the key itself)
```

> Prefer to generate a fresh key in the keychain from the start? Use
> `hpp-x402-keychain generate` instead, then re-run Step 1 with
> `--delegate-pk $(hpp-x402-keychain ... )` — but the simpler flow is
> Step 1 generates, Step 2 stores.

## Step 3 — Register the bridge with your MCP host

You can do this automatically (recommended) or manually.

### 3a. Automatic — re-run setup with the install flag

```bash
# Claude Desktop:
npx -y -p @hpp-io/x402-mcp-bridge hpp-x402-safe-setup \
  --owner-pk 0xYOUR_OWNER_KEY \
  --delegate-pk 0xDELEGATE_FROM_STEP_1 \
  --resource-server-url https://YOUR_X402_MCP_SERVER/mcp/sse \
  --install-claude

# OpenClaw:
... --install-openclaw
```

(Setup is idempotent — running it again with the same Safe / delegate
keys just refreshes the host config; on-chain state isn't re-deployed.)

### 3b. Manual — edit the host config

Open the host config (paths below), and add an `hpp-x402` entry under
`mcpServers` (Claude Desktop) or `mcp.servers` (OpenClaw). Use
`keychain://hpp-x402/delegate-default` for `DELEGATE_PRIVATE_KEY`.

**Claude Desktop**:
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`

```jsonc
{
  "mcpServers": {
    "hpp-x402": {
      "command": "npx",
      "args": ["-y", "@hpp-io/x402-mcp-bridge"],
      "env": {
        "DELEGATE_PRIVATE_KEY": "keychain://hpp-x402/delegate-default",
        "SAFE_ADDRESS": "0xYOUR_SAFE",
        "ALLOWANCE_MODULE_ADDRESS": "0x3CcE72483929e0517Dafc8fD192547B3B65f9b07",
        "USDCE_ADDRESS": "0x401eCb1D350407f13ba348573E5630B83638E30D",
        "RESOURCE_SERVER_URL": "https://YOUR_X402_MCP_SERVER/mcp/sse",
        "HPP_RPC_URL": "https://sepolia.hpp.io",
        "HPP_NETWORK": "eip155:181228"
      }
    }
  }
}
```

**OpenClaw**: `~/.openclaw/openclaw.json`

```jsonc
{
  "mcp": {
    "servers": {
      "hpp-x402": { /* same shape as above */ }
    }
  }
}
```

See [`examples/`](../examples/) for ready-to-merge snippets.

## Step 4 — Restart the host and test

- Claude Desktop: cmd+Q (macOS) or close from tray (Windows), reopen
- OpenClaw: restart per its docs

In Claude Desktop, you should see `hpp-x402` in the MCP tools dropdown.
Ask the model to call a tool from your remote server (e.g.
`compute_hello-world`) — the bridge handles 402 + payment silently.

## Managing your batch-settlement channels

After using the bridge for paid MCP calls, your channels accumulate
balance + outstanding vouchers under `~/.hpp-x402/client/`. The
`hpp-x402-channel` CLI lets you inspect and reclaim that balance without
restarting the host.

### Inspect

```bash
# List all local channels (channelId + balance + claimed + chargedCumulative)
hpp-x402-channel ls

# Full state for one channel
hpp-x402-channel status 0xa1223e8529b0f160…
```

### Reclaim (cooperative — server co-signs, immediate)

When you're done with a server and want unspent balance back. Server
cooperation needed (it must be online + co-sign the refund). The
contract atomically claims outstanding vouchers (server gets what you
owe) + refunds the remainder to your wallet in a single tx.

```bash
# Set the same env as the bridge runtime
export AGENT_PRIVATE_KEY=0x…   # or use keychain: in the bridge
export HPP_RPC_URL=https://sepolia.hpp.io/<your-key>
export HPP_NETWORK=eip155:181228
export PAYER_SALT=0x…           # the same salt the bridge used

# Refund 5000 atomic units (channel stays usable for more calls)
hpp-x402-channel refund https://YOUR_X402_MCP_SERVER/mcp/sse 5000

# Refund the rest (closes the channel)
hpp-x402-channel refund https://YOUR_X402_MCP_SERVER/mcp/sse
```

### Reclaim (unilateral — server-free escape hatch)

When the server is offline / unresponsive / can't be trusted to refund.
Two onchain txs separated by the channel's `withdrawDelay` (HPP default
1 day; SDK minimum 15 minutes). Between initiate and finalize the
server may still claim outstanding vouchers — the CLI requests a
conservative `balance - chargedCumulative` so the math stays safe.

```bash
# 1) Declare intent onchain
hpp-x402-channel withdraw https://YOUR_X402_MCP_SERVER/mcp/sse
# → initiate tx printed + "finalize available in ~<delay>s, re-run with --finalize"

# 2) Wait for the delay window
# 3) Drain
hpp-x402-channel withdraw https://YOUR_X402_MCP_SERVER/mcp/sse --finalize
```

`topup` is not yet wired into the CLI — when balance runs low, the
bridge auto-deposits via the SDK. The setup CLI's `--fund-usdc` /
`--fund-eth` covers the *initial* funding of your delegate + Safe.

## Troubleshooting

**"keychain entry not found"**
The bridge couldn't find the keychain slot. Check: `hpp-x402-keychain show`
and re-set if needed.

**"existing hpp-x402 entry differs"**
Setup found a different `hpp-x402` entry already in the host config. Pass
`--force` to overwrite, or edit by hand.

**"newSpent > allowance.spent" on chain**
The daily cap is exhausted. Either wait until tomorrow (cap resets every
1440 min) or re-run setup with a higher `--allowance`.

**Tail bridge logs** (debugging):
```bash
# Claude Desktop on macOS:
tail -f ~/Library/Logs/Claude/mcp-server-hpp-x402.log
```

## Rotating / revoking

```bash
# Generate a fresh delegate in keychain, replacing the old slot:
hpp-x402-keychain generate

# Add the new delegate to your Safe via setup again:
hpp-x402-safe-setup --owner-pk 0x... --delegate-pk $(uri-derived-from-show)

# Emergency revoke (Safe instantly stops funding the delegate):
hpp-x402-safe-revoke --owner-pk 0x... --safe 0x... --delegate 0x...
```

## Loss model recap

| Event | Max additional loss |
|---|---|
| Delegate key (from keychain) leaks | today's remaining allowance + delegate's USDC.e |
| Owner runs `hpp-x402-safe-revoke` | stops within 1 block — only delegate's current balance |
| Both keys leak | whatever's in Safe + delegate (owner can still rotate via Safe) |

Compare to plain `AGENT_PRIVATE_KEY` (no Safe): leak = full balance.

## Where to next

- [`README.md`](../README.md) — architecture + roadmap
- [`hpp-x402-agent-sample`](https://github.com/hpp-io/hpp-x402-agent-sample) — same wallet pattern in SDK code (LangChain / OpenAI / A2A examples)
- File issues at https://github.com/hpp-io/x402-mcp-bridge/issues
