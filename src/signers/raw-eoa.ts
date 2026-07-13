/**
 * RawEoaSigner — viem PrivateKeyAccount wrapped to fit `Signer`.
 *
 * The most permissive signer. Accepts a 0x-prefixed 32-byte private key
 * directly. Used as the PoC default; production deployments should layer
 * an OS keychain or wallet service in front of this.
 */
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex, PrivateKeyAccount } from "viem";

import type { Signer } from "../signer.js";

export class RawEoaSigner implements Signer {
  readonly address: Address;
  private readonly account: PrivateKeyAccount;

  constructor(privateKey: Hex) {
    this.account = privateKeyToAccount(privateKey);
    this.address = this.account.address;
  }

  /** Expose the underlying viem account for callers that need it
   *  (writeContract / sendTransaction). Not part of the Signer interface;
   *  bridge-internal use only. */
  get viemAccount(): PrivateKeyAccount {
    return this.account;
  }

  async signTypedData(args: Parameters<Signer["signTypedData"]>[0]): Promise<Hex> {
    // viem's signTypedData uses overload narrowing keyed on `primaryType`
    // and the literal `types` shape. The bridge passes user-built typed
    // data at runtime, so we widen via the loose overload.
    return this.account.signTypedData(args as Parameters<PrivateKeyAccount["signTypedData"]>[0]);
  }
}
