/**
 * DirectBalance — light wallet mode (Safe-less).
 *
 * The delegate EOA holds USDC.e directly (funded by sending USDC.e straight to
 * its address). No Safe, no AllowanceModule, no autoTopup — and because x402
 * settlement is gasless (the facilitator submits EIP-3009 / sponsors the upto
 * Permit2 approval), the delegate needs no native gas either. So funding the
 * wallet is a single USDC.e transfer.
 *
 * This `Funds` impl simply reads the delegate's balance before each payment and,
 * when short, throws an error whose message doubles as a funding instruction the
 * MCP host surfaces to the LLM/user.
 */
import {
  createPublicClient,
  http,
  defineChain,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";

import type { Funds } from "../funds.js";

const ERC20_BALANCE_ABI = [
  {
    type: "function",
    name: "balanceOf",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
] as const;

export class DirectBalance implements Funds {
  private readonly publicClient: PublicClient;

  constructor(
    private readonly delegate: Address,
    private readonly token: Address,
    chainId: number,
    rpcUrl: string,
  ) {
    const chain = defineChain({
      id: chainId,
      name: `chain-${chainId}`,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    });
    this.publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  }

  /**
   * Light mode never performs an on-chain topup, so this either returns null
   * (sufficient balance) or throws with a funding instruction. It never returns
   * a tx hash.
   */
  async balance(): Promise<bigint> {
    return (await this.publicClient.readContract({
      address: this.token,
      abi: ERC20_BALANCE_ABI,
      functionName: "balanceOf",
      args: [this.delegate],
    })) as bigint;
  }

  async ensure(requiredAtomic: bigint): Promise<Hex | null> {
    const balance = await this.balance();

    if (balance >= requiredAtomic) return null;

    throw new Error(
      `insufficient USDC.e: need ${requiredAtomic}, have ${balance}. ` +
        `Send USDC.e to ${this.delegate} on this network to top up ` +
        `(no native gas required).`,
    );
  }
}
