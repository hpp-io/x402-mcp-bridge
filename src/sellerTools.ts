/**
 * Seller building-block tools (A2 Phase 1) — let an agent that already receives
 * requests (its own HTTP/A2A server) charge for them over x402.
 *
 * Stateless tools mirroring Polygon's seller set, but covering all three
 * HPP schemes (exact / upto / batch-settlement), not just exact:
 *   - seller_create_requirements  build a PaymentRequirements (local)
 *   - seller_generate_402         build the HTTP 402 body from accepts[] (local)
 *   - seller_decode_payment       decode the X-PAYMENT header + payer (local)
 *   - seller_verify               facilitator /verify   (does the buyer's sig hold?)
 *   - seller_settle               facilitator /settle   (move the funds on-chain)
 *   - seller_receipt              bind the settled tx to the delivered result (local)
 *
 * verify/settle are thin wrappers over the same HTTPFacilitatorClient the
 * resource server uses; the tools never hold funds or keys. The agent's own
 * server orchestrates: 402 → decode → verify → do the work → settle → receipt.
 */
import { HTTPFacilitatorClient } from "@x402/core/server";
import type { PaymentRequirements, PaymentPayload, Network } from "@x402/core/types";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { SELLER_RECEIPT_TOOL } from "./sellerReceipt.js";
import { log } from "./log.js";

export interface SellerDeps {
  /** Default network for create_requirements when the caller omits one. */
  network: Network;
  /** Facilitator base URL used by verify/settle. */
  facilitatorUrl: string;
}

// ── decode helper (mirrors resource-server lib/xpayment.ts) ─────────────
interface DecodedPayload {
  x402Version?: number;
  scheme?: string;
  payload?: {
    authorization?: { from?: string };
    channelConfig?: { payer?: string };
    permit2Authorization?: { from?: string };
  };
}

function decodeHeader(header: string): { payload: DecodedPayload; payer: string | null } | null {
  try {
    const json = Buffer.from(header, "base64").toString("utf-8");
    const parsed = JSON.parse(json) as DecodedPayload;
    if (!parsed || !parsed.payload) return null;
    const payer =
      parsed.payload.authorization?.from ??
      parsed.payload.channelConfig?.payer ??
      parsed.payload.permit2Authorization?.from ??
      null;
    return { payload: parsed, payer };
  } catch {
    return null;
  }
}

