/**
 * Discovery-backed local tools: hpp_discover + hpp_describe + hpp_call.
 *
 * The multi-service UX decision: instead of proxying every discovered
 * service's tools (which would explode the host's context),
 * expose three generic tools —
 *   - hpp_discover: list/search the curated directory (read-only, no payment)
 *   - hpp_describe: one service's input schema + example (read-only, no payment)
 *   - hpp_call:     call one discovered service by id (payment via our wallet)
 *
 * hpp_describe exists because discovery already stores what a service expects
 * (`metadata.info.input` + `metadata.schema`, mirrored from the seller's x402
 * bazaar extension) but nothing used to show it to the agent. Guessing the body
 * is not a free retry — the payment settles before the seller validates, so a
 * wrong guess costs real USDC.e and returns an error.
 *
 * hpp_call routes HTTP-typed resources through the same x402 HTTP payment path
 * as x402_http_call, and mcp-typed ones through a one-shot paid MCP session
 * (./mcpCall.ts). Both mark the call `trustedSource` so it skips the manual
 * host allowlist — curated discovery is the trust boundary — while keeping the
 * daily spend cap.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type {
  DiscoveryClient,
  DiscoverQuery,
  DiscoveredResource,
  DiscoveredResourceDetail,
} from "./discovery.js";
import { x402HttpCall, type HttpX402Deps } from "./httpX402.js";
import { payMcpTool } from "./mcpCall.js";
import { payA2aAgent } from "./a2a.js";

export const HPP_DISCOVER_TOOL = {
  name: "hpp_discover",
  description:
    "Discover paid x402 services on the HPP chain from the curated discovery " +
    "directory. Returns services with their resourceId, name, description, price " +
    "(USDC.e atomic units), network, type and trust signals (how many times the " +
    "service has actually been paid). Pass `query` for a semantic search " +
    "(e.g. 'image generation'), or omit it to browse. Results are limited to the " +
    "network this wallet can pay on unless you pass `network` explicitly " +
    "(use \"all\" to see every network). Then call hpp_describe({ resourceId }) " +
    "to learn the input arguments, and hpp_call({ resourceId, body }) to run it.",
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
        description:
          'CAIP-2 network, e.g. eip155:190415. Defaults to this wallet\'s network; "all" removes the filter.',
      },
      limit: { type: "number", description: "Max results (default 20, max 50)." },
    },
    additionalProperties: false,
  },
} as const;

export const HPP_DESCRIBE_TOOL = {
  name: "hpp_describe",
  description:
    "Describe one service found via hpp_discover: its input arguments (JSON " +
    "Schema plus a concrete example body), output example, price, network and " +
    "endpoint. Read-only — no payment. Call this before hpp_call when you are " +
    "not certain what the service expects: hpp_call pays first and the seller " +
    "validates after, so a wrong body costs a real payment.",
  inputSchema: {
    type: "object",
    properties: {
      resourceId: {
        type: "string",
        description: "Service id returned by hpp_discover.",
      },
    },
    required: ["resourceId"],
    additionalProperties: false,
  },
} as const;

export const HPP_CALL_TOOL = {
  name: "hpp_call",
  description:
    "Call a service found via hpp_discover. Pass its `resourceId` and a `body` " +
    "(the service's input args — check hpp_describe first if unsure). Payment " +
    "(USDC.e) is handled automatically with your wallet, subject to the daily " +
    "spend cap — you do not sign anything. HTTP, MCP and A2A typed services are " +
    "all invoked directly; the price advertised by discovery is enforced as a " +
    "ceiling.",
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

export interface DescribeArgs {
  resourceId: string;
}

export interface HppCallArgs {
  resourceId: string;
  body?: unknown;
}

function errorResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function jsonResult(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

/** Compact per-service view for the directory listing. */
function summarize(r: DiscoveredResource) {
  const t = r.trustSignals;
  return {
    resourceId: r.id,
    type: r.type,
    name: r.serviceName ?? undefined,
    description: r.description ?? r.toolName ?? r.resourceUrl,
    priceAtomic: r.priceAtomic,
    asset: r.asset,
    network: r.network,
    scheme: r.scheme,
    ...(r.tags?.length ? { tags: r.tags } : {}),
    ...(r.verified !== undefined ? { verified: r.verified } : {}),
    ...(t?.settlementCount !== undefined
      ? {
          trust: {
            settlementCount: t.settlementCount,
            uniquePayers: t.uniquePayers,
            lastSettlementAt: t.lastSettlementAt ?? null,
          },
        }
      : {}),
    ...(r.toolName ? { toolName: r.toolName } : {}),
  };
}

