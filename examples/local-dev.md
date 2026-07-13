# Local development integration

While the package is unpublished, point Claude Desktop / OpenClaw at your
local build instead of `npx`.

## 1. Build once

```bash
cd /path/to/x402-mcp-bridge
pnpm install   # or npm install
pnpm build     # or npx tsc
```

## 2. Use absolute path in the host config

Replace the `command` / `args` block in
[`claude_desktop_config.json`](claude_desktop_config.json) (or
[`openclaw_config.json`](openclaw_config.json)) with:

```jsonc
"command": "node",
"args": ["/absolute/path/to/x402-mcp-bridge/dist/index.js"],
"env": { /* same as published example */ }
```

## 3. Quick stdio smoke (without a host)

Verify the bridge actually proxies + pays before wiring it into Claude
Desktop:

```bash
cd /path/to/x402-mcp-bridge
DELEGATE_PRIVATE_KEY=0x... \
SAFE_ADDRESS=0x... \
ALLOWANCE_MODULE_ADDRESS=0x... \
USDCE_ADDRESS=0x... \
RESOURCE_SERVER_URL=http://localhost:4021/mcp/sse \
HPP_RPC_URL=https://sepolia.hpp.io \
HPP_NETWORK=eip155:181228 \
LOG_LEVEL=debug \
npx tsx scripts/smoke.ts
```

Successful run prints `🎉 bridge smoke OK` and includes either
`autoTopup.skipped` (delegate already has balance) or
`autoTopup.executed` (Safe → delegate transfer just fired).
