#!/usr/bin/env node
/**
 * hpp-x402 — unified CLI (Polygon `polygon-agent` style).
 *
 * One entry with subcommands over the scattered per-tool bins:
 *   wallet · install · status   (setup/fund/policy/pay to follow)
 * The existing bins (hpp-x402-quickstart / -keychain / ...) remain during the
 * transition; this reuses the same lib functions so behavior matches.
 */
import { Command } from "commander";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import {
  createPublicClient,
  http,
  defineChain,
  formatUnits,
  type Address,
  type Hex,
} from "viem";

import {
  setKeychain,
  buildKeychainURI,
  resolveKeychain,
  deleteKeychain,
} from "../keychain.js";
import { DiscoveryClient } from "../discovery.js";
import { hppCall } from "../discoveryTools.js";
import { x402HttpCall } from "../httpX402.js";
import { RawEoaSigner } from "../signers/raw-eoa.js";
import { DirectBalance } from "../funds/direct-balance.js";
import type { Network } from "@x402/core/types";
import { installClaudeDesktop } from "./install-claude.js";
import { installOpenClaw } from "./install-openclaw.js";
import { installCursor } from "./install-cursor.js";
import { installWindsurf } from "./install-windsurf.js";
import { installClaudeCode, type ClaudeCodeInstallResult } from "./install-claude-code.js";
import type { InstallEnv, InstallResult } from "./install-mcp-host.js";

const NETWORKS: Record<
  string,
  { rpc: string; usdc: Address; name: string; chainId: number }
> = {
  "eip155:181228": {
    rpc: "https://sepolia.hpp.io",
    usdc: "0x401eCb1D350407f13ba348573E5630B83638E30D",
    name: "HPP Sepolia",
    chainId: 181228,
  },
  "eip155:190415": {
    rpc: "https://mainnet.hpp.io",
    usdc: "0x401eCb1D350407f13ba348573E5630B83638E30D",
    name: "HPP Mainnet",
    chainId: 190415,
  },
};
const DEFAULT_NETWORK = "eip155:181228";
const DEFAULT_RESOURCE_SERVER = "http://localhost:4021/mcp/sse";

