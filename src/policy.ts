/**
 * Host policy — generic credential injection + spend guardrails for the
 * HTTP x402 tool (`x402_http_call`).
 *
 * The proxy tool is generic (`{url, method, body}`); each x402 service has
 * its own auth header and spend limits. We keep that service-specific part
 * as *data* (this policy file), not code, so adding a service is one entry
 * and no service name is ever hardcoded.
 *
 * File: `$HPP_X402_CRED_FILE` or `${HPP_X402_HOME|~/.hpp-x402}/policy.json`.
 * Shape (host-keyed):
 *
 *   {
 *     "_defaults": { "allowUnlisted": false,
 *                    "limits": { "requireHttps": true, "maxPerCallAtomic": "1000000" } },
 *     "hub-stage.hpp.io": {
 *       "headers": { "X-Api-Key": "file:~/.hpphub/config.json#api_key" },
 *       "limits":  { "requireHttps": true, "maxPerCallAtomic": "5000000" }
 *     }
 *   }
 *
 * Security: secrets are referenced by *value-source* (file:/env:/keychain://),
 * resolved locally at call time, never passed through tool args (LLM-visible)
 * and never logged.
 */
import { Entry } from "@napi-rs/keyring";
import { readFileSync, writeFileSync, mkdirSync, openSync, closeSync, unlinkSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve as pathResolve, dirname } from "node:path";

export interface HostLimits {
  /** Reject non-https targets. Defaults true. */
  requireHttps?: boolean;
  /** Max atomic units per single call. */
  maxPerCallAtomic?: string;
  /** Max atomic units per host per UTC day. (Ledger = follow-up; parsed now.) */
  maxPerDayAtomic?: string;
  /**
   * H2 idempotency: min interval (ms) between *paid* calls to this host.
   * A paid call within the window returns the previous result instead of
   * paying again — blunts agent-retry / heartbeat double-fire. 0/undefined
   * disables. GET/unpaid (non-402) calls are never throttled.
   */
  cooldownMs?: number;
}
export interface HostPolicy {
  /** header name -> value-source string */
  headers?: Record<string, string>;
  limits?: HostLimits;
}
export interface PolicyDefaults {
  /** Allow calling hosts with no explicit entry. Defaults false (deny). */
  allowUnlisted?: boolean;
  limits?: HostLimits;
}
export type PolicyFile = { _defaults?: PolicyDefaults } & {
  [host: string]: HostPolicy | PolicyDefaults | undefined;
};

function expandHome(p: string): string {
  if (!p.startsWith("~")) return p;
  return pathResolve(homedir(), p.slice(1).replace(/^[/\\]+/, ""));
}

function policyPath(): string {
  if (process.env.HPP_X402_CRED_FILE) return expandHome(process.env.HPP_X402_CRED_FILE);
  const home = process.env.HPP_X402_HOME ?? pathResolve(homedir(), ".hpp-x402");
  return pathResolve(home, "policy.json");
}

/** Load the policy file. Missing file = empty policy (deny-by-default). */
export function loadPolicy(): PolicyFile {
  const path = policyPath();
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PolicyFile;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`x402 policy file unreadable (${path}): ${(err as Error).message}`);
  }
}

function getHostPolicy(policy: PolicyFile, host: string): HostPolicy | undefined {
  if (host === "_defaults") return undefined;
  return policy[host] as HostPolicy | undefined; // exact match only — no wildcard (C1)
}

/** Absolute path of the active policy file (for tooling/diagnostics). */
export function policyFilePath(): string {
  return policyPath();
}

/** Write the policy file (used by the `hpp-x402-policy` CLI). 0600. */
export function savePolicy(policy: PolicyFile): void {
  const path = policyPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(policy, null, 2) + "\n", { mode: 0o600 });
}

/** Resolve a value-source string to its secret/value. Throws if unresolved. */
export function resolveSource(src: string): string {
  if (src.startsWith("literal:")) return src.slice("literal:".length);

  if (src.startsWith("env:")) {
    const v = process.env[src.slice("env:".length)];
    if (!v) throw new Error(`env var not set`);
    return v;
  }

  if (src.startsWith("keychain://")) {
    const rest = src.slice("keychain://".length);
    const slash = rest.indexOf("/");
    if (slash === -1) throw new Error(`malformed keychain source (need keychain://svc/acct)`);
    const secret = new Entry(rest.slice(0, slash), rest.slice(slash + 1)).getPassword();
    if (!secret) throw new Error(`keychain entry not found`);
    return secret;
  }

  if (src.startsWith("file:")) {
    const body = src.slice("file:".length);
    const hash = body.indexOf("#");
    if (hash === -1) throw new Error(`file source needs #<field> (e.g. file:~/x.json#api_key)`);
    const json = JSON.parse(readFileSync(expandHome(body.slice(0, hash)), "utf8"));
    let v: unknown = json;
    for (const k of body.slice(hash + 1).split(".")) {
      if (v == null || typeof v !== "object") { v = undefined; break; }
      v = (v as Record<string, unknown>)[k];
    }
    if (typeof v !== "string" || v === "") throw new Error(`file source field empty/not-a-string`);
    return v;
  }

  throw new Error(`unknown value-source scheme`);
}

/** Mask a source for error text (literal: hides its value; others are safe). */
function maskSource(src: string): string {
  return src.startsWith("literal:") ? "literal:***" : src;
}

