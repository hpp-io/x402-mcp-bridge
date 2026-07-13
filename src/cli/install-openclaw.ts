/**
 * Merge an `hpp-x402` MCP server entry into the user's OpenClaw config.
 *
 * OpenClaw stores its MCP gateway config as JSON at
 *   ~/.openclaw/openclaw.json    (default)
 *
 * If a project / corp setup uses a non-default location, callers can
 * pass `configPathOverride` to point at it directly. The merge logic
 * is shared with Claude Desktop — see install-mcp-host.ts.
 */
import { resolve } from "node:path";
import { homedir } from "node:os";

import {
  installMcpHost,
  type InstallEnv,
  type InstallResult,
} from "./install-mcp-host.js";

const ENTRY_NAME = "hpp-x402";

export function configPath(): string {
  return resolve(homedir(), ".openclaw/openclaw.json");
}

export function installOpenClaw(
  env: InstallEnv,
  opts: { force?: boolean; bridgeAbsPath?: string; configPathOverride?: string } = {},
): InstallResult {
  return installMcpHost({
    configPath: opts.configPathOverride ?? configPath(),
    entryName: ENTRY_NAME,
    env,
    force: opts.force,
    bridgeAbsPath: opts.bridgeAbsPath,
    serversKeyPath: ["mcp", "servers"],
  });
}
