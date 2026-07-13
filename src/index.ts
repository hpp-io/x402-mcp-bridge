/**
 * Bridge entry — wires config → signer → autoTopup → upstream client →
 * stdio server, then runs forever (until the host closes our stdin).
 *
 * Public surface for callers (npx, programmatic):
 *   - default export: `runBridge()` — runs main loop
 *   - named exports: types only (config, signer, autoTopup) for tests
 */
import { loadConfig, type Config } from "./config.js";
import { setLogLevel, log } from "./log.js";
import { RawEoaSigner } from "./signers/raw-eoa.js";
import { AutoTopup } from "./autoTopup.js";
import { DirectBalance } from "./funds/direct-balance.js";
import type { Funds } from "./funds.js";
import { connectUpstream } from "./client.js";
import { startBridgeServer } from "./server.js";
import { DiscoveryClient } from "./discovery.js";
import {
  isKeychainURI,
  resolveKeychain,
  setKeychain,
  buildKeychainURI,
} from "./keychain.js";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import type { Network } from "@x402/core/types";

const PKG_NAME = "@hpp-io/x402-mcp-bridge";
const PKG_VERSION = "0.1.5"; // mirrors package.json — bump together
const DEFAULT_ACCOUNT = "delegate-default";

/**
 * Zero-config first run: if no DELEGATE_PRIVATE_KEY is supplied, auto-create a
 * delegate wallet in the OS keychain (idempotent — reused on later runs) and
 * point the env at its keychain URI. Lets a bare
 * `npx -y @hpp-io/x402-mcp-bridge` boot with no config; the user just funds the
 * printed address. Explicitly-set keys are untouched.
 */
function ensureDelegateKey(env: NodeJS.ProcessEnv): void {
  if (env.DELEGATE_PRIVATE_KEY) return;
  const uri = buildKeychainURI(DEFAULT_ACCOUNT);
  let key: `0x${string}`;
  let created = false;
  try {
    key = resolveKeychain(uri);
  } catch {
    key = generatePrivateKey();
    setKeychain(DEFAULT_ACCOUNT, key);
    created = true;
  }
  env.DELEGATE_PRIVATE_KEY = uri;
  const address = privateKeyToAccount(key).address;
  // Written straight to stderr (not the level-gated logger, which isn't
  // configured yet at this point) so the funding address is always visible.
  process.stderr.write(
    `\nhpp-x402: wallet ${created ? "created" : "ready"} → ${address}\n` +
      `  ▶ Fund it: send USDC.e to this address (no native gas needed).\n\n`,
  );
}

