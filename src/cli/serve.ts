/**
 * hpp-x402 serve — lightweight generic x402 seller (A2 Phase 2).
 *
 * Turns any agent capability into a paid HTTP endpoint. express +
 * @x402/express `paymentMiddleware` run the whole serve-then-settle x402 flow
 * (build requirements → 402 → verify → settle) against our facilitator; the
 * route handler just does the work — either **echo** (default, for testing) or
 * forward the request body to a configured **webhook** (`--handler <url>`).
 * The Noosphere on-chain compute backend is intentionally NOT used — the
 * handler is generic (SELLER_DESIGN layer 2).
 *
 * Usage:
 *   hpp-x402 serve --pay-to 0x... [--port 4030] [--path /paid/echo]
 *     [--price 10000] [--network eip155:181228] [--asset 0x...]
 *     [--facilitator-url https://facilitator-sepolia.hpp.io]
 *     [--handler https://my-agent/handle] [--description "..."]
 */
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { UptoEvmScheme } from "@x402/evm/upto/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { declareEip2612GasSponsoringExtension } from "@x402/extensions";
import type { Network } from "@x402/core/types";

const DEFAULT_USDCE = "0x401eCb1D350407f13ba348573E5630B83638E30D";
const DEFAULT_FACILITATOR = "https://facilitator-sepolia.hpp.io";
// EIP-712 domain of HPP USDC.e — buyers need (name, version) in the advertised
// requirements to sign the EIP-3009 authorization. Override via --domain-name /
// --domain-version for a different asset.
const DEFAULT_DOMAIN_NAME = "Bridged USDC";
const DEFAULT_DOMAIN_VERSION = "2";

type Args = Record<string, string | boolean>;
function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const k = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) out[k] = true;
    else {
      out[k] = next;
      i++;
    }
  }
  return out;
}

