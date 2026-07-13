/**
 * stdio MCP server — what the host (Claude Desktop / OpenClaw / Cursor)
 * actually connects to.
 *
 * It's a thin proxy: tools are pulled from upstream on listTools, and
 * callTool forwards through the payment-wrapped upstream client. The host
 * sees a normal MCP server with paid tools that "just work".
 *
 * If autoTopup or the payment retry fails, the bridge surfaces the error
 * as a tool-result with `isError: true` so the LLM can see what happened
 * (e.g. "spend cap exceeded"). Throwing instead would crash the MCP RPC
 * stream.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import type { UpstreamClient } from "./client.js";
import { PAY_A2A_TOOL, payA2aAgent, type PayA2aArgs } from "./a2a.js";
import { X402_HTTP_TOOL, x402HttpCall, type X402HttpArgs } from "./httpX402.js";
import {
  HPP_DISCOVER_TOOL,
  HPP_CALL_TOOL,
  hppDiscover,
  hppCall,
  type DiscoverArgs,
  type HppCallArgs,
} from "./discoveryTools.js";
import type { DiscoveryClient } from "./discovery.js";
import {
  SELLER_TOOLS,
  SELLER_CREATE_REQUIREMENTS_TOOL,
  SELLER_GENERATE_402_TOOL,
  SELLER_DECODE_PAYMENT_TOOL,
  SELLER_VERIFY_TOOL,
  SELLER_SETTLE_TOOL,
  sellerCreateRequirements,
  sellerGenerate402,
  sellerDecodePayment,
  sellerVerify,
  sellerSettle,
  type SellerDeps,
} from "./sellerTools.js";
import { walletSpendStatus, setWalletLimits } from "./spendGuard.js";
import type { RawEoaSigner } from "./signers/raw-eoa.js";
import type { Funds } from "./funds.js";
import type { Network } from "@x402/core/types";
import { log } from "./log.js";

const WALLET_GET_LIMITS_TOOL = {
  name: "wallet_get_limits",
  description:
    "Show the wallet's spend limits (per-call + per-day in atomic USDC.e units) " +
    "and how much has been spent today. Empty limits = uncapped.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
} as const;

const WALLET_SET_LIMIT_TOOL = {
  name: "wallet_set_limit",
  description:
    "Set the wallet's spend guard: a per-call cap and/or a per-day cap in atomic " +
    "USDC.e units (e.g. '10000' = 0.01 USDC.e). These bind across ALL payment " +
    "tools and are enforced locally before signing (complements the Safe's " +
    "on-chain cap). Omit a field to leave it unchanged.",
  inputSchema: {
    type: "object",
    properties: {
      maxPerCallAtomic: { type: "string", description: "Max atomic units per single payment." },
      maxPerDayAtomic: { type: "string", description: "Max atomic units per UTC day (all tools combined)." },
    },
    additionalProperties: false,
  },
} as const;

const WALLET_BALANCE_TOOL = {
  name: "wallet_balance",
  description:
    "Show the wallet's current USDC.e balance — what it can spend right now. In " +
    "Safe mode this is the delegate's immediately-spendable balance (the Safe " +
    "tops up more on demand).",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
} as const;

export interface BridgeServerOptions {
  /** Upstream resource server. Undefined = local-tools-only mode. */
  upstream?: UpstreamClient;
  name: string;
  version: string;
  /** Delegate signer + network — used by the local `pay_a2a_agent` tool. */
  signer: RawEoaSigner;
  network: Network;
  funds?: Funds;
  /** Chain RPC — enables the upto scheme in hpp_call / x402_http_call. */
  rpcUrl?: string;
  /** Curated-discovery client. Present = register hpp_discover / hpp_call. */
  discovery?: DiscoveryClient;
  /** Seller deps. Present = register seller_* tools. */
  seller?: SellerDeps;
  /**
   * Per-request timeout for the A2A JSON-RPC calls in `pay_a2a_agent`.
   * Surfaced via env `HPP_X402_A2A_RPC_TIMEOUT_MS` (set at CLI entry);
   * defaults to {@link DEFAULT_A2A_RPC_TIMEOUT_MS} (60s) when omitted.
   */
  a2aRpcTimeoutMs?: number;
}

const WALLET_ADDRESS_TOOL = {
  name: "wallet_address",
  description:
    "Return this agent's own wallet address (to receive/fund USDC.e) and its " +
    "network. Use when the user asks 'what's my address' or where to send funds.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
} as const;

