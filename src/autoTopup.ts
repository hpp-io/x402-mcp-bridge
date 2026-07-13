/**
 * AutoTopup — pulls USDC.e from the user's Safe to the delegate EOA via
 * AllowanceModule.executeAllowanceTransfer.
 *
 * Triggered lazily before each x402 payment when the delegate's balance
 * is insufficient. The chain enforces the daily cap; if a topup would
 * exceed the allowance the call reverts with
 *
 *   "newSpent > allowance.spent && newSpent <= allowance.amount"
 *
 * which the bridge maps to a clear "spend cap exceeded" error for the
 * MCP host (and therefore the LLM and the user).
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  defineChain,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";

import type { Signer } from "./signer.js";
import type { Funds } from "./funds.js";
import { RawEoaSigner } from "./signers/raw-eoa.js";

const ERC20_BALANCE_ABI = [
  {
    type: "function",
    name: "balanceOf",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
] as const;

const ALLOWANCE_ABI = [
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
  {
    type: "function",
    name: "executeAllowanceTransfer",
    inputs: [
      { name: "safe", type: "address" },
      { name: "token", type: "address" },
      { name: "to", type: "address" },
      { name: "amount", type: "uint96" },
      { name: "paymentToken", type: "address" },
      { name: "payment", type: "uint96" },
      { name: "delegate", type: "address" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

export interface AutoTopupOptions {
  /** PoC-only: explicit pull amount (atomic). If unset, a dynamic value
   *  based on `requiredAtomic` × headroom is used. */
  fixedAmountAtomic?: bigint;
  /** Headroom multiplier for dynamic topup. Default 10. */
  headroomX?: bigint;
}

export class AutoTopup implements Funds {
  private readonly publicClient: PublicClient;
  private readonly walletClient: WalletClient;

  constructor(
    private readonly signer: Signer,
    private readonly safe: Address,
    private readonly allowanceModule: Address,
    private readonly token: Address,
    private readonly chainId: number,
    private readonly rpcUrl: string,
    private readonly opts: AutoTopupOptions = {},
  ) {
    if (!(signer instanceof RawEoaSigner)) {
      // The contract calls below require a viem-account-shaped signer.
      // The Signer interface itself doesn't yet expose `sendTransaction`,
      // so the autoTopup path currently requires RawEoaSigner. When new
      // signer kinds land we'll widen this through a `tx.send` helper.
      throw new Error(
        "AutoTopup currently requires RawEoaSigner; other signer types pending",
      );
    }
    const chain = defineChain({
      id: chainId,
      name: `chain-${chainId}`,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    });
    this.publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
    this.walletClient = createWalletClient({
      chain,
      transport: http(rpcUrl),
      account: signer.viemAccount,
    });
  }

  /**
   * Ensure the delegate holds at least `requiredAtomic` of `token`.
   * No-op when balance already sufficient. Returns the topup tx hash
   * (or null if no topup was needed).
   */
  async ensure(requiredAtomic: bigint): Promise<Hex | null> {
    const balance = await this.balanceOfDelegate();
    if (balance >= requiredAtomic) return null;

    const need = requiredAtomic - balance;
    const headroom = this.opts.headroomX ?? 10n;
    const wanted =
      this.opts.fixedAmountAtomic ?? need * headroom > 0n
        ? this.opts.fixedAmountAtomic ?? need * headroom
        : need;

    // Cap at remaining allowance to avoid the (otherwise inevitable) revert.
    const remaining = await this.remainingAllowance();
    const amount = wanted > remaining ? remaining : wanted;
    if (amount < need) {
      throw new Error(
        `spend cap exceeded — required ${requiredAtomic} but only ${
          balance + remaining
        } available before allowance reset`,
      );
    }

    return this.execute(amount);
  }

  /** Funds interface: the delegate's immediately-spendable balance. */
  async balance(): Promise<bigint> {
    return this.balanceOfDelegate();
  }

  /** Read delegate's current ERC-20 balance. */
  private async balanceOfDelegate(): Promise<bigint> {
    return (await this.publicClient.readContract({
      address: this.token,
      abi: ERC20_BALANCE_ABI,
      functionName: "balanceOf",
      args: [this.signer.address],
    })) as bigint;
  }

  /** allowance.amount - allowance.spent (after on-chain auto-reset, which
   *  AllowanceModule applies inside getTokenAllowance). */
  private async remainingAllowance(): Promise<bigint> {
    const a = (await this.publicClient.readContract({
      address: this.allowanceModule,
      abi: ALLOWANCE_ABI,
      functionName: "getTokenAllowance",
      args: [this.safe, this.signer.address, this.token],
    })) as readonly [bigint, bigint, bigint, bigint, bigint];
    if (a[0] === 0n) return 0n;
    return a[1] >= a[0] ? 0n : a[0] - a[1];
  }

  /** Sign + send AllowanceModule.executeAllowanceTransfer. */
  private async execute(amountAtomic: bigint): Promise<Hex> {
    const a = (await this.publicClient.readContract({
      address: this.allowanceModule,
      abi: ALLOWANCE_ABI,
      functionName: "getTokenAllowance",
      args: [this.safe, this.signer.address, this.token],
    })) as readonly [bigint, bigint, bigint, bigint, bigint];
    const nonce = Number(a[4]);

    const signature = await this.signer.signTypedData({
      domain: { chainId: this.chainId, verifyingContract: this.allowanceModule },
      types: {
        AllowanceTransfer: [
          { name: "safe", type: "address" },
          { name: "token", type: "address" },
          { name: "to", type: "address" },
          { name: "amount", type: "uint96" },
          { name: "paymentToken", type: "address" },
          { name: "payment", type: "uint96" },
          { name: "nonce", type: "uint16" },
        ],
      },
      primaryType: "AllowanceTransfer",
      message: {
        safe: this.safe,
        token: this.token,
        to: this.signer.address,
        amount: amountAtomic,
        paymentToken: "0x0000000000000000000000000000000000000000",
        payment: 0n,
        nonce,
      },
    });

    const txHash = await this.walletClient.writeContract({
      address: this.allowanceModule,
      abi: ALLOWANCE_ABI,
      functionName: "executeAllowanceTransfer",
      args: [
        this.safe,
        this.token,
        this.signer.address,
        amountAtomic,
        "0x0000000000000000000000000000000000000000",
        0n,
        this.signer.address,
        signature,
      ],
      chain: null,
      account: (this.signer as RawEoaSigner).viemAccount,
    });
    await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    return txHash;
  }
}