const ERC20_BALANCE_ABI = [
  {
    type: "function",
    name: "balanceOf",
    inputs: [{ name: "a", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
] as const;

function net(id: string) {
  const n = NETWORKS[id];
  if (!n) throw new Error(`unknown network ${id} (use ${Object.keys(NETWORKS).join(" | ")})`);
  return n;
}
function addressFor(account: string): Address {
  const key = resolveKeychain(buildKeychainURI(account));
  return privateKeyToAccount(key).address;
}
async function usdcBalance(address: Address, netId: string): Promise<string> {
  const n = net(netId);
  const chain = defineChain({
    id: n.chainId,
    name: n.name,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [n.rpc] } },
  });
  const pub = createPublicClient({ chain, transport: http(n.rpc) });
  const bal = (await pub.readContract({
    address: n.usdc,
    abi: ERC20_BALANCE_ABI,
    functionName: "balanceOf",
    args: [address],
  })) as bigint;
  return formatUnits(bal, 6);
}
function lightEnv(account: string, netId: string, resourceServerUrl: string): InstallEnv {
  const n = net(netId);
  return {
    DELEGATE_PRIVATE_KEY: buildKeychainURI(account),
    USDCE_ADDRESS: n.usdc,
    RESOURCE_SERVER_URL: resourceServerUrl,
    HPP_RPC_URL: n.rpc,
    HPP_NETWORK: netId,
    LOG_LEVEL: "info",
  };
}

const acct = ["-a, --account <name>", "keychain account", "delegate-default"] as const;

const HOSTS: Record<string, (env: InstallEnv) => InstallResult | ClaudeCodeInstallResult> = {
  claude: (e) => installClaudeDesktop(e, { force: true }),
  "claude-code": (e) => installClaudeCode(e, { scope: "user" }),
  cursor: (e) => installCursor(e, { force: true }),
  windsurf: (e) => installWindsurf(e, { force: true }),
  openclaw: (e) => installOpenClaw(e, { force: true }),
};

/**
 * Report an install result. Claude Code shells out to the `claude` CLI; when
 * that binary is absent we surface a helpful message + the exact command to run
 * manually, not the raw spawn ENOENT.
 */
function printInstallResult(host: string, r: InstallResult | ClaudeCodeInstallResult): void {
  if (!("ok" in r)) {
    console.log(`✓ ${host}: ${r.configPath}${r.backupPath ? ` (backup ${r.backupPath})` : ""}`);
    return;
  }
  if (r.ok) {
    console.log("✓ registered with Claude Code (claude mcp add)");
  } else if (r.notFound) {
    console.error("✗ Claude Code CLI ('claude') not found on PATH.");
    console.error("  Install Claude Code, then register hpp-x402 with:");
    console.error(`    ${r.command}`);
    console.error("  Or target another host:  hpp-x402 install claude|cursor|windsurf|openclaw");
    process.exitCode = 1;
  } else {
    console.error(`✗ claude mcp add failed: ${r.stderr.trim()}`);
    process.exitCode = 1;
  }
}

const program = new Command();
program
  .name("hpp-x402")
  .description("HPP x402 agent wallet + payment CLI")
  .version("0.1.5");

// ── setup (one-command onboarding) ─────────────────────────────────────
program
  .command("setup")
  .description("one-command light onboarding: wallet + fund instructions (+ optional --install)")
  .option(...acct)
  .option("-n, --network <id>", "network", DEFAULT_NETWORK)
  .option("--resource-server-url <url>", "x402 MCP resource server", DEFAULT_RESOURCE_SERVER)
  .option("--delegate-pk <key>", "import an existing 0x key instead of generating one")
  .option("--print-key", "emit the raw key instead of a keychain URI (dev only)")
  .option("--install <host>", `also register into an MCP host (${Object.keys(HOSTS).join("|")})`)
  .action(
    (o: {
      account: string;
      network: string;
      resourceServerUrl: string;
      delegatePk?: string;
      printKey?: boolean;
      install?: string;
    }) => {
      const n = net(o.network);
      let key = o.delegatePk as Hex | undefined;
      const generated = !key;
      if (!key) key = generatePrivateKey();
      const address = privateKeyToAccount(key).address;

      let ref: string;
      if (o.printKey) {
        ref = key;
      } else {
        setKeychain(o.account, key);
        ref = buildKeychainURI(o.account);
      }

      console.log(`network : ${n.name} (${o.network})`);
      console.log(`wallet  : ${address}${generated ? " (generated)" : ""}`);
      console.log(`storage : ${o.printKey ? "raw key (dev)" : `keychain (${ref})`}`);
      console.log("");
      console.log(`▶ Fund: send USDC.e to ${address} on ${n.name} — no native gas needed (gasless settlement).`);
      console.log("");

      const env: InstallEnv = {
        DELEGATE_PRIVATE_KEY: ref,
        USDCE_ADDRESS: n.usdc,
        RESOURCE_SERVER_URL: o.resourceServerUrl,
        HPP_RPC_URL: n.rpc,
        HPP_NETWORK: o.network,
        LOG_LEVEL: "info",
      };

      if (o.install) {
        const fn = HOSTS[o.install];
        if (!fn) throw new Error(`unknown host "${o.install}" (${Object.keys(HOSTS).join("|")})`);
        const r = fn(env);
        printInstallResult(o.install, r);
      } else {
        console.log("MCP host config (paste, or re-run with --install <host>):");
        console.log(
          JSON.stringify(
            { mcpServers: { "hpp-x402": { command: "npx", args: ["-y", "@hpp-io/x402-mcp-bridge"], env } } },
            null,
            2,
          ),
        );
      }
    },
  );

// ── wallet ────────────────────────────────────────────────────────────
const wallet = program.command("wallet").description("wallet management (OS keychain)");

wallet
  .command("address")
  .option(...acct)
  .description("print the wallet (delegate) address")
  .action((o: { account: string }) => console.log(addressFor(o.account)));

wallet
  .command("balance")
  .option(...acct)
  .option("-n, --network <id>", "network", DEFAULT_NETWORK)
  .description("show USDC.e balance")
  .action(async (o: { account: string; network: string }) => {
    const addr = addressFor(o.account);
    console.log(`${addr}\n${await usdcBalance(addr, o.network)} USDC.e (${net(o.network).name})`);
  });

wallet
  .command("generate")
  .option(...acct)
  .description("generate a new delegate key into the keychain")
  .action((o: { account: string }) => {
    const key = generatePrivateKey();
    setKeychain(o.account, key);
    console.log(`generated ${privateKeyToAccount(key).address}\nstored:  ${buildKeychainURI(o.account)}`);
  });

wallet
  .command("import <key>")
  .option(...acct)
  .description("import an existing 0x delegate key into the keychain")
  .action((key: string, o: { account: string }) => {
    setKeychain(o.account, key as Hex);
    console.log(`imported ${privateKeyToAccount(key as Hex).address}\nstored:  ${buildKeychainURI(o.account)}`);
  });

wallet
  .command("remove")
  .option(...acct)
  .description("delete the keychain entry")
  .action((o: { account: string }) => {
    console.log(deleteKeychain(o.account) ? `removed ${o.account}` : `not found: ${o.account}`);
  });

// ── install ───────────────────────────────────────────────────────────
program
  .command("install <host>")
  .description(`register the bridge into an MCP host (${Object.keys(HOSTS).join("|")})`)
  .option(...acct)
  .option("-n, --network <id>", "network", DEFAULT_NETWORK)
  .option("--resource-server-url <url>", "x402 MCP resource server", DEFAULT_RESOURCE_SERVER)
  .action((host: string, o: { account: string; network: string; resourceServerUrl: string }) => {
    const fn = HOSTS[host];
    if (!fn) throw new Error(`unknown host "${host}" (${Object.keys(HOSTS).join("|")})`);
    const r = fn(lightEnv(o.account, o.network, o.resourceServerUrl));
    printInstallResult(host, r);
  });

// ── fund ──────────────────────────────────────────────────────────────
program
  .command("fund")
  .description("show where to send USDC.e to top up the wallet")
  .option(...acct)
  .option("-n, --network <id>", "network", DEFAULT_NETWORK)
  .action(async (o: { account: string; network: string }) => {
    const n = net(o.network);
    const addr = addressFor(o.account);
    let bal = "?";
    try {
      bal = await usdcBalance(addr, o.network);
    } catch {
      /* leave ? */
    }
    console.log(`Send USDC.e on ${n.name} to:`);
    console.log(`  ${addr}`);
    console.log(`token   : ${n.usdc}`);
    console.log(`balance : ${bal} USDC.e`);
    console.log(`(no native gas needed — x402 settlement is gasless)`);
  });

// ── discover (browse curated services) ────────────────────────────────
const DEFAULT_DISCOVERY_URL = "https://x402-discovery.hpp.io";
program
  .command("discover [query]")
  .description("browse/search curated x402 services from the HPP discovery directory")
  .option("-t, --type <type>", "http|mcp|a2a|all", "all")
  .option("--scheme <scheme>", "filter by payment scheme (exact|upto)")
  .option("-n, --network <id>", "CAIP-2 network filter (e.g. eip155:190415)")
  .option("--limit <n>", "max results", "20")
  .option("--url <url>", "discovery base URL", DEFAULT_DISCOVERY_URL)
  .action(
    async (
      query: string | undefined,
      o: { type: string; scheme?: string; network?: string; limit: string; url: string },
    ) => {
      const client = new DiscoveryClient(o.url);
      const limit = Number(o.limit);
      // Scheme isn't a server-side filter, so over-fetch then narrow locally.
      const results0 = await client.discover({
        query,
        type: o.type as "http" | "mcp" | "a2a" | "all",
        network: o.network,
        limit: o.scheme ? 50 : limit,
      });
      const results = o.scheme
        ? results0.filter((r) => r.scheme === o.scheme).slice(0, limit)
        : results0;
      if (!results.length) {
        console.log(o.scheme ? `(no ${o.scheme} services found)` : "(no services found)");
        return;
      }
      for (const r of results) {
        console.log(r.id);
        console.log(`  ${r.type}  ${r.scheme}  price=${r.priceAtomic}  (${r.network})`);
        console.log(`  ${r.description ?? r.toolName ?? r.resourceUrl}`);
        if (r.resourceUrl) console.log(`  ${r.resourceUrl}`);
      }
      console.log(
        `\n${results.length} service(s). Pay one:  hpp-x402 call <url or id> --body '{…}'`,
      );
    },
  );

// ── call (pay + invoke a service — by URL or discovery id) ────────────
program
  .command("call <target>")
  .description("pay + call an x402 service — a URL directly, or a resourceId from discover")
  .option(...acct)
  .option("-n, --network <id>", "network", DEFAULT_NETWORK)
  .option("--method <verb>", "HTTP method (for URL targets)", "POST")
  .option("--body <json>", "JSON request body / input args")
  .option("--scheme <exact|upto>", "force a scheme when the seller offers both")
  .option("--url <url>", "discovery base URL (for resourceId targets)", DEFAULT_DISCOVERY_URL)
  .action(
    async (
      target: string,
      o: {
        account: string;
        network: string;
        method: string;
        body?: string;
        scheme?: string;
        url: string;
      },
    ) => {
      const n = net(o.network);
      const signer = new RawEoaSigner(resolveKeychain(buildKeychainURI(o.account)));
      const funds = new DirectBalance(signer.address, n.usdc, n.chainId, n.rpc);
      if (o.scheme && o.scheme !== "exact" && o.scheme !== "upto") {
        throw new Error("--scheme must be exact or upto");
      }
      const preferScheme = o.scheme as "exact" | "upto" | undefined;

      let body: unknown;
      if (o.body) {
        try {
          body = JSON.parse(o.body);
        } catch {
          throw new Error("--body must be valid JSON");
        }
      }

      // A URL is paid directly (a seller's first sale, an unlisted endpoint, or
      // a service not in the directory); anything else is resolved via discovery
      // first. You supplied the target either way, so it's trusted (host allowlist
      // skipped) — the per-call spend cap still applies. rpcUrl enables the upto
      // scheme; preferScheme forces one when the seller advertises both.
      const res = /^https?:\/\//i.test(target)
        ? await x402HttpCall(
            {
              signer,
              network: o.network as Network,
              funds,
              trustedSource: true,
              rpcUrl: n.rpc,
              preferScheme,
            },
            { url: target, method: o.method, body },
          )
        : await hppCall(
            { signer, network: o.network as Network, funds, rpcUrl: n.rpc, preferScheme },
            new DiscoveryClient(o.url),
            { resourceId: target, body },
          );
      const text = (res.content ?? [])
        .map((c) => (c as { text?: string }).text)
        .filter(Boolean)
        .join("\n");
      if (res.isError) {
        console.error(text);
        process.exit(1);
      }
      console.log(text);
    },
  );

// ── status ────────────────────────────────────────────────────────────
program
  .command("status")
  .description("config · wallet balance · server reachability")
  .option(...acct)
  .option("-n, --network <id>", "network", DEFAULT_NETWORK)
  .option("--resource-server-url <url>", "x402 MCP resource server", DEFAULT_RESOURCE_SERVER)
  .action(async (o: { account: string; network: string; resourceServerUrl: string }) => {
    const n = net(o.network);
    console.log(`network : ${n.name} (${o.network})`);
    let addr: Address;
    try {
      addr = addressFor(o.account);
    } catch {
      console.log(`wallet  : (no key for "${o.account}" — run: hpp-x402 wallet generate)`);
      return;
    }
    console.log(`wallet  : ${addr}`);
    try {
      console.log(`balance : ${await usdcBalance(addr, o.network)} USDC.e`);
    } catch {
      console.log(`balance : (read failed)`);
    }
    let srv = "unreachable";
    try {
      const origin = new URL(o.resourceServerUrl).origin;
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 4000);
      const res = await fetch(origin, { signal: ac.signal }).catch(() => null);
      clearTimeout(t);
      if (res) srv = String(res.status);
    } catch {
      /* keep unreachable */
    }
    console.log(`server  : ${o.resourceServerUrl} → ${srv}`);
  });

