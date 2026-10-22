/**
 * ERC-7710 payment delegations on the buyer side: the agent (this bridge's delegate
 * key) pays x402 from the USER's smart account, holding no funds itself.
 *
 * The user's wallet signed a delegation to our key with on-chain caps and handed us
 * `HPP_PAYMENT_DELEGATION` (the encoded, signed delegation = permissionContext). For
 * each 402 whose accept says `extra.assetTransferMethod: "erc7710"`, we sign a
 * redelegation to ANY_DELEGATE scoped by RedeemerEnforcer(facilitator keys from the
 * accept's `extra.facilitatorAddresses`), ERC20TransferAmount(amount),
 * AllowedCalldata(to = payTo) and a short Timestamp, and send
 * `{ delegationManager, permissionContext, delegator }`. The HPP facilitator redeems it.
 *
 * Byte-for-byte the leaf `@hpp-io/aa-sdk`'s `buildPaymentRedelegation` produces (the SDK is
 * the canonical implementation; this copy exists so the bridge does not pull the AA SDK in
 * — switch to it once `@hpp-io/aa-sdk` >= 0.2 is published). Contracts: MetaMask
 * delegation-framework v1.3.0 redeployed by HPP (addresses below).
 */
import { ExactEvmScheme } from "@x402/evm/exact/client";
import type { PaymentPayloadContext, PaymentPayloadResult, PaymentRequirements, SchemeNetworkClient } from "@x402/core/types";
import {
  concatHex,
  createPublicClient,
  decodeAbiParameters,
  encodeAbiParameters,
  encodePacked,
  getAddress,
  hashStruct,
  hashTypedData,
  http,
  isAddress,
  isHex,
  keccak256,
  pad,
  toHex,
  type Address,
  type Hex,
  type LocalAccount,
} from "viem";
import { log } from "./log.js";

export const ERC7710_METHOD = "erc7710";
export const ANY_DELEGATE: Address = "0x0000000000000000000000000000000000000a11";

/** HPP deployments (enforcers: CREATE2 salt `hpp-x402-7710-poc`; DelegationManager owner = Sepolia test key / mainnet AA operations Safe). */
export const ERC7710_CONTRACTS: Record<number, { delegationManager: Address; enforcers: { ERC20TransferAmountEnforcer: Address; RedeemerEnforcer: Address; AllowedCalldataEnforcer: Address; TimestampEnforcer: Address } }> = {
  181228: {
    delegationManager: "0x20248e5193B1Ef08298812AdA31F4B0D75e99652",
    enforcers: {
      ERC20TransferAmountEnforcer: "0x8b76d04EbB53082D258e653ddb49423ce142c546",
      RedeemerEnforcer: "0x7914D7940E7b6A2F8579FaB1c4c02CB4370700f8",
      AllowedCalldataEnforcer: "0x31c407faAFbc69868b4d8822B1a761214A04080b",
      TimestampEnforcer: "0xa5FB0F520984Ece260b9248D4Ae6A2f6350a4850",
    },
  },
  // HPP Mainnet (2026-10-15). Enforcers share the CREATE2 addresses; the DelegationManager differs because its
  // owner (constructor arg) is the HPP AA operations Safe. Same set the facilitator accepts on eip155:190415.
  190415: {
    delegationManager: "0xEf6d2D01af8e6313f9D544DC2AaC6a438590c2A9",
    enforcers: {
      ERC20TransferAmountEnforcer: "0x8b76d04EbB53082D258e653ddb49423ce142c546",
      RedeemerEnforcer: "0x7914D7940E7b6A2F8579FaB1c4c02CB4370700f8",
      AllowedCalldataEnforcer: "0x31c407faAFbc69868b4d8822B1a761214A04080b",
      TimestampEnforcer: "0xa5FB0F520984Ece260b9248D4Ae6A2f6350a4850",
    },
  },
};

