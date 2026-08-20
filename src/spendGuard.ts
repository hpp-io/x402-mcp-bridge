/**
 * Wallet-wide spend guard — the runaway-agent brake.
 *
 * Enforces two caps *uniformly across every payment path* (x402_http_call,
 * hpp_call, pay_a2a_agent), so no single tool can bypass them:
 *   - per-call:  a single payment may not exceed `maxPerCallAtomic`
 *   - per-day:   the wallet's total spend in a UTC day may not exceed
 *                `maxPerDayAtomic`  (this is the daily "ledger" that policy.ts
 *                declared as a follow-up — now implemented)
 *
 * Limits are read from `policy._defaults.limits` (wallet-wide). When unset the
 * guard is a no-op, so existing setups are unaffected — the caps only bite once
 * a user sets them (via `wallet_set_limit` / `hpp-x402 policy defaults`).
 *
 * This is a *soft* guard the bridge enforces before signing: it protects
 * against the agent overspending (misbehaviour / prompt injection), NOT against
 * an attacker with machine access (that's the Safe's on-chain cap). Two
 * complementary layers.
 *
 * The daily ledger lives at `${HPP_X402_HOME|~/.hpp-x402}/ledger.json` and only
 * keeps today + yesterday (rolling).
 */
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  openSync,
  closeSync,
  unlinkSync,
  renameSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { resolve as pathResolve } from "node:path";

import { loadPolicy, savePolicy } from "./policy.js";
import { log } from "./log.js";

function home(): string {
  return process.env.HPP_X402_HOME ?? pathResolve(homedir(), ".hpp-x402");
}
function ledgerPath(): string {
  return pathResolve(home(), "ledger.json");
}
function dayKey(offsetDays = 0): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10); // UTC yyyy-mm-dd
}

type Ledger = Record<string, string>; // day -> wallet-wide atomic total spent

