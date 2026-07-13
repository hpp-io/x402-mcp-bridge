/**
 * hpp-x402-safe-revoke — emergency / scheduled revocation.
 *
 * Calls AllowanceModule.deleteAllowance(delegate, USDC.e) via Safe.execTx,
 * which immediately blocks any further executeAllowanceTransfer for that
 * delegate.
 *
 * Optional: --drain transfers the delegate's leftover USDC.e back to the
 * Safe. (Requires --delegate-pk because we need to sign from delegate.)
 *
 * Usage:
 *   npx -y @hpp-io/x402-mcp-bridge revoke \
 *     --owner-pk 0x...
 *     --safe 0x...
 *     --delegate 0x...
 *     [--network eip155:181228]   default HPP Sepolia
 *     [--rpc ...]
 *     [--module ...]
 *     [--usdc ...]
 *     [--drain --delegate-pk 0x...]   also drain delegate's USDC.e
 */
import {
  encodeFunctionData,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  buildClients,
  execSafeTx,
  encodeDeleteAllowance,
  type ChainConfig,
} from "./safe.js";

const DEFAULTS: Record<
  string,
  { rpc: string; usdc: Address; module: Address; chainId: number }
> = {
  "eip155:181228": {
    rpc: "https://sepolia.hpp.io",
    usdc: "0x401eCb1D350407f13ba348573E5630B83638E30D",
    module: "0x3CcE72483929e0517Dafc8fD192547B3B65f9b07",
    chainId: 181228,
  },
};

type Args = Record<string, string | boolean>;
function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const k = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out[k] = true;
    } else {
      out[k] = next;
      i++;
    }
  }
  return out;
}

function requireStr(a: Args, k: string): string {
  const v = a[k];
  if (typeof v !== "string" || v.length === 0) {
    console.error(`missing --${k}`);
    process.exit(1);
  }
  return v;
}

const ERC20_ABI = [
  {
    type: "function",
    name: "balanceOf",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "transfer",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
  },
] as const;

export async function run() {
  const args = parseArgs(process.argv);
  const network = (args.network as string) || "eip155:181228";
  const def = DEFAULTS[network];
  if (!def) {
    console.error(`unsupported network: ${network}`);
    process.exit(1);
  }

  const ownerPk = requireStr(args, "owner-pk") as Hex;
  const safe = requireStr(args, "safe") as Address;
  const delegate = requireStr(args, "delegate") as Address;
  const rpc = (args.rpc as string) || def.rpc;
  const usdc = ((args.usdc as string) || def.usdc) as Address;
  const module = ((args.module as string) || def.module) as Address;
  const drain = args.drain === true;
  const delegatePk = (args["delegate-pk"] as string) as Hex | undefined;

  if (drain && !delegatePk) {
    console.error("--drain requires --delegate-pk to sign the transfer back");
    process.exit(1);
  }

  const cfg: ChainConfig = { rpcUrl: rpc, chainId: def.chainId };

  console.log(`hpp-x402-safe-revoke`);
  console.log(`  Safe         : ${safe}`);
  console.log(`  Delegate     : ${delegate}`);
  console.log(`  Mode         : ${drain ? "deleteAllowance + drain" : "deleteAllowance only"}`);
  console.log("");

  // ---- 1) deleteAllowance (Safe Tx, owner signs) ---------------------
  console.log("[1/2] AllowanceModule.deleteAllowance…");
  const deleteTx = await execSafeTx(
    cfg,
    ownerPk,
    safe,
    module,
    encodeDeleteAllowance(delegate, usdc),
  );
  console.log(`      ✓ deleted (Safe tx ${deleteTx})`);

  // ---- 2) (optional) drain delegate's remaining USDC.e ---------------
  if (drain) {
    console.log("[2/2] Draining delegate's USDC.e back to Safe…");
    const { publicClient, walletClient } = buildClients(cfg, delegatePk!);
    const balance = (await publicClient.readContract({
      address: usdc,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [delegate],
    })) as bigint;
    if (balance === 0n) {
      console.log("      ✓ delegate already empty — nothing to drain");
    } else {
      const tx = await walletClient.writeContract({
        address: usdc,
        abi: ERC20_ABI,
        functionName: "transfer",
        args: [safe, balance],
      });
      await publicClient.waitForTransactionReceipt({ hash: tx });
      console.log(`      ✓ drained ${Number(balance) / 1e6} USDC.e (tx ${tx})`);
    }
  } else {
    console.log("[2/2] Skipped drain (no --drain flag).");
  }

  console.log("\n🎉 revocation complete.");
  console.log("\nThe delegate can no longer pull from the Safe via AllowanceModule.");
  if (!drain) {
    console.log("⚠ delegate may still hold leftover USDC.e it pulled earlier.");
    console.log("  Run again with --drain --delegate-pk 0x... to recover that balance.");
  }
}

