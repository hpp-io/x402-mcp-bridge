import { describe, it, expect } from "vitest";
import { pickExactAccept } from "./a2a.js";
import type { Network } from "@x402/core/types";

const NET = "eip155:181228" as Network;
const USDC = "0x401ecb1d350407f13ba348573e5630b83638e30d";
const EVIL = "0x1111111111111111111111111111111111111111";
const acc = (scheme: string, asset: string, network: string = NET) => ({ scheme, network, asset, amount: "1000" });

describe("pickExactAccept (asset allowlist)", () => {
  it("picks the exact accept on our network in an allowed asset", () => {
    const required = { accepts: [acc("batch-settlement", USDC), acc("exact", EVIL), acc("exact", USDC)] };
    expect(pickExactAccept(required, NET, { allowedAssets: [USDC] })).toMatchObject({ scheme: "exact", asset: USDC });
  });
  it("returns null when the only exact accept is in another token", () => {
    const required = { accepts: [acc("exact", EVIL)] };
    expect(pickExactAccept(required, NET, { allowedAssets: [USDC] })).toBeNull();
  });
  it("ignores accepts on other networks regardless of asset", () => {
    const required = { accepts: [acc("exact", USDC, "eip155:1")] };
    expect(pickExactAccept(required, NET, { allowedAssets: [USDC] })).toBeNull();
  });
});
