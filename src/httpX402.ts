/**
 * Generic HTTP x402 tool for the bridge.
 *
 * Like `pay_a2a_agent`, this is a *local* tool (not forwarded upstream):
 * it lets the host call an x402-protected HTTP endpoint. The first use is
 * HPP Hub credit top-up (`POST /api/web3/credit/topup`), but nothing here
 * is Hub-specific — the per-host auth header + spend limits come from the
 * generic policy (see ./policy.ts), so any "x402 + auth header" service
 * works with one policy entry and no code change.
 *
 * Flow (mirrors a2a.ts: gate → spend-cap → sign → re-send):
 *   1. pre-flight guard: host allowlist + https              (policy.checkAccess)
 *   2. inject auth headers from local policy                  (policy.resolveCredentials)
 *   3. unpaid fetch; non-402 → passthrough (e.g. GET usage)
 *   4. parse 402 → pick the (exact, ourNetwork) accept        (a2a.pickExactAccept)
 *   5. per-call amount cap                                    (policy.checkAmount)
 *   6. autoTopup the delegate from the Safe (reused)
 *   7. sign exact payload, encode Payment-Signature, re-send
 *
 * Secrets (api keys) never travel through tool args — only `{url, method,
 * body}` come from the host/LLM. Identity is the X-Api-Key injected locally.
 */
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { UptoEvmScheme } from "@x402/evm/upto/client";
import type { Network } from "@x402/core/types";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { Funds } from "./funds.js";
import type { RawEoaSigner } from "./signers/raw-eoa.js";
import {
  loadPolicy,
  checkAccess,
  checkAmount,
  resolveCredentials,
  checkCooldown,
  recordPaid,
  acquireHostLock,
} from "./policy.js";
import { checkWalletSpend, recordWalletSpend } from "./spendGuard.js";
import { log } from "./log.js";

export interface HttpX402Deps {
  signer: RawEoaSigner;
  network: Network;
  /** Ensure the delegate holds enough USDC.e before paying. */
  funds?: Funds;
  /**
   * Set by hpp_call for curated-discovery resources: skip the manual host
   * allowlist + local credential injection (discovery is the trust boundary).
   * The spend cap (default limits, per-call amount, cooldown) still applies.
   */
  trustedSource?: boolean;
  /**
   * Chain RPC. When present, the `upto` (usage-based) scheme is also registered
   * so this call can pay upto services — the upto client reads the EIP-2612
   * token nonce over this RPC to sign the gasless Permit2 approval. Omitted =
   * exact-only (backward compatible).
   */
  rpcUrl?: string;
  /**
   * Buyer override for when a seller advertises more than one payable scheme.
   * Unset = honor the seller's advertised order (x402 default). Also honored:
   * `HPP_X402_PREFER_EXACT=true` (forces exact).
   */
  preferScheme?: "exact" | "upto";
}

/**
 * Pick the accept to pay. Filters to schemes we can sign (exact always; upto
 * when an RPC is available) on the target network, then: an explicit buyer
 * preference wins, else the seller's advertised order (first eligible).
 */
function pickPayableAccept(
  required: { accepts?: ReadonlyArray<Record<string, unknown>> },
  network: Network,
  opts: { upto: boolean; prefer?: "exact" | "upto" },
): Record<string, unknown> | null {
  const supported = new Set<string>(["exact", ...(opts.upto ? ["upto"] : [])]);
  const eligible = (required.accepts ?? []).filter(
    (a) => a.network === network && supported.has(a.scheme as string),
  );
  if (eligible.length === 0) return null;
  // An explicit buyer force (--scheme) must be honored exactly — if the seller
  // doesn't offer it, that's an error (null), not a silent fallback.
  if (opts.prefer) {
    return eligible.find((a) => a.scheme === opts.prefer) ?? null;
  }
  // Lenient demo override: prefer exact when present, else the seller's order.
  if (process.env.HPP_X402_PREFER_EXACT === "true") {
    const ex = eligible.find((a) => a.scheme === "exact");
    if (ex) return ex;
  }
  return eligible[0]; // seller's advertised order
}

