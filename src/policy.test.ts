import { describe, it, expect } from "vitest";
import { checkAmount, checkAccess, type PolicyFile } from "./policy.js";

describe("checkAmount (per-call cap)", () => {
  it("allows amounts at or under the cap", () => {
    expect(checkAmount({ maxPerCallAtomic: "1000" }, 500n)).toBeNull();
    expect(checkAmount({ maxPerCallAtomic: "1000" }, 1000n)).toBeNull();
  });
  it("denies amounts over the cap", () => {
    expect(checkAmount({ maxPerCallAtomic: "1000" }, 1001n)).toBeTruthy();
  });
  it("allows anything when no cap is set", () => {
    expect(checkAmount({}, 10n ** 30n)).toBeNull();
  });
});

describe("checkAccess (allowlist + https)", () => {
  it("denies a non-allowlisted host by default", () => {
    expect(checkAccess({}, "https://evil.example/x").ok).toBe(false);
  });
  it("allows an allowlisted https host", () => {
    const policy = { "good.example": {} } as unknown as PolicyFile;
    expect(checkAccess(policy, "https://good.example/x").ok).toBe(true);
  });
  it("denies non-https for an allowlisted host (requireHttps default)", () => {
    const policy = { "good.example": {} } as unknown as PolicyFile;
    expect(checkAccess(policy, "http://good.example/x").ok).toBe(false);
  });
  it("allowUnlisted lets any host through", () => {
    const policy = { _defaults: { allowUnlisted: true } } as unknown as PolicyFile;
    expect(checkAccess(policy, "https://anything.example/x").ok).toBe(true);
  });
  it("rejects an invalid URL", () => {
    expect(checkAccess({}, "not a url").ok).toBe(false);
  });
});
