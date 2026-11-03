import { describe, it, expect } from "vitest";
import { paymentRequiredError, pickPayableAccept } from "./httpX402.js";
import type { Network } from "@x402/core/types";

const NET = "eip155:181228" as Network;
const USDC = "0x401ecb1d350407f13ba348573e5630b83638e30d";
const EVIL = "0x1111111111111111111111111111111111111111";
const acc = (scheme: string, asset: string, extra?: Record<string, unknown>) => ({ scheme, network: NET, asset, amount: "1000", ...(extra ? { extra } : {}) });

describe("pickPayableAccept (asset allowlist)", () => {
  it("skips accepts in a token we do not pay in and keeps the seller's order otherwise", () => {
    const required = { accepts: [acc("exact", EVIL), acc("upto", USDC), acc("exact", USDC)] };
    const picked = pickPayableAccept(required, NET, { upto: true, allowedAssets: [USDC] });
    expect(picked).toMatchObject({ scheme: "upto", asset: USDC });
  });
  it("returns null when every accept on our network is in another token", () => {
    const required = { accepts: [acc("exact", EVIL), acc("upto", EVIL)] };
    expect(pickPayableAccept(required, NET, { upto: true, allowedAssets: [USDC] })).toBeNull();
  });
  it("matches the asset case-insensitively", () => {
    const required = { accepts: [acc("exact", "0x401eCb1D350407f13ba348573E5630B83638E30D")] };
    expect(pickPayableAccept(required, NET, { upto: false, allowedAssets: [USDC] })).not.toBeNull();
  });
  it("erc7710 accepts are subject to the same filter", () => {
    const required = { accepts: [acc("exact", EVIL, { assetTransferMethod: "erc7710" }), acc("exact", USDC)] };
    const picked = pickPayableAccept(required, NET, { upto: false, delegation: true, allowedAssets: [USDC] });
    expect(picked).toMatchObject({ asset: USDC });
    expect((picked as { extra?: unknown }).extra).toBeUndefined();
  });
});

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");

describe("paymentRequiredError", () => {
  it("decodes the seller's reason from the PAYMENT-REQUIRED header", () => {
    expect(paymentRequiredError(b64({ x402Version: 2, accepts: [], error: "erc7710_simulation_failed" }))).toBe("erc7710_simulation_failed");
    expect(paymentRequiredError(b64({ error: "insufficient_payer_balance", errorMessage: "payer holds 0 < required 1000" }))).toBe("insufficient_payer_balance: payer holds 0 < required 1000");
  });
  it("is undefined when there is no header, no error field, or garbage", () => {
    expect(paymentRequiredError(null)).toBeUndefined();
    expect(paymentRequiredError(b64({ x402Version: 2, accepts: [] }))).toBeUndefined();
    expect(paymentRequiredError("not-base64-json")).toBeUndefined();
  });
});