export type Caveat = { enforcer: Address; terms: Hex; args: Hex };
export type Delegation = { delegate: Address; delegator: Address; authority: Hex; caveats: Caveat[]; salt: bigint; signature: Hex };

const DELEGATION_TYPES = {
  Delegation: [
    { name: "delegate", type: "address" },
    { name: "delegator", type: "address" },
    { name: "authority", type: "bytes32" },
    { name: "caveats", type: "Caveat[]" },
    { name: "salt", type: "uint256" },
  ],
  Caveat: [
    { name: "enforcer", type: "address" },
    { name: "terms", type: "bytes" },
  ],
} as const;

const DELEGATION_ARRAY_ABI = [
  {
    type: "tuple[]",
    components: [
      { name: "delegate", type: "address" },
      { name: "delegator", type: "address" },
      { name: "authority", type: "bytes32" },
      { name: "caveats", type: "tuple[]", components: [{ name: "enforcer", type: "address" }, { name: "terms", type: "bytes" }, { name: "args", type: "bytes" }] },
      { name: "salt", type: "uint256" },
      { name: "signature", type: "bytes" },
    ],
  },
] as const;

export function decodeDelegations(permissionContext: Hex): Delegation[] {
  const [arr] = decodeAbiParameters(DELEGATION_ARRAY_ABI, permissionContext);
  return (arr as readonly Delegation[]).map((d) => ({ ...d, caveats: [...d.caveats] }));
}
export function encodeDelegations(chain: Delegation[]): Hex {
  return encodeAbiParameters(DELEGATION_ARRAY_ABI, [chain as never]);
}
const typedMessage = (d: Delegation) => ({ delegate: d.delegate, delegator: d.delegator, authority: d.authority, caveats: d.caveats.map((c) => ({ enforcer: c.enforcer, terms: c.terms })), salt: d.salt });
/** = DelegationManager.getDelegationHash (EIP-712 struct hash). */
export function delegationHash(d: Delegation): Hex {
  return hashStruct({ data: typedMessage(d), primaryType: "Delegation", types: DELEGATION_TYPES });
}
const delegationDomain = (chainId: number) => ({ name: "DelegationManager", version: "1", chainId, verifyingContract: ERC7710_CONTRACTS[chainId].delegationManager });
/** The EIP-712 digest the delegator signed — bound to the chain and its DelegationManager. */
export function delegationDigest(chainId: number, d: Delegation): Hex {
  return hashTypedData({ domain: delegationDomain(chainId), types: DELEGATION_TYPES, primaryType: "Delegation", message: typedMessage(d) });
}

// ---- config ---------------------------------------------------------------------------------

export interface PaymentDelegation {
  chainId: number;
  /** The user's smart account the payments come from. */
  delegator: Address;
  /** Encoded signed delegation chain (root last) whose leaf is delegated to this bridge's key. */
  permissionContext: Hex;
  /** Remaining cap etc. are on-chain; this is only what the delegation says it allows. */
  caveatCount: number;
}

/**
 * Parse `HPP_PAYMENT_DELEGATION` and check it is usable by THIS key on THIS chain.
 * Throws with an operator-readable message — a misconfigured delegation must fail at boot,
 * not on the first payment.
 */
export function loadPaymentDelegation(raw: string | undefined, agent: Address, chainId: number): PaymentDelegation | undefined {
  if (!raw || raw.trim() === "") return undefined;
  const hex = raw.trim();
  if (!isHex(hex)) throw new Error("HPP_PAYMENT_DELEGATION must be the hex permissionContext the wallet issued");
  if (!ERC7710_CONTRACTS[chainId]) throw new Error(`HPP_PAYMENT_DELEGATION set but ERC-7710 contracts are not deployed on chain ${chainId}`);
  let chain: Delegation[];
  try {
    chain = decodeDelegations(hex as Hex);
  } catch (err) {
    throw new Error(`HPP_PAYMENT_DELEGATION does not decode as a delegation chain: ${(err as Error).message}`);
  }
  if (chain.length === 0) throw new Error("HPP_PAYMENT_DELEGATION holds no delegations");
  const leaf = chain[0];
  if (leaf.delegate.toLowerCase() !== agent.toLowerCase()) {
    throw new Error(`HPP_PAYMENT_DELEGATION is for ${leaf.delegate}, but this bridge's key is ${agent} — the wallet must grant it to this key`);
  }
  if (!leaf.signature || leaf.signature === "0x") throw new Error("HPP_PAYMENT_DELEGATION is unsigned");
  return { chainId, delegator: getAddress(chain[chain.length - 1].delegator), permissionContext: hex as Hex, caveatCount: leaf.caveats.length };
}

