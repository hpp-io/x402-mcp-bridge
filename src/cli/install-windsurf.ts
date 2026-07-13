/**
 * Merge an `hpp-x402` MCP server entry into Windsurf's mcp_config.json.
 *
 * Windsurf (Codeium) uses the same `{ mcpServers: { … } }` schema, but a
 * different file location per OS:
 *   macOS   : ~/.codeium/windsurf/mcp_config.json
 *   Linux   : ~/.config/.codeium/windsurf/mcp_config.json
 *   Windows : %APPDATA%/Codeium/windsurf/mcp_config.json
 * Pass `configPathOverride` for a non-default path (or for tests).
 * The merge logic is shared — see install-mcp-host.ts.
 */
import { resolve } from "node:path";
import { homedir, platform } from "node:os";

import {
  installMcpHost,
  type InstallEnv,
  type InstallResult,
} from "./install-mcp-host.js";

const ENTRY_NAME = "hpp-x402";

export function configPath(): string {
  const p = platform();
  if (p === "win32") {
    return resolve(process.env.APPDATA ?? "", "Codeium/windsurf/mcp_config.json");
  }
  if (p === "darwin") {
    return resolve(homedir(), ".codeium/windsurf/mcp_config.json");
  }
  // Linux
  return resolve(homedir(), ".config/.codeium/windsurf/mcp_config.json");
}

export function installWindsurf(
  env: InstallEnv,
  opts: { force?: boolean; bridgeAbsPath?: string; configPathOverride?: string } = {},
): InstallResult {
  return installMcpHost({
    configPath: opts.configPathOverride ?? configPath(),
    entryName: ENTRY_NAME,
    env,
    force: opts.force,
    bridgeAbsPath: opts.bridgeAbsPath,
    // serversKeyPath defaults to ["mcpServers"] — same as Windsurf's schema.
  });
}
