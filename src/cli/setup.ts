/**
 * hpp-x402-safe-setup — one-shot bootstrap of the user's wallet config.
 *
 * Composes the four steps that used to live in /tmp/safe-deploy/* into
 * a single command:
 *
 *   1. Deploy a 1-of-1 Safe (owner = --owner-pk's account)
 *   2. Generate a fresh delegate EOA (or use --delegate-pk if provided)
 *   3. Fund the Safe with USDC.e (--fund-usdc) + delegate with ETH (--fund-eth)
 *      from the owner account
 *   4. Send three Safe transactions:
 *      - enableModule(allowanceModule)
 *      - allowanceModule.addDelegate(delegate)
 *      - allowanceModule.setAllowance(delegate, USDCe, allowance/day, 1440, 0)
 *
 * Outputs a copy-pasteable env block + (optional) merges into the host
 * config (Claude Desktop) via the existing install-claude-desktop helper.
 *
 * Usage:
 *   npx -y @hpp-io/x402-mcp-bridge setup \
 *     --owner-pk 0x...                     (required — Safe owner key)
 *     --network eip155:181228              (default: HPP Sepolia)
 *     --rpc https://sepolia.hpp.io         (default by network)
 *     --usdc 0x401eCb1D...                 (default by network)
 *     --module 0x3CcE72...                 (default by network)
 *     --allowance 1                        (USDC.e/day, default 1)
 *     --fund-usdc 5                        (Safe USDC.e seed, default 5)
 *     --fund-eth 0.001                     (delegate gas seed, default 0.001)
 *     --delegate-pk 0x...                  (optional; auto-generates if omitted)
 *     --resource-server-url https://...    (default localhost:4021/mcp/sse)
 *     --install-claude                     (also write claude_desktop_config.json)
 *     --install-openclaw                   (also write ~/.openclaw/openclaw.json)
 */
