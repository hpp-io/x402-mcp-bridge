import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installMcpHost, type InstallEnv } from "./install-mcp-host.js";

const env: InstallEnv = { DELEGATE_PRIVATE_KEY: "keychain://hpp-x402/delegate-default", USDCE_ADDRESS: "0x401eCb1D350407f13ba348573E5630B83638E30D", HPP_RPC_URL: "https://sepolia.hpp.io", HPP_NETWORK: "eip155:181228" };
const read = (p: string) => JSON.parse(readFileSync(p, "utf8")) as { mcpServers: Record<string, { env: Record<string, string> }> };

describe("installMcpHost", () => {
  it("writes HPP_PAYMENT_DELEGATION only when given, and keeps other servers", () => {
    const dir = mkdtempSync(join(tmpdir(), "hpp-x402-install-"));
    const configPath = join(dir, "config.json");
    installMcpHost({ configPath, entryName: "hpp-x402", env });
    expect("HPP_PAYMENT_DELEGATION" in read(configPath).mcpServers["hpp-x402"].env).toBe(false);

    const r = installMcpHost({ configPath, entryName: "hpp-x402", env: { ...env, HPP_PAYMENT_DELEGATION: "0xabc" }, force: true });
    expect(r.changed).toBe(true);
    expect(read(configPath).mcpServers["hpp-x402"].env.HPP_PAYMENT_DELEGATION).toBe("0xabc");

    // Re-installing the same value is a no-op; dropping the option removes the key again (force overwrites).
    expect(installMcpHost({ configPath, entryName: "hpp-x402", env: { ...env, HPP_PAYMENT_DELEGATION: "0xabc" }, force: true }).changed).toBe(false);
    installMcpHost({ configPath, entryName: "hpp-x402", env, force: true });
    expect("HPP_PAYMENT_DELEGATION" in read(configPath).mcpServers["hpp-x402"].env).toBe(false);
  });
});
