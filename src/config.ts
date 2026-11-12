/**
 * Env parsing + validation. The bridge runs as a stdio subprocess spawned
 * by the MCP host; *all* of its inputs come from env. We surface clear
 * errors before doing any I/O so misconfigured Claude Desktop entries fail
 * loudly at startup rather than mid-call.
 */
import { z } from "zod";

const HEX_ADDR = /^0x[0-9a-fA-F]{40}$/;
const HEX_KEY = /^0x[0-9a-fA-F]{64}$/;
const KEYCHAIN_URI = /^keychain:\/\/[^\/]+\/[a-zA-Z0-9._-]+$/;

// Per-network defaults so USDCE_ADDRESS / HPP_RPC_URL can be omitted (zero-config).
// `assets` is the list of tokens the bridge will pay in on that network — a 402
// asking for anything else is refused before signing (see assets.ts). USDC.e
// and CHIP are the settlement assets on both networks; Sepolia also carries
// HAC, the test token dev-router prices in.
//
// HPP is the network token (18 decimals, floating price). It has EIP-2612
// permit but no EIP-3009, so it can only pay usage-based (`upto`, Permit2)
// prices (assets.ts UPTO_ONLY_ASSETS), and its amounts are valued in USD for
// the spend caps (valuation.ts). Its address also differs per network.
//
// CHIP (House Chip) is the HPP ecosystem credit token: 6 decimals, EIP-3009,
// EIP-712 domain { name: "House Chip", version: "1" }. It lives at a DIFFERENT
// address on each network, so each list names only its own.
const NETWORK_DEFAULTS: Record<string, { rpc: string; usdc: string; assets: readonly string[] }> = {
  "eip155:181228": {
    rpc: "https://sepolia.hpp.io",
    usdc: "0x401eCb1D350407f13ba348573E5630B83638E30D",
    assets: [
      "0x401eCb1D350407f13ba348573E5630B83638E30D", // USDC.e
      "0xb58A997c7CE77074e08715b73EaF709dafDEd349", // HAC (test token)
      "0x0Ac610E77ec39AB5c6B402B376548Ac02ACc5a48", // CHIP
      "0x8ebCaf48D2D91b8CEcF1668A4519823881Bf8fc3", // HPP (upto only)
    ],
  },
  "eip155:190415": {
    rpc: "https://mainnet.hpp.io",
    usdc: "0x401eCb1D350407f13ba348573E5630B83638E30D",
    assets: [
      "0x401eCb1D350407f13ba348573E5630B83638E30D", // USDC.e
      "0xEDFC8E6658561C97A3FFc966923d16C1c626083A", // CHIP
      "0xB48334E7938367bC24Fe1F19000D6f06C622E6c7", // HPP (upto only)
    ],
  },
};

const HEX_ADDR_LIST = /^\s*(0x[0-9a-fA-F]{40}\s*(,\s*0x[0-9a-fA-F]{40}\s*)*)?$/;

/**
 * Tokens the bridge pays in on `network`, lowercased and de-duplicated: the
 * network's default list, the configured USDC.e address, and any operator
 * extras (comma-separated, i.e. `HPP_X402_ALLOWED_ASSETS`). Shared by the
 * bridge (loadConfig) and the `hpp-x402` CLI so both refuse the same 402s.
 */
export function allowedAssetsFor(network: string, usdc?: string, extraCsv?: string): string[] {
  const defaults = NETWORK_DEFAULTS[network] ?? NETWORK_DEFAULTS["eip155:181228"];
  const extras = (extraCsv ?? "")
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean);
  return [...new Set([usdc ?? defaults.usdc, ...defaults.assets, ...extras].map((a) => a.toLowerCase()))];
}

