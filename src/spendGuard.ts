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
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
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
    writeFileSync(ledgerPath(), JSON.stringify(l), { mode: 0o600 });
  } catch (err) {
    log.debug("spendGuard.saveFailed", { err: (err as Error).message });
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

/** Record a *successful* payment against today's wallet-wide total. */
export function recordWalletSpend(amount: bigint): void {
  if (amount <= 0n) return;
  const l = loadLedger();
  l[dayKey(0)] = (BigInt(l[dayKey(0)] ?? "0") + amount).toString();
  saveLedger(l);
  log.debug("spendGuard.recorded", { amount: amount.toString(), spentToday: l[dayKey(0)] });
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
