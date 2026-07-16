/**
 * Agent2Agent (A2A) buyer tool for the bridge.
 *
 * The bridge's host (Claude Desktop / OpenClaw) speaks MCP, not A2A. This
 * tool lets the host pay an *external A2A agent*: the operator passes the
 * agent's `/a2a` endpoint URL + skill id (no AgentCard discovery — that
 * is post-MVP, see TODO below), the bridge drives the `message/send`
 * gate-then-pay flow, and signs the x402 `exact` payment with the
 * bridge's existing delegate EOA — the same signer + AllowanceModule
 * spend-cap that gate the MCP/HTTP path.
 *
 * The payment travels inside A2A message metadata (the a2a-x402 extension),
 * not an HTTP header — but the signed payload is produced by the same
 * @x402/core client + @x402/evm exact scheme used everywhere else.
 *
 * TODO (post-MVP): GET `/.well-known/agent-card.json`, validate `skill`
 * against the published skill list, surface card metadata in errors.
 */
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import type { Network } from "@x402/core/types";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { Funds } from "./funds.js";
import type { RawEoaSigner } from "./signers/raw-eoa.js";
import { checkWalletSpend, recordWalletSpend } from "./spendGuard.js";
import { log } from "./log.js";

export interface A2aPayerDeps {
  signer: RawEoaSigner;
  network: Network;
  /** Optional: ensure the delegate holds enough USDC.e before paying. */
  funds?: Funds;
  /**
   * Optional atomic-units price ceiling. When set (e.g. the discovery-listed
   * price on the hpp_call path), refuse to sign if the agent's gate demands
   * MORE than this — stops a bait-and-switch where a service advertises a
   * cheap price but gates a large `accept.amount` at call time.
   */
  maxAmountAtomic?: string;
  /**
   * Per-request timeout for the gate + paid `message/send` JSON-RPC calls.
   * Defaults to {@link DEFAULT_A2A_RPC_TIMEOUT_MS} (60s). Override via env
   * `HPP_X402_A2A_RPC_TIMEOUT_MS` at startup.
   */
  rpcTimeoutMs?: number;
}

/**
 * Pick the single `accept` entry the bridge will actually pay against:
 * scheme === "exact" AND network === `deps.network`. The server may
 * advertise multiple schemes (batch-settlement first, exact second is
 * the noosphere-x402-server default); the SDK's
 * `createPaymentPayload(required)` would internally re-select based on
 * registered schemes — but our spend-cap topup happens *before* that
 * call, so they must operate on the *same* accept or `accept.amount`
 * (topup) and the signed amount can diverge silently. We narrow to one
 * accept here and pass it to both the topup gate AND the SDK, so the
 * choice is auditable + consistent.
 */
export function pickExactAccept(
  required: { accepts?: ReadonlyArray<Record<string, unknown>> },
  network: Network,
): Record<string, unknown> | null {
  const accepts = required.accepts ?? [];
  for (const a of accepts) {
    if (a.scheme === "exact" && a.network === network) return a;
  }
  return null;
}

export const PAY_A2A_TOOL = {
  name: "pay_a2a_agent",
  description:
    "Pay an external Agent2Agent (A2A) agent for one of its skills using x402 " +
    "(exact scheme, USDC.e) and return the result. The operator supplies the " +
    "agent's A2A endpoint URL (e.g. http://host:4021/a2a) and the skill id " +
    "directly — this MVP does not yet fetch the AgentCard. The bridge gates " +
    "(unpaid message/send), signs the x402 payment with its delegate wallet " +
    "(subject to the daily spend cap), and re-sends with the payment in A2A " +
    "metadata, returning the agent's output on success.",
  inputSchema: {
    type: "object",
    properties: {
      agentUrl: {
        type: "string",
        description: "The A2A agent's JSON-RPC endpoint URL (e.g. http://host:4021/a2a)",
      },
      skill: {
        type: "string",
        description: "The skill id to invoke. Operator-supplied — this MVP does not auto-discover the AgentCard.",
      },
      message: {
        type: "string",
        description: "Text input / prompt for the skill",
      },
    },
    required: ["agentUrl", "skill", "message"],
    additionalProperties: false,
  },
} as const;

const REQUIRED_KEY = "x402.payment.required";
const PAYLOAD_KEY = "x402.payment.payload";
const STATUS_KEY = "x402.payment.status";
const RECEIPTS_KEY = "x402.payment.receipts";

/**
 * Per-request timeout for A2A JSON-RPC calls. Without this the bridge's
 * tool call hangs as long as the external agent does — the MCP host's
 * own timeout (~5min) is the only fallback, and it surfaces a generic
 * error that doesn't identify A2A as the slow leg. 60s covers any
 * realistic gate / paid-message-send wallclock for synchronous A2A
 * skills; long-running compute is meant to use the agent's own pending /
 * polling protocol, not a single message/send.
 */
export const DEFAULT_A2A_RPC_TIMEOUT_MS = 60_000;

let rpcId = 0;

async function a2aRpc(
  url: string,
  method: string,
  params: unknown,
  timeoutMs: number,
): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new Error(
        `A2A ${method} timed out after ${Math.round(timeoutMs / 1000)}s (${url})`,
      );
    }
    throw err;
  }
  const json = (await res.json()) as { result?: any; error?: unknown };
  if (json.error) {
    throw new Error(`A2A JSON-RPC error: ${JSON.stringify(json.error)}`);
  }
  return json.result;
}

function userMessage(text: string, metadata: Record<string, unknown>) {
  return {
    message: {
      kind: "message",
      messageId: `bridge-a2a-${++rpcId}`,
      role: "user",
      parts: [{ kind: "text", text }],
      metadata,
    },
  };
}