export const NETWORK_NAMES: Record<number, string> = { 181228: "HPP Sepolia", 190415: "HPP Mainnet" };
const networkName = (chainId: number) => NETWORK_NAMES[chainId] ?? `chain ${chainId}`;

/** TimestampEnforcer terms: afterThreshold(uint128) ‖ beforeThreshold(uint128); 0 = unbounded. */
export function decodeTimestampTerms(terms: Hex): { after: bigint; before: bigint } | undefined {
  if (terms.length !== 2 + 64) return undefined;
  return { after: BigInt("0x" + terms.slice(2, 34)), before: BigInt("0x" + terms.slice(34, 66)) };
}

/** What `checkPaymentDelegation` needs from the chain — a viem public client, or a stub in tests. */
export type DelegationChainReader = {
  getCode: (args: { address: Address }) => Promise<Hex | undefined>;
  readContract: (args: { address: Address; abi: readonly unknown[]; functionName: string; args: readonly unknown[] }) => Promise<unknown>;
};

export type DelegationCheck =
  | { ok: true; delegator: Address; validUntil?: number }
  /** `fatal` = the delegation can never work here (wrong network, revoked, expired); otherwise the chain could not be asked. */
  | { ok: false; fatal: boolean; reason: string };

const ERC1271_MAGIC = "0x1626ba7e";
const ERC1271_ABI = [{ type: "function", name: "isValidSignature", stateMutability: "view", inputs: [{ name: "hash", type: "bytes32" }, { name: "signature", type: "bytes" }], outputs: [{ name: "", type: "bytes4" }] }] as const;
const DM_ABI = [{ type: "function", name: "disabledDelegations", stateMutability: "view", inputs: [{ name: "", type: "bytes32" }], outputs: [{ name: "", type: "bool" }] }] as const;

/**
 * Ask the chain whether the delegation is usable on `delegation.chainId`: the signer (the user's
 * smart account) must exist there and accept the signature, and the DelegationManager must not
 * have it disabled. The signature covers the chain id and the DelegationManager address, so this
 * is also what tells a delegation issued on the other network apart — the enforcer addresses
 * are the same on both. Expiry comes from the TimestampEnforcer caveat and needs no RPC.
 */
