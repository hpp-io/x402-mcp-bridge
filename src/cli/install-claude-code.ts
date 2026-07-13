/**
 * Register the `hpp-x402` MCP server with Claude Code via its native
 * `claude mcp add` command (the recommended path for Claude Code, mirroring
 * BlockRun's `claude mcp add blockrun …`).
 *
 * Unlike the JSON-file hosts (Claude Desktop / Cursor / Windsurf / OpenClaw),
 * Claude Code owns its own config, so we shell out to the `claude` CLI rather
 * than editing a file. Env vars are passed with `-e KEY=value` (args array →
 * no shell interpolation). With the keychain-URI form of DELEGATE_PRIVATE_KEY
 * (quickstart's default) no secret ever lands on the command line.
 */
import { spawnSync } from "node:child_process";

import type { InstallEnv } from "./install-mcp-host.js";

const ENTRY_NAME = "hpp-x402";
const PKG = "@hpp-io/x402-mcp-bridge";

export interface ClaudeCodeInstallResult {
  /** The full command that was run (for logging; env values may be URIs). */
  command: string;
  ok: boolean;
  /** True when the `claude` CLI itself isn't on PATH (spawn ENOENT). */
  notFound: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Build the argv for `claude mcp add`:
 *   mcp add hpp-x402 -s <scope> [-e K=V …] -- npx -y @hpp-io/x402-mcp-bridge
 */
export function buildClaudeMcpAddArgs(
  env: InstallEnv,
  opts: { scope?: string; entryName?: string; bridgeAbsPath?: string } = {},
): string[] {
  const scope = opts.scope ?? "user";
  const entry = opts.entryName ?? ENTRY_NAME;
  const args = ["mcp", "add", entry, "-s", scope];
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    args.push("-e", `${k}=${v}`);
  }
  // Default launches the published package via npx; `bridgeAbsPath` points at a
  // local checkout (dev / testing) as `node <abs>` — mirrors the file-based hosts.
  if (opts.bridgeAbsPath) {
    args.push("--", "node", opts.bridgeAbsPath);
  } else {
    args.push("--", "npx", "-y", PKG);
  }
  return args;
}

export function installClaudeCode(
  env: InstallEnv,
  opts: { scope?: string; entryName?: string; cwd?: string; claudeBin?: string; bridgeAbsPath?: string } = {},
): ClaudeCodeInstallResult {
  const bin = opts.claudeBin ?? "claude";
  const args = buildClaudeMcpAddArgs(env, opts);
  const res = spawnSync(bin, args, { cwd: opts.cwd, encoding: "utf8" });
  const notFound = (res.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
  const stderr = (res.stderr ?? "") + (res.error ? `\n${res.error.message}` : "");
  return {
    command: `${bin} ${args.join(" ")}`,
    ok: res.status === 0,
    notFound,
    stdout: res.stdout ?? "",
    stderr,
  };
}
