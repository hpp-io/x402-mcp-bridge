/**
 * A2A (Agent2Agent) seller mount for `hpp-x402 serve --a2a`.
 *
 * The HTTP `serve` path uses @x402/express `paymentMiddleware` (serve-then-
 * settle, payment in the X-PAYMENT header). A2A is different: the payment
 * travels inside the JSON-RPC message *metadata* (the a2a-x402 extension), so
 * the middleware can't gate it and — because middleware settles AFTER the
 * handler — it couldn't emit a receipt anyway. This module hand-rolls the
 * gate-then-pay flow (symmetric with the bridge's buyer `src/a2a.ts`, which
 * also speaks A2A JSON-RPC without @a2a-js/sdk):
 *
 *   message/send (skillId)                    → Task input-required + x402.payment.required
 *   message/send (+ x402.payment.payload)     → verify → work → settle → completed
 *                                               + artifacts + x402.payment.receipts
 *
 * Serve-then-settle + fund safety: settle ONLY after the work succeeds. The
 * receipts array carries BOTH the raw facilitator settle response (value moved)
 * and our ExecutionReceipt (what the payment bought — request/result binding),
 * so a buyer can independently verify delivery.
 */
import type { Express, Request, Response } from "express";
import type { Network } from "@x402/core/types";

import { buildExecutionReceipt, canonicalize } from "./sellerReceipt.js";
import { log } from "./log.js";

// a2a-x402 extension metadata keys (mirror src/a2a.ts + the a2a-x402 spec).
const REQUIRED_KEY = "x402.payment.required";
const PAYLOAD_KEY = "x402.payment.payload";
const STATUS_KEY = "x402.payment.status";
const RECEIPTS_KEY = "x402.payment.receipts";
const ERROR_KEY = "x402.payment.error";
const X402_EXTENSION_URI = "https://github.com/google-a2a/a2a-x402/v0.1";

// a2a-x402 payment-status wire strings (spec v0.2).
const PAYMENT_STATUS = {
  REQUIRED: "payment-required",
  REJECTED: "payment-rejected",
  COMPLETED: "payment-completed",
  FAILED: "payment-failed",
} as const;

/** Minimal facilitator surface we depend on (HTTPFacilitatorClient shape). */
export interface A2aFacilitator {
  verify(payload: unknown, requirements: unknown): Promise<{ isValid: boolean; payer?: string; invalidReason?: string }>;
  settle(payload: unknown, requirements: unknown): Promise<{ success: boolean; transaction?: string; network?: string; payer?: string; errorReason?: string }>;
}

export interface A2aServeOptions {
  /** Pre-built PaymentRequirements the buyer signs against (accepts[0]). */
  requirements: Record<string, unknown>;
  /** Full accepts array advertised in the 402-equivalent (usually [requirements]). */
  accepts: Record<string, unknown>[];
  facilitator: A2aFacilitator;
  skill: string;
  description: string;
  /** Public base URL (no trailing slash) for the AgentCard + resource identity. */
  publicBaseUrl: string;
  priceAtomic: string;
  network: Network;
  /** Optional webhook that does the actual work; echo when omitted. */
  handlerUrl?: string;
  agentName?: string;
}

let msgSeq = 0;
const newId = (p: string): string => `${p}-${Date.now().toString(36)}-${++msgSeq}`;

function textOf(message: unknown): string {
  const parts = (message as { parts?: Array<{ kind?: string; text?: string }> } | undefined)?.parts ?? [];
  for (const p of parts) if (p.kind === "text" && typeof p.text === "string") return p.text;
  return "";
}

