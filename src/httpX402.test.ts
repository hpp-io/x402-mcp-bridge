import { describe, it, expect } from "vitest";
import { paymentRequiredError } from "./httpX402.js";

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
