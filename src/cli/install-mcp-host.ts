/**
 * Generic JSON-config merge for MCP hosts.
 *
 * Both Claude Desktop and OpenClaw store their MCP server registry as
 * `{ mcpServers: { <name>: { command, args, env } } }` JSON. The merge
 * logic is identical — only the file path differs. This module owns
 * that logic; `install-claude.ts` / `install-openclaw.ts` are thin
 * wrappers that pass the right path.
 */
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  copyFileSync,
} from "node:fs";
import { dirname } from "node:path";

export interface InstallEnv {
  DELEGATE_PRIVATE_KEY: string;
  // Safe mode only. Omitted in light mode — undefined values are dropped by
  // JSON.stringify, so the written config simply has no SAFE_* keys.
  SAFE_ADDRESS?: string;
  ALLOWANCE_MODULE_ADDRESS?: string;
  USDCE_ADDRESS: string;
  RESOURCE_SERVER_URL: string;
  HPP_RPC_URL: string;
  HPP_NETWORK: string;
  LOG_LEVEL?: string;
}

export interface InstallResult {
  configPath: string;
  backupPath: string | null;
  changed: boolean;
  preservedEntries: string[];
}

export interface InstallOptions {
  configPath: string;
  entryName: string;
  env: InstallEnv;
  force?: boolean;
  bridgeAbsPath?: string;
  /**
   * JSON key path where MCP servers live. Defaults to `["mcpServers"]`
   * (Claude Desktop). OpenClaw uses `["mcp", "servers"]`.
   */
  serversKeyPath?: string[];
}

function getOrCreateNested(
  root: Record<string, unknown>,
  keyPath: string[],
): Record<string, unknown> {
  let cur: Record<string, unknown> = root;
  for (const k of keyPath) {
    if (typeof cur[k] !== "object" || cur[k] === null) cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  return cur;
}

/**
 * Merge an `<entryName>` MCP server entry into the host config and write it.
 * Preserves all other entries; backs up the original if it exists.
 * `command`/`args` default to launching the published bridge via npx;
 * pass `bridgeAbsPath` for a local checkout.
 */
export function installMcpHost(opts: InstallOptions): InstallResult {
  const {
    configPath,
    entryName,
    env,
    force,
    bridgeAbsPath,
    serversKeyPath = ["mcpServers"],
  } = opts;

  let existing: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    existing = JSON.parse(readFileSync(configPath, "utf8"));
  } else {
    mkdirSync(dirname(configPath), { recursive: true });
  }

  const command = bridgeAbsPath ? "node" : "npx";
  const args = bridgeAbsPath
    ? [bridgeAbsPath]
    : ["-y", "@hpp-io/x402-mcp-bridge"];

  const entry = {
    command,
    args,
    env: {
      DELEGATE_PRIVATE_KEY: env.DELEGATE_PRIVATE_KEY,
      SAFE_ADDRESS: env.SAFE_ADDRESS,
      ALLOWANCE_MODULE_ADDRESS: env.ALLOWANCE_MODULE_ADDRESS,
      USDCE_ADDRESS: env.USDCE_ADDRESS,
      RESOURCE_SERVER_URL: env.RESOURCE_SERVER_URL,
      HPP_RPC_URL: env.HPP_RPC_URL,
      HPP_NETWORK: env.HPP_NETWORK,
      LOG_LEVEL: env.LOG_LEVEL ?? "info",
    },
  };

  const servers = getOrCreateNested(existing, serversKeyPath);
  const prior = servers[entryName];

  if (prior && JSON.stringify(prior) === JSON.stringify(entry)) {
    return {
      configPath,
      backupPath: null,
      changed: false,
      preservedEntries: Object.keys(servers).filter((k) => k !== entryName),
    };
  }
  if (prior && !force) {
    throw new Error(
      `existing ${entryName} entry differs; pass force:true (or --force in CLI) to overwrite`,
    );
  }

  servers[entryName] = entry;

  let backupPath: string | null = null;
  if (existsSync(configPath)) {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    backupPath = configPath + "." + ts + ".bak";
    copyFileSync(configPath, backupPath);
  }

  writeFileSync(configPath, JSON.stringify(existing, null, 2) + "\n", "utf8");

  return {
    configPath,
    backupPath,
    changed: true,
    preservedEntries: Object.keys(servers).filter((k) => k !== entryName),
  };
}
