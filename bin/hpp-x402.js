#!/usr/bin/env node
import("../dist/cli/hpp-x402.js").catch((err) => {
  process.stderr.write(`hpp-x402 fatal: ${err?.message ?? err}\n`);
  process.exit(1);
});
