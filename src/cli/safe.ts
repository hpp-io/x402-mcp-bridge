/**
 * Safe v1.4.1 helpers — minimal viem-based reimplementation of the bits
 * of @safe-global/protocol-kit we use, to keep this CLI dependency-free
 * beyond viem.
 *
 * What we need:
 *   - deploySafe(owner, threshold)            via canonical ProxyFactory
 *   - execSafeTx(to, data, ownerSigner)       1-of-1 path
 *   - read helpers (nonce, isModuleEnabled)
 *
 * The canonical addresses are present on every chain that hosts Safe
 * v1.4.1 (verified for HPP Sepolia + Mainnet on 2026-04-30).
 */
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  defineChain,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const SAFE_V141 = {
  singleton: "0x41675C099F32341bf84BFc5382aF534df5C7461a" as Address,
  proxyFactory: "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67" as Address,
  fallbackHandler: "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99" as Address,
} as const;

const SAFE_SETUP_ABI = [
  {
    type: "function",
    name: "setup",
    inputs: [
      { name: "_owners", type: "address[]" },
      { name: "_threshold", type: "uint256" },
      { name: "to", type: "address" },
      { name: "data", type: "bytes" },
      { name: "fallbackHandler", type: "address" },
      { name: "paymentToken", type: "address" },
      { name: "payment", type: "uint256" },
      { name: "paymentReceiver", type: "address" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

const PROXY_FACTORY_ABI = [
  {
    type: "function",
    name: "createProxyWithNonce",
    inputs: [
      { name: "_singleton", type: "address" },
      { name: "initializer", type: "bytes" },
      { name: "saltNonce", type: "uint256" },
    ],
    outputs: [{ name: "proxy", type: "address" }],
    stateMutability: "nonpayable",
  },
  {
    type: "event",
    name: "ProxyCreation",
    inputs: [
      { name: "proxy", type: "address", indexed: true },
      { name: "singleton", type: "address", indexed: false },
    ],
    anonymous: false,
  },
] as const;

const SAFE_ABI = [
  {
    type: "function",
    name: "execTransaction",
    inputs: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
      { name: "operation", type: "uint8" },
      { name: "safeTxGas", type: "uint256" },
      { name: "baseGas", type: "uint256" },
      { name: "gasPrice", type: "uint256" },
      { name: "gasToken", type: "address" },
      { name: "refundReceiver", type: "address" },
      { name: "signatures", type: "bytes" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "nonce",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "enableModule",
    inputs: [{ name: "module", type: "address" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "isModuleEnabled",
    inputs: [{ name: "module", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
  },
] as const;

export interface ChainConfig {
  rpcUrl: string;
  chainId: number;
}

export function buildClients(cfg: ChainConfig, ownerPk: Hex) {
  const owner = privateKeyToAccount(ownerPk);
  const chain = defineChain({
    id: cfg.chainId,
    name: `chain-${cfg.chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
  });
  const publicClient = createPublicClient({ chain, transport: http(cfg.rpcUrl) });
  const walletClient = createWalletClient({
    chain,
    transport: http(cfg.rpcUrl),
    account: owner,
  });
  return { owner, publicClient, walletClient };
}

/** Deploy a 1-of-1 Safe and return its address. */
export async function deploySafe(
  cfg: ChainConfig,
  ownerPk: Hex,
): Promise<{ safe: Address; tx: Hex }> {
  const { owner, publicClient, walletClient } = buildClients(cfg, ownerPk);
  const initializer = encodeFunctionData({
    abi: SAFE_SETUP_ABI,
    functionName: "setup",
    args: [
      [owner.address],
      1n,
      "0x0000000000000000000000000000000000000000",
      "0x",
      SAFE_V141.fallbackHandler,
      "0x0000000000000000000000000000000000000000",
      0n,
      "0x0000000000000000000000000000000000000000",
    ],
  });
  const saltNonce = BigInt(Date.now());

  const txHash = await walletClient.writeContract({
    address: SAFE_V141.proxyFactory,
    abi: PROXY_FACTORY_ABI,
    functionName: "createProxyWithNonce",
    args: [SAFE_V141.singleton, initializer, saltNonce],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

  // Extract Safe address from ProxyCreation event topic[1] (indexed).
  const log = receipt.logs.find(
    (l) =>
      l.address.toLowerCase() === SAFE_V141.proxyFactory.toLowerCase() &&
      l.topics[0]?.toLowerCase() ===
        "0x4f51faf6c4561ff95f067657e43439f0f856d97c04d9ec9070a6199ad418e235",
  );
  if (!log || !log.topics[1]) throw new Error("ProxyCreation event missing");
  const safe = (`0x${log.topics[1].slice(26)}`) as Address;
  return { safe, tx: txHash };
}

/** Execute a single Safe transaction (operation = CALL, nonce auto-fetched). */
export async function execSafeTx(
  cfg: ChainConfig,
  ownerPk: Hex,
  safe: Address,
  to: Address,
  data: Hex,
): Promise<Hex> {
  const { owner, publicClient, walletClient } = buildClients(cfg, ownerPk);
  const nonce = (await publicClient.readContract({
    address: safe,
    abi: SAFE_ABI,
    functionName: "nonce",
  })) as bigint;

  const params = {
    to,
    value: 0n,
    data,
    operation: 0,
    safeTxGas: 0n,
    baseGas: 0n,
    gasPrice: 0n,
    gasToken: "0x0000000000000000000000000000000000000000" as Address,
    refundReceiver: "0x0000000000000000000000000000000000000000" as Address,
    nonce,
  };

  const signature = await owner.signTypedData({
    domain: { chainId: cfg.chainId, verifyingContract: safe },
    types: {
      SafeTx: [
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "data", type: "bytes" },
        { name: "operation", type: "uint8" },
        { name: "safeTxGas", type: "uint256" },
        { name: "baseGas", type: "uint256" },
        { name: "gasPrice", type: "uint256" },
        { name: "gasToken", type: "address" },
        { name: "refundReceiver", type: "address" },
        { name: "nonce", type: "uint256" },
      ],
    },
    primaryType: "SafeTx",
    message: params,
  });

  const txHash = await walletClient.writeContract({
    address: safe,
    abi: SAFE_ABI,
    functionName: "execTransaction",
    args: [
      params.to,
      params.value,
      params.data,
      params.operation,
      params.safeTxGas,
      params.baseGas,
      params.gasPrice,
      params.gasToken,
      params.refundReceiver,
      signature,
    ],
  });
  await publicClient.waitForTransactionReceipt({ hash: txHash });
  return txHash;
}

export async function isModuleEnabled(
  cfg: ChainConfig,
  safe: Address,
  module: Address,
): Promise<boolean> {
  const publicClient = createPublicClient({
    chain: defineChain({
      id: cfg.chainId,
      name: `chain-${cfg.chainId}`,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [cfg.rpcUrl] } },
    }),
    transport: http(cfg.rpcUrl),
  });
  return (await publicClient.readContract({
    address: safe,
    abi: SAFE_ABI,
    functionName: "isModuleEnabled",
    args: [module],
  })) as boolean;
}

export const ALLOWANCE_MODULE_ABI = [
  {
    type: "function",
    name: "addDelegate",
    inputs: [{ name: "delegate", type: "address" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "setAllowance",
    inputs: [
      { name: "delegate", type: "address" },
      { name: "token", type: "address" },
      { name: "allowanceAmount", type: "uint96" },
      { name: "resetTimeMin", type: "uint16" },
      { name: "resetBaseMin", type: "uint32" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "deleteAllowance",
    inputs: [
      { name: "delegate", type: "address" },
      { name: "token", type: "address" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "getTokenAllowance",
    inputs: [
      { name: "safe", type: "address" },
      { name: "delegate", type: "address" },
      { name: "token", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256[5]" }],
    stateMutability: "view",
  },
] as const;

export function encodeEnableModule(module: Address): Hex {
  return encodeFunctionData({
    abi: SAFE_ABI,
    functionName: "enableModule",
    args: [module],
  });
}

export function encodeAddDelegate(delegate: Address): Hex {
  return encodeFunctionData({
    abi: ALLOWANCE_MODULE_ABI,
    functionName: "addDelegate",
    args: [delegate],
  });
}

export function encodeSetAllowance(
  delegate: Address,
  token: Address,
  amountAtomic: bigint,
  resetMinutes: number,
): Hex {
  return encodeFunctionData({
    abi: ALLOWANCE_MODULE_ABI,
    functionName: "setAllowance",
    args: [delegate, token, amountAtomic, resetMinutes, 0],
  });
}

export function encodeDeleteAllowance(delegate: Address, token: Address): Hex {
  return encodeFunctionData({
    abi: ALLOWANCE_MODULE_ABI,
    functionName: "deleteAllowance",
    args: [delegate, token],
  });
}