export async function checkPaymentDelegation(delegation: PaymentDelegation, opts: { rpcUrl?: string; client?: DelegationChainReader; now?: number }): Promise<DelegationCheck> {
  const { chainId, delegator } = delegation;
  const contracts = ERC7710_CONTRACTS[chainId];
  const chain = decodeDelegations(delegation.permissionContext);
  const root = chain[chain.length - 1];
  const name = networkName(chainId);
  let validUntil: number | undefined;
  for (const c of root.caveats) {
    if (c.enforcer.toLowerCase() !== contracts.enforcers.TimestampEnforcer.toLowerCase()) continue;
    const t = decodeTimestampTerms(c.terms);
    if (t && t.before > 0n) validUntil = Number(t.before);
  }
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (validUntil !== undefined && validUntil <= now) {
    return { ok: false, fatal: true, reason: `the delegation expired on ${new Date(validUntil * 1000).toISOString()} — issue a new one in the wallet` };
  }
  const client: DelegationChainReader = opts.client ?? (createPublicClient({ transport: http(opts.rpcUrl, { timeout: 8_000 }) }) as unknown as DelegationChainReader);
  try {
    const code = await client.getCode({ address: delegator });
    if (!code || code === "0x") {
      return { ok: false, fatal: true, reason: `the paying account ${delegator} is not set up on ${name} — this delegation was most likely issued by the wallet on the other network (HPP Sepolia ↔ HPP Mainnet); re-run with the matching -n, or issue one from the ${name} wallet` };
    }
    const disabled = (await client.readContract({ address: contracts.delegationManager, abi: DM_ABI, functionName: "disabledDelegations", args: [delegationHash(root)] })) as boolean;
    if (disabled) return { ok: false, fatal: true, reason: "the delegation was revoked in the wallet — issue a new one" };
    let magic: string | undefined;
    try {
      magic = (await client.readContract({ address: delegator, abi: ERC1271_ABI, functionName: "isValidSignature", args: [delegationDigest(chainId, root), root.signature] })) as string;
    } catch {
      magic = undefined; // Kernel reverts on a bad root signature instead of returning a non-magic value
    }
    if (magic?.toLowerCase() !== ERC1271_MAGIC) {
      return { ok: false, fatal: true, reason: `the paying account ${delegator} on ${name} does not accept this delegation's signature — it was issued for a different network or account` };
    }
    return { ok: true, delegator, validUntil };
  } catch (err) {
    return { ok: false, fatal: false, reason: `could not verify the delegation on ${name}: ${(err as Error).message.split("\n")[0]}` };
  }
}

// ---- accept selection -------------------------------------------------------------------------

type AcceptLike = { scheme?: unknown; network?: unknown; extra?: unknown };

export function isErc7710Accept(a: AcceptLike | undefined | null): boolean {
  return !!a && a.scheme === "exact" && (a.extra as { assetTransferMethod?: unknown } | undefined)?.assetTransferMethod === ERC7710_METHOD;
}

/**
 * The bridge can pay an `erc7710` accept only with a delegation; without one such accepts are
 * simply not payable. With one, erc7710 comes first — the key itself may hold nothing.
 */
export function orderAccepts<T extends AcceptLike>(accepts: readonly T[], hasDelegation: boolean): T[] {
  if (!hasDelegation) return accepts.filter((a) => !isErc7710Accept(a));
  return [...accepts.filter((a) => isErc7710Accept(a)), ...accepts.filter((a) => !isErc7710Accept(a))];
}

/** erc7710 payments come out of the user's account: no top-up / balance check for the bridge key. */
export function needsOwnFunds(accept: AcceptLike | undefined | null): boolean {
  return !isErc7710Accept(accept);
}

// ---- scheme client ------------------------------------------------------------------------------

export interface Erc7710PayloadFields {
  delegationManager: Address;
  permissionContext: Hex;
  delegator: Address;
}

