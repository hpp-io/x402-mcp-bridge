import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  checkWalletSpend,
  recordWalletSpend,
  reserveWalletSpend,
  spentToday,
  walletSpendStatus,
  setWalletLimits,
  DEFAULT_MAX_PER_CALL_ATOMIC,
} from "./spendGuard.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sg-test-"));
  process.env.HPP_X402_HOME = home;
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.HPP_X402_HOME;
});

function setLimits(limits: Record<string, string>): void {
  writeFileSync(join(home, "policy.json"), JSON.stringify({ _defaults: { limits } }));
}

describe("spendGuard", () => {
  it("applies the built-in 1 USDC.e per-call cap when none is configured", () => {
    expect(DEFAULT_MAX_PER_CALL_ATOMIC).toBe(1_000_000n);
    expect(checkWalletSpend(1_000_000n)).toBeNull(); // at the default is allowed
    expect(checkWalletSpend(1_000_001n)).toMatch(/per-call cap.*built-in default/);
    expect(reserveWalletSpend(1_000_001n)).toMatchObject({ ok: false, reason: expect.stringMatching(/built-in default/) });
    expect(walletSpendStatus()).toMatchObject({ maxPerCallAtomic: "1000000", maxPerCallIsDefault: true });
  });

  it("an explicit per-call cap replaces the default in both directions", () => {
    setLimits({ maxPerCallAtomic: "5000000" });
    expect(checkWalletSpend(4_000_000n)).toBeNull();
    expect(walletSpendStatus()).toMatchObject({ maxPerCallAtomic: "5000000", maxPerCallIsDefault: false });
    setLimits({ maxPerCallAtomic: "10" });
    expect(checkWalletSpend(11n)).toMatch(/per-call cap exceeded: 11 > 10 atomic\./);
  });

  it("still has no daily cap unless one is configured", () => {
    expect(checkWalletSpend(999_999n)).toBeNull();
    recordWalletSpend(999_999n);
    recordWalletSpend(999_999n);
    expect(checkWalletSpend(999_999n)).toBeNull();
  });

  it("enforces the per-call cap (strict > only)", () => {
    setLimits({ maxPerCallAtomic: "3000" });
    expect(checkWalletSpend(2000n)).toBeNull();
    expect(checkWalletSpend(3000n)).toBeNull(); // at the cap is allowed
    expect(checkWalletSpend(3001n)).toMatch(/per-call cap/);
  });

  it("accumulates the daily ledger and blocks at the daily cap", () => {
    setLimits({ maxPerDayAtomic: "5000" });
    expect(spentToday()).toBe(0n);
    recordWalletSpend(2000n);
    expect(spentToday()).toBe(2000n);
    expect(checkWalletSpend(3000n)).toBeNull(); // 2000 + 3000 == 5000 cap
    recordWalletSpend(3000n);
    expect(spentToday()).toBe(5000n);
    expect(checkWalletSpend(1n)).toMatch(/daily cap/);
  });

  it("reports status with remaining budget", () => {
    setLimits({ maxPerCallAtomic: "3000", maxPerDayAtomic: "5000" });
    recordWalletSpend(4000n);
    const s = walletSpendStatus();
    expect(s.spentTodayAtomic).toBe("4000");
    expect(s.maxPerDayAtomic).toBe("5000");
    expect(s.remainingTodayAtomic).toBe("1000");
  });

  it("ignores non-positive record amounts", () => {
    setLimits({ maxPerDayAtomic: "100" });
    recordWalletSpend(0n);
    recordWalletSpend(-5n);
    expect(spentToday()).toBe(0n);
  });

  it("setWalletLimits persists caps the guard then enforces", () => {
    setWalletLimits({ maxPerCallAtomic: "500", maxPerDayAtomic: "2000" });
    expect(checkWalletSpend(600n)).toMatch(/per-call cap/);
    expect(checkWalletSpend(500n)).toBeNull();
    const s = walletSpendStatus();
    expect(s.maxPerCallAtomic).toBe("500");
    expect(s.maxPerDayAtomic).toBe("2000");
  });

  it("setWalletLimits leaves omitted fields unchanged", () => {
    setWalletLimits({ maxPerDayAtomic: "1000" });
    setWalletLimits({ maxPerCallAtomic: "300" });
    const s = walletSpendStatus();
    expect(s.maxPerCallAtomic).toBe("300");
    expect(s.maxPerDayAtomic).toBe("1000");
  });
});
