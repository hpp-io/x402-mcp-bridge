/**
 * Asset allowlist — which tokens the bridge is willing to pay in.
 *
 * A 402 names the token it wants paid (`accept.asset`). Until now the bridge
 * picked an accept by network + scheme only and signed for whatever asset the
 * seller named, so a hostile seller could ask for a token the key happens to
 * hold, and the per-call cap (an atomic-unit number) meant nothing for a token
 * with different decimals. Every payment path now drops accepts whose asset is
 * not on the allowlist *before* the cap and the signature.
 *
 * The list is per network (config.ts NETWORK_DEFAULTS.assets) plus whatever the
 * operator adds through `USDCE_ADDRESS` / `HPP_X402_ALLOWED_ASSETS`.
 */

type AssetLike = { asset?: unknown; network?: unknown; scheme?: unknown };

/**
 * Tokens without EIP-3009 (`transferWithAuthorization`). They cannot settle an
 * `exact` payment; only the Permit2-settled `upto` scheme works for them.
 * HPP on Sepolia and Mainnet.
 */
export const UPTO_ONLY_ASSETS: readonly string[] = [
  "0x8ebcaf48d2d91b8cecf1668a4519823881bf8fc3",
  "0xb48334e7938367bc24fe1f19000d6f06c622e6c7",
];

/** False when the accept asks a token for a scheme it cannot do (an upto-only token priced as exact). */
export function schemeFitsAsset(a: AssetLike): boolean {
  return !(typeof a.asset === "string" && UPTO_ONLY_ASSETS.includes(normalizeAsset(a.asset)) && a.scheme !== "upto");
}

/** Normalise for comparison — addresses in 402s arrive in mixed case. */
export function normalizeAsset(asset: string): string {
  return asset.trim().toLowerCase();
}

export function isAllowedAsset(allowed: readonly string[], asset: unknown): boolean {
  return typeof asset === "string" && allowed.includes(normalizeAsset(asset));
}

/** Keep only the accepts paid in an allowed asset, in a scheme that asset supports (order preserved). */
export function filterAllowedAssets<T extends AssetLike>(accepts: readonly T[], allowed: readonly string[]): T[] {
  return accepts.filter((a) => isAllowedAsset(allowed, a.asset) && schemeFitsAsset(a));
}

/**
 * Why nothing was payable, when the only reason is the asset: the seller priced
 * on our network but in a token we do not pay in. Returns undefined when the
 * asset was not the (sole) problem, so callers fall through to their usual
 * "no payable accept" message.
 */
export function assetRefusal(
  accepts: readonly AssetLike[],
  network: string,
  allowed: readonly string[],
): string | undefined {
  const onNetwork = accepts.filter((a) => a.network === network);
  if (onNetwork.length === 0) return undefined;
  const allowedOnes = onNetwork.filter((a) => isAllowedAsset(allowed, a.asset));
  if (allowedOnes.length > 0) {
    // Allowed token, wrong scheme for it: say so instead of a generic "no payable accept".
    if (allowedOnes.every((a) => !schemeFitsAsset(a))) {
      const tokens = [...new Set(allowedOnes.map((a) => String(a.asset)))].join(", ");
      return `seller asks for a fixed-price payment in a token that can only pay usage-based (upto) prices (${tokens})`;
    }
    return undefined;
  }
  const offered = [...new Set(onNetwork.map((a) => String(a.asset)))].join(", ");
  return (
    `seller wants payment in an asset this wallet does not pay in (offered: ${offered}; ` +
    `allowed on ${network}: ${allowed.join(", ")}). Add it with HPP_X402_ALLOWED_ASSETS if you trust it.`
  );
}