export async function runBridge(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  ensureDelegateKey(env);
  const cfg: Config = loadConfig(env);
  setLogLevel(cfg.LOG_LEVEL);
  log.info("bridge.start", {
    name: PKG_NAME,
    version: PKG_VERSION,
    chain: cfg.HPP_NETWORK,
    walletMode: cfg.walletMode,
    safe: cfg.SAFE_ADDRESS,
    resourceServer: cfg.RESOURCE_SERVER_URL,
  });

  // ---- Signer (raw key from env or OS keychain) -----------------------
  const delegateKey = isKeychainURI(cfg.DELEGATE_PRIVATE_KEY)
    ? resolveKeychain(cfg.DELEGATE_PRIVATE_KEY)
    : (cfg.DELEGATE_PRIVATE_KEY as `0x${string}`);
  const signer = new RawEoaSigner(delegateKey);
  log.info("signer.loaded", {
    address: signer.address,
    source: isKeychainURI(cfg.DELEGATE_PRIVATE_KEY) ? "keychain" : "env",
  });

  // ---- Funds (wallet mode) --------------------------------------------
  // Safe mode: autoTopup pulls USDC.e from the Safe within the on-chain daily
  // cap when the delegate is short. Light mode: the delegate holds USDC.e
  // directly; DirectBalance only checks the balance and surfaces a funding
  // instruction when short (no Safe, no on-chain topup, no native gas).
  const funds: Funds =
    cfg.walletMode === "safe"
      ? new AutoTopup(
          signer,
          cfg.SAFE_ADDRESS as `0x${string}`,
          cfg.ALLOWANCE_MODULE_ADDRESS as `0x${string}`,
          cfg.USDCE_ADDRESS as `0x${string}`,
          cfg.chainId,
          cfg.HPP_RPC_URL,
          {
            headroomX: BigInt(cfg.TOPUP_HEADROOM_X),
            fixedAmountAtomic: cfg.TOPUP_AMOUNT_ATOMIC
              ? BigInt(cfg.TOPUP_AMOUNT_ATOMIC)
              : undefined,
          },
        )
      : new DirectBalance(
          signer.address,
          cfg.USDCE_ADDRESS as `0x${string}`,
          cfg.chainId,
          cfg.HPP_RPC_URL,
        );

  // ---- Upstream MCP client (optional) ---------------------------------
  // When RESOURCE_SERVER_URL is unset, run in local-tools-only mode (credit
  // top-up / A2A) and skip the upstream connection.
  let upstream: Awaited<ReturnType<typeof connectUpstream>> | undefined;
  if (cfg.RESOURCE_SERVER_URL) {
    upstream = await connectUpstream({
      url: cfg.RESOURCE_SERVER_URL,
      network: cfg.HPP_NETWORK as Network,
      rpcUrl: cfg.HPP_RPC_URL,
      signer,
      funds,
      bridgeName: PKG_NAME,
      bridgeVersion: PKG_VERSION,
    });
  } else {
    log.info("upstream.skipped", {
      reason: "RESOURCE_SERVER_URL unset — local tools only (x402_http_call, pay_a2a_agent)",
    });
  }

  // ---- stdio MCP server (host-facing) ---------------------------------
  // HPP_X402_A2A_RPC_TIMEOUT_MS — per-request timeout for pay_a2a_agent's
  // A2A JSON-RPC calls. Falls back to the in-module default when unset or
  // not a positive integer.
  const a2aRpcTimeoutRaw = process.env.HPP_X402_A2A_RPC_TIMEOUT_MS;
  const a2aRpcTimeoutParsed = a2aRpcTimeoutRaw ? Number(a2aRpcTimeoutRaw) : NaN;
  const a2aRpcTimeoutMs =
    Number.isFinite(a2aRpcTimeoutParsed) && a2aRpcTimeoutParsed > 0
      ? a2aRpcTimeoutParsed
      : undefined;

  // Curated service discovery — register hpp_discover / hpp_call when enabled.
  const discovery = cfg.discoveryEnabled
    ? new DiscoveryClient(cfg.discoveryUrl)
    : undefined;
  if (discovery) log.info("discovery.enabled", { url: cfg.discoveryUrl });

  // Seller tools — register seller_* when enabled.
  const seller = cfg.sellerEnabled
    ? { network: cfg.HPP_NETWORK as Network, facilitatorUrl: cfg.facilitatorUrl }
    : undefined;
  if (seller) log.info("seller.enabled", { facilitator: cfg.facilitatorUrl });

  await startBridgeServer({
    upstream,
    name: PKG_NAME,
    version: PKG_VERSION,
    signer,
    network: cfg.HPP_NETWORK as Network,
    funds,
    rpcUrl: cfg.HPP_RPC_URL,
    discovery,
    seller,
    a2aRpcTimeoutMs,
  });

  // Graceful shutdown: when the host closes our stdin (or Claude Desktop
  // restarts), node exits. Belt-and-suspenders: handle signals too.
  const shutdown = async (sig: string) => {
    log.info("bridge.shutdown", { signal: sig });
    await upstream?.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

// Auto-run when invoked directly (npx, node dist/index.js).
// `import.meta.url` matches `process.argv[1]` only for the entry script.
if (import.meta.url === `file://${process.argv[1]}`) {
  runBridge().catch((err) => {
    log.error("bridge.fatal", { err: (err as Error).message });
    process.exit(1);
  });
}
