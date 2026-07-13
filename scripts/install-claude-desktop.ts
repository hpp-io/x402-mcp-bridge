/**
 * Safe merge of the hpp-x402 MCP server entry into the user's
 * claude_desktop_config.json. Preserves all other entries; backs up
 * the original; prints a diff before writing; refuses to overwrite a
 * pre-existing different `hpp-x402` entry without --force.
 *
 * Usage:
 *   npx tsx scripts/install-claude-desktop.ts            # show plan
 *   npx tsx scripts/install-claude-desktop.ts --apply    # write
 *   npx tsx scripts/install-claude-desktop.ts --apply --force  # overwrite
 *
 * DELEGATE_PRIVATE_KEY in env can be either:
 *   - 0x[64 hex]                          raw key
 *   - keychain://hpp-x402/<account>       OS keychain reference (recommended;
 *                                         set up first via `hpp-x402-keychain`)
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { homedir, platform } from "node:os";

// ---- locate config -----------------------------------------------------
function configPath(): string {
  const p = platform();
  if (p === "darwin") {
    return resolve(homedir(), "Library/Application Support/Claude/claude_desktop_config.json");
  }
  if (p === "win32") {
    return resolve(process.env.APPDATA ?? "", "Claude/claude_desktop_config.json");
  }
  // Linux: Claude Desktop is officially mac/windows only, but allow override.
  return resolve(homedir(), ".config/Claude/claude_desktop_config.json");
}

// ---- entry to install --------------------------------------------------
const BRIDGE_DIST = resolve(
  dirname(new URL(import.meta.url).pathname),
  "..",
  "dist",
  "index.js",
);

const ENTRY_NAME = "hpp-x402";

function buildEntry(env: NodeJS.ProcessEnv) {
  const required = [
    "DELEGATE_PRIVATE_KEY",
    "SAFE_ADDRESS",
    "ALLOWANCE_MODULE_ADDRESS",
    "USDCE_ADDRESS",
    "RESOURCE_SERVER_URL",
    "HPP_RPC_URL",
    "HPP_NETWORK",
  ];
  const missing = required.filter((k) => !env[k]);
  if (missing.length) {
    console.error("Missing env vars: " + missing.join(", "));
    console.error("Set them in your shell, or `export $(grep -v ^# .env.local | xargs)`.");
    process.exit(1);
  }
  return {
    command: "node",
    args: [BRIDGE_DIST],
    env: {
      DELEGATE_PRIVATE_KEY: env.DELEGATE_PRIVATE_KEY!,
      SAFE_ADDRESS: env.SAFE_ADDRESS!,
      ALLOWANCE_MODULE_ADDRESS: env.ALLOWANCE_MODULE_ADDRESS!,
      USDCE_ADDRESS: env.USDCE_ADDRESS!,
      RESOURCE_SERVER_URL: env.RESOURCE_SERVER_URL!,
      HPP_RPC_URL: env.HPP_RPC_URL!,
      HPP_NETWORK: env.HPP_NETWORK!,
      LOG_LEVEL: env.LOG_LEVEL ?? "info",
    },
  };
}

// ---- main --------------------------------------------------------------
function main() {
  const apply = process.argv.includes("--apply");
  const force = process.argv.includes("--force");

  const path = configPath();
  console.log("config path:", path);

  if (!existsSync(BRIDGE_DIST)) {
    console.error(`bridge dist missing at ${BRIDGE_DIST} — run \`pnpm build\` first`);
    process.exit(1);
  }
  console.log("bridge dist:", BRIDGE_DIST);

  const entry = buildEntry(process.env);

  // Read existing
  let existing: { mcpServers?: Record<string, unknown> } = {};
  if (existsSync(path)) {
    try {
      existing = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      console.error("existing config is not valid JSON:", (err as Error).message);
      process.exit(1);
    }
  } else {
    mkdirSync(dirname(path), { recursive: true });
  }

  const mcpServers = (existing.mcpServers ??= {});
  const prior = mcpServers[ENTRY_NAME];

  if (prior && !force) {
    if (JSON.stringify(prior) === JSON.stringify(entry)) {
      console.log("\nentry already up to date — nothing to do.");
      return;
    }
    console.log("\nexisting hpp-x402 entry differs (showing diff):");
    console.log("--- before");
    console.log(JSON.stringify(prior, null, 2));
    console.log("+++ after");
    console.log(JSON.stringify(entry, null, 2));
    if (!apply) {
      console.log("\n(dry run) re-run with --apply --force to overwrite");
      return;
    }
    console.error("\nrefusing to overwrite without --force");
    process.exit(1);
  }

  mcpServers[ENTRY_NAME] = entry;
  const merged = { ...existing, mcpServers };

  console.log("\nplanned change:");
  console.log("---");
  console.log(JSON.stringify({ mcpServers: { [ENTRY_NAME]: entry } }, null, 2));
  console.log("---");
  console.log(`other mcpServers entries preserved: ${Object.keys(mcpServers).filter(k => k !== ENTRY_NAME).length}`);

  if (!apply) {
    console.log("\n(dry run) re-run with --apply to write");
    return;
  }

  // Backup
  if (existsSync(path)) {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const backup = path + "." + ts + ".bak";
    copyFileSync(path, backup);
    console.log("backup:", backup);
  }

  writeFileSync(path, JSON.stringify(merged, null, 2) + "\n", "utf8");
  console.log("\n✅ written. Restart Claude Desktop to load the new MCP server.");
  console.log("   (cmd+Q then reopen on macOS)");
}

main();
