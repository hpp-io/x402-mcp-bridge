/**
 * One-shot paid MCP tool call — the mcp-typed counterpart to httpX402.ts.
 *
 * `hpp_call` used to refuse mcp-typed discovery resources with "connect to it
 * directly", which left half the catalog unusable from an agent: the same
 * service is often listed twice (http + mcp), and semantic search happily
 * returns the mcp row as the best match. So discover → call was a dead end
 * exactly when the directory did its job well.
 *
 * This is deliberately NOT client.ts. That module maintains a long-lived
 * upstream session with batch-settlement channel state; here we want the same
 * shape as an HTTP x402 call — connect, pay once, get the result, disconnect —
 * so the schemes registered are the ones we can settle statelessly (exact
 * always, upto when an RPC is available).
 *
 * Guards mirror the HTTP path exactly (same policy limits, same daily ledger),
 * because "which transport the seller happens to speak" must not change how
 * much an agent is allowed to spend. One deliberate exception: the HTTP path's
 * per-host cooldown, which replays the *previous* result for a repeat call
 * within the window. That dedupes an agent's retry of the same top-up, but here
 * the same host serves many tools with different args, so replaying a cached
 * answer would be wrong rather than merely stale.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { wrapMCPClientWithPaymentFromConfig } from "@x402/mcp";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { UptoEvmScheme } from "@x402/evm/upto/client";
import type { Network } from "@x402/core/types";

import type { Funds } from "./funds.js";
import type { RawEoaSigner } from "./signers/raw-eoa.js";
import { loadPolicy, checkAccess, checkAmount } from "./policy.js";
import { checkWalletSpend, recordWalletSpend } from "./spendGuard.js";
import { log } from "./log.js";

export interface McpCallDeps {
  signer: RawEoaSigner;
  network: Network;
  funds?: Funds;
  /** Enables the upto scheme (needs an RPC to read the EIP-2612 nonce). */
  rpcUrl?: string;
  /**
   * Ceiling from the curated listing: refuse if the server's 402 asks for more
   * than discovery advertised. Same defence as the a2a path — a listed price is
   * what the agent consented to, so a seller can't quietly raise it at gate time.
   */
  maxAmountAtomic?: string;
  preferScheme?: "exact" | "upto";
}

export interface McpCallArgs {
  serverUrl: string;
  toolName: string;
  toolArgs?: Record<string, unknown>;
  transport?: "streamable-http" | "sse";
}

/** Per-call timeout for the whole connect → pay → call → close cycle. */
const DEFAULT_TIMEOUT_MS = 120_000;

function errorResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

