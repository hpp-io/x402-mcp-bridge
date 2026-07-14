/**
 * Unit tests for the seller execution receipt — pure, offline, funds-free.
 * Covers determinism and the "settledAt is metadata only" invariant that
 * keeps a receipt independently reproducible.
 */
import { describe, it, expect } from "vitest";

import { buildExecutionReceipt, canonicalize, sellerReceipt } from "./sellerReceipt.js";

const requirements = {
  scheme: "exact",
  network: "hpp-mainnet",
  asset: "0xUSDCe",
  amount: "10000",
  payTo: "0xSeller",
  maxTimeoutSeconds: 600,
  extra: { b: 2, a: 1 },
} as never;

const base = {
  requirements,
  transaction: "0xabc123",
  capability: { skillId: "translate", request: { text: "hi", lang: "ko" }, result: { out: "안녕" } },
  payer: "0xBuyer",
  sellerServiceId: "svc-1",
  settledAt: "2026-07-14T00:00:00.000Z",
};

describe("canonicalize", () => {
  it("is object-key-order independent", () => {
    expect(canonicalize({ a: 1, b: 2 })).toBe(canonicalize({ b: 2, a: 1 }));
    expect(canonicalize({ x: { p: 1, q: 2 } })).toBe(canonicalize({ x: { q: 2, p: 1 } }));
  });

  it("preserves array order (arrays are not sorted)", () => {
    expect(canonicalize([1, 2, 3])).not.toBe(canonicalize([3, 2, 1]));
  });
});

describe("buildExecutionReceipt", () => {
  it("is deterministic — identical inputs yield a byte-identical receipt", () => {
    expect(buildExecutionReceipt(base)).toEqual(buildExecutionReceipt(base));
  });

  it("keeps paymentRequirementsDigest stable under requirements key reordering", () => {
    const reordered = {
      ...base,
      requirements: {
        extra: { a: 1, b: 2 },
        payTo: "0xSeller",
        amount: "10000",
        asset: "0xUSDCe",
        network: "hpp-mainnet",
        maxTimeoutSeconds: 600,
        scheme: "exact",
      } as never,
    };
    expect(buildExecutionReceipt(reordered).paymentRequirementsDigest).toBe(
      buildExecutionReceipt(base).paymentRequirementsDigest,
    );
  });

  it("flips resultHash and only resultHash when the result changes", () => {
    const a = buildExecutionReceipt(base);
    const b = buildExecutionReceipt({ ...base, capability: { ...base.capability, result: { out: "different" } } });
    expect(b.capability.resultHash).not.toBe(a.capability.resultHash);
    expect(b.paymentRequirementsDigest).toBe(a.paymentRequirementsDigest);
    expect(b.capability.requestHash).toBe(a.capability.requestHash);
    // receiptId depends only on (requirements digest, tx) — not the result.
    expect(b.receiptId).toBe(a.receiptId);
  });

  it("flips receiptId when the tx hash changes", () => {
    expect(buildExecutionReceipt({ ...base, transaction: "0xdifferent" }).receiptId).not.toBe(
      buildExecutionReceipt(base).receiptId,
    );
  });

  it("never lets settledAt leak into any digest (metadata only)", () => {
    const a = buildExecutionReceipt(base);
    const b = buildExecutionReceipt({ ...base, settledAt: "2099-01-01T00:00:00.000Z" });
    expect(b.receiptId).toBe(a.receiptId);
    expect(b.paymentRequirementsDigest).toBe(a.paymentRequirementsDigest);
    expect(b.capability.resultHash).toBe(a.capability.resultHash);
  });

  it("hashes null and missing request/result identically (defaulted)", () => {
    const withNull = buildExecutionReceipt({ ...base, capability: { skillId: "x", request: null, result: null } });
    const withMissing = buildExecutionReceipt({
      ...base,
      capability: { skillId: "x", request: undefined as never, result: undefined as never },
    });
    expect(withNull.capability.requestHash).toBe(withMissing.capability.requestHash);
    expect(withNull.capability.resultHash).toBe(withMissing.capability.resultHash);
  });
});

describe("sellerReceipt tool handler", () => {
  it("errors when a required field is missing", () => {
    expect(sellerReceipt({ transaction: "0xabc", skillId: "x" }).isError).toBe(true);
  });

  it("output equals the pure builder for the same inputs", () => {
    const res = sellerReceipt({
      paymentRequirements: requirements,
      transaction: base.transaction,
      skillId: base.capability.skillId,
      request: base.capability.request,
      result: base.capability.result,
      payer: base.payer,
      sellerServiceId: base.sellerServiceId,
      settledAt: base.settledAt,
    });
    expect(res.isError).not.toBe(true);
    const parsed = JSON.parse((res.content[0] as { text: string }).text);
    expect(parsed.receipt).toEqual(buildExecutionReceipt(base));
  });

  it("defaults settledAt to a valid ISO-8601 timestamp when omitted", () => {
    const res = sellerReceipt({ paymentRequirements: requirements, transaction: "0xabc123", skillId: "x" });
    const parsed = JSON.parse((res.content[0] as { text: string }).text);
    expect(parsed.receipt.settlement.settledAt).toBe(new Date(parsed.receipt.settlement.settledAt).toISOString());
  });
});
