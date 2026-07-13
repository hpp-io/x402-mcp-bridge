#!/usr/bin/env node
/**
 * Entry shim for `npx @hpp-io/x402-mcp-bridge` and Claude Desktop's
 * "command": "npx" launch path. Imports the compiled ESM build.
 */
import("../dist/index.js").then((m) => {
  return m.runBridge();
}).catch((err) => {
  process.stderr.write(`x402-mcp-bridge fatal: ${err?.message ?? err}\n`);
  process.exit(1);
});