export const X402_HTTP_TOOL = {
  name: "x402_http_call",
  description:
    "Call an x402-protected HTTP endpoint and return its response. Payment " +
    "(USDC.e) is handled automatically with your wallet, subject to the daily " +
    "spend cap; per-host auth headers come from local policy (you do NOT pass " +
    "keys). Only allow-listed hosts can be called. Use for paid HTTP APIs and " +
    "account actions such as Hub credit top-up " +
    "(POST <hub>/api/web3/credit/topup {amount}) and usage checks " +
    "(GET <hub>/api/web3/credit/usage).",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "Target endpoint URL (host must be allow-listed)." },
      method: { type: "string", description: "HTTP method (default POST)." },
      body: { type: "object", description: "JSON request body (for POST/PUT/...)." },
    },
    required: ["url"],
    additionalProperties: false,
  },
} as const;

export interface X402HttpArgs {
  url: string;
  method?: string;
  body?: unknown;
}

function errorResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

async function toToolResult(res: Response): Promise<CallToolResult> {
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* keep raw text */
  }
  return {
    content: [
      { type: "text", text: JSON.stringify({ status: res.status, ok: res.ok, body: parsed }) },
    ],
    isError: !res.ok,
  };
}

export async function x402HttpCall(
  deps: HttpX402Deps,
  args: X402HttpArgs,
): Promise<CallToolResult> {
  const url = args.url;
  if (!url || typeof url !== "string") return errorResult("url required");
  const method = (args.method ?? "POST").toUpperCase();

  const policy = loadPolicy();

  // 1. pre-flight guard — host allowlist + https (③ / H1·C1). Trusted
  // (curated-discovery) calls skip the allowlist/https gate but still inherit
  // the default spend limits carried on `access.limits`.
  const access = checkAccess(policy, url);
  if (!access.ok && !deps.trustedSource) return errorResult(`blocked: ${access.error}`);

  const host = new URL(url).host.toLowerCase();

  // 2. inject auth headers from local policy (② — never from args/LLM). Trusted
  // discovery services authenticate by payment (x402), not a local api key.
  let authHeaders: Record<string, string> = {};
  if (!deps.trustedSource) {
    try {
      authHeaders = resolveCredentials(policy, host);
    } catch (err) {
      return errorResult((err as Error).message);
    }
  }

  const baseHeaders: Record<string, string> = { "Content-Type": "application/json", ...authHeaders };
  const init: RequestInit = {
    method,
    headers: baseHeaders,
    body: method === "GET" || method === "HEAD" ? undefined : JSON.stringify(args.body ?? {}),
  };

  // 3. unpaid request — non-402 passes through (e.g. GET /usage 200)
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    return errorResult(`request failed: ${(err as Error).message}`);
  }
  if (res.status !== 402) return toToolResult(res);

  // Paid path. Serialize per host so two near-simultaneous calls can't both
  // pay (closes the cooldown's check-then-act race); combined with the
  // cooldown below this dedupes agent-retry / heartbeat double-fire.
  const release = acquireHostLock(host);
  if (!release) {
    log.info("x402_http_call.locked", { host });
    return {
      content: [
        { type: "text", text: JSON.stringify({ inProgress: true, retry: true, message: `payment to ${host} already in progress` }) },
      ],
    };
  }

  try {
    // H2 idempotency: if we paid this host within its cooldown window, return
    // the previous result instead of paying again.
    const cd = checkCooldown(host, access.limits.cooldownMs);
    if (cd.throttled) {
      let previous: unknown = cd.cachedResult;
      try {
        previous = JSON.parse(cd.cachedResult ?? "null");
      } catch {
        /* keep raw */
      }
      log.info("x402_http_call.cooldown", { host, remainingMs: cd.remainingMs });
      return {
        content: [
          { type: "text", text: JSON.stringify({ cooldown: true, retryAfterMs: cd.remainingMs, previous }) },
        ],
      };
    }

    // x402 client — also parses the 402 (v2 header / v1 body) and signs.
    // Register exact always; add upto when an RPC is available (needed to sign
    // the gasless Permit2 approval). Registering both lets a seller advertise
    // either — the accept picker (below) honors the seller's order.
    const useUpto = Boolean(deps.rpcUrl);
    const client = new x402Client().register(deps.network, new ExactEvmScheme(deps.signer.viemAccount));
    if (useUpto) {
      client.register(deps.network, new UptoEvmScheme(deps.signer.viemAccount, { rpcUrl: deps.rpcUrl! }));
    }
    const httpClient = new x402HTTPClient(client);

    // Parse 402 requirements. x402 v2 carries them in the PAYMENT-REQUIRED
    // header (body is the v1 fallback) — getPaymentRequiredResponse handles
    // those. Some servers (incl. HPP Hub) instead return v2-shaped requirements
    // directly in the JSON body; fall back to that when the SDK parser rejects.
    const body = (await res.json().catch(() => undefined)) as
      | { accepts?: ReadonlyArray<Record<string, unknown>> }
      | undefined;
    let required: { accepts?: ReadonlyArray<Record<string, unknown>> };
    try {
      required = httpClient.getPaymentRequiredResponse(
        (name) => res.headers.get(name),
        body,
      ) as unknown as { accepts?: ReadonlyArray<Record<string, unknown>> };
    } catch {
      if (body && Array.isArray(body.accepts)) {
        required = body;
      } else {
        return errorResult("no x402 payment requirements found (header or body)");
      }
    }

    const accept = pickPayableAccept(required, deps.network, {
      upto: useUpto,
      prefer: deps.preferScheme,
    });
    if (!accept) {
      const forced = deps.preferScheme ? `--scheme ${deps.preferScheme} ` : "";
      return errorResult(
        `no ${forced}payable accept (exact${useUpto ? "/upto" : ""}) for network ${deps.network} ` +
          `(offered: ${JSON.stringify((required.accepts ?? []).map((a) => ({ scheme: a.scheme, network: a.network })))})`,
      );
    }
    const narrowedRequired = { ...required, accepts: [accept] };
    const amount = BigInt((accept as { amount?: string }).amount ?? "0");

    // per-call amount cap — before pulling any funds
    const deny = checkAmount(access.limits, amount);
    if (deny) return errorResult(`blocked: ${deny}`);

    // wallet-wide guard (per-call + daily ledger) — uniform across all payment
    // tools; blocks a runaway agent before signing.
    const walletDeny = checkWalletSpend(amount);
    if (walletDeny) return errorResult(`blocked: ${walletDeny}`);

    // Ensure the delegate holds enough USDC.e (Safe autoTopup within the
    // on-chain cap, or a light-mode balance check — same gate either way).
    if (deps.funds) {
      try {
        await deps.funds.ensure(amount);
      } catch (err) {
        return errorResult(`funds check failed (spend cap / insufficient balance?): ${(err as Error).message}`);
      }
    }

    // sign exact payload + encode Payment-Signature header
    let payHeaders: Record<string, string>;
    try {
      const payload = await httpClient.createPaymentPayload(narrowedRequired as never);
      payHeaders = httpClient.encodePaymentSignatureHeader(payload);
    } catch (err) {
      return errorResult(`failed to sign payment: ${(err as Error).message}`);
    }

    // re-send with payment + preserved auth headers
    let paid: Response;
    try {
      paid = await fetch(url, { ...init, headers: { ...baseHeaders, ...payHeaders } });
    } catch (err) {
      return errorResult(`paid request failed: ${(err as Error).message}`);
    }

    const result = await toToolResult(paid);
    // Record only successful paid calls so the cooldown gate can dedupe
    // retries; a failed settle (isError) stays retryable.
    if (!result.isError) {
      recordPaid(host, (result.content[0] as { text?: string }).text ?? "");
      recordWalletSpend(amount);
    }
    log.info("x402_http_call.done", {
      host,
      status: paid.status,
      amountAtomic: amount.toString(),
      paid: !result.isError,
    });
    return result;
  } finally {
    release();
  }
}
