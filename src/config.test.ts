import { describe, it, expect } from "vitest";
import { loadConfig } from "./config.js";

const base: NodeJS.ProcessEnv = {
  DELEGATE_PRIVATE_KEY: "0x" + "1".repeat(64),
  USDCE_ADDRESS: "0x" + "a".repeat(40),
  HPP_RPC_URL: "https://sepolia.hpp.io",
  HPP_NETWORK: "eip155:181228",
};

describe("loadConfig", () => {
  it("parses a valid light-mode config", () => {
    const cfg = loadConfig(base);
    expect(cfg.walletMode).toBe("light");
    expect(cfg.chainId).toBe(181228);
    expect(cfg.discoveryEnabled).toBe(true); // default on
  });

  it("infers safe mode when SAFE_ADDRESS + ALLOWANCE_MODULE_ADDRESS are set", () => {
    const cfg = loadConfig({
      ...base,
      SAFE_ADDRESS: "0x" + "b".repeat(40),
      ALLOWANCE_MODULE_ADDRESS: "0x" + "c".repeat(40),
    });
    expect(cfg.walletMode).toBe("safe");
  });

  it("rejects a Safe address without the module (both-or-neither)", () => {
    expect(() => loadConfig({ ...base, SAFE_ADDRESS: "0x" + "b".repeat(40) })).toThrow();
  });

  it("rejects an invalid delegate key", () => {
    expect(() => loadConfig({ ...base, DELEGATE_PRIVATE_KEY: "nope" })).toThrow();
  });

  it("HPP_X402_DISCOVERY=off disables discovery", () => {
    const cfg = loadConfig({ ...base, HPP_X402_DISCOVERY: "off" });
    expect(cfg.discoveryEnabled).toBe(false);
  });
});