const Schema = z.object({
  // Delegate EOA — signs EIP-3009 payments + executeAllowanceTransfer.
  // Accepted forms:
  //   - 0x + 64 hex chars (raw key, dev / quickstart)
  //   - keychain://hpp-x402/<account> (resolved via @napi-rs/keyring at startup)
  DELEGATE_PRIVATE_KEY: z
    .string()
    .refine(
      (v) => HEX_KEY.test(v) || KEYCHAIN_URI.test(v),
      "expected 0x + 64 hex chars OR keychain://hpp-x402/<account>",
    ),

  // Safe wallet that holds the user's USDC.e (Safe mode only). Omit for light
  // mode, where the delegate EOA holds USDC.e directly. Must be set together
  // with ALLOWANCE_MODULE_ADDRESS (both-or-neither, enforced below).
  SAFE_ADDRESS: z.string().regex(HEX_ADDR).optional(),

  // Deployed AllowanceModule (Safe mode only; pairs with SAFE_ADDRESS).
  ALLOWANCE_MODULE_ADDRESS: z.string().regex(HEX_ADDR).optional(),

  // Asset paid in (USDC.e on HPP). Optional — defaults per network (below).
  USDCE_ADDRESS: z.string().regex(HEX_ADDR).optional(),

  // Extra tokens the bridge may pay in, comma-separated addresses. Added to the
  // per-network default list (NETWORK_DEFAULTS.assets) + USDCE_ADDRESS. A 402
  // priced in any other token is refused before signing.
  HPP_X402_ALLOWED_ASSETS: z
    .string()
    .regex(HEX_ADDR_LIST, "expected comma-separated 0x addresses")
    .optional(),

  // Remote MCP server we proxy to (the seller). Optional: when unset the
  // bridge runs in local-tools-only mode (e.g. credit top-up / A2A) and skips
  // the upstream connection entirely.
  RESOURCE_SERVER_URL: z.string().url().optional(),

  // Chain RPC. Optional — defaults per network (below).
  HPP_RPC_URL: z.string().url().optional(),

  // CAIP-2 network identifier used by @x402/evm.
  // e.g. "eip155:181228" (HPP Sepolia) / "eip155:190415" (HPP Mainnet).
  // Optional — defaults to HPP Sepolia so a bare `npx @hpp-io/x402-mcp-bridge`
  // boots with zero config (see NETWORK_DEFAULTS + runBridge auto-wallet).
  HPP_NETWORK: z.string().regex(/^eip155:\d+$/).optional().default("eip155:181228"),
  /**
   * ERC-7710 payment delegation (hex permissionContext) the user's wallet granted to this
   * bridge's key: pays `erc7710` accepts from the USER's smart account under on-chain caps —
   * the bridge key itself needs no USDC.e. Validated against the key at boot (see erc7710.ts).
   */
  HPP_PAYMENT_DELEGATION: z.string().regex(/^0x[0-9a-fA-F]*$/).optional(),

  // Optional knobs ------------------------------------------------------
  // How much to pull on each topup, in atomic USDC.e units. If unset,
  // the bridge tops up "just enough" for the upcoming payment + small
  // headroom (10x the price, capped to remaining allowance).
  TOPUP_AMOUNT_ATOMIC: z
    .string()
    .regex(/^\d+$/)
    .optional(),

  // Headroom multiplier for the dynamic topup amount above. 10 = pull
  // 10× the next payment so subsequent calls don't always trigger a
  // topup tx. Defaults to 10.
  TOPUP_HEADROOM_X: z
    .string()
    .regex(/^\d+$/)
    .optional()
    .default("10"),

  // Logging. "off" = silent (good for clean stdio), "debug" = verbose stderr.
  LOG_LEVEL: z.enum(["off", "info", "debug"]).optional().default("info"),

  // Curated service discovery (hpp-x402-discovery). "on" (default) registers
  // the hpp_discover / hpp_call tools that query the HPP discovery directory —
  // a facilitator-indexed, semi-curated list of paid x402 services. "off"
  // disables them (manual RESOURCE_SERVER_URL only).
  HPP_X402_DISCOVERY: z.enum(["on", "off"]).optional().default("on"),
  // The directory moved to x402-explorer.hpp.io; the old x402-discovery host
  // only survives as a 301, so point at the canonical origin directly.
  HPP_X402_DISCOVERY_URL: z
    .string()
    .url()
    .optional()
    .default("https://x402-explorer.hpp.io"),

  // Seller tools (A2 Phase 1). "on" registers seller_* MCP tools so this agent
  // can charge others over x402 (facilitator verify/settle wrappers). Off by
  // default — buyers don't need them.
  HPP_X402_SELLER: z.enum(["on", "off"]).optional().default("off"),
  HPP_X402_FACILITATOR_URL: z
    .string()
    .url()
    .optional()
    .default("https://facilitator-sepolia.hpp.io"),
})
  // Wallet mode is inferred from Safe config presence: both set = Safe mode
  // (autoTopup from the Safe within an on-chain cap); both omitted = light mode
  // (delegate EOA holds USDC.e directly). Setting one without the other is a
  // config error.
  .superRefine((v, ctx) => {
    const hasSafe = !!v.SAFE_ADDRESS;
    const hasModule = !!v.ALLOWANCE_MODULE_ADDRESS;
    if (hasSafe !== hasModule) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [hasSafe ? "ALLOWANCE_MODULE_ADDRESS" : "SAFE_ADDRESS"],
        message:
          "SAFE_ADDRESS and ALLOWANCE_MODULE_ADDRESS must be set together (Safe mode) or both omitted (light mode)",
      });
    }
  });