function ok(obj: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(obj) }] };
}
function err(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

// ── tool defs ───────────────────────────────────────────────────────────
export const SELLER_CREATE_REQUIREMENTS_TOOL = {
  name: "seller_create_requirements",
  description:
    "Build an x402 PaymentRequirements object for a resource you sell. Returns " +
    "the requirements to advertise in a 402 (see seller_generate_402). Scheme " +
    "defaults to 'exact'; use 'upto' or 'batch-settlement' with scheme-specific " +
    "fields in `extra`.",
  inputSchema: {
    type: "object",
    properties: {
      amount: { type: "string", description: "Price in atomic units (e.g. '10000' = 0.01 USDC.e)." },
      payTo: { type: "string", description: "Your wallet address (receives payment)." },
      asset: { type: "string", description: "Token address (USDC.e on HPP)." },
      network: { type: "string", description: "CAIP-2 network; defaults to the bridge network." },
      scheme: { type: "string", enum: ["exact", "upto", "batch-settlement"], description: "Payment scheme (default exact)." },
      maxTimeoutSeconds: { type: "number", description: "Payment validity window (default 600)." },
      extra: { type: "object", description: "Scheme-specific extras (EIP-712 domain, Permit2 proxy, channel info)." },
    },
    required: ["amount", "payTo", "asset"],
    additionalProperties: false,
  },
} as const;

export const SELLER_GENERATE_402_TOOL = {
  name: "seller_generate_402",
  description:
    "Build the HTTP 402 Payment Required response body from one or more " +
    "PaymentRequirements (from seller_create_requirements). Return this when a " +
    "request arrives with no payment header.",
  inputSchema: {
    type: "object",
    properties: {
      accepts: { type: "array", description: "PaymentRequirements[] the buyer may choose from.", items: { type: "object" } },
      resource: { type: "string", description: "The resource URL being protected." },
      error: { type: "string", description: "Optional human-readable reason." },
    },
    required: ["accepts"],
    additionalProperties: false,
  },
} as const;

export const SELLER_DECODE_PAYMENT_TOOL = {
  name: "seller_decode_payment",
  description:
    "Decode a buyer's base64 X-PAYMENT / Payment-Signature header locally (no " +
    "facilitator call) to inspect the payload and extract the payer address. " +
    "Supports exact / upto / batch-settlement.",
  inputSchema: {
    type: "object",
    properties: { paymentHeader: { type: "string", description: "The base64 X-PAYMENT header value." } },
    required: ["paymentHeader"],
    additionalProperties: false,
  },
} as const;

export const SELLER_VERIFY_TOOL = {
  name: "seller_verify",
  description:
    "Verify a buyer's payment against the facilitator BEFORE doing the work. " +
    "Pass the X-PAYMENT header + the PaymentRequirements you advertised. Returns " +
    "{ isValid, payer, invalidReason }.",
  inputSchema: {
    type: "object",
    properties: {
      paymentHeader: { type: "string", description: "The base64 X-PAYMENT header." },
      paymentRequirements: { type: "object", description: "The requirements you advertised for this resource." },
    },
    required: ["paymentHeader", "paymentRequirements"],
    additionalProperties: false,
  },
} as const;

export const SELLER_SETTLE_TOOL = {
  name: "seller_settle",
  description:
    "Settle a verified payment on-chain AFTER the work succeeded (serve-then-" +
    "settle). Pass the same X-PAYMENT header + PaymentRequirements. Returns " +
    "{ success, transaction }.",
  inputSchema: {
    type: "object",
    properties: {
      paymentHeader: { type: "string", description: "The base64 X-PAYMENT header." },
      paymentRequirements: { type: "object", description: "The requirements you advertised for this resource." },
    },
    required: ["paymentHeader", "paymentRequirements"],
    additionalProperties: false,
  },
} as const;

export const SELLER_TOOLS = [
  SELLER_CREATE_REQUIREMENTS_TOOL,
  SELLER_GENERATE_402_TOOL,
  SELLER_DECODE_PAYMENT_TOOL,
  SELLER_VERIFY_TOOL,
  SELLER_SETTLE_TOOL,
  SELLER_RECEIPT_TOOL,
] as const;

// ── handlers ──────────────────────────────────────────────────────────────
export function sellerCreateRequirements(deps: SellerDeps, a: Record<string, unknown>): CallToolResult {
  if (!a.amount || !a.payTo || !a.asset) return err("amount, payTo, asset are required");
  const req: PaymentRequirements = {
    scheme: (a.scheme as string) ?? "exact",
    network: ((a.network as string) ?? deps.network) as Network,
    asset: a.asset as string,
    amount: String(a.amount),
    payTo: a.payTo as string,
    maxTimeoutSeconds: (a.maxTimeoutSeconds as number) ?? 600,
    extra: (a.extra as Record<string, unknown>) ?? {},
  };
  return ok({ requirements: req });
}

export function sellerGenerate402(a: Record<string, unknown>): CallToolResult {
  const accepts = a.accepts;
  if (!Array.isArray(accepts) || accepts.length === 0) return err("accepts[] required");
  const body = {
    x402Version: 2,
    error: (a.error as string) ?? "payment required",
    ...(a.resource ? { resource: a.resource } : {}),
    accepts,
  };
  return ok({
    response: { statusCode: 402, headers: { "Content-Type": "application/json" }, body },
  });
}

export function sellerDecodePayment(a: Record<string, unknown>): CallToolResult {
  const header = a.paymentHeader as string;
  if (!header || typeof header !== "string") return err("paymentHeader required");
  const decoded = decodeHeader(header);
  if (!decoded) return err("could not decode payment header (base64 JSON expected)");
  return ok({ scheme: decoded.payload.scheme, payer: decoded.payer, payload: decoded.payload });
}

export async function sellerVerify(deps: SellerDeps, a: Record<string, unknown>): Promise<CallToolResult> {
  const header = a.paymentHeader as string;
  const requirements = a.paymentRequirements as PaymentRequirements | undefined;
  if (!header || !requirements) return err("paymentHeader and paymentRequirements required");
  const decoded = decodeHeader(header);
  if (!decoded) return err("could not decode payment header");
  try {
    const client = new HTTPFacilitatorClient({ url: deps.facilitatorUrl });
    const res = await client.verify(decoded.payload as unknown as PaymentPayload, requirements);
    log.info("seller_verify", { isValid: res.isValid, payer: res.payer });
    return ok({ isValid: res.isValid, payer: res.payer, invalidReason: res.invalidReason });
  } catch (e) {
    return err(`verify failed: ${(e as Error).message}`);
  }
}

export async function sellerSettle(deps: SellerDeps, a: Record<string, unknown>): Promise<CallToolResult> {
  const header = a.paymentHeader as string;
  const requirements = a.paymentRequirements as PaymentRequirements | undefined;
  if (!header || !requirements) return err("paymentHeader and paymentRequirements required");
  const decoded = decodeHeader(header);
  if (!decoded) return err("could not decode payment header");
  try {
    const client = new HTTPFacilitatorClient({ url: deps.facilitatorUrl });
    const res = await client.settle(decoded.payload as unknown as PaymentPayload, requirements);
    log.info("seller_settle", { success: res.success, tx: (res as { transaction?: string }).transaction });
    return ok({ success: res.success, transaction: (res as { transaction?: string }).transaction });
  } catch (e) {
    return err(`settle failed: ${(e as Error).message}`);
  }
}