/**
 * Pull the request-body schema out of a bazaar `schema` block.
 *
 * The seller's schema describes the *bazaar info envelope*
 * (`{input: {type, method, bodyType, body}}`), not the request body — so
 * handing it to an agent as-is invites it to POST the envelope. The genuinely
 * useful constraints (e.g. "address or addresses required") sit at
 * `properties.input.properties.body`; extract that and label it for what it is.
 */
function bodySchemaFrom(schema: unknown): unknown | null {
  const body = (
    schema as {
      properties?: { input?: { properties?: { body?: unknown } } };
    } | null
  )?.properties?.input?.properties?.body;
  if (body == null || typeof body !== "object") return null;
  // A bare `{type: "object"}` placeholder says nothing the example doesn't.
  const keys = Object.keys(body as object);
  if (keys.length === 0 || (keys.length === 1 && keys[0] === "type")) return null;
  return body;
}

/**
 * The seller-declared input contract, if any. Kept in one place because both
 * hpp_describe (up front) and hpp_call (on failure) need to show it.
 */
function inputContract(detail: DiscoveredResourceDetail) {
  const input = detail.metadata?.info?.input;
  const hasExample = input?.body != null && Object.keys(input.body as object).length > 0;
  const bodySchema = bodySchemaFrom(detail.metadata?.schema);
  if (!hasExample && !bodySchema) return null;
  return {
    // Both fields describe the SAME thing — what goes in `body` — so an agent
    // never has to guess which level of nesting is meant.
    ...(hasExample ? { exampleBody: input!.body } : {}),
    ...(bodySchema ? { bodySchema } : {}),
  };
}

export async function hppDiscover(
  client: DiscoveryClient,
  args: DiscoverArgs,
  /**
   * Network this bridge can actually settle on. Used as the default filter so
   * the directory doesn't hand the agent services it provably cannot pay for
   * (the call would fail with "no payable accept" after a wasted round-trip).
   */
  defaultNetwork?: string,
): Promise<CallToolResult> {
  const query: DiscoverQuery = {
    ...(args as DiscoverQuery),
    network: args.network ?? defaultNetwork,
  };
  const resources = await client.discover(query);
  const services = resources.map(summarize);
  return jsonResult({
    count: services.length,
    ...(query.network && query.network !== "all" ? { network: query.network } : {}),
    services,
    ...(services.length
      ? { next: "hpp_describe({ resourceId }) for input args, then hpp_call({ resourceId, body })" }
      : {}),
  });
}

export async function hppDescribe(
  client: DiscoveryClient,
  args: DescribeArgs,
): Promise<CallToolResult> {
  if (!args.resourceId || typeof args.resourceId !== "string") {
    return errorResult("resourceId required");
  }
  let detail: DiscoveredResourceDetail;
  try {
    detail = await client.detail(args.resourceId);
  } catch (err) {
    return errorResult(`discovery lookup failed: ${(err as Error).message}`);
  }

  const contract = inputContract(detail);
  return jsonResult({
    ...summarize(detail),
    endpoint: detail.resourceUrl,
    ...(detail.type === "http" ? { httpMethod: detail.httpMethod ?? "POST" } : {}),
    ...(detail.type === "mcp"
      ? {
          transport: detail.transport ?? "streamable-http",
          mcpServerUrl: detail.mcpServerUrl ?? detail.resourceUrl,
        }
      : {}),
    ...(detail.type === "a2a" && detail.skillId ? { skillId: detail.skillId } : {}),
    // `input` always describes the request body itself (not the bazaar
    // envelope), so `exampleBody` can be sent to hpp_call verbatim.
    input: contract ?? "not declared by the seller — send what the description implies",
    ...(detail.metadata?.info?.output ? { output: detail.metadata.info.output } : {}),
  });
}

