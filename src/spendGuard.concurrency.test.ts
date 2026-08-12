import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  reserveWalletSpend,
  recordWalletSpend,
  spentToday,
} from "./spendGuard.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sg-conc-"));
  process.env.HPP_X402_HOME = home;
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.HPP_X402_HOME;
});

function setLimits(limits: Record<string, string>): void {
  writeFileSync(join(home, "policy.json"), JSON.stringify({ _defaults: { limits } }));
}

describe("spendGuard — concurrent-cap race (issue #10)", () => {
  // THE regression: two payments in flight at once must not both pass the
  // daily cap. Under the old check→settle→record shape both calls read
  // spentToday()==0 and both settled. reserve() debits synchronously, so the
  // second reservation sees the headroom already taken.
  it("a second reservation cannot re-use headroom the first still holds", () => {
    setLimits({ maxPerDayAtomic: "5000" });

    const a = reserveWalletSpend(3000n);
    const b = reserveWalletSpend(3000n); // both in flight, neither settled yet

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.reason).toMatch(/daily cap/);
    expect(spentToday()).toBe(3000n); // only the first reservation is counted
  });

  it("exactly the cap is allowed; one atomic over is refused", () => {
    setLimits({ maxPerDayAtomic: "5000" });
    const a = reserveWalletSpend(5000n);
    expect(a.ok).toBe(true);
    const b = reserveWalletSpend(1n);
    expect(b.ok).toBe(false);
  });

  it("release() returns the headroom (failed settle / refusal)", () => {
    setLimits({ maxPerDayAtomic: "5000" });
    const a = reserveWalletSpend(3000n);
    expect(a.ok).toBe(true);
    if (a.ok) a.reservation.release();

    expect(spentToday()).toBe(0n);
    const b = reserveWalletSpend(5000n); // full budget available again
    expect(b.ok).toBe(true);
  });

  it("commit() makes the debit permanent; a later release() is a no-op", () => {
    setLimits({ maxPerDayAtomic: "5000" });
    const a = reserveWalletSpend(3000n);
    expect(a.ok).toBe(true);
    if (a.ok) {
      a.reservation.commit();
      a.reservation.release(); // must NOT give back committed spend
    }
    expect(spentToday()).toBe(3000n);
  });

  it("release() is idempotent — double release never double-credits", () => {
    setLimits({ maxPerDayAtomic: "5000" });
    const a = reserveWalletSpend(3000n);
    expect(a.ok).toBe(true);
    if (a.ok) {
      a.reservation.release();
      a.reservation.release();
    }
    expect(spentToday()).toBe(0n);
  });

  it("per-call cap is enforced by reserve WITHOUT touching the ledger", () => {
    setLimits({ maxPerCallAtomic: "1000", maxPerDayAtomic: "10000" });
    const r = reserveWalletSpend(2000n);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/per-call cap/);
    expect(spentToday()).toBe(0n);
  });

  it("no daily cap set → no-op reservation, ledger untouched (back-compat)", () => {
    const r = reserveWalletSpend(999_999_999n);
    expect(r.ok).toBe(true);
    expect(spentToday()).toBe(0n);
    if (r.ok) {
      r.reservation.commit();
      r.reservation.release();
    }
  });

  // A burst of reserve→commit / reserve→release in arbitrary order must leave
  // the ledger exactly equal to the net committed total (no lost updates).
  it("net ledger equals committed reservations across a mixed burst", () => {
    setLimits({ maxPerDayAtomic: "1000000" });
    let committed = 0n;
    for (let i = 0; i < 50; i++) {
      const r = reserveWalletSpend(100n);
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      if (i % 2 === 0) {
        r.reservation.commit();
        committed += 100n;
      } else {
        r.reservation.release();
      }
    }
    expect(spentToday()).toBe(committed);
  });

  it("recordWalletSpend stays consistent under a parallel burst (atomic write)", async () => {
    setLimits({ maxPerDayAtomic: "1000000" });
    await Promise.all(
      Array.from({ length: 200 }, () => Promise.resolve().then(() => recordWalletSpend(1n))),
    );
    expect(spentToday()).toBe(200n);
  });
});
