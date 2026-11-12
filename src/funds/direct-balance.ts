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
  async balance(asset?: string): Promise<bigint> {
    return (await this.publicClient.readContract({
      address: (asset as Address | undefined) ?? this.token,
      abi: ERC20_BALANCE_ABI,
      functionName: "balanceOf",
      args: [this.delegate],
    })) as bigint;
  }

  async ensure(requiredAtomic: bigint, asset?: string): Promise<Hex | null> {
    // Check the token the seller priced in, not always USDC.e: a wallet funded
    // only with another allowlisted token (e.g. CHIP) must still be able to pay.
    const balance = await this.balance(asset);

    if (balance >= requiredAtomic) return null;

    const primary = !asset || asset.toLowerCase() === this.token.toLowerCase();
    const what = primary ? "USDC.e" : `token ${asset}`;
    throw new Error(
      `insufficient ${primary ? "USDC.e" : `balance of ${what}`}: need ${requiredAtomic}, have ${balance}. ` +
        `Send ${what} to ${this.delegate} on this network to top up ` +
        `(no native gas required).`,
    );
  }
}
