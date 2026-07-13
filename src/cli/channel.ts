/**
 * hpp-x402-channel — inspect / manage local batch-settlement channels.
 *
 * Subcommands:
 *
 *   ls                          List all channels persisted under HPP_X402_HOME.
 *   status <channelId>          Print full local channel context.
 *   refund <url> [amount]       Cooperative refund — server co-signs, single
 *                               multicall(claim + refund) onchain. Immediate.
 *                               Omit `amount` for a full refund.
 *   withdraw <url> [--finalize] Unilateral withdraw — server-free escape hatch.
 *                               Without --finalize: initiateWithdraw onchain.
 *                               With --finalize: finalizeWithdraw after
 *                               the channel's withdrawDelay elapsed.
 *
 * Storage layout matches `FileClientChannelStorage`:
 *   {HPP_X402_HOME or ~/.hpp-x402}/client/<channelId>.json
 *
 * Env required for mutating commands (refund, withdraw):
 *   AGENT_PRIVATE_KEY   payer wallet (0x + 64 hex)
 *   HPP_RPC_URL         e.g. https://sepolia.hpp.io/<key>
 *   HPP_NETWORK         CAIP-2 (e.g. eip155:181228)
 *   PAYER_SALT          optional — bytes32 hex used to derive channelId.
 *                       Must match the salt the channel was opened with.
 *                       Defaults to 0x00…0 (SDK default).
 *
 * Usage:
 *   hpp-x402-channel ls
 *   hpp-x402-channel status 0xe3fd…
 *   hpp-x402-channel refund http://localhost:4021/paid/compute/hello-world
 *   hpp-x402-channel refund http://localhost:4021/paid/compute/hello-world 5000
 *   hpp-x402-channel withdraw http://localhost:4021/paid/compute/hello-world
 *   hpp-x402-channel withdraw http://localhost:4021/paid/compute/hello-world --finalize
 */
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { readdir } from "node:fs/promises";

import { FileClientChannelStorage } from "@x402/evm/batch-settlement/client/file-storage";
import { BatchSettlementEvmScheme } from "@x402/evm/batch-settlement/client";
import { toClientEvmSigner } from "@x402/evm";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import type { Network, PaymentRequirements } from "@x402/core/types";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseAbi,
  type PublicClient,
  type Account,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const STORAGE_ROOT =
  process.env.HPP_X402_HOME ?? resolve(homedir(), ".hpp-x402");

const X402_BATCH_SETTLEMENT =
  "0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003" as const;

const CONTRACT_ABI = parseAbi([
  "function channels(bytes32 channelId) view returns (uint128 balance, uint128 totalClaimed)",
  "function pendingWithdrawals(bytes32 channelId) view returns (uint128 amount, uint40 initiatedAt)",
  "function getChannelId((address payer, address payerAuthorizer, address receiver, address receiverAuthorizer, address token, uint40 withdrawDelay, bytes32 salt) config) view returns (bytes32)",
  "function initiateWithdraw((address payer, address payerAuthorizer, address receiver, address receiverAuthorizer, address token, uint40 withdrawDelay, bytes32 salt) config, uint128 amount)",
  "function finalizeWithdraw((address payer, address payerAuthorizer, address receiver, address receiverAuthorizer, address token, uint40 withdrawDelay, bytes32 salt) config)",
]);

interface ChannelConfigStruct {
  payer: `0x${string}`;
  payerAuthorizer: `0x${string}`;
  receiver: `0x${string}`;
  receiverAuthorizer: `0x${string}`;
  token: `0x${string}`;
  withdrawDelay: number;
  salt: `0x${string}`;
}

function usage(): never {
  console.error("Usage: hpp-x402-channel <ls|status|refund|withdraw> [args]");
  console.error("  ls                                List local channels");
  console.error("  status <channelId>                Show channel detail");
  console.error("  refund <url> [amount]             Cooperative refund (server co-signs)");
  console.error("  withdraw <url> [--finalize]       Unilateral withdraw (server-free)");
  process.exit(1);
}

function reqEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) {
    console.error(`Missing env: ${name}`);
    process.exit(2);
  }
  return v;
}

interface SignerCtx {
  account: ReturnType<typeof privateKeyToAccount>;
  network: Network;
  chainId: number;
  rpcUrl: string;
  salt: `0x${string}`;
  publicClient: PublicClient;
}

