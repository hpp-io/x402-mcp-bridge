import { describe, it, expect } from "vitest";
import {
  isKeychainURI,
  isHexKey,
  parseKeychainURI,
  buildKeychainURI,
} from "./keychain.js";

describe("keychain URIs (pure)", () => {
  it("builds and round-trips a URI", () => {
    const uri = buildKeychainURI("my-acct");
    expect(isKeychainURI(uri)).toBe(true);
    expect(parseKeychainURI(uri).account).toBe("my-acct");
  });

  it("isKeychainURI is a loose prefix gate (strict validation is parseKeychainURI's job)", () => {
    expect(isKeychainURI("keychain://hpp-x402/x")).toBe(true);
    expect(isKeychainURI("keychain://")).toBe(true); // prefix matches; parse rejects it
    expect(isKeychainURI("0xabc")).toBe(false);
    expect(isKeychainURI("")).toBe(false);
  });

  it("parseKeychainURI strictly rejects malformed URIs", () => {
    expect(() => parseKeychainURI("keychain://")).toThrow(); // missing account
    expect(() => parseKeychainURI("keychain://wrong-service/acct")).toThrow();
    expect(() => parseKeychainURI("keychain://hpp-x402/bad acct")).toThrow(); // space in account
  });

  it("isHexKey validates 0x + 64 hex", () => {
    expect(isHexKey("0x" + "a".repeat(64))).toBe(true);
    expect(isHexKey("0x" + "a".repeat(63))).toBe(false);
    expect(isHexKey("0x" + "g".repeat(64))).toBe(false);
    expect(isHexKey("abc")).toBe(false);
  });
});
