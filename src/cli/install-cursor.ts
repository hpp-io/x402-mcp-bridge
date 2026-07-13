/**
 * Merge an `hpp-x402` MCP server entry into Cursor's mcp.json.
 *
 * Cursor uses the same `{ mcpServers: { … } }` schema as Claude Desktop.
 * The global config lives at ~/.cursor/mcp.json; a project can also carry a
 * .cursor/mcp.json — pass `configPathOverride` for that (or for tests).
 * The merge logic is shared — see install-mcp-host.ts.
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
  return resolve(homedir(), ".cursor/mcp.json");
}

export function installCursor(
  env: InstallEnv,
  opts: { force?: boolean; bridgeAbsPath?: string; configPathOverride?: string } = {},
): InstallResult {
  return installMcpHost({
    configPath: opts.configPathOverride ?? configPath(),
    entryName: ENTRY_NAME,
    env,
    force: opts.force,
    bridgeAbsPath: opts.bridgeAbsPath,
    // serversKeyPath defaults to ["mcpServers"] — same as Cursor's schema.
  });
}