import {
  parseUnits,
  parseEther,
  encodeFunctionData,
  createPublicClient,
  createWalletClient,
  http,
  defineChain,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

import {
  SAFE_V141,
  buildClients,
  deploySafe,
  execSafeTx,
  encodeEnableModule,
  encodeAddDelegate,
  encodeSetAllowance,
  isModuleEnabled,
  type ChainConfig,
} from "./safe.js";

// Built-in defaults per network; users can override with flags.
const DEFAULTS: Record<
  string,
  { rpc: string; usdc: Address; module: Address; chainId: number; name: string }
> = {
  "eip155:181228": {
    rpc: "https://sepolia.hpp.io",
    usdc: "0x401eCb1D350407f13ba348573E5630B83638E30D",
    module: "0x3CcE72483929e0517Dafc8fD192547B3B65f9b07",
    chainId: 181228,
    name: "HPP Sepolia",
  },
  // Mainnet entry pre-wired for when AllowanceModule is deployed there.
  // "eip155:190415": { ..., module: "0x..." }
};

// ---- arg parsing -------------------------------------------------------
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

const ERC20_TRANSFER_ABI = [
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
    console.error(`unsupported network: ${network} (no default known)`);
    process.exit(1);
  }

  const ownerPk = requireStr(args, "owner-pk") as Hex;
  const rpc = (args.rpc as string) || def.rpc;
  const usdc = ((args.usdc as string) || def.usdc) as Address;
  const module = ((args.module as string) || def.module) as Address;
  const chainId = def.chainId;
  const allowanceUSDC = (args.allowance as string) || "1";
  const fundUSDC = (args["fund-usdc"] as string) || "5";
  const fundETH = (args["fund-eth"] as string) || "0.001";
  const resourceServerUrl =
    (args["resource-server-url"] as string) ||
    "http://localhost:4021/mcp/sse";
  const installClaude = args["install-claude"] === true;
  const installOpenClaw = args["install-openclaw"] === true;

  let delegatePk = (args["delegate-pk"] as string) as Hex | undefined;
  let delegateGenerated = false;
  if (!delegatePk) {
    delegatePk = generatePrivateKey();
    delegateGenerated = true;
  }
  const delegate = privateKeyToAccount(delegatePk).address;

  const cfg: ChainConfig = { rpcUrl: rpc, chainId };

  console.log(`hpp-x402-safe-setup`);
  console.log(`  network         : ${network} (${def.name})`);
  console.log(`  rpc             : ${rpc}`);
  console.log(`  USDC.e          : ${usdc}`);
  console.log(`  AllowanceModule : ${module}`);
  console.log(`  owner address   : ${privateKeyToAccount(ownerPk).address}`);
  console.log(`  delegate address: ${delegate}${delegateGenerated ? " (auto-generated)" : ""}`);
  console.log(`  allowance       : ${allowanceUSDC} USDC.e / 24h`);
  console.log(`  fund-usdc       : ${fundUSDC} USDC.e`);
  console.log(`  fund-eth        : ${fundETH} ETH`);
  console.log("");

  // ---- 1) Deploy Safe -------------------------------------------------
  console.log("[1/5] Deploying Safe (1-of-1)…");
  const { safe, tx: deployTx } = await deploySafe(cfg, ownerPk);
  console.log(`      ✓ Safe: ${safe}  (tx ${deployTx})`);

  // ---- 2) Fund Safe with USDC.e + delegate with ETH ------------------
  const { walletClient, publicClient } = buildClients(cfg, ownerPk);
  const usdcAtomic = parseUnits(fundUSDC, 6);
  const ethWei = parseEther(fundETH);

  console.log(`[2/5] Funding Safe with ${fundUSDC} USDC.e + delegate with ${fundETH} ETH…`);
  const usdcTransferTx = await walletClient.writeContract({
    address: usdc,
    abi: ERC20_TRANSFER_ABI,
    functionName: "transfer",
    args: [safe, usdcAtomic],
  });
  await publicClient.waitForTransactionReceipt({ hash: usdcTransferTx });

  const ethTx = await walletClient.sendTransaction({
    to: delegate,
    value: ethWei,
  });
  await publicClient.waitForTransactionReceipt({ hash: ethTx });
  console.log(`      ✓ Safe ← ${fundUSDC} USDC.e (tx ${usdcTransferTx})`);
  console.log(`      ✓ delegate ← ${fundETH} ETH (tx ${ethTx})`);

  // ---- 3) enableModule(AllowanceModule) ------------------------------
  if (await isModuleEnabled(cfg, safe, module)) {
    console.log("[3/5] AllowanceModule already enabled — skip");
  } else {
    console.log("[3/5] Enabling AllowanceModule…");
    const enableTx = await execSafeTx(cfg, ownerPk, safe, safe, encodeEnableModule(module));
    console.log(`      ✓ enabled (Safe tx ${enableTx})`);
  }

  // ---- 4) addDelegate ------------------------------------------------
  console.log("[4/5] Authorising delegate…");
  const addDelegateTx = await execSafeTx(
    cfg,
    ownerPk,
    safe,
    module,
    encodeAddDelegate(delegate),
  );
  console.log(`      ✓ addDelegate (Safe tx ${addDelegateTx})`);

  // ---- 5) setAllowance -----------------------------------------------
  const allowanceAtomic = parseUnits(allowanceUSDC, 6);
  console.log(`[5/5] Setting allowance ${allowanceUSDC} USDC.e / 24h…`);
  const setAllowanceTx = await execSafeTx(
    cfg,
    ownerPk,
    safe,
    module,
    encodeSetAllowance(delegate, usdc, allowanceAtomic, 1440),
  );
  console.log(`      ✓ setAllowance (Safe tx ${setAllowanceTx})`);

  // ---- Output --------------------------------------------------------
  console.log("\n🎉 setup complete.\n");
  console.log("Addresses:");
  console.log(`  Safe              : ${safe}`);
  console.log(`  Delegate EOA      : ${delegate}`);
  console.log(`  AllowanceModule   : ${module}`);
  console.log(`  USDC.e            : ${usdc}`);
  console.log("");

  if (delegateGenerated) {
    console.log("⚠ Delegate private key (save securely — *not* committed):");
    console.log(`  ${delegatePk}`);
    console.log("");
  }

  const envBlock = {
    DELEGATE_PRIVATE_KEY: delegatePk,
    SAFE_ADDRESS: safe,
    ALLOWANCE_MODULE_ADDRESS: module,
    USDCE_ADDRESS: usdc,
    RESOURCE_SERVER_URL: resourceServerUrl,
    HPP_RPC_URL: rpc,
    HPP_NETWORK: network,
    LOG_LEVEL: "info",
  };

  console.log("Paste into claude_desktop_config.json (or openclaw config.json):");
  console.log(JSON.stringify(
    {
      mcpServers: {
        "hpp-x402": {
          command: "npx",
          args: ["-y", "@hpp-io/x402-mcp-bridge"],
          env: envBlock,
        },
      },
    },
    null,
    2,
  ));

  if (installClaude) {
    console.log("\n[install-claude] Writing to Claude Desktop config…");
    const { installClaudeDesktop } = await import("./install-claude.js");
    try {
      const r = installClaudeDesktop(envBlock as Parameters<typeof installClaudeDesktop>[0], {
        force: true,
      });
      console.log(`      config: ${r.configPath}`);
      if (r.backupPath) console.log(`      backup: ${r.backupPath}`);
      console.log(`      preserved entries: ${r.preservedEntries.length}`);
      console.log(`      changed: ${r.changed}`);
      console.log("\n   ✓ Restart Claude Desktop (cmd+Q then reopen) to load.");
    } catch (err) {
      console.error("   ✗ install-claude failed:", (err as Error).message);
      console.error("     Use the env block above to merge manually.");
    }
  }

  if (installOpenClaw) {
    console.log("\n[install-openclaw] Writing to OpenClaw config…");
    const { installOpenClaw: doInstall } = await import("./install-openclaw.js");
    try {
      const r = doInstall(envBlock as Parameters<typeof doInstall>[0], {
        force: true,
      });
      console.log(`      config: ${r.configPath}`);
      if (r.backupPath) console.log(`      backup: ${r.backupPath}`);
      console.log(`      preserved entries: ${r.preservedEntries.length}`);
      console.log(`      changed: ${r.changed}`);
      console.log("\n   ✓ Restart OpenClaw to load the new MCP server.");
    } catch (err) {
      console.error("   ✗ install-openclaw failed:", (err as Error).message);
      console.error("     Use the env block above to merge manually.");
    }
  }

  if (!installClaude && !installOpenClaw) {
    console.log("\nTo merge into Claude Desktop automatically, re-run with --install-claude.");
    console.log("To merge into OpenClaw automatically, re-run with --install-openclaw.");
    console.log("To start the bridge manually:");
    console.log(`  RESOURCE_SERVER_URL=${resourceServerUrl} \\`);
    console.log(`  DELEGATE_PRIVATE_KEY=${delegatePk} \\`);
    console.log(`  SAFE_ADDRESS=${safe} \\`);
    console.log(`  ALLOWANCE_MODULE_ADDRESS=${module} \\`);
    console.log(`  USDCE_ADDRESS=${usdc} \\`);
    console.log(`  HPP_RPC_URL=${rpc} \\`);
    console.log(`  HPP_NETWORK=${network} \\`);
    console.log(`  npx @hpp-io/x402-mcp-bridge`);
  }
}

