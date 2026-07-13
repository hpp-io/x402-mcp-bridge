/**
 * Upstream MCP client. Connects to the remote x402 MCP server (the
 * "seller") and wraps it with @x402/mcp's payment middleware.
 *
 * The middleware handles the 402 → sign → retry cycle. We hook into its
 * `onPaymentRequested` callback to run autoTopup before each payment so
 * the delegate EOA holds enough USDC.e to sign the EIP-3009 authorization.
 */
import { homedir } from "node:os";
import { resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { wrapMCPClientWithPaymentFromConfig } from "@x402/mcp";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { UptoEvmScheme } from "@x402/evm/upto/client";
import {
  BatchSettlementEvmScheme,
  processSettleResponse,
} from "@x402/evm/batch-settlement/client";
// @x402/evm 2.13.0 moved FileClientChannelStorage into its own subpath.
import { FileClientChannelStorage } from "@x402/evm/batch-settlement/client/file-storage";
import type { Network } from "@x402/core/types";

import type { Funds } from "./funds.js";
import { RawEoaSigner } from "./signers/raw-eoa.js";
import { log } from "./log.js";

/**
 * Root directory for persisted batch-settlement client state.
 *
 * The SDK's `FileClientChannelStorage` writes one JSON per channel under
 * `{root}/client/{channelId}.json` and uses cross-process file locks so
 * concurrent bridge instances (e.g., Claude Desktop + OpenClaw on the same
 * machine sharing a delegate EOA) can mutate the same channel safely.
 *
 * Override with `HPP_X402_HOME` for test isolation or non-standard layouts.
 */
const CHANNEL_STORAGE_ROOT =
  process.env.HPP_X402_HOME ?? resolve(homedir(), ".hpp-x402");

export interface UpstreamClient {
  /** Standard MCP client — listTools/etc go here. */
  base: Client;
  /** Payment-aware wrapper — callTool goes here. */
  x402: ReturnType<typeof wrapMCPClientWithPaymentFromConfig>;
  /**
   * batch-settlement scheme instance — F-3a auto-refund needs to
   * call `.refund(url, {amount})` when a paid compute times out and
   * the server reports the job failed.
   */
  batchScheme: BatchSettlementEvmScheme;
  /**
   * Resource server URL the bridge is talking to. F-3a refund uses
   * this as the target URL passed to `batchScheme.refund(...)`.
   */
  serverUrl: string;
  /**
   * Most recent payment amount the selector accepted, in atomic
   * units. F-3a's refund needs this to know how much to ask back —
   * the SDK doesn't surface it through onAfterPayment cleanly.
   * Updated by `paymentRequirementsSelector` on every 402 → sign.
   */
  lastPaymentAmount(): bigint | null;
  /** Disconnect and free resources. */
  close(): Promise<void>;
}

export interface UpstreamOptions {
  url: string;
  network: Network;
  /** EVM RPC URL — the upto client needs it to read the EIP-2612 token nonce
   *  for gasless Permit2 approval (without it, upto falls back to requiring a
   *  pre-existing on-chain approve(Permit2)). */
  rpcUrl: string;
  signer: RawEoaSigner; // PoC: RawEoaSigner only; widens with future signers
  funds: Funds;
  bridgeName: string;
  bridgeVersion: string;
}

export async function connectUpstream(opts: UpstreamOptions): Promise<UpstreamClient> {
  const base = new Client({ name: opts.bridgeName, version: opts.bridgeVersion });

  const channelStorage = new FileClientChannelStorage({
    directory: CHANNEL_STORAGE_ROOT,
  });
  log.info("channelStorage.configured", { directory: CHANNEL_STORAGE_ROOT });

  // Single batch-settlement scheme instance — referenced by both the
  // payment middleware and F-3a's auto-refund poller (via UpstreamClient
  // surface). Sharing the instance keeps storage consistent — the same
  // FileClientChannelStorage backs voucher signing AND refund signing.
  const batchScheme = new BatchSettlementEvmScheme(opts.signer.viemAccount, {
    storage: channelStorage,
  });

  // Track the last accepted payment amount so F-3a knows how much to
  // refund on a failed compute. The selector callback below assigns
  // it; the UpstreamClient surface reads it.
  let lastPaymentAmountAtomic: bigint | null = null;

  const x402 = wrapMCPClientWithPaymentFromConfig(
    base,
    {
      // Register all three client schemes so the bridge can pay whatever a
      // service advertises. The selector (below) honors the seller's accepts
      // order and logs the choice; registration order here is not significant.
      schemes: [
        {
          network: opts.network,
          // payerAuthorizer defaults to signer.address (Q-3: delegate EOA
          // self-signs vouchers — no Safe EIP-1271 round-trip per call).
          client: batchScheme,
        },
        {
          network: opts.network,
          client: new ExactEvmScheme(opts.signer.viemAccount),
        },
        {
          // upto (usage-based) — selected when the service advertises it first
          // (seller-driven). The client auto-detects the facilitator's EIP-2612
          // gas-sponsoring extension and signs the Permit2 permit accordingly;
          // without it the payer must have an existing approve(Permit2).
          // Ref: x402-upto-scheme design/05.
          network: opts.network,
          // rpcUrl lets the upto client read the EIP-2612 token nonce so it can
          // sign the gasless Permit2 approval (no on-chain approve needed).
          client: new UptoEvmScheme(opts.signer.viemAccount, { rpcUrl: opts.rpcUrl }),
        },
      ],
      paymentRequirementsSelector: (_x402Version, accepts) => {
        // Honor the SELLER's advertised order: pick the first accept whose
        // scheme this client can sign. Scheme choice is a property of the
        // service's pricing model (seller advertises priority via accepts
        // order), NOT buyer config — so a usage-based service that lists `upto`
        // first gets upto automatically; a fixed-price service that lists
        // batch/exact gets those. `HPP_X402_PREFER_EXACT=true` is a demo-only
        // override (forces exact, e.g. to show wallet balance deltas live).
        const supported = new Set(["exact", "batch-settlement", "upto"]);
        let picked = accepts.find((a) => supported.has(a.scheme)) ?? accepts[0];
        if (process.env.HPP_X402_PREFER_EXACT === "true") {
          picked = accepts.find((a) => a.scheme === "exact") ?? picked;
        }
        const amountStr = (picked as { amount?: string }).amount;
        if (amountStr) {
          try {
            lastPaymentAmountAtomic = BigInt(amountStr);
          } catch {
            // amount unparseable — leave previous value, log already covers selecting
          }
        }
        log.info("scheme.selecting", {
          offered: accepts.map((a) => a.scheme),
          picked: picked.scheme,
          amount: amountStr,
        });
        return picked;
      },
    },
    {
      autoPayment: true,
      onPaymentRequested: async ({ paymentRequired }) => {
        // A multi-network resource-server advertises accepts for several networks;
        // pick THIS bridge's network so the topup amount + log match the accept the
        // selector will actually settle (the SDK filters accepts by registered
        // network). Falling back to accepts[0] keeps single-network servers working.
        const accept =
          paymentRequired.accepts?.find((a) => a.network === opts.network) ??
          paymentRequired.accepts?.[0];
        if (!accept) return false;

        const requiredAtomic = BigInt((accept as { amount?: string }).amount ?? "0");
        log.info("payment.requested", {
          amount: requiredAtomic.toString(),
          asset: (accept as { asset?: string }).asset,
          network: (accept as { network?: string }).network,
        });

        try {
          const txHash = await opts.funds.ensure(requiredAtomic);
          if (txHash) {
            log.info("autoTopup.executed", { txHash, requiredAtomic: requiredAtomic.toString() });
          } else {
            log.debug("autoTopup.skipped — sufficient balance");
          }
          return true;
        } catch (err) {
          log.error("autoTopup.failed", {
            err: (err as Error).message,
            requiredAtomic: requiredAtomic.toString(),
          });
          return false; // refuse payment — host will see the error
        }
      },
    },
  );

  // Persist channel state after every paid call. The SDK's HTTP transport
  // does this through `processPaymentResponse(storage, getHeader)` which
  // parses the PAYMENT-RESPONSE header; MCP transport routes the same
  // settle payload through tool result meta (extractPaymentResponseFromMeta
  // → afterPaymentHooks ctx.settleResponse) but the SDK's BatchSettlement
  // schemeHooks.onPaymentResponse is *not* invoked by the MCP wrapper
  // (only manual afterPaymentHooks are). Without this we never write
  // {balance, totalClaimed, chargedCumulativeAmount, signedMaxClaimable,
  // signature} back to the channel context, and the next call signs a
  // voucher against stale state — triggering
  // `invalid_batch_settlement_evm_cumulative_amount_mismatch`. Pending
  // upstream MCP wrapper fix: x402-foundation/x402#2387.
  x402.onAfterPayment(async ({ settleResponse }) => {
    if (!settleResponse || !settleResponse.success) return;

    // Auto-deposit visibility: when the SDK bundles an onchain deposit
    // with this call (channel was low on balance), the settle response
    // carries a transaction hash AND the post-deposit balance. Compare
    // against the previously-persisted balance to surface a clear log.
    const extra = (settleResponse as { extra?: { channelState?: { channelId?: string; balance?: string } } })
      .extra?.channelState;
    if (extra?.channelId && extra.balance !== undefined && settleResponse.transaction) {
      try {
        const prior = await channelStorage.get(extra.channelId.toLowerCase());
        const priorBalance = BigInt(
          (prior as { balance?: string } | undefined)?.balance ?? "0",
        );
        const newBalance = BigInt(extra.balance);
        if (newBalance > priorBalance) {
          log.info("batch.channel.deposited", {
            channelId: extra.channelId,
            depositedAmount: (newBalance - priorBalance).toString(),
            balanceAfter: extra.balance,
            txHash: settleResponse.transaction,
          });
        }
      } catch {
        // best-effort log — never block payment on this
      }
    }

    try {
      await processSettleResponse(channelStorage, settleResponse);
    } catch (err) {
      log.error("batch.settleResponse.persist_failed", {
        err: (err as Error).message,
      });
    }
  });

  const transport = new SSEClientTransport(new URL(opts.url));
  await base.connect(transport);
  log.info("upstream.connected", { url: opts.url });

  return {
    base,
    x402,
    batchScheme,
    serverUrl: opts.url,
    lastPaymentAmount: () => lastPaymentAmountAtomic,
    async close() {
      await base.close().catch(() => {});
    },
  };
}