function tryParseObject(s: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Normalize a buyer message into the request args the seller acts on AND
 * hashes into the receipt. Deterministic so the buyer can recompute the same
 * `requestHash`: metadata.input wins, else parsed JSON text, else {prompt:text}.
 */
export function requestArgsOf(message: unknown): Record<string, unknown> {
  const meta = (message as { metadata?: Record<string, unknown> } | undefined)?.metadata;
  const input = meta?.input as Record<string, unknown> | undefined;
  if (input && typeof input === "object") return input;
  const text = textOf(message);
  return tryParseObject(text) ?? (text ? { prompt: text } : {});
}

/** Build a minimal, x402-extension-declaring A2A AgentCard (hand-rolled). */
export function buildAgentCard(opts: A2aServeOptions): Record<string, unknown> {
  return {
    name: opts.agentName ?? "HPP x402 Agent",
    description: opts.description,
    url: `${opts.publicBaseUrl}/a2a`,
    version: "1.0.0",
    defaultInputModes: ["text", "text/plain"],
    defaultOutputModes: ["text", "text/plain"],
    capabilities: {
      streaming: false,
      extensions: [
        { uri: X402_EXTENSION_URI, description: "Supports payments using the x402 protocol.", required: true },
      ],
    },
    skills: [
      {
        id: opts.skill,
        name: opts.skill,
        description: opts.description,
        tags: ["x402", "hpp"],
        examples: [`Pay ${opts.priceAtomic} atomic USDC.e per call to ${opts.skill}`],
      },
    ],
  };
}

// ── Task builders (mirror the PoC executor's shapes; x402 keys live BOTH on
//    status.message.metadata (spec) AND task-level metadata (our readers)). ──
function statusMessage(taskId: string, text: string, metadata: Record<string, unknown>) {
  return {
    kind: "message",
    messageId: newId("msg"),
    role: "agent",
    taskId,
    parts: [{ kind: "text", text }],
    metadata,
  };
}

function inputRequiredTask(accepts: Record<string, unknown>[]): Record<string, unknown> {
  const taskId = newId("task");
  const meta = {
    [STATUS_KEY]: PAYMENT_STATUS.REQUIRED,
    [REQUIRED_KEY]: { x402Version: 2, accepts },
  };
  return {
    kind: "task",
    id: taskId,
    status: { state: "input-required", message: statusMessage(taskId, "Payment required.", meta) },
    metadata: meta,
  };
}

function failedTask(
  text: string,
  reason: string,
  status: string = PAYMENT_STATUS.REJECTED,
): Record<string, unknown> {
  const taskId = newId("task");
  const meta = { [STATUS_KEY]: status, [ERROR_KEY]: reason };
  return {
    kind: "task",
    id: taskId,
    status: { state: "failed", message: statusMessage(taskId, text, meta) },
    metadata: meta,
  };
}

function completedTask(
  skill: string,
  result: unknown,
  settleReceipt: unknown,
  executionReceipt: unknown,
): Record<string, unknown> {
  const taskId = newId("task");
  const meta = {
    [STATUS_KEY]: PAYMENT_STATUS.COMPLETED,
    [RECEIPTS_KEY]: [settleReceipt, executionReceipt],
  };
  return {
    kind: "task",
    id: taskId,
    status: { state: "completed", message: statusMessage(taskId, "Payment completed.", meta) },
    artifacts: [
      { artifactId: newId("art"), name: skill, parts: [{ kind: "text", text: JSON.stringify(result) }] },
    ],
    metadata: meta,
  };
}

async function doWork(opts: A2aServeOptions, args: Record<string, unknown>): Promise<unknown> {
  if (!opts.handlerUrl) return { ok: true, echo: args, served: "hpp-x402-a2a" };
  const r = await fetch(opts.handlerUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  const text = await r.text();
  try {
    return JSON.parse(text);
  } catch {
    return { output: text };
  }
}

/** Handle one A2A `message/send` (stateless: paid iff a payload is present). */
export async function handleMessageSend(
  opts: A2aServeOptions,
  message: unknown,
): Promise<Record<string, unknown>> {
  const meta = (message as { metadata?: Record<string, unknown> } | undefined)?.metadata ?? {};
  const payload = meta[PAYLOAD_KEY];

  // Gate: no payment → 402-equivalent input-required with the accepts list.
  if (!payload) return inputRequiredTask(opts.accepts);

  const requirements = opts.requirements;

  // Verify BEFORE doing any work.
  const v = await opts.facilitator.verify(payload, requirements);
  if (!v.isValid) return failedTask(`Payment rejected: ${v.invalidReason ?? "invalid payment"}`, v.invalidReason ?? "verify_failed");
  const payer =
    v.payer ??
    ((payload as { payload?: { authorization?: { from?: string } } }).payload?.authorization?.from);

  // Reject pathological (deeply-nested) input BEFORE doing work or settling,
  // so an attacker can't force the receipt hashing to blow the stack after we
  // already spent handler compute + a settle. canonicalize is depth-bounded.
  const args = requestArgsOf(message);
  try {
    canonicalize(args);
  } catch {
    return failedTask("Invalid request payload.", "invalid_input");
  }

  // Do the work (payment verified, NOT yet settled).
  const result = await doWork(opts, args);

  // Settle AFTER success (serve-then-settle).
  let settleReceipt: { success: boolean; transaction?: string; errorReason?: string };
  try {
    settleReceipt = await opts.facilitator.settle(payload, requirements);
  } catch (err) {
    log.error("a2a.settle.error", { err: err instanceof Error ? err.message : String(err) });
    settleReceipt = { success: false };
  }

  // Fund safety: deliver the paid result ONLY if settlement actually
  // succeeded. Returning the artifact on a failed settle = free work
  // (verify passing does not guarantee settle). Withhold + fail instead;
  // don't mint a receipt binding a non-existent tx.
  if (settleReceipt.success !== true) {
    return failedTask("Payment settlement failed.", "settle_failed", PAYMENT_STATUS.FAILED);
  }

  const executionReceipt = buildExecutionReceipt({
    requirements: requirements as never,
    transaction: String(settleReceipt.transaction ?? ""),
    capability: { skillId: opts.skill, request: args, result },
    payer: payer ?? null,
    sellerServiceId: opts.skill,
    settledAt: new Date().toISOString(),
  });

  return completedTask(opts.skill, result, settleReceipt, executionReceipt);
}

/** Mount `/a2a` (JSON-RPC) + AgentCard routes onto an Express app. */
export function mountA2aSeller(app: Express, opts: A2aServeOptions): void {
  const card = buildAgentCard(opts);
  app.get("/.well-known/agent-card.json", (_req: Request, res: Response) => res.json(card));
  app.get("/a2a/.well-known/agent-card.json", (_req: Request, res: Response) => res.json(card));

  app.post("/a2a", async (req: Request, res: Response) => {
    const { id, method, params } = (req.body ?? {}) as { id?: unknown; method?: string; params?: { message?: unknown } };
    res.setHeader("X-A2A-Extensions", X402_EXTENSION_URI);
    if (method !== "message/send") {
      res.json({ jsonrpc: "2.0", id: id ?? null, error: { code: -32601, message: `method not supported: ${method}` } });
      return;
    }
    try {
      const result = await handleMessageSend(opts, params?.message);
      res.json({ jsonrpc: "2.0", id: id ?? null, result });
    } catch (err) {
      // Log the detail server-side; return a generic message so operator
      // internals (handler / facilitator URLs, stack detail) don't leak.
      log.error("a2a.request.error", { err: err instanceof Error ? err.message : String(err) });
      res.json({ jsonrpc: "2.0", id: id ?? null, error: { code: -32000, message: "internal error" } });
    }
  });
}
