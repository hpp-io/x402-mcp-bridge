/**
 * Discovery-backed local tools: hpp_discover + hpp_call.
 *
 * The multi-service UX decision: instead of proxying every discovered
 * service's tools (which would explode the host's context),
 * expose two generic tools —
 *   - hpp_discover: list/search the curated directory (read-only, no payment)
 *   - hpp_call:     call one discovered service by id (payment via our wallet)
 *
 * hpp_call routes HTTP-typed resources through the same x402 HTTP payment path
 * as x402_http_call, but marks the call `trustedSource` so it skips the manual
 * host allowlist — curated discovery is the trust boundary — while keeping the
 * daily spend cap. MCP/A2A-typed resources return connection guidance.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { DiscoveryClient, DiscoverQuery } from "./discovery.js";
import { x402HttpCall, type HttpX402Deps } from "./httpX402.js";
import { payA2aAgent } from "./a2a.js";

export const HPP_DISCOVER_TOOL = {
  name: "hpp_discover",
  description:
    "Discover paid x402 services on the HPP chain from the curated discovery " +
    "directory. Returns services with their resourceId, description, price " +
    "(USDC.e atomic units), network and type. Pass `query` for a semantic " +
    "search (e.g. 'image generation'), or omit it to browse. Then invoke one " +
    "with hpp_call({ resourceId, body }).",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Optional free-text search over the directory.",
      },
      type: {
        type: "string",
        enum: ["http", "mcp", "a2a", "all"],
        description: "Filter by resource type (default all).",
      },
      network: {
        type: "string",
        description: "Filter by CAIP-2 network, e.g. eip155:190415.",
      },
      limit: { type: "number", description: "Max results (default 20, max 50)." },
    },
    additionalProperties: false,
  },
} as const;

export const HPP_CALL_TOOL = {
  name: "hpp_call",
  description:
    "Call a service found via hpp_discover. Pass its `resourceId` and a `body` " +
    "(the service's input args). Payment (USDC.e) is handled automatically with " +
    "your wallet, subject to the daily spend cap — you do not sign anything. " +
    "HTTP-typed services are called directly; MCP/A2A-typed services return " +
    "connection guidance.",
  inputSchema: {
    type: "object",
    properties: {
      resourceId: {
        type: "string",
        description: "Service id returned by hpp_discover.",
      },
      body: {
        type: "object",
        description: "Request body / input args for the service.",
      },
    },
    required: ["resourceId"],
    additionalProperties: false,
  },
} as const;

export interface DiscoverArgs {
  query?: string;
  type?: "http" | "mcp" | "a2a" | "all";
  network?: string;
  limit?: number;
}

export interface HppCallArgs {
  resourceId: string;
  body?: unknown;
}

function errorResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

export async function hppDiscover(
  client: DiscoveryClient,
  args: DiscoverArgs,
): Promise<CallToolResult> {
  const resources = await client.discover(args as DiscoverQuery);
  const services = resources.map((r) => ({
    resourceId: r.id,
    type: r.type,
    description: r.description ?? r.toolName ?? r.resourceUrl,
    priceAtomic: r.priceAtomic,
    asset: r.asset,
    network: r.network,
    scheme: r.scheme,
    ...(r.toolName ? { toolName: r.toolName } : {}),
  }));
  return {
    content: [
      { type: "text", text: JSON.stringify({ count: services.length, services }) },
    ],
  };
}

export async function hppCall(
  deps: HttpX402Deps,
  client: DiscoveryClient,
  args: HppCallArgs,
): Promise<CallToolResult> {
  if (!args.resourceId || typeof args.resourceId !== "string") {
    return errorResult("resourceId required");
  }

  let detail;
  try {
    detail = await client.detail(args.resourceId);
  } catch (err) {
    return errorResult(`discovery lookup failed: ${(err as Error).message}`);
  }

  // A2A-typed: drive the gate-then-pay A2A flow internally (same wallet +
  // spend cap as the HTTP path), so discover → call is one tool for A2A too.
  // The seller returns its result plus an execution receipt in
  // x402.payment.receipts, which payA2aAgent surfaces.
  if (detail.type === "a2a") {
    if (!detail.skillId) {
      return errorResult(`a2a resource "${args.resourceId}" has no skillId in discovery — cannot invoke`);
    }
    const message = typeof args.body === "string" ? args.body : JSON.stringify(args.body ?? {});
    return payA2aAgent(
      {
        signer: deps.signer,
        network: deps.network,
        funds: deps.funds,
        // Curated price is the ceiling: refuse if the agent's gate demands more
        // than discovery advertised (defends the "trusted price" of hpp_call).
        maxAmountAtomic: detail.priceAtomic,
      },
      { agentUrl: detail.resourceUrl, skill: detail.skillId, message },
    );
  }

  if (detail.type !== "http") {
    return errorResult(
      `resource "${args.resourceId}" is type "${detail.type}" — connect to it ` +
        `directly at ${detail.resourceUrl} (MCP transport).`,
    );
  }

  // Curated discovery is the trust boundary → skip the manual host allowlist
  // (trustedSource) but keep the spend cap. exact + upto are payable (upto needs
  // deps.rpcUrl); batch-settlement surfaces a clear "no payable accept" error.
  return x402HttpCall(
    { ...deps, trustedSource: true },
    {
      url: detail.resourceUrl,
      method: detail.httpMethod ?? "POST",
      body: args.body,
    },
  );
}
