import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  reserveWalletSpend,
  settleReservation,
  spentToday,
} from "./spendGuard.js";
import { log } from "./log.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sg-hold-"));
  process.env.HPP_X402_HOME = home;
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.HPP_X402_HOME;
});

function setLimits(limits: Record<string, string>): void {
  writeFileSync(join(home, "policy.json"), JSON.stringify({ _defaults: { limits } }));
}

function reserve(amount: bigint) {
  const r = reserveWalletSpend(amount);
  if (!r.ok) throw new Error(`reserve unexpectedly refused: ${r.reason}`);
  return r.reservation;
}

describe("settleReservation — hold-on-ambiguous-timeout (issue #12, tier 1)", () => {
  it("success → commits (debit kept)", () => {
    setLimits({ maxPerDayAtomic: "5000" });
    settleReservation(reserve(3000n), "success");
    expect(spentToday()).toBe(3000n);
  });

  it("clean-failure → releases (debit refunded)", () => {
    setLimits({ maxPerDayAtomic: "5000" });
    settleReservation(reserve(3000n), "clean-failure");
    expect(spentToday()).toBe(0n);
  });

  it("ambiguous → HOLDS the debit (does not release, does not double-count)", () => {
    setLimits({ maxPerDayAtomic: "5000" });
    settleReservation(reserve(3000n), "ambiguous");
    // The core of T1: an ambiguous timeout leaves the spend counted, so the cap
    // can only be too tight, never loosened by phantom headroom.
    expect(spentToday()).toBe(3000n);
  });

  it("a held (ambiguous) spend keeps the cap tight against the next call", () => {
    setLimits({ maxPerDayAtomic: "5000" });
    settleReservation(reserve(3000n), "ambiguous"); // held, counts as spent
    // 3000 already held → only 2000 headroom left; 3000 more must be refused.
    const next = reserveWalletSpend(3000n);
    expect(next.ok).toBe(false);
    const fits = reserveWalletSpend(2000n);
    expect(fits.ok).toBe(true);
  });

  it("clean-failure frees headroom that ambiguous would have held", () => {
    setLimits({ maxPerDayAtomic: "5000" });
    settleReservation(reserve(3000n), "clean-failure"); // refunded
    const next = reserveWalletSpend(5000n); // full budget available again
    expect(next.ok).toBe(true);
  });

  it("mixed batch: only ambiguous+success survive in the ledger", () => {
    setLimits({ maxPerDayAtomic: "1000000" });
    settleReservation(reserve(100n), "success"); // +100
    settleReservation(reserve(100n), "ambiguous"); // +100 (held)
    settleReservation(reserve(100n), "clean-failure"); // -100 (released)
    expect(spentToday()).toBe(200n);
  });

  it("emits spendGuard.heldOnAmbiguous only on a hold (observability signal)", () => {
    setLimits({ maxPerDayAtomic: "5000" });
    const spy = vi.spyOn(log, "info");
    try {
      settleReservation(reserve(100n), "success");
      settleReservation(reserve(100n), "clean-failure");
      expect(spy.mock.calls.some(([m]) => m === "spendGuard.heldOnAmbiguous")).toBe(false);
      settleReservation(reserve(100n), "ambiguous");
      expect(spy.mock.calls.some(([m]) => m === "spendGuard.heldOnAmbiguous")).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("null reservation is a no-op for every outcome", () => {
    expect(() => {
      settleReservation(null, "success");
      settleReservation(null, "clean-failure");
      settleReservation(null, "ambiguous");
    }).not.toThrow();
  });

  it("no cap set → reservation is a no-op, every outcome leaves ledger empty", () => {
    const r = reserveWalletSpend(999_999_999n); // no daily cap → no-op reservation
    expect(r.ok).toBe(true);
    if (r.ok) settleReservation(r.reservation, "ambiguous");
    expect(spentToday()).toBe(0n);
  });
});