export async function startBridgeServer(opts: BridgeServerOptions): Promise<void> {
  const server = new Server(
    { name: opts.name, version: opts.version },
    { capabilities: { tools: {} } },
  );

  // ---- listTools — upstream tools (if any) + local tools --------------
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const upstreamTools = opts.upstream ? await opts.upstream.base.listTools() : { tools: [] };
    const localTools = [
      WALLET_ADDRESS_TOOL,
      WALLET_BALANCE_TOOL,
      WALLET_GET_LIMITS_TOOL,
      WALLET_SET_LIMIT_TOOL,
      PAY_A2A_TOOL,
      X402_HTTP_TOOL,
      ...(opts.discovery ? [HPP_DISCOVER_TOOL, HPP_CALL_TOOL] : []),
      ...(opts.seller ? SELLER_TOOLS : []),
    ];
    log.debug("listTools", { count: upstreamTools.tools.length + localTools.length });
    return { tools: [...upstreamTools.tools, ...localTools] };
  });

  // ---- callTool — forward through x402-aware wrapper ------------------
  //
  // Long-running tools: the upstream resource-server emits
  // `notifications/progress` every ~25s while it inline-waits for an
  // on-chain X402Delivered event. We forward each one to the host using
  // the host's own progressToken (from extra._meta) so its idle timer
  // resets and the request doesn't get cancelled at 60s. Without this,
  // any compute taking longer than ~55s gets killed at the host's MCP
  // client timeout, regardless of what the server eventually returns.
  //
  // `resetTimeoutOnProgress: true` on the upstream call applies the same
  // protection on the bridge → resource-server hop. `timeout: 300_000`
  // gives the upstream up to 5 minutes (well past anything we'd run
  // inline) before bridge gives up.
  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const { name, arguments: args } = req.params;
    log.info("callTool.start", { name });

    // Local tool: report our own wallet address (for funding).
    if (name === WALLET_ADDRESS_TOOL.name) {
      const address = opts.signer.address;
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              address,
              network: opts.network,
              fund: `Send USDC.e to ${address} on ${opts.network} — no native gas needed (gasless settlement).`,
            }),
          },
        ],
      };
    }

    // Local tool: read the wallet's current USDC.e balance.
    if (name === WALLET_BALANCE_TOOL.name) {
      if (!opts.funds) {
        return { content: [{ type: "text" as const, text: "no funds source configured" }], isError: true };
      }
      try {
        const atomic = await opts.funds.balance();
        const s = atomic.toString().padStart(7, "0");
        const usdce = `${s.slice(0, -6)}.${s.slice(-6)}`;
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                address: opts.signer.address,
                balanceAtomic: atomic.toString(),
                balanceUsdce: usdce,
                network: opts.network,
              }),
            },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `wallet_balance error: ${msg}` }], isError: true };
      }
    }

    // Local tool: read the wallet's spend limits + today's usage.
    if (name === WALLET_GET_LIMITS_TOOL.name) {
      return { content: [{ type: "text" as const, text: JSON.stringify(walletSpendStatus()) }] };
    }

    // Local tool: set the wallet's per-call / per-day spend caps.
    if (name === WALLET_SET_LIMIT_TOOL.name) {
      const a = (args ?? {}) as { maxPerCallAtomic?: unknown; maxPerDayAtomic?: unknown };
      const DIGITS = /^\d+$/;
      const next: { maxPerCallAtomic?: string; maxPerDayAtomic?: string } = {};
      for (const k of ["maxPerCallAtomic", "maxPerDayAtomic"] as const) {
        const v = a[k];
        if (v === undefined) continue;
        if (typeof v !== "string" || !DIGITS.test(v)) {
          return { content: [{ type: "text" as const, text: `${k} must be a decimal atomic-units string` }], isError: true };
        }
        next[k] = v;
      }
      if (next.maxPerCallAtomic === undefined && next.maxPerDayAtomic === undefined) {
        return { content: [{ type: "text" as const, text: "provide maxPerCallAtomic and/or maxPerDayAtomic" }], isError: true };
      }
      setWalletLimits(next);
      return { content: [{ type: "text" as const, text: JSON.stringify({ updated: true, ...walletSpendStatus() }) }] };
    }

    // Local tool: pay an external A2A agent (not an upstream MCP tool).
    if (name === PAY_A2A_TOOL.name) {
      try {
        return await payA2aAgent(
          {
            signer: opts.signer,
            network: opts.network,
            funds: opts.funds,
            rpcTimeoutMs: opts.a2aRpcTimeoutMs,
          },
          (args ?? {}) as unknown as PayA2aArgs,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error("pay_a2a_agent.failed", { err: msg });
        return { content: [{ type: "text" as const, text: `pay_a2a_agent error: ${msg}` }], isError: true };
      }
    }

    // Local tool: call an x402-protected HTTP endpoint (not an upstream MCP
    // tool). Auth headers + spend limits come from local policy; payment is
    // signed with the bridge's delegate wallet.
    if (name === X402_HTTP_TOOL.name) {
      try {
        return await x402HttpCall(
          {
            signer: opts.signer,
            network: opts.network,
            funds: opts.funds,
            rpcUrl: opts.rpcUrl,
          },
          (args ?? {}) as unknown as X402HttpArgs,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error("x402_http_call.failed", { err: msg });
        return { content: [{ type: "text" as const, text: `x402_http_call error: ${msg}` }], isError: true };
      }
    }

    // Local tool: discover curated x402 services (read-only, no payment).
    if (opts.discovery && name === HPP_DISCOVER_TOOL.name) {
      try {
        return await hppDiscover(opts.discovery, (args ?? {}) as unknown as DiscoverArgs);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error("hpp_discover.failed", { err: msg });
        return { content: [{ type: "text" as const, text: `hpp_discover error: ${msg}` }], isError: true };
      }
    }

    // Local tool: call a discovered service by id (payment via our wallet).
    if (opts.discovery && name === HPP_CALL_TOOL.name) {
      try {
        return await hppCall(
          { signer: opts.signer, network: opts.network, funds: opts.funds, rpcUrl: opts.rpcUrl },
          opts.discovery,
          (args ?? {}) as unknown as HppCallArgs,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error("hpp_call.failed", { err: msg });
        return { content: [{ type: "text" as const, text: `hpp_call error: ${msg}` }], isError: true };
      }
    }

    // Local tools: seller building blocks (charge others over x402).
    if (opts.seller && name.startsWith("seller_")) {
      const s = opts.seller;
      const a = (args ?? {}) as Record<string, unknown>;
      try {
        switch (name) {
          case SELLER_CREATE_REQUIREMENTS_TOOL.name:
            return sellerCreateRequirements(s, a);
          case SELLER_GENERATE_402_TOOL.name:
            return sellerGenerate402(a);
          case SELLER_DECODE_PAYMENT_TOOL.name:
            return sellerDecodePayment(a);
          case SELLER_VERIFY_TOOL.name:
            return await sellerVerify(s, a);
          case SELLER_SETTLE_TOOL.name:
            return await sellerSettle(s, a);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`${name}.failed`, { err: msg });
        return { content: [{ type: "text" as const, text: `${name} error: ${msg}` }], isError: true };
      }
    }

    // Beyond the local tools above, everything is an upstream resource-server
    // tool. In local-tools-only mode there's no upstream to forward to.
    if (!opts.upstream) {
      return {
        content: [{ type: "text" as const, text: `unknown tool: ${name} (no upstream resource server configured)` }],
        isError: true,
      };
    }
    const up = opts.upstream;

    const hostProgressToken = (
      extra._meta as { progressToken?: string | number } | undefined
    )?.progressToken;

    try {
      // x402MCPClient's typed callTool options omit `onprogress`, but at
      // runtime the underlying mcpClient.callTool receives the options
      // object unchanged — so onprogress IS honoured by the SDK. Cast
      // around the type gap; remove once @x402/mcp upstream broadens its
      // option type.
      const upstreamOptions: unknown = {
        timeout: 300_000,
        resetTimeoutOnProgress: true,
        onprogress:
          hostProgressToken !== undefined
            ? (p: { progress: number; total?: number; message?: string }) => {
                extra
                  .sendNotification({
                    method: "notifications/progress",
                    params: {
                      progressToken: hostProgressToken,
                      progress: p.progress,
                      total: p.total,
                      message: p.message,
                    },
                  })
                  .catch((err) => {
                    log.debug("progress.forwardFailed", {
                      err: (err as Error).message,
                    });
                  });
              }
            : undefined,
      };
      const result = await up.x402.callTool(
        name,
        (args ?? {}) as Record<string, unknown>,
        upstreamOptions as Parameters<typeof up.x402.callTool>[2],
      );

      const paymentMade =
        (result as { paymentMade?: boolean }).paymentMade ?? false;
      log.info("callTool.done", { name, paymentMade });

      // Strip bridge-internal fields (paymentMade, paymentResponse) before
      // returning to host — they're not part of the MCP CallToolResult shape.
      return {
        content: result.content,
        isError: result.isError,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("callTool.failed", { name, err: msg });
      return {
        content: [{ type: "text" as const, text: `bridge error: ${msg}` }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("bridge.ready");
}
