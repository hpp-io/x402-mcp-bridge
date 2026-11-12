/**
 * Valuation — turns a token amount into the unit the spend caps are written in.
 *
 * The caps (`maxPerCallAtomic`, `maxPerDayAtomic`, per-host `maxPerCallAtomic`)
 * are one number for every token: micro-dollars, i.e. the atomic unit of a
 * 6-decimal dollar token. For USDC.e and CHIP (and any other 6-decimal token)
 * the amount in the 402 already *is* that number, so nothing changes for them.
 *
 * HPP is different twice over: 18 decimals, and a floating price. An HPP
 * amount is therefore converted to micro-dollars with the HPP/USD rate the HPP
 * paymaster publishes (`GET /wallet/rates`, refreshed every 10 minutes from
 * several markets). If that cannot be read, or the answer looks wrong, a
 * built-in reference price is used instead — and whenever there is doubt the
 * HIGHER price wins, because a higher price makes the cap stricter, never
 * looser.
 */
import { log } from "./log.js";

/** Tokens valued by a rate instead of 1:1. Lowercased address → how to value it. */
const RATE_VALUED: Record<string, { symbol: string; decimals: number }> = {
  "0x8ebcaf48d2d91b8cecf1668a4519823881bf8fc3": { symbol: "HPP", decimals: 18 }, // HPP Sepolia
  "0xb48334e7938367bc24fe1f19000d6f06c622e6c7": { symbol: "HPP", decimals: 18 }, // HPP Mainnet
};

/**
 * Reference HPP price in USD (Nov 2026). Used when the published rate is
 * unavailable, and as the centre of the sanity band for a published one.
 */
export const REFERENCE_HPP_USD = 0.005;
/** A published rate further than this factor from the reference is not trusted. */
const SANITY_FACTOR = 50;
/** A published rate older than this is treated as unavailable. */
const MAX_RATE_AGE_MS = 24 * 60 * 60 * 1000;
const CACHE_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 4000;

const DEFAULT_RATES_URL: Record<string, string> = {
  "eip155:181228": "https://aa-sepolia.hpp.io/wallet/rates",
  "eip155:190415": "https://aa.hpp.io/wallet/rates",
};

type Fetcher = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;
let fetcher: Fetcher = (url, init) => fetch(url, init);
let ratesUrlOverride: string | undefined;
const cache = new Map<string, { at: number; hppUsd: number; source: "published" | "reference" }>();

/** Operator override for the rates endpoint (`HPP_X402_RATES_URL`); empty = per-network default. */
export function configureValuation(opts: { ratesUrl?: string; fetch?: Fetcher; keepCache?: boolean }): void {
  ratesUrlOverride = opts.ratesUrl?.trim() || undefined;
  if (opts.fetch) fetcher = opts.fetch;
  if (!opts.keepCache) cache.clear();
}

export function isRateValued(asset: unknown): boolean {
  return typeof asset === "string" && asset.trim().toLowerCase() in RATE_VALUED;
}

/** HPP price in USD for cap purposes: the published rate when trustworthy, else the reference — never below the reference when in doubt. */
export async function hppUsd(network: string, now = Date.now()): Promise<{ hppUsd: number; source: "published" | "reference" }> {
  const hit = cache.get(network);
  if (hit && now - hit.at < CACHE_MS) return hit;
  const url = ratesUrlOverride ?? (process.env.HPP_X402_RATES_URL?.trim() || undefined) ?? DEFAULT_RATES_URL[network];
  let out: { hppUsd: number; source: "published" | "reference" } = {
    // doubt → the higher of what we last trusted and the reference
    hppUsd: Math.max(hit?.source === "published" ? hit.hppUsd : 0, REFERENCE_HPP_USD),
    source: "reference",
  };
  if (url) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetcher(url, { signal: ctl.signal });
      const body = (res.ok ? await res.json() : null) as { hpp_usd?: unknown; updatedAt?: unknown } | null;
      const price = Number(body?.hpp_usd);
      const age = typeof body?.updatedAt === "string" ? now - Date.parse(body.updatedAt) : Number.NaN;
      const sane =
        Number.isFinite(price) && price >= REFERENCE_HPP_USD / SANITY_FACTOR && price <= REFERENCE_HPP_USD * SANITY_FACTOR;
      const fresh = Number.isFinite(age) && age <= MAX_RATE_AGE_MS;
      if (sane && fresh) out = { hppUsd: price, source: "published" };
      else log.info("valuation.rateRejected", { network, price: body?.hpp_usd ?? null, updatedAt: body?.updatedAt ?? null });
    } catch (err) {
      log.info("valuation.rateUnavailable", { network, error: (err as Error).message });
    } finally {
      clearTimeout(timer);
    }
  }
  const entry = { at: now, ...out };
  cache.set(network, entry);
  return entry;
}

export type CapAmount = {
  /** The amount in cap units (micro-dollars). Equals the token amount for 1:1 tokens. */
  units: bigint;
  /** Human note for refusals when the amount was converted, e.g. "0.5 HPP ≈ $0.0025 at 0.005 USD/HPP (published)". */
  note?: string;
};

/**
 * The number to compare against the spend caps for paying `atomic` of `asset`.
 * 6-decimal tokens: the amount itself. HPP: its USD value in micro-dollars,
 * rounded up.
 */
export async function capAmount(asset: unknown, atomic: bigint, network: string): Promise<CapAmount> {
  const meta = typeof asset === "string" ? RATE_VALUED[asset.trim().toLowerCase()] : undefined;
  if (!meta) return { units: atomic };
  const { hppUsd: price, source } = await hppUsd(network);
  // integer math: price in 1e-12 USD per token; micro-dollars = atomic × price / 10^(decimals + 6), rounded up
  const priceE12 = BigInt(Math.ceil(price * 1e12));
  const denom = 10n ** BigInt(meta.decimals + 6);
  const units = (atomic * priceE12 + denom - 1n) / denom;
  const tokens = Number(atomic) / 10 ** meta.decimals;
  return {
    units,
    note: `${tokens} ${meta.symbol} ≈ $${(Number(units) / 1e6).toFixed(6)} at ${Number(price.toPrecision(4))} USD/${meta.symbol} (${source} rate)`,
  };
}
