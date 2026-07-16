/**
 * Unit tests for the A2A seller — gate-then-pay orchestration + receipt
 * binding, driven directly through handleMessageSend with a mock facilitator
 * (no HTTP, no chain).
 */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";

import { handleMessageSend, requestArgsOf, buildAgentCard, type A2aServeOptions } from "./a2aServe.js";
import { canonicalize } from "./sellerReceipt.js";

const sha256 = (s: string) => createHash("sha256").update(s, "utf-8").digest("hex");
const MOCK_TX = "0xa2a0feed0000000000000000000000000000000000000000000000000000abcd";

const requirements = {
  scheme: "exact",
  network: "eip155:181228",
  maxAmountRequired: "1000",
  asset: "0xUSDCe",
  payTo: "0xSeller",
  resource: "http://x/a2a/summarize",
  extra: { name: "Bridged USDC", version: "2" },
};

let verifyCalls = 0;
let settleCalls = 0;
const facilitator = {
  async verify(p: any) { verifyCalls++; return { isValid: true, payer: p?.payload?.authorization?.from ?? "0xBuyer" }; },
  async settle(p: any) { settleCalls++; return { success: true, transaction: MOCK_TX, payer: p?.payload?.authorization?.from ?? "0xBuyer" }; },
};

const opts: A2aServeOptions = {
  requirements,
  accepts: [requirements],
  facilitator,
  skill: "summarize",
  description: "summarize",
  publicBaseUrl: "http://x",
  priceAtomic: "1000",
  network: "eip155:181228" as never,
};

const msg = (text: string, metadata: Record<string, unknown>) => ({ kind: "message", role: "user", parts: [{ kind: "text", text }], metadata });
const PAYLOAD = { payload: { authorization: { from: "0xBuyer" } } };

describe("requestArgsOf", () => {
  it("prefers metadata.input", () => {
    expect(requestArgsOf(msg("ignored", { input: { a: 1 } }))).toEqual({ a: 1 });
  });
  it("parses JSON text", () => {
    expect(requestArgsOf(msg('{"prompt":"hi"}', {}))).toEqual({ prompt: "hi" });
  });
  it("falls back to {prompt:text}", () => {
    expect(requestArgsOf(msg("just words", {}))).toEqual({ prompt: "just words" });
  });
});

describe("buildAgentCard", () => {
  it("advertises the skill and the x402 extension", () => {
    const card = buildAgentCard(opts) as any;
    expect(card.skills[0].id).toBe("summarize");
    expect(card.url).toBe("http://x/a2a");
    expect(card.capabilities.extensions[0].uri).toContain("a2a-x402");
  });
});

describe("handleMessageSend — gate", () => {
  it("with no payment payload → input-required + x402.payment.required", async () => {
    const task = await handleMessageSend(opts, msg("summarize this", { skillId: "summarize" }));
    expect(task.status).toMatchObject({ state: "input-required" });
    expect((task.metadata as any)["x402.payment.status"]).toBe("payment-required");
    expect((task.metadata as any)["x402.payment.required"].accepts[0]).toEqual(requirements);
  });
});

describe("handleMessageSend — paid", () => {
  it("verifies, works, settles, and emits a bound execution receipt", async () => {
    verifyCalls = 0; settleCalls = 0;
    const request = { prompt: "summarize this" };
    const task = await handleMessageSend(opts, msg(JSON.stringify(request), { skillId: "summarize", "x402.payment.payload": PAYLOAD }));

    expect(task.status).toMatchObject({ state: "completed" });
    expect((task.metadata as any)["x402.payment.status"]).toBe("payment-completed");
    expect(verifyCalls).toBe(1);
    expect(settleCalls).toBe(1);

    const result = JSON.parse((task.artifacts as any)[0].parts[0].text);
    const receipts = (task.metadata as any)["x402.payment.receipts"];
    const receipt = receipts.find((r: any) => r?.version === "1");
    expect(receipt).toBeTruthy();

    // cross-party binding: recompute from independent data
    expect(receipt.capability.resultHash).toBe(sha256(canonicalize(result)));
    expect(receipt.capability.requestHash).toBe(sha256(canonicalize(request)));
    expect(receipt.paymentRequirementsDigest).toBe(sha256(canonicalize(requirements)));
    expect(receipt.settlement.transaction).toBe(MOCK_TX);
    expect(receipt.receiptId).toBe(sha256(`${receipt.paymentRequirementsDigest}:${MOCK_TX}`));
    expect(receipt.payer).toBe("0xBuyer");
  });

  it("does NOT settle when verify fails", async () => {
    settleCalls = 0;
    const rejecting = { ...opts, facilitator: { verify: async () => ({ isValid: false, invalidReason: "bad_sig" }), settle: facilitator.settle } };
    const task = await handleMessageSend(rejecting, msg("x", { "x402.payment.payload": PAYLOAD }));
    expect(task.status).toMatchObject({ state: "failed" });
    expect(settleCalls).toBe(0);
  });
});
