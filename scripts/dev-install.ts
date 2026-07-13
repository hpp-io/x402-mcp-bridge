/**
 * Dev workflow — re-point an existing host MCP entry at the *local dist*
 * build instead of the npm-published version. Preserves the user's env
 * (delegate key URI, Safe, etc) so we don't re-setup.
 *
 * Usage:
 *   pnpm tsx scripts/dev-install.ts --host claude --local-dist <abs path>
 *     [--env HPP_X402_HOME=/tmp/...] [--env LOG_LEVEL=debug]
 *     [--revert]                      # back to npm @hpp-io/x402-mcp-bridge
 *
 *   pnpm tsx scripts/dev-install.ts --host openclaw ...
 *
 * On --revert we drop bridgeAbsPath so installMcpHost regenerates the
 * npx-based entry (the polished prod default).
 */
import { readFileSync, existsSync } from "node:fs";
import {
  installClaudeDesktop,
  configPath as claudeConfigPath,
} from "../src/cli/install-claude.js";
import {
  installOpenClaw,
  configPath as openclawConfigPath,
} from "../src/cli/install-openclaw.js";
import type { InstallEnv } from "../src/cli/install-mcp-host.js";

interface Args {
  host?: "claude" | "openclaw";
  localDist?: string;
  envOverrides: Record<string, string>;
  revert: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { envOverrides: {}, revert: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--host") out.host = argv[++i] as "claude" | "openclaw";
    else if (a === "--local-dist") out.localDist = argv[++i];
    else if (a === "--env") {
      const [k, ...v] = argv[++i].split("=");
      out.envOverrides[k] = v.join("=");
    } else if (a === "--revert") out.revert = true;
    else if (a === "--help" || a === "-h") usage();
    else {
      console.error("unknown arg:", a);
      usage();
    }
  }
  if (!out.host) {
    console.error("--host is required (claude | openclaw)");
    usage();
  }
  if (!out.revert && !out.localDist) {
    console.error("--local-dist <path> is required (or --revert to restore npm)");
    usage();
  }
  return out;
}

function usage(): never {
  console.error("Usage: dev-install --host <claude|openclaw> --local-dist <path> [--env K=V]... [--revert]");
  process.exit(1);
}

function readExistingEnv(
  configPath: string,
  serversKeyPath: string[],
): InstallEnv {
  if (!existsSync(configPath)) {
    throw new Error(
      `${configPath} does not exist — run hpp-x402-safe-setup --install-${configPath.includes("Claude") ? "claude" : "openclaw"} first to create the initial entry`,
    );
  }
  const json = JSON.parse(readFileSync(configPath, "utf8"));
  let cur: Record<string, unknown> = json;
  for (const k of serversKeyPath) {
    cur = (cur[k] ?? {}) as Record<string, unknown>;
  }
  const entry = cur["hpp-x402"] as
    | { env?: Record<string, string> }
    | undefined;
  if (!entry?.env) {
    throw new Error(
      `no existing hpp-x402 entry in ${configPath} — run setup first`,
    );
  }
  // Required keys per InstallEnv schema; missing ones throw at install time.
  return entry.env as unknown as InstallEnv;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const isClaudeHost = args.host === "claude";
  const path = isClaudeHost ? claudeConfigPath() : openclawConfigPath();
  const serversKeyPath = isClaudeHost ? ["mcpServers"] : ["mcp", "servers"];

  const baseEnv = readExistingEnv(path, serversKeyPath);
  const env: InstallEnv = { ...baseEnv, ...args.envOverrides } as InstallEnv;

  console.log(`config         : ${path}`);
  console.log(`mode           : ${args.revert ? "REVERT to npm" : "DEV (local dist)"}`);
  if (!args.revert) console.log(`local-dist     : ${args.localDist}`);
  if (Object.keys(args.envOverrides).length > 0) {
    console.log("env overrides  :", args.envOverrides);
  }

  const installFn = isClaudeHost ? installClaudeDesktop : installOpenClaw;
  const result = installFn(env, {
    force: true,
    bridgeAbsPath: args.revert ? undefined : args.localDist,
  });

  console.log("");
  console.log(`changed        : ${result.changed}`);
  if (result.backupPath) console.log(`backup         : ${result.backupPath}`);
  console.log(`preserved keys : [${result.preservedEntries.join(", ")}]`);
  console.log("");
  console.log(
    args.revert
      ? "✅ reverted to npm @hpp-io/x402-mcp-bridge. Restart your host to load."
      : "✅ pointed at local dist. Restart your host (cmd+Q + reopen for Claude) to load.",
  );
}

main().catch((err) => {
  console.error("dev-install failed:", (err as Error).message);
  process.exit(1);
});
