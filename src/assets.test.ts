import { describe, it, expect } from "vitest";
import { assetRefusal, filterAllowedAssets, isAllowedAsset, normalizeAsset } from "./assets.js";

const USDC = "0x401ecb1d350407f13ba348573e5630b83638e30d";
const HAC = "0xb58a997c7ce77074e08715b73eaf709dafded349";
const EVIL = "0x1111111111111111111111111111111111111111";
const NET = "eip155:181228";

describe("assets allowlist", () => {
  it("compares addresses case-insensitively", () => {
    expect(normalizeAsset(" 0x401eCb1D350407f13ba348573E5630B83638E30D ")).toBe(USDC);
    expect(isAllowedAsset([USDC], "0x401ECB1D350407F13BA348573E5630B83638E30D")).toBe(true);
    expect(isAllowedAsset([USDC], EVIL)).toBe(false);
    expect(isAllowedAsset([USDC], undefined)).toBe(false);
    expect(isAllowedAsset([USDC], 42)).toBe(false);
  });

  it("filterAllowedAssets keeps order and drops other tokens", () => {
    const accepts = [
      { scheme: "upto", asset: EVIL, network: NET },
      { scheme: "exact", asset: USDC, network: NET },
      { scheme: "exact", asset: HAC, network: NET },
    ];
    expect(filterAllowedAssets(accepts, [USDC, HAC]).map((a) => a.asset)).toEqual([USDC, HAC]);
    expect(filterAllowedAssets(accepts, [USDC]).map((a) => a.asset)).toEqual([USDC]);
    expect(filterAllowedAssets(accepts, [])).toEqual([]);
  });

  it("assetRefusal names the asset only when that is the sole problem", () => {
    // Nothing on our network at all → not an asset problem.
    expect(assetRefusal([{ asset: EVIL, network: "eip155:1" }], NET, [USDC])).toBeUndefined();
    // Something on our network is in an allowed asset → not an asset problem.
    expect(
      assetRefusal([{ asset: EVIL, network: NET }, { asset: USDC, network: NET }], NET, [USDC]),
    ).toBeUndefined();
    // Our network, but only tokens we do not pay in → say so, listing both sides.
    const r = assetRefusal([{ asset: EVIL, network: NET }, { asset: EVIL, network: NET }], NET, [USDC]);
    expect(r).toMatch(/does not pay in/);
    expect(r).toContain(`offered: ${EVIL}`);
    expect(r).toContain(`allowed on ${NET}: ${USDC}`);
    expect(r).toContain("HPP_X402_ALLOWED_ASSETS");
  });
});