// Absorbed per-tool scripts — shown in --help; actually dispatched below.
program.command("policy").description("manage the x402_http_call host policy (show/set/list/unset/defaults)").allowUnknownOption();
program.command("channel").description("inspect/manage batch-settlement channels (ls/status/refund)").allowUnknownOption();
program.command("safe").description("Safe (governance) wallet: setup | revoke").allowUnknownOption();
program.command("serve").description("run a lightweight x402 seller — a paid HTTP endpoint (--pay-to, --handler)").allowUnknownOption();

// Passthrough groups delegate to the existing scripts, which parse process.argv
// themselves. Intercept BEFORE commander so their flags aren't consumed, and
// rewrite argv so each script sees its sub-args starting at index 2.
async function runPassthrough(modPath: string, label: string, subArgs: string[]): Promise<void> {
  process.argv = [process.argv[0], label, ...subArgs];
  const m = (await import(modPath)) as { run: () => void | Promise<void> };
  await m.run();
}

const PASSTHROUGH: Record<string, { mod: string; label: string }> = {
  policy: { mod: "./policy.js", label: "hpp-x402-policy" },
  channel: { mod: "./channel.js", label: "hpp-x402-channel" },
  serve: { mod: "./serve.js", label: "hpp-x402-serve" },
};

const sub = process.argv[2];
if (sub && sub in PASSTHROUGH) {
  const { mod, label } = PASSTHROUGH[sub];
  runPassthrough(mod, label, process.argv.slice(3)).catch((e) => {
    console.error(`${label} error:`, e?.message ?? e);
    process.exit(1);
  });
} else if (sub === "safe") {
  const action = process.argv[3];
  const map: Record<string, string> = { setup: "./setup.js", revoke: "./revoke.js" };
  if (!action || !(action in map)) {
    console.log("usage: hpp-x402 safe <setup|revoke> [options]");
    process.exit(action ? 1 : 0);
  }
  runPassthrough(map[action], `hpp-x402-safe-${action}`, process.argv.slice(4)).catch((e) => {
    console.error(`hpp-x402-safe-${action} error:`, e?.message ?? e);
    process.exit(1);
  });
} else {
  program.parseAsync(process.argv).catch((e) => {
    console.error("error:", e?.message ?? e);
    process.exit(1);
  });
}