export async function payMcpTool(
  deps: McpCallDeps,
  args: McpCallArgs,
): Promise<CallToolResult> {
  if (!args.toolName) return errorResult("toolName required");

  // Same limits source as the HTTP path. The allowlist verdict itself is
  // ignored (hpp_call already established curated discovery as the trust
  // boundary) but `access.limits` carries the per-call cap we must honor.
  const policy = loadPolicy();
  const access = checkAccess(policy, args.serverUrl);
  const limits = access.limits;

  const useUpto = Boolean(deps.rpcUrl);
  const base = new Client({ name: "hpp-x402-bridge", version: "0" });

  // Mutable holder rather than plain locals: both fields are written from SDK
  // callbacks, and TS narrows a `let` it can't see assigned to `null` forever.
  //
  // `amount` is the value the selector actually accepted, so the spend is
  // recorded only after the call comes back — a refused or failed call must not
  // consume budget. `refusal` carries our own reason out of the callbacks, which
  // otherwise can only say "false".
  const state: { amount: bigint | null; refusal: string | null } = {
    amount: null,
    refusal: null,
  };

  const x402 = wrapMCPClientWithPaymentFromConfig(
    base,
    {
      schemes: [
        { network: deps.network, client: new ExactEvmScheme(deps.signer.viemAccount) },
        ...(useUpto
          ? [
              {
                network: deps.network,
                client: new UptoEvmScheme(deps.signer.viemAccount, { rpcUrl: deps.rpcUrl! }),
              },
            ]
          : []),
      ],
      paymentRequirementsSelector: (_v, accepts) => {
        const supported = new Set<string>(["exact", ...(useUpto ? ["upto"] : [])]);
        const eligible = accepts.filter(
          (a) => a.network === deps.network && supported.has(a.scheme),
        );
        // Buyer force wins; otherwise the seller's advertised order.
        const picked = deps.preferScheme
          ? eligible.find((a) => a.scheme === deps.preferScheme)
          : eligible[0];
        if (!picked) {
          // Reached when the buyer forced a scheme this seller doesn't offer.
          // Falling back to another scheme would silently ignore the force, so
          // record the reason and let onPaymentRequested refuse. (Accepts on
          // networks/schemes we never registered are dropped by the SDK before
          // this selector runs — that surfaces from the catch below instead.)
          state.refusal =
            `seller does not offer the forced scheme "${deps.preferScheme}" on ` +
            `${deps.network} (offered: ${JSON.stringify(
              accepts.map((a) => ({ scheme: a.scheme, network: a.network })),
            )})`;
          return accepts[0];
        }
        log.info("mcp.scheme.selecting", {
          offered: accepts.map((a) => a.scheme),
          picked: picked.scheme,
        });
        return picked;
      },
    },
    {
      autoPayment: true,
      onPaymentRequested: async ({ paymentRequired }) => {
        if (state.refusal) return false;
        const accept =
          paymentRequired.accepts?.find((a) => a.network === deps.network) ??
          paymentRequired.accepts?.[0];
        if (!accept) {
          state.refusal = "402 carried no payment requirements";
          return false;
        }
        const amount = BigInt((accept as { amount?: string }).amount ?? "0");

        if (deps.maxAmountAtomic !== undefined) {
          try {
            const ceiling = BigInt(deps.maxAmountAtomic);
            if (amount > ceiling) {
              state.refusal =
                `server asks ${amount} atomic but discovery advertised ${ceiling} — refusing`;
              return false;
            }
          } catch {
            /* unparseable ceiling — fall through to the generic guards */
          }
        }

        const capDeny = checkAmount(limits, amount);
        if (capDeny) {
          state.refusal = `blocked: ${capDeny}`;
          return false;
        }
        const walletDeny = checkWalletSpend(amount);
        if (walletDeny) {
          state.refusal = `blocked: ${walletDeny}`;
          return false;
        }

        if (deps.funds) {
          try {
            await deps.funds.ensure(amount);
          } catch (err) {
            state.refusal = `funds check failed (spend cap / insufficient balance?): ${(err as Error).message}`;
            return false;
          }
        }

        state.amount = amount;
        return true;
      },
    },
  );

  const url = new URL(args.serverUrl);
  const transport =
    args.transport === "sse"
      ? new SSEClientTransport(url)
      : new StreamableHTTPClientTransport(url);

  try {
    await base.connect(transport);
  } catch (err) {
    // A streamable-http URL that only speaks SSE (or vice versa) is a listing
    // metadata problem, not an agent mistake — say which transport we tried.
    return errorResult(
      `mcp connect failed (${args.transport ?? "streamable-http"}) at ${args.serverUrl}: ${(err as Error).message}`,
    );
  }

  try {
    const result = (await x402.callTool(args.toolName, args.toolArgs ?? {}, {
      timeout: DEFAULT_TIMEOUT_MS,
    })) as unknown as CallToolResult;

    if (state.refusal) return errorResult(state.refusal);

    if (!result.isError && state.amount !== null) {
      recordWalletSpend(state.amount);
    }
    log.info("mcp.call.done", {
      server: url.host,
      tool: args.toolName,
      amountAtomic: state.amount?.toString() ?? "0",
      paid: state.amount !== null && !result.isError,
    });
    return result;
  } catch (err) {
    // A refusal recorded above is the real cause — the thrown error is just the
    // SDK reporting that no payment was produced.
    if (state.refusal) return errorResult(state.refusal);
    const msg = (err as Error).message;
    // The SDK drops accepts for networks/schemes we didn't register, then throws
    // its own multi-line dump. Say the same thing the HTTP path says, so an agent
    // reading either error learns the same fact.
    if (msg.includes("No network/scheme registered")) {
      return errorResult(
        `no payable accept (exact${useUpto ? "/upto" : ""}) for network ${deps.network} ` +
          `at ${args.serverUrl} — the service prices in a network/scheme this wallet can't settle`,
      );
    }
    return errorResult(`mcp call failed: ${msg}`);
  } finally {
    await base.close().catch(() => {});
  }
}