function loadSignerCtx(): SignerCtx {
  const key = reqEnv("AGENT_PRIVATE_KEY");
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    console.error("AGENT_PRIVATE_KEY must be 0x + 64 hex chars");
    process.exit(2);
  }
  const rpcUrl = reqEnv("HPP_RPC_URL");
  const network = reqEnv("HPP_NETWORK") as Network;
  if (!/^eip155:\d+$/.test(network)) {
    console.error('HPP_NETWORK must match "eip155:<chainId>"');
    process.exit(2);
  }
  const saltRaw = process.env.PAYER_SALT ?? `0x${"0".repeat(64)}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(saltRaw)) {
    console.error("PAYER_SALT must be 0x + 64 hex chars");
    process.exit(2);
  }
  const salt = saltRaw as `0x${string}`;
  const chainId = Number(network.split(":")[1]);
  const account = privateKeyToAccount(key as `0x${string}`);
  const chain = defineChain({
    id: chainId,
    name: `hpp-${chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  return { account, network, chainId, rpcUrl, salt, publicClient };
}

async function probeRequirements(url: string): Promise<PaymentRequirements> {
  const r = await fetch(url, { method: "GET" });
  if (r.status !== 402) {
    throw new Error(`probe expected 402, got ${r.status} (server may not advertise this URL)`);
  }
  const header = r.headers.get("PAYMENT-REQUIRED");
  if (!header) throw new Error("probe response missing PAYMENT-REQUIRED header");
  const paymentRequired = decodePaymentRequiredHeader(header);
  const requirements = paymentRequired.accepts.find((a) => a.scheme === "batch-settlement");
  if (!requirements) throw new Error("server does not advertise batch-settlement on this URL");
  return requirements;
}

async function listChannelIds(): Promise<string[]> {
  const clientDir = join(STORAGE_ROOT, "client");
  try {
    const files = await readdir(clientDir);
    return files
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""))
      .sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

async function cmdLs(): Promise<void> {
  const storage = new FileClientChannelStorage({ directory: STORAGE_ROOT });
  const ids = await listChannelIds();
  if (ids.length === 0) {
    console.log(`(no channels under ${STORAGE_ROOT}/client/)`);
    return;
  }
  console.log(`channels in ${STORAGE_ROOT}/client/:\n`);
  for (const id of ids) {
    const ctx = await storage.get(id);
    if (!ctx) continue;
    const ch = (ctx as { channel?: Record<string, unknown> }).channel;
    if (!ch) {
      console.log(`  ${id}  (no channel record)`);
      continue;
    }
    const balance = String(ch.balance ?? "0");
    const totalClaimed = String(ch.totalClaimed ?? "0");
    const charged = String(ch.chargedCumulativeAmount ?? "0");
    console.log(
      `  ${id}\n` +
        `      balance: ${balance}  totalClaimed: ${totalClaimed}  chargedCumulative: ${charged}`,
    );
  }
}

async function cmdStatus(channelId: string): Promise<void> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(channelId)) {
    console.error("channelId must be 0x + 64 hex chars");
    process.exit(2);
  }
  const storage = new FileClientChannelStorage({ directory: STORAGE_ROOT });
  const ctx = await storage.get(channelId.toLowerCase());
  if (!ctx) {
    console.error(`channel ${channelId} not found under ${STORAGE_ROOT}/client/`);
    process.exit(3);
  }
  console.log(JSON.stringify(ctx, null, 2));
}

async function cmdRefund(url: string, amountArg: string | undefined): Promise<void> {
  if (amountArg !== undefined && !/^\d+$/.test(amountArg)) {
    console.error("amount must be a positive integer (atomic token units)");
    process.exit(2);
  }
  const { account, salt, publicClient } = loadSignerCtx();
  const signer = toClientEvmSigner(account, publicClient);
  // Persistent client storage so this CLI can recover a channel created
  // by another bridge process (Claude Desktop / OpenClaw stdio).
  const storage = new FileClientChannelStorage({ directory: STORAGE_ROOT });
  const scheme = new BatchSettlementEvmScheme(signer, { salt, storage });

  console.log(`refunding channel for ${url}${amountArg ? ` (amount=${amountArg})` : " (full drain)"}…`);
  const settle = await scheme.refund(url, amountArg !== undefined ? { amount: amountArg } : undefined);
  if (!settle.success) {
    console.error(
      `refund failed: ${settle.errorReason ?? "unknown"} ${settle.errorMessage ?? ""}`,
    );
    process.exit(4);
  }
  console.log(`refund tx: ${settle.transaction}`);
  const extra = (settle as { extra?: { channelState?: Record<string, unknown> } }).extra
    ?.channelState;
  if (extra) {
    console.log("post-refund channel state:");
    console.log(JSON.stringify(extra, null, 2));
  }
}