function loadLedger(): Ledger {
  try {
    return JSON.parse(readFileSync(ledgerPath(), "utf-8")) as Ledger;
  } catch {
    return {};
  }
}
function saveLedger(l: Ledger): void {
  const keep = new Set([dayKey(0), dayKey(-1)]);
  for (const k of Object.keys(l)) if (!keep.has(k)) delete l[k];
  try {
    mkdirSync(home(), { recursive: true });
    // Write-then-rename so a crash mid-write can never leave a half-written
    // ledger (rename is atomic on POSIX). The temp name is pid-scoped, and we
    // only ever write while holding the lock, so temps can't collide.
    const tmp = `${ledgerPath()}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(l), { mode: 0o600 });
    renameSync(tmp, ledgerPath());
  } catch (err) {
    log.debug("spendGuard.saveFailed", { err: (err as Error).message });
  }
}

// Cross-process lock over the ledger. A single wallet can be driven by
// concurrent tool calls in one process AND by several bridge processes sharing
// $HPP_X402_HOME/ledger.json. An exclusive-create lockfile serialises the
// read-modify-write in both cases, so a reservation and a record can't clobber
// each other (the lost-write half of issue #10).
const LOCK_STALE_MS = 5_000;
const LOCK_SPIN_MS = 5;
const LOCK_MAX_WAIT_MS = 2_000;

function sleepSync(ms: number): void {
  // The critical section is a few synchronous fs ops (sub-ms), so we block
  // briefly rather than busy-spin the CPU while waiting for the lock.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withLedgerLock<T>(fn: () => T): T {
  const lock = `${ledgerPath()}.lock`;
  mkdirSync(home(), { recursive: true });
  const start = Date.now();
  let fd: number | undefined;
  for (;;) {
    try {
      fd = openSync(lock, "wx"); // atomic: fails with EEXIST if already held
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        // Reclaim a lock orphaned by a crashed holder.
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
          unlinkSync(lock);
          continue;
        }
      } catch {
        /* lock vanished between stat and unlink — just retry the open */
      }
      if (Date.now() - start > LOCK_MAX_WAIT_MS) {
        // Fail closed: refusing a payment is safer than racing the cap.
        throw new Error("spendGuard: could not acquire ledger lock (contention/stale)");
      }
      sleepSync(LOCK_SPIN_MS);
    }
  }
  try {
    return fn();
  } finally {
    try {
      closeSync(fd);
      unlinkSync(lock);
    } catch {
      /* already released */
    }
  }
}

function walletLimits(): { maxPerCall?: bigint; maxPerDay?: bigint } {
  const d = loadPolicy()._defaults?.limits ?? {};
  return {
    maxPerCall: d.maxPerCallAtomic != null ? BigInt(d.maxPerCallAtomic) : undefined,
    maxPerDay: d.maxPerDayAtomic != null ? BigInt(d.maxPerDayAtomic) : undefined,
  };
}

/** Wallet-wide atomic units spent so far today (UTC). */
export function spentToday(): bigint {
  return BigInt(loadLedger()[dayKey(0)] ?? "0");
}

/**
 * Returns a human-readable deny reason if paying `amount` would breach the
 * wallet-wide per-call or per-day cap, else null. No-op (null) when no caps set.
 */
export function checkWalletSpend(amount: bigint): string | null {
  const { maxPerCall, maxPerDay } = walletLimits();
  if (maxPerCall != null && amount > maxPerCall) {
    return `wallet per-call cap exceeded: ${amount} > ${maxPerCall} atomic. Raise it with wallet_set_limit (or hpp-x402 policy defaults --max-per-call).`;
  }
  if (maxPerDay != null) {
    const after = spentToday() + amount;
    if (after > maxPerDay) {
      return `wallet daily cap exceeded: ${spentToday()} spent + ${amount} = ${after} > ${maxPerDay} atomic today. Resets at UTC midnight; raise with wallet_set_limit.`;
    }
  }
  return null;
}

/**
 * Record a *successful* payment against today's wallet-wide total.
 *
 * The load→add→save runs under the ledger lock so two concurrent records (or a
 * record racing a reservation) can't clobber each other's write.
 */
export function recordWalletSpend(amount: bigint): void {
  if (amount <= 0n) return;
  withLedgerLock(() => {
    const l = loadLedger();
    const key = dayKey(0);
    l[key] = (BigInt(l[key] ?? "0") + amount).toString();
    saveLedger(l);
    log.debug("spendGuard.recorded", { amount: amount.toString(), spentToday: l[key] });
  });
}

/** A debited slice of the daily cap, held across the settle await. */
export type SpendReservation = {
  amount: bigint;
  /** Settle succeeded — keep the debited headroom permanently. */
  commit(): void;
  /** Settle failed / call refused — return the headroom to today's budget. */
  release(): void;
};

/**
 * Atomically reserve `amount` against the wallet-wide caps *before* signing.
 *
 * The debit happens now, under the ledger lock — not after the on-chain settle
 * `await`. So a second concurrent payment sees the headroom already gone and is
 * refused while the first is still in flight. This closes the
 * check-then-settle-then-record window (issue #10):
 *
 *   reserve → sign → settle → commit()   (success)
 *                          ↘ release()   (failure / refusal)
 *
 * Backward compatible: with no daily cap set (or a non-positive amount) it
 * returns a no-op reservation and never touches the ledger, so per-call-only or
 * uncapped setups behave exactly as before.
 */
export function reserveWalletSpend(
  amount: bigint,
): { ok: true; reservation: SpendReservation } | { ok: false; reason: string } {
  const { maxPerCall, maxPerDay } = walletLimits();

  if (maxPerCall != null && amount > maxPerCall) {
    return {
      ok: false,
      reason: `wallet per-call cap exceeded: ${amount} > ${maxPerCall} atomic. Raise it with wallet_set_limit (or hpp-x402 policy defaults --max-per-call).`,
    };
  }

  // Nothing to debit — keep callers uniform without touching the ledger/lock.
  if (maxPerDay == null || amount <= 0n) {
    return { ok: true, reservation: { amount, commit() {}, release() {} } };
  }

  return withLedgerLock(() => {
    const key = dayKey(0);
    const l = loadLedger();
    const spent = BigInt(l[key] ?? "0");
    const after = spent + amount;
    if (after > maxPerDay) {
      return {
        ok: false as const,
        reason: `wallet daily cap exceeded: ${spent} spent + ${amount} = ${after} > ${maxPerDay} atomic today. Resets at UTC midnight; raise with wallet_set_limit.`,
      };
    }
    l[key] = after.toString();
    saveLedger(l);
    log.debug("spendGuard.reserved", { amount: amount.toString(), spentToday: l[key] });

    let settled = false; // commit or release, whichever fires first, wins once
    const reservation: SpendReservation = {
      amount,
      commit() {
        settled = true; // already debited at reserve time — nothing to write
      },
      release() {
        if (settled) return; // committed reservations are permanent; idempotent
        settled = true;
        withLedgerLock(() => {
          const cur = loadLedger();
          const k = dayKey(0);
          const now = BigInt(cur[k] ?? "0");
          cur[k] = (now > amount ? now - amount : 0n).toString();
          saveLedger(cur);
          log.debug("spendGuard.released", { amount: amount.toString(), spentToday: cur[k] });
        });
      },
    };
    return { ok: true as const, reservation };
  });
}

/**
 * How a payment attempt ended, from the caller's point of view.
 *   - `success`        — settle confirmed → commit the reservation.
 *   - `clean-failure`  — money definitely did NOT leave: a pre-send error
 *                        (funds/sign/no-accept), an explicit rejection, or a
 *                        definitive non-settle response → release.
 *   - `ambiguous`      — the settle request was sent and we never got a
 *                        definitive answer (timeout / transport error / gateway
 *                        5xx). The tx may have landed even without a receipt.
 */
export type SettleOutcome = "success" | "clean-failure" | "ambiguous";

/**
 * Resolve a reservation from how the settle attempt ended (issue #12, tier 1).
 *
 * The important case is `ambiguous`: we do **nothing**, leaving the debit in
 * place ("hold"). Releasing on an ambiguous timeout is exactly what let the
 * daily tally drift *below* reality and loosen the cap. Holding errs toward
 * "spent", so the cap can only ever be too tight, never too loose; a
 * genuinely-absent spend self-heals at the next UTC-midnight ledger reset (or
 * is reconciled promptly against on-chain state by tier 2, if implemented).
 */
export function settleReservation(
  reservation: SpendReservation | null,
  outcome: SettleOutcome,
): void {
  if (!reservation) return;
  if (outcome === "success") reservation.commit();
  else if (outcome === "clean-failure") reservation.release();
  else {
    // "ambiguous" → hold: leave the debit; do not commit or release. Emit so ops
    // can see how often this fires in production — that rate is the signal for
    // whether the tier-2 on-chain reconcile (#12) is ever worth building.
    log.info("spendGuard.heldOnAmbiguous", { amount: reservation.amount.toString() });
  }
}

/**
 * Set the wallet-wide spend limits (persisted to policy._defaults.limits), so
 * the guard enforces them. Omitted fields are left unchanged. Atomic strings.
 */
export function setWalletLimits(next: {
  maxPerCallAtomic?: string;
  maxPerDayAtomic?: string;
}): void {
  const policy = loadPolicy();
  const defaults = policy._defaults ?? {};
  const limits = { ...(defaults.limits ?? {}) };
  if (next.maxPerCallAtomic !== undefined) limits.maxPerCallAtomic = next.maxPerCallAtomic;
  if (next.maxPerDayAtomic !== undefined) limits.maxPerDayAtomic = next.maxPerDayAtomic;
  policy._defaults = { ...defaults, limits };
  savePolicy(policy);
  log.info("spendGuard.limitsUpdated", { ...limits });
}

/** Current limits + today's usage, for `wallet_get_limits` / `status`. */
export function walletSpendStatus(): {
  spentTodayAtomic: string;
  maxPerCallAtomic?: string;
  maxPerDayAtomic?: string;
  remainingTodayAtomic?: string;
} {
  const { maxPerCall, maxPerDay } = walletLimits();
  const spent = spentToday();
  return {
    spentTodayAtomic: spent.toString(),
    maxPerCallAtomic: maxPerCall?.toString(),
    maxPerDayAtomic: maxPerDay?.toString(),
    remainingTodayAtomic:
      maxPerDay != null ? (maxPerDay > spent ? (maxPerDay - spent).toString() : "0") : undefined,
  };
}