/**
 * Resolve the auth headers to inject for `host`. Throws (no silent
 * unauthenticated send) if a configured source can't be resolved.
 */
export function resolveCredentials(policy: PolicyFile, host: string): Record<string, string> {
  const hp = getHostPolicy(policy, host);
  const out: Record<string, string> = {};
  if (!hp?.headers) return out;
  for (const [name, source] of Object.entries(hp.headers)) {
    try {
      out[name] = resolveSource(source);
    } catch (err) {
      throw new Error(
        `credential for ${host} header "${name}" unresolved (${maskSource(source)}): ${(err as Error).message}`,
      );
    }
  }
  return out;
}

export interface AccessDecision {
  ok: boolean;
  error?: string;
  /** Effective limits (defaults merged with host) — used for amount checks. */
  limits: HostLimits;
}

/** ③ pre-flight: host allowlist (deny-by-default) + https. */
export function checkAccess(policy: PolicyFile, url: string): AccessDecision {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, error: `invalid url`, limits: {} };
  }
  const host = u.host.toLowerCase();
  const hp = getHostPolicy(policy, host);
  const limits: HostLimits = { ...(policy._defaults?.limits ?? {}), ...(hp?.limits ?? {}) };

  if (!hp && policy._defaults?.allowUnlisted !== true) {
    return { ok: false, error: `host not allowlisted: ${host}`, limits };
  }
  const requireHttps = limits.requireHttps ?? true;
  if (requireHttps && u.protocol !== "https:") {
    return { ok: false, error: `https required for ${host}`, limits };
  }
  return { ok: true, limits };
}

/** ③ per-call amount cap. Returns a deny reason or null. */
export function checkAmount(limits: HostLimits, amountAtomic: bigint): string | null {
  if (limits.maxPerCallAtomic != null) {
    const cap = BigInt(limits.maxPerCallAtomic);
    if (amountAtomic > cap) {
      return `amount ${amountAtomic} exceeds per-call cap ${cap}`;
    }
  }
  // maxPerDayAtomic: enforced once the daily ledger lands (follow-up).
  return null;
}

// ───────────────────────────────────────────────────────────────────────
// H2 idempotency — per-host paid-call cooldown (best-effort, file-backed).
// ───────────────────────────────────────────────────────────────────────

type SpendState = Record<string, { lastPaidAt: number; lastResult: string }>;

function spendStatePath(): string {
  const home = process.env.HPP_X402_HOME ?? pathResolve(homedir(), ".hpp-x402");
  return pathResolve(home, "topup-state.json");
}

function loadSpendState(): SpendState {
  try {
    return JSON.parse(readFileSync(spendStatePath(), "utf8")) as SpendState;
  } catch {
    return {};
  }
}

/**
 * Cooldown gate for a paid call to `host`. If a paid call happened within
 * `cooldownMs`, returns the previous result text so the caller can return it
 * verbatim instead of paying again. `now` is injectable for tests.
 */
export function checkCooldown(
  host: string,
  cooldownMs: number | undefined,
  now: number = Date.now(),
): { throttled: boolean; cachedResult?: string; remainingMs?: number } {
  if (!cooldownMs || cooldownMs <= 0) return { throttled: false };
  const entry = loadSpendState()[host];
  if (!entry) return { throttled: false };
  const elapsed = now - entry.lastPaidAt;
  if (elapsed < cooldownMs) {
    return { throttled: true, cachedResult: entry.lastResult, remainingMs: cooldownMs - elapsed };
  }
  return { throttled: false };
}

const LOCK_TTL_MS = 120_000;

function lockPath(host: string): string {
  const home = process.env.HPP_X402_HOME ?? pathResolve(homedir(), ".hpp-x402");
  return pathResolve(home, "locks", `${host.replace(/[^a-zA-Z0-9._-]/g, "_")}.lock`);
}

/**
 * Best-effort per-host advisory lock around the paid ceremony. Returns a
 * release fn, or null when another in-flight payment to this host holds it
 * (caller must NOT pay — closes the cooldown's check-then-act race for
 * concurrent calls). Stale locks (crashed process, older than LOCK_TTL_MS)
 * are reclaimed.
 */
export function acquireHostLock(host: string): (() => void) | null {
  const p = lockPath(host);
  try {
    mkdirSync(dirname(p), { recursive: true });
  } catch {
    /* noop */
  }
  try {
    if (Date.now() - statSync(p).mtimeMs > LOCK_TTL_MS) unlinkSync(p);
  } catch {
    /* no existing lock */
  }
  let fd: number;
  try {
    fd = openSync(p, "wx"); // O_CREAT|O_EXCL|O_WRONLY — fails if it exists
  } catch {
    return null; // held by another in-flight payment
  }
  closeSync(fd);
  return () => {
    try {
      unlinkSync(p);
    } catch {
      /* noop */
    }
  };
}

/** Record a successful paid call to `host` (for the cooldown gate). */
export function recordPaid(host: string, resultText: string, now: number = Date.now()): void {
  try {
    const state = loadSpendState();
    state[host] = { lastPaidAt: now, lastResult: resultText };
    const home = process.env.HPP_X402_HOME ?? pathResolve(homedir(), ".hpp-x402");
    mkdirSync(home, { recursive: true });
    writeFileSync(spendStatePath(), JSON.stringify(state, null, 2), { mode: 0o600 });
  } catch {
    // best-effort — cooldown is a safety net, never block a paid call on it
  }
}
