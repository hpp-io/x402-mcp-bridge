/**
 * Merge an `hpp-x402` MCP server entry into the user's
 * claude_desktop_config.json. Importable from the setup CLI
 * (--install-claude flag).
 *
 * The merge logic is shared with OpenClaw — see install-mcp-host.ts.
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
  if (p === "darwin") {
    return resolve(homedir(), "Library/Application Support/Claude/claude_desktop_config.json");
  }
  if (p === "win32") {
    return resolve(process.env.APPDATA ?? "", "Claude/claude_desktop_config.json");
  }
  return resolve(homedir(), ".config/Claude/claude_desktop_config.json");
}

export type { InstallEnv, InstallResult };

export function installClaudeDesktop(
  env: InstallEnv,
  opts: { force?: boolean; bridgeAbsPath?: string } = {},
): InstallResult {
  return installMcpHost({
    configPath: configPath(),
    entryName: ENTRY_NAME,
    env,
    force: opts.force,
    bridgeAbsPath: opts.bridgeAbsPath,
  });
}