export function buildErc7710Payload(agentAddress: Address, delegation: PaymentDelegation, requirements: PaymentRequirements, opts: { validUntil?: bigint; salt?: bigint } = {}): { leaf: Delegation; typedData: { domain: { name: string; version: string; chainId: number; verifyingContract: Address }; types: typeof DELEGATION_TYPES; primaryType: "Delegation"; message: ReturnType<typeof typedMessage> } } {
  const contracts = ERC7710_CONTRACTS[delegation.chainId];
  const chainId = Number((requirements.network as string).split(":")[1]);
  if (chainId !== delegation.chainId) throw new Error(`payment is on chain ${chainId} but the delegation is for ${delegation.chainId}`);
  const extra = (requirements.extra ?? {}) as { facilitatorAddresses?: unknown };
  const facilitators = Array.isArray(extra.facilitatorAddresses) ? extra.facilitatorAddresses.filter((x): x is string => typeof x === "string" && isAddress(x)).map((x) => getAddress(x)) : [];
  if (facilitators.length === 0) throw new Error("erc7710 accept carries no extra.facilitatorAddresses — cannot scope the redelegation to a redeemer");
  if (!isAddress(requirements.asset) || !isAddress(requirements.payTo)) throw new Error("erc7710 accept has an invalid asset/payTo");
  const amount = BigInt(requirements.amount);
  const validUntil = opts.validUntil ?? BigInt(Math.floor(Date.now() / 1000) + Math.max(600, Number(requirements.maxTimeoutSeconds ?? 0) + 60));
  const parents = decodeDelegations(delegation.permissionContext);
  const { enforcers } = contracts;
  const leaf: Delegation = {
    delegate: ANY_DELEGATE,
    delegator: agentAddress,
    authority: delegationHash(parents[0]),
    caveats: [
      { enforcer: enforcers.RedeemerEnforcer, terms: concatHex(facilitators), args: "0x" },
      { enforcer: enforcers.ERC20TransferAmountEnforcer, terms: encodePacked(["address", "uint256"], [getAddress(requirements.asset), amount]), args: "0x" },
      { enforcer: enforcers.AllowedCalldataEnforcer, terms: concatHex([pad(toHex(4n), { size: 32 }), pad(getAddress(requirements.payTo), { size: 32 })]), args: "0x" },
      { enforcer: enforcers.TimestampEnforcer, terms: encodePacked(["uint128", "uint128"], [0n, validUntil]), args: "0x" },
    ],
    salt: opts.salt ?? BigInt(keccak256(toHex(`hpp-x402-7710-${Date.now()}-${Math.random()}`))),
    signature: "0x",
  };
  return {
    leaf,
    typedData: { domain: { name: "DelegationManager", version: "1", chainId: delegation.chainId, verifyingContract: contracts.delegationManager }, types: DELEGATION_TYPES, primaryType: "Delegation", message: typedMessage(leaf) },
  };
}

/**
 * `exact` scheme client that pays `erc7710` accepts from the delegation and everything else
 * through the upstream EIP-3009/Permit2 client. Registers in place of `new ExactEvmScheme(...)`.
 */
export class Erc7710ExactClient implements SchemeNetworkClient {
  readonly scheme = "exact";
  private readonly fallback: ExactEvmScheme;

  constructor(
    private readonly agent: LocalAccount,
    private readonly delegation: PaymentDelegation | undefined,
    fallback?: ExactEvmScheme,
  ) {
    this.fallback = fallback ?? new ExactEvmScheme(agent);
  }

  async createPaymentPayload(x402Version: number, requirements: PaymentRequirements, context?: PaymentPayloadContext): Promise<PaymentPayloadResult> {
    if (!isErc7710Accept(requirements)) return this.fallback.createPaymentPayload(x402Version, requirements, context);
    if (!this.delegation) {
      throw new Error("seller wants an ERC-7710 delegation payment but HPP_PAYMENT_DELEGATION is not set (have the wallet grant this key a payment delegation)");
    }
    const { leaf, typedData } = buildErc7710Payload(this.agent.address, this.delegation, requirements);
    const signature = await this.agent.signTypedData(typedData);
    const permissionContext = encodeDelegations([{ ...leaf, signature }, ...decodeDelegations(this.delegation.permissionContext)]);
    const payload: Erc7710PayloadFields = { delegationManager: ERC7710_CONTRACTS[this.delegation.chainId].delegationManager, permissionContext, delegator: this.delegation.delegator };
    log.info("erc7710.payload", { delegator: payload.delegator, amount: requirements.amount, payTo: requirements.payTo, redeemers: (leaf.caveats[0].terms.length - 2) / 40 });
    return { x402Version, payload: { ...payload } as Record<string, unknown> };
  }
}

export function makeExactClient(agent: LocalAccount, delegation: PaymentDelegation | undefined): Erc7710ExactClient {
  return new Erc7710ExactClient(agent, delegation);
}
