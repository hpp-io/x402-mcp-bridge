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

  it("allowedAssets = configured USDC.e + per-network defaults, lowercased and de-duplicated", () => {
    const cfg = loadConfig(base);
    expect(cfg.allowedAssets).toEqual([
      "0x" + "a".repeat(40),
      "0x401ecb1d350407f13ba348573e5630b83638e30d",
      "0xb58a997c7ce77074e08715b73eaf709dafded349", // HAC — Sepolia test token (dev-router)
      "0x0ac610e77ec39ab5c6b402b376548ac02acc5a48", // CHIP on Sepolia
      "0x8ebcaf48d2d91b8cecf1668a4519823881bf8fc3", // HPP on Sepolia (upto only)
    ]);
    const main = loadConfig({ ...base, USDCE_ADDRESS: undefined, HPP_NETWORK: "eip155:190415" });
    // mainnet: USDC.e, CHIP and HPP — CHIP at its mainnet address, never the Sepolia one
    expect(main.allowedAssets).toEqual([
      "0x401ecb1d350407f13ba348573e5630b83638e30d",
      "0xedfc8e6658561c97a3ffc966923d16c1c626083a",
      "0xb48334e7938367bc24fe1f19000d6f06c622e6c7", // HPP on Mainnet (upto only)
    ]);
    expect(main.allowedAssets).not.toContain("0x0ac610e77ec39ab5c6b402b376548ac02acc5a48");
    expect(cfg.allowedAssets).not.toContain("0xedfc8e6658561c97a3ffc966923d16c1c626083a");
  });

  it("HPP_X402_ALLOWED_ASSETS adds operator extras and rejects garbage", () => {
    const cfg = loadConfig({ ...base, HPP_X402_ALLOWED_ASSETS: " 0x" + "C".repeat(40) + ", 0x" + "a".repeat(40) });
    expect(cfg.allowedAssets).toContain("0x" + "c".repeat(40));
    expect(cfg.allowedAssets.filter((x) => x === "0x" + "a".repeat(40))).toHaveLength(1);
    expect(() => loadConfig({ ...base, HPP_X402_ALLOWED_ASSETS: "USDC" })).toThrow(/comma-separated/);
  });

  it("HPP_X402_DISCOVERY=off disables discovery", () => {
    const cfg = loadConfig({ ...base, HPP_X402_DISCOVERY: "off" });
    expect(cfg.discoveryEnabled).toBe(false);
  });
});
