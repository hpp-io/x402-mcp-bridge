/**
 * Seller execution receipt (A2 Phase 2) — bind a settled x402 payment to the
 * capability that was invoked and the result that was returned.
 *
 * `seller_settle` only proves value transfer (a txHash). That proves money
 * moved; it does NOT prove *what* the money bought. This building block adds
 * the missing binding so a later identity / policy layer — or a dispute audit
 * — can verify the seller actually delivered the paid-for result, WITHOUT the
 * payment payload having to carry any trust decision itself:
 *
 *   x402 proves value transfer  →  receipt binds transfer to the action  →
 *   local policy decides whether that's enough to route future work.
 *
 * The receipt is deterministic: the same (requirements, request, result)
 * always hash to the same digests, so any party can recompute + verify it
 * offline. `settledAt` is metadata only — no digest depends on it — so a
 * wall-clock timestamp does not break reproducibility.
 *
 * This is a stateless building block, same as the other seller_* tools. The
 * agent's own server orchestrates: 402 → decode → verify → do the work →
 * settle → **receipt**.
 */
import { createHash } from "node:crypto";
import type { PaymentRequirements } from "@x402/core/types";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { log } from "./log.js";

export const RECEIPT_VERSION = "1" as const;

export interface ExecutionReceipt {
  /** Receipt schema version — bump on any field or hashing change. */
  version: typeof RECEIPT_VERSION;
  /** sha256(paymentRequirementsDigest || ":" || settlement.transaction). */
  receiptId: string;
  /** The seller's own service id, if it advertises one. */
  sellerServiceId: string | null;
  /** Buyer / payer address, when the caller can supply it. */
  payer: string | null;
  /** sha256 over the canonicalized PaymentRequirements the seller advertised. */
  paymentRequirementsDigest: string;
  settlement: {
    network: string;
    scheme: string;
    /** Facilitator settle `.transaction` (on-chain tx hash). */
    transaction: string;
    /** Settled amount, atomic units (from the advertised requirements). */
    amount: string;
    /** Token address the payment moved. */
    asset: string;
    /** ISO-8601 timestamp; metadata only, not part of any digest. */
    settledAt: string;
  };
  capability: {
    /** A2A skill id / MCP tool the buyer paid to invoke. */
    skillId: string;
    /** sha256 of the canonicalized request params (post-decode, pre-exec). */
    requestHash: string;
    /** sha256 of the canonicalized result payload — the key new binding. */
    resultHash: string;
  };
}

// ── deterministic hashing ──────────────────────────────────────────────────
/**
 * Canonical JSON: object keys sorted recursively so semantically-equal values
 * always serialize identically (a small RFC-8785-style stable stringify).
 * Arrays keep their order; primitives serialize as JSON. `undefined` object
 * properties are dropped, mirroring JSON.stringify.
 */
/** Max nesting depth — bounds recursion so pathological (deeply-nested or
 *  cyclic) input throws a controlled error instead of overflowing the stack. */
export const CANONICALIZE_MAX_DEPTH = 256;

export function canonicalize(value: unknown, depth = 0): string {
  if (depth > CANONICALIZE_MAX_DEPTH) {
    throw new Error(`canonicalize: max nesting depth (${CANONICALIZE_MAX_DEPTH}) exceeded`);
  }
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => canonicalize(v ?? null, depth + 1)).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(obj).sort()) {
    if (obj[key] === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${canonicalize(obj[key], depth + 1)}`);
  }
  return `{${parts.join(",")}}`;
}

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf-8").digest("hex");
}

export interface BuildReceiptInput {
  /** The PaymentRequirements the seller advertised in its 402. */
  requirements: PaymentRequirements;
  /** The tx hash returned by seller_settle (`.transaction`). */
  transaction: string;
  capability: { skillId: string; request: unknown; result: unknown };
  /** Buyer address, when known (e.g. from seller_decode_payment). */
  payer?: string | null;
  /** The seller's own service id, when it advertises one. */
  sellerServiceId?: string | null;
  /** ISO-8601 settlement time. Caller supplies it so the builder stays pure. */
  settledAt: string;
}

/**
 * Build a deterministic {@link ExecutionReceipt}. Pure: identical inputs
 * (including `settledAt`) always yield an identical object.
 */
export function buildExecutionReceipt(input: BuildReceiptInput): ExecutionReceipt {
  const { requirements: r } = input;
  const paymentRequirementsDigest = sha256(canonicalize(r as unknown));
  return {
    version: RECEIPT_VERSION,
    receiptId: sha256(`${paymentRequirementsDigest}:${input.transaction}`),
    sellerServiceId: input.sellerServiceId ?? null,
    payer: input.payer ?? null,
    paymentRequirementsDigest,
    settlement: {
      network: String(r.network),
      scheme: String(r.scheme),
      transaction: input.transaction,
      amount: String(r.amount),
      asset: String(r.asset),
      settledAt: input.settledAt,
    },
    capability: {
      skillId: input.capability.skillId,
      requestHash: sha256(canonicalize(input.capability.request ?? null)),
      resultHash: sha256(canonicalize(input.capability.result ?? null)),
    },
  };
}

// ── MCP tool ────────────────────────────────────────────────────────────────
function ok(obj: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(obj) }] };
}
function err(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

export const SELLER_RECEIPT_TOOL = {
  name: "seller_receipt",
  description:
    "Build a portable execution receipt AFTER a successful seller_settle, " +
    "binding the settled payment (tx + requirements) to the capability you " +
    "ran and the result you returned. Pass the PaymentRequirements you " +
    "advertised, the `transaction` from seller_settle, and the skill id + " +
    "request + result. Returns a deterministic { receipt } any party can " +
    "recompute and verify. Does NOT move funds — settle first.",
  inputSchema: {
    type: "object",
    properties: {
      paymentRequirements: { type: "object", description: "The requirements you advertised for this resource." },
      transaction: { type: "string", description: "The tx hash returned by seller_settle." },
      skillId: { type: "string", description: "The A2A skill / MCP tool the buyer paid to invoke." },
      request: { description: "The request params the buyer sent (any JSON)." },
      result: { description: "The result payload you returned to the buyer (any JSON)." },
      payer: { type: "string", description: "Buyer address, if known (e.g. from seller_decode_payment)." },
      sellerServiceId: { type: "string", description: "Your own service id, if you advertise one." },
      settledAt: { type: "string", description: "ISO-8601 settlement time; defaults to now." },
    },
    required: ["paymentRequirements", "transaction", "skillId"],
    additionalProperties: false,
  },
} as const;

export function sellerReceipt(a: Record<string, unknown>): CallToolResult {
  const requirements = a.paymentRequirements as PaymentRequirements | undefined;
  const transaction = a.transaction as string | undefined;
  const skillId = a.skillId as string | undefined;
  if (!requirements || !transaction || !skillId) {
    return err("paymentRequirements, transaction and skillId are required");
  }
  const settledAt =
    typeof a.settledAt === "string" && a.settledAt ? a.settledAt : new Date().toISOString();
  const receipt = buildExecutionReceipt({
    requirements,
    transaction,
    capability: { skillId, request: a.request ?? null, result: a.result ?? null },
    payer: (a.payer as string | undefined) ?? null,
    sellerServiceId: (a.sellerServiceId as string | undefined) ?? null,
    settledAt,
  });
  log.info("seller_receipt", { receiptId: receipt.receiptId, skillId, tx: transaction });
  return ok({ receipt });
}