async function cmdWithdraw(url: string, finalize: boolean): Promise<void> {
  const { account, publicClient, chainId, rpcUrl, salt } = loadSignerCtx();
  const signer = toClientEvmSigner(account, publicClient);
  const storage = new FileClientChannelStorage({ directory: STORAGE_ROOT });
  const scheme = new BatchSettlementEvmScheme(signer, { salt, storage });

  const requirements = await probeRequirements(url);
  const channelConfig = scheme.buildChannelConfig(requirements) as ChannelConfigStruct;

  // viem walletClient for the direct onchain writes (initiate / finalize).
  const chain = defineChain({
    id: chainId,
    name: `hpp-${chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const walletClient = createWalletClient({
    chain,
    transport: http(rpcUrl),
    account: account as unknown as Account,
  });

  if (!finalize) {
    // initiateWithdraw — amount = onchain balance - charged. Conservative,
    // safe against server claiming up to charged during the delay window.
    // Derive channelId via the contract's view (avoid depending on SDK
    // internal `computeChannelId` whose export path is unstable).
    const channelId = (await publicClient.readContract({
      address: X402_BATCH_SETTLEMENT,
      abi: CONTRACT_ABI,
      functionName: "getChannelId",
      args: [channelConfig],
    })) as `0x${string}`;
    const [balance, _totalClaimed] = (await publicClient.readContract({
      address: X402_BATCH_SETTLEMENT,
      abi: CONTRACT_ABI,
      functionName: "channels",
      args: [channelId],
    })) as readonly [bigint, bigint];

    // Read local charged-cumulative from storage.
    const local = await storage.get(channelId.toLowerCase());
    const charged = BigInt((local as { chargedCumulativeAmount?: string })?.chargedCumulativeAmount ?? "0");
    const withdrawAmount = balance - charged;
    if (withdrawAmount <= 0n) {
      console.error(
        `nothing to withdraw — balance(${balance}) <= chargedCumulative(${charged})`,
      );
      process.exit(5);
    }

    console.log(`initiateWithdraw amount=${withdrawAmount} (balance ${balance} - charged ${charged})`);
    const txHash = await walletClient.writeContract({
      account: account as unknown as Account,
      chain,
      address: X402_BATCH_SETTLEMENT,
      abi: CONTRACT_ABI,
      functionName: "initiateWithdraw",
      args: [channelConfig, withdrawAmount],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") {
      console.error(`initiateWithdraw tx reverted: ${txHash}`);
      process.exit(6);
    }
    console.log(`initiate tx: ${txHash}`);

    const [pendAmount, pendInitAt] = (await publicClient.readContract({
      address: X402_BATCH_SETTLEMENT,
      abi: CONTRACT_ABI,
      functionName: "pendingWithdrawals",
      args: [channelId],
    })) as readonly [bigint, number];
    const block = await publicClient.getBlock();
    const readyAt = pendInitAt + channelConfig.withdrawDelay;
    const eta = readyAt - Number(block.timestamp);
    console.log(`pendingWithdrawals: amount=${pendAmount}  initiatedAt=${pendInitAt}`);
    console.log(
      `finalize available in ~${eta}s (at block.timestamp >= ${readyAt}). Re-run with --finalize.`,
    );
    return;
  }

  // finalize ----------------------------------------------------------------
  console.log("finalizeWithdraw…");
  const txHash = await walletClient.writeContract({
    account: account as unknown as Account,
    chain,
    address: X402_BATCH_SETTLEMENT,
    abi: CONTRACT_ABI,
    functionName: "finalizeWithdraw",
    args: [channelConfig],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    console.error(`finalizeWithdraw tx reverted: ${txHash} (delay not yet elapsed, or amount overshot)`);
    process.exit(6);
  }
  console.log(`finalize tx: ${txHash}`);
}

export async function run(): Promise<void> {
  const args = process.argv.slice(2);
  const subcmd = args[0];

  switch (subcmd) {
    case "ls":
      await cmdLs();
      break;
    case "status":
      if (!args[1]) {
        console.error("status requires a channelId argument");
        usage();
      }
      await cmdStatus(args[1]);
      break;
    case "refund":
      if (!args[1]) {
        console.error("refund requires a <url> argument");
        usage();
      }
      await cmdRefund(args[1], args[2]);
      break;
    case "withdraw": {
      if (!args[1]) {
        console.error("withdraw requires a <url> argument");
        usage();
      }
      const finalize = args.includes("--finalize");
      await cmdWithdraw(args[1], finalize);
      break;
    }
    case "topup":
      console.error(
        "topup is not yet implemented (needs ERC-3009 deposit signing flow). " +
          "See https://github.com/hpp-io/noosphere-x402-server/issues/9",
      );
      process.exit(64);
      break;
    case "--help":
    case "-h":
    case undefined:
      usage();
    default:
      console.error(`unknown subcommand: ${subcmd}`);
      usage();
  }
}

