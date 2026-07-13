# @hpp-io/x402-mcp-bridge

> The agent payment rail for HPP. A stdio MCP bridge + the `hpp-x402` CLI that let
> Claude Desktop / Claude Code / Cursor / Windsurf / OpenClaw make autonomous
> **HPP USDC.e** payments over [x402](https://x402.org) — discover paid services,
> pay per call, within a spend cap. No API keys, no manual signing.

## 📖 Full documentation

**[hpp-io/x402-tools](https://github.com/hpp-io/x402-tools)** — the complete manual:
how it works, every command, buyer **and** seller flows, payment schemes
(exact / upto), wallet modes, and troubleshooting. This README is a quick reference.

## Install

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/hpp-io/x402-tools/main/install/install.sh | bash
# Windows (PowerShell)
irm https://raw.githubusercontent.com/hpp-io/x402-tools/main/install/install.ps1 | iex
# …or npm
npm install -g @hpp-io/x402-mcp-bridge
```

Needs Node 20+. On a headless box (no OS keychain) use `setup --print-key` — see
the [manual](https://github.com/hpp-io/x402-tools#requirements).

## Quick start

```bash
hpp-x402 setup --install claude-code   # create a wallet + register into your host
hpp-x402 fund                          # where to send USDC.e (gasless, no native gas)
hpp-x402 status                        # confirm it's wired
```

Restart your host and your agent can discover and pay for services. Browse and pay
from the terminal too:

```bash
hpp-x402 discover --limit 5                        # shows type · scheme · price · URL · id
hpp-x402 call <url-or-id> --body '{"hi":"there"}'  # pay + call — a URL, or an id from discover
```

Full command reference, selling (`serve`), schemes, and Safe mode →
the **[manual](https://github.com/hpp-io/x402-tools)**.

## Use it from an MCP host

The host spawns the bridge over stdio. A bare entry boots zero-config on HPP
Sepolia with an auto-created keychain wallet:

```jsonc
{ "mcpServers": { "hpp-x402": {
  "command": "npx", "args": ["-y", "@hpp-io/x402-mcp-bridge"]
} } }
```

`hpp-x402 install <host>` writes this for you. Note: a bare
`npx @hpp-io/x402-mcp-bridge` runs the MCP **server** (what the host wants) — for
the CLI use `npx -y -p @hpp-io/x402-mcp-bridge hpp-x402 <command>`.

### Host-facing tools

| Tool | What it does |
|------|--------------|
| `wallet_address` | report your wallet address (to fund it) |
| `hpp_discover` | list/search the curated HPP directory (read-only) |
| `hpp_call` | call a discovered service; pays via your wallet |
| `x402_http_call` | pay + call any x402 HTTP endpoint |
| `pay_a2a_agent` | pay + message another A2A agent |

Every paid call stays within your spend cap; discovery never holds funds or sees
your keys.

### Key env (all optional)

| Var | Notes |
|-----|-------|
| `DELEGATE_PRIVATE_KEY` | auto-created in the OS keychain if unset |
| `HPP_NETWORK` | `eip155:181228` Sepolia (default) / `eip155:190415` Mainnet |
| `RESOURCE_SERVER_URL` | proxy one upstream MCP server (omit = local tools only) |
| `SAFE_ADDRESS` + `ALLOWANCE_MODULE_ADDRESS` | set both = Safe (governance) mode |

Full environment reference + Safe/governance setup are in the
[manual](https://github.com/hpp-io/x402-tools).

## Related

Building an agent / SDK integration (LangChain, OpenAI function-calling, AgentKit,
A2A)? See the runnable gallery →
[hpp-io/hpp-x402-agent-sample](https://github.com/hpp-io/hpp-x402-agent-sample)

## License

Apache-2.0