export type Config = Omit<z.infer<typeof Schema>, "USDCE_ADDRESS" | "HPP_RPC_URL"> & {
  /** Filled from NETWORK_DEFAULTS when omitted, so always present downstream. */
  USDCE_ADDRESS: string;
  HPP_RPC_URL: string;
  /** Lowercased token addresses this bridge pays in on HPP_NETWORK (see assets.ts). */
  allowedAssets: string[];
  chainId: number;
  /** "safe" when SAFE_ADDRESS + ALLOWANCE_MODULE_ADDRESS are set (autoTopup
   *  from the Safe); "light" when both are omitted (delegate holds USDC.e). */
  walletMode: "safe" | "light";
  /** true when HPP_X402_DISCOVERY === "on" — register hpp_discover/hpp_call. */
  discoveryEnabled: boolean;
  /** Base URL of the discovery REST API. */
  discoveryUrl: string;
  /** true when HPP_X402_SELLER === "on" — register seller_* tools. */
  sellerEnabled: boolean;
  /** Facilitator base URL used by seller verify/settle. */
  facilitatorUrl: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(
      "x402-mcp-bridge: invalid config from env\n" + issues + "\n",
    );
  }
  const v = parsed.data;
  const chainId = Number(v.HPP_NETWORK.split(":")[1]);
  const walletMode: "safe" | "light" =
    v.SAFE_ADDRESS && v.ALLOWANCE_MODULE_ADDRESS ? "safe" : "light";
  // Zero-config: fill USDC.e + RPC from per-network defaults when omitted.
  const defaults = NETWORK_DEFAULTS[v.HPP_NETWORK] ?? NETWORK_DEFAULTS["eip155:181228"];
  const usdc = v.USDCE_ADDRESS ?? defaults.usdc;
  return {
    ...v,
    USDCE_ADDRESS: usdc,
    HPP_RPC_URL: v.HPP_RPC_URL ?? defaults.rpc,
    allowedAssets: allowedAssetsFor(v.HPP_NETWORK, usdc, v.HPP_X402_ALLOWED_ASSETS),
    chainId,
    walletMode,
    discoveryEnabled: v.HPP_X402_DISCOVERY === "on",
    discoveryUrl: v.HPP_X402_DISCOVERY_URL,
    sellerEnabled: v.HPP_X402_SELLER === "on",
    facilitatorUrl: v.HPP_X402_FACILITATOR_URL,
  };
}