export async function hppCall(
  deps: HttpX402Deps,
  client: DiscoveryClient,
  args: HppCallArgs,
): Promise<CallToolResult> {
  if (!args.resourceId || typeof args.resourceId !== "string") {
    return errorResult("resourceId required");
  }

  let detail: DiscoveredResourceDetail;
  try {
    detail = await client.detail(args.resourceId);
  } catch (err) {
    return errorResult(`discovery lookup failed: ${(err as Error).message}`);
  }

  // The listing states which chain the seller prices on, so a mismatch is known
  // before we open a connection — worth catching here rather than after a
  // round-trip, and the message names the fix (hpp_discover already defaults to
  // this wallet's network, so this is mostly a hand-passed resourceId).
  if (detail.network && detail.network !== deps.network) {
    return errorResult(
      `service "${args.resourceId}" is priced on ${detail.network} but this wallet ` +
        `settles on ${deps.network} — switch network or pick a ${deps.network} service`,
    );
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

  // mcp-typed: one-shot paid MCP session against the listed tool. Same wallet,
  // same caps, same advertised-price ceiling as the other two transports.
  if (detail.type === "mcp") {
    if (!detail.toolName) {
      return errorResult(
        `mcp resource "${args.resourceId}" has no toolName in discovery — cannot invoke`,
      );
    }
    const result = await payMcpTool(
      {
        signer: deps.signer,
        network: deps.network,
        funds: deps.funds,
        rpcUrl: deps.rpcUrl,
        preferScheme: deps.preferScheme,
        maxAmountAtomic: detail.priceAtomic,
      },
      {
        // Connect to the endpoint, not the payment identity. Older listings did
        // not distinguish them, so `resourceUrl` is the fallback — deriving the
        // root by trimming `/tools/<name>` would be guessing at a convention
        // that already changed once.
        serverUrl: detail.mcpServerUrl ?? detail.resourceUrl,
        toolName: detail.toolName,
        toolArgs: (args.body ?? {}) as Record<string, unknown>,
        transport: detail.transport,
      },
    );
    return withInputHintOnError(result, detail);
  }

  if (detail.type !== "http") {
    return errorResult(
      `resource "${args.resourceId}" is type "${detail.type}" — not invokable; ` +
        `endpoint is ${detail.resourceUrl}`,
    );
  }

  // Curated discovery is the trust boundary → skip the manual host allowlist
  // (trustedSource) but keep the spend cap. exact + upto are payable (upto needs
  // deps.rpcUrl); batch-settlement surfaces a clear "no payable accept" error.
  const result = await x402HttpCall(
    { ...deps, trustedSource: true },
    {
      url: detail.resourceUrl,
      method: detail.httpMethod ?? "POST",
      body: args.body,
    },
  );
  return withInputHintOnError(result, detail);
}

/**
 * On failure, append the seller's declared input contract. The agent's most
 * likely mistake is a wrong body shape, and it cannot see the contract from the
 * call result alone — without this it retries blind, paying each time.
 */
function withInputHintOnError(
  result: CallToolResult,
  detail: DiscoveredResourceDetail,
): CallToolResult {
  if (!result.isError) return result;
  const contract = inputContract(detail);
  if (!contract) return result;
  return {
    ...result,
    content: [
      ...result.content,
      {
        type: "text" as const,
        text: JSON.stringify({
          hint: "the service declares this input contract — check `body` against it before retrying",
          ...contract,
        }),
      },
    ],
  };
}
