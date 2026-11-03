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

type AssetLike = { asset?: unknown; network?: unknown };

/** Normalise for comparison — addresses in 402s arrive in mixed case. */
export function normalizeAsset(asset: string): string {
  return asset.trim().toLowerCase();
}

export function isAllowedAsset(allowed: readonly string[], asset: unknown): boolean {
  return typeof asset === "string" && allowed.includes(normalizeAsset(asset));
}

/** Keep only the accepts paid in an allowed asset (order preserved). */
export function filterAllowedAssets<T extends AssetLike>(accepts: readonly T[], allowed: readonly string[]): T[] {
  return accepts.filter((a) => isAllowedAsset(allowed, a.asset));
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
  if (onNetwork.some((a) => isAllowedAsset(allowed, a.asset))) return undefined;
  const offered = [...new Set(onNetwork.map((a) => String(a.asset)))].join(", ");
  return (
    `seller wants payment in an asset this wallet does not pay in (offered: ${offered}; ` +
    `allowed on ${network}: ${allowed.join(", ")}). Add it with HPP_X402_ALLOWED_ASSETS if you trust it.`
  );
}