export async function run(): Promise<void> {
  const a = parseArgs(process.argv);
  const payTo = a["pay-to"] as string | undefined;
  if (!payTo) throw new Error("--pay-to <address> required (where payments land)");

  const port = Number(a.port ?? 4030);
  const path = (a.path as string) ?? "/paid/echo";
  const price = String(a.price ?? "10000");
  const network = ((a.network as string) ?? "eip155:181228") as Network;
  const asset = (a.asset as string) ?? DEFAULT_USDCE;
  const facilitatorUrl = (a["facilitator-url"] as string) ?? DEFAULT_FACILITATOR;
  const handlerUrl = a.handler as string | undefined;
  const description = (a.description as string) ?? "hpp-x402 paid endpoint";
  const domainName = (a["domain-name"] as string) ?? DEFAULT_DOMAIN_NAME;
  const domainVersion = (a["domain-version"] as string) ?? DEFAULT_DOMAIN_VERSION;

  // Pricing model this seller advertises. exact = fixed price; upto = usage-based
  // (buyer signs a gasless Permit2 approval up to the max, facilitator settles the
  // actual amount). batch-settlement is out (channel-based, not wired here).
  const scheme = ((a.scheme as string) ?? "exact") as "exact" | "upto";
  if (scheme !== "exact" && scheme !== "upto") {
    throw new Error("--scheme must be exact or upto");
  }

  // Public URL this seller is reachable at, for discovery + the 402 `resource`.
  // The x402 middleware otherwise derives the resource URL from the request's
  // Host header — so a buyer paying via localhost gets `http://localhost:PORT`
  // indexed, which no one else can reach. Set --url to the address buyers use
  // (e.g. https://seller.example.com behind a tunnel) so that's what's advertised.
  const publicUrl = a.url as string | undefined;
  let publicHost: string | undefined;
  let publicProto: string | undefined;
  if (publicUrl) {
    try {
      const u = new URL(publicUrl);
      publicHost = u.host;
      publicProto = u.protocol.replace(":", "");
    } catch {
      throw new Error(`--url must be a full URL, e.g. https://seller.example.com (got: ${publicUrl})`);
    }
  }
  // Advertise discovery metadata by default so the facilitator auto-indexes
  // this seller into x402-discovery after the first settlement. --private opts
  // out (unlisted endpoint).
  const discoverable = a.private !== true;

  // SDK server-side scheme builds correct requirements (incl. exact EIP-712
  // domain) + drives verify/settle via the facilitator.
  const facilitator = new HTTPFacilitatorClient({ url: facilitatorUrl });
  const resourceServer = new x402ResourceServer([facilitator]);
  resourceServer.register(
    network,
    scheme === "upto" ? new UptoEvmScheme() : new ExactEvmScheme(),
  );

  // Bazaar discovery extension — the facilitator picks it up at settlement and
  // forwards it to the discovery indexer, so this seller becomes findable via
  // hpp_discover after its first sale (no explicit register needed).
  const discovery = discoverable
    ? declareDiscoveryExtension({
        bodyType: "json",
        input: {},
        inputSchema: { type: "object", additionalProperties: true },
        output: { example: { ok: true } },
      })
    : {};

  // upto needs the EIP-2612 gas-sponsoring extension so buyers sign the Permit2
  // approval gaslessly; exact ignores it.
  const gasSponsoring = scheme === "upto" ? declareEip2612GasSponsoringExtension() : {};

  const routes = {
    [`POST ${path}`]: {
      accepts: [
        {
          scheme,
          network,
          payTo,
          price: { amount: price, asset, extra: { name: domainName, version: domainVersion } },
          maxTimeoutSeconds: 600,
        },
      ],
      description,
      extensions: { ...discovery, ...gasSponsoring },
    },
  };

  const app = express();
  app.use(express.json());
  // When --url is set, rewrite the Host/protocol the x402 middleware reads so the
  // advertised `resource` URL is the public one, not the buyer's request Host.
  // Must run BEFORE paymentMiddleware. (You're still responsible for routing that
  // public URL to this process — a tunnel or reverse proxy.)
  if (publicHost && publicProto) {
    app.use((req, _res, next) => {
      req.headers.host = publicHost;
      Object.defineProperty(req, "protocol", { configurable: true, get: () => publicProto });
      next();
    });
  }
  // Serve-then-settle: verifies X-PAYMENT, runs the handler, settles on success.
  app.use(paymentMiddleware(routes, resourceServer));

  app.post(path, async (req, res) => {
    try {
      if (handlerUrl) {
        const r = await fetch(handlerUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(req.body ?? {}),
        });
        const text = await r.text();
        res.status(r.status).type(r.headers.get("content-type") ?? "application/json").send(text);
      } else {
        res.json({ ok: true, echo: req.body ?? null, served: "hpp-x402-serve" });
      }
    } catch (err) {
      res.status(502).json({ error: `handler failed: ${(err as Error).message}` });
    }
  });

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  const advertised = publicHost
    ? `${publicProto}://${publicHost}${path}`
    : `http://localhost:${port}${path} (from request Host — set --url for a public address)`;
  const server = app.listen(port, () => {
    process.stderr.write(
      `hpp-x402 serve: POST ${path} @ :${port}  scheme=${scheme} price=${price} payTo=${payTo}\n` +
        `  network=${network} facilitator=${facilitatorUrl} handler=${handlerUrl ?? "echo"}\n` +
        `  discovery resource: ${discoverable ? advertised : "(--private: not advertised)"}\n`,
    );
  });
  // Turn a failed bind into a clear message instead of an unhandled 'error'
  // crash (the default). EADDRINUSE is the common one: another process (or a
  // stale serve) already holds the port.
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      process.stderr.write(
        `hpp-x402 serve error: port ${port} is already in use.\n` +
          `  Pick a free port: hpp-x402 serve --pay-to ${payTo} --port ${port + 1}\n`,
      );
    } else if (err.code === "EACCES") {
      process.stderr.write(
        `hpp-x402 serve error: not allowed to bind port ${port} — use --port <n> with n >= 1024.\n`,
      );
    } else {
      process.stderr.write(`hpp-x402 serve error: ${err.message}\n`);
    }
    process.exit(1);
  });
}