export interface PayA2aArgs {
  agentUrl: string;
  skill: string;
  message: string;
}

function errorResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

export async function payA2aAgent(
  deps: A2aPayerDeps,
  args: PayA2aArgs,
): Promise<CallToolResult> {
  const a2aUrl = args.agentUrl.replace(/\/+$/, "");
  const timeoutMs = deps.rpcTimeoutMs ?? DEFAULT_A2A_RPC_TIMEOUT_MS;

  // 1. Gate: send the request unpaid → expect input-required + requirements.
  let gate: any;
  try {
    gate = await a2aRpc(
      a2aUrl,
      "message/send",
      userMessage(args.message, { skillId: args.skill }),
      timeoutMs,
    );
  } catch (err) {
    return errorResult(`A2A gate request failed: ${(err as Error).message}`);
  }

  const state = gate?.status?.state;
  // Free agent (no payment needed) — return the result as-is.
  if (state === "completed") {
    return { content: [{ type: "text", text: JSON.stringify(extractResult(gate)) }] };
  }
  if (state !== "input-required") {
    return errorResult(`unexpected A2A task state "${state}" (expected input-required)`);
  }
  const required = gate.metadata?.[REQUIRED_KEY];
  if (!required?.accepts?.length) {
    return errorResult("A2A agent did not return x402 payment requirements");
  }
  // Narrow to the (scheme=exact, network=deps.network) entry — the SDK
  // would otherwise re-pick based on registered schemes and the topup
  // amount could end up funding a different `accepts[i].amount` than the
  // one actually signed. See pickExactAccept docstring.
  const accept = pickExactAccept(required, deps.network);
  if (!accept) {
    return errorResult(
      `A2A agent advertised no "exact" accept for network ${deps.network} ` +
        `(scheme/networks: ${JSON.stringify(
          required.accepts.map((a: any) => ({ scheme: a.scheme, network: a.network })),
        )})`,
    );
  }
  // Reconstruct a single-accept PaymentRequired for the SDK so its
  // internal selection cannot diverge from what we just chose.
  const narrowedRequired = { ...required, accepts: [accept] };

  const requiredAtomic = BigInt((accept as { amount?: string }).amount ?? "0");

  // 2a0. Price ceiling: on the discovery path the caller passes the listed
  //      price; refuse if the agent's gate demands more than advertised.
  if (deps.maxAmountAtomic !== undefined) {
    let ceiling: bigint;
    try {
      ceiling = BigInt(deps.maxAmountAtomic);
    } catch {
      ceiling = 0n;
    }
    if (requiredAtomic > ceiling) {
      return errorResult(
        `A2A agent demands ${requiredAtomic} atomic USDC.e but the advertised/allowed ` +
          `price is ${ceiling} — refusing (possible price bait-and-switch).`,
      );
    }
  }

  // 2a. Wallet-wide guard (per-call + daily ledger) — the same brake as the
  //     HTTP/MCP path, so A2A payments are capped too (previously uncapped).
  const walletDeny = checkWalletSpend(requiredAtomic);
  if (walletDeny) return errorResult(`blocked: ${walletDeny}`);

  // 2b. Spend-cap: ensure the delegate holds enough USDC.e (Safe autoTopup or
  //     light-mode balance check). Skipped when no funds source is wired.
  if (deps.funds) {
    try {
      await deps.funds.ensure(requiredAtomic);
    } catch (err) {
      return errorResult(`funds check failed (spend cap / insufficient balance?): ${(err as Error).message}`);
    }
  }

  // 3. Sign the exact payload with the bridge's delegate EOA against
  //    the *narrowed* PaymentRequired (single-accept) so the SDK's
  //    internal scheme/network selection cannot pick a different entry.
  let payload: unknown;
  try {
    const client = new x402Client().register(
      deps.network,
      new ExactEvmScheme(deps.signer.viemAccount),
    );
    payload = await client.createPaymentPayload(narrowedRequired);
  } catch (err) {
    return errorResult(`failed to sign x402 payment: ${(err as Error).message}`);
  }

  // 4. Re-send with the payload in A2A metadata → expect completed.
  let task: any;
  try {
    task = await a2aRpc(
      a2aUrl,
      "message/send",
      userMessage(args.message, { skillId: args.skill, [PAYLOAD_KEY]: payload }),
      timeoutMs,
    );
  } catch (err) {
    return errorResult(`A2A paid request failed: ${(err as Error).message}`);
  }

  const finalState = task?.status?.state;
  const payStatus = task?.metadata?.[STATUS_KEY];
  log.info("a2a.paid", { agent: a2aUrl, skill: args.skill, state: finalState, payment: payStatus });

  if (finalState !== "completed") {
    return errorResult(
      `A2A payment did not complete (state="${finalState}", payment="${payStatus}"): ` +
        JSON.stringify(task?.status?.message ?? task?.metadata ?? {}).slice(0, 300),
    );
  }

  // Record the successful spend against the wallet-wide daily ledger.
  recordWalletSpend(requiredAtomic);
  // Surface the a2a-x402 receipts (settle response + execution receipt, when
  // the seller emits one) so the caller can verify what the payment bought.
  const receipts = task?.metadata?.[RECEIPTS_KEY];
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          payment: payStatus,
          ...(receipts ? { receipts } : {}),
          ...extractResult(task),
        }),
      },
    ],
  };
}

function extractResult(task: any): Record<string, unknown> {
  const artifact = (task?.artifacts ?? [])[0];
  const part = artifact?.parts?.[0];
  if (part?.kind === "text" && typeof part.text === "string") {
    try {
      return JSON.parse(part.text);
    } catch {
      return { output: part.text };
    }
  }
  return { taskId: task?.id, state: task?.status?.state };
}
