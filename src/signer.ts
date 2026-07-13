/**
 * Signer abstraction.
 *
 * The bridge needs two signing capabilities:
 *   1. EIP-712 typed-data — for x402 EIP-3009 transferWithAuthorization
 *      and AllowanceModule.AllowanceTransfer.
 *   2. Generic transactions — for sending the executeAllowanceTransfer
 *      call (the delegate is the tx sender + payer of gas).
 *
 * The PoC implementation is a raw-key viem account (`signers/raw-eoa.ts`).
 * Future implementations swap in:
 *   - OS keychain wrapper (still raw key, just unsealed lazily)
 *   - HPP self-hosted server-wallet API (HTTP signing)
 *   - Coinbase CDP / Turnkey / Privy (if HPP support arrives)
 *   - ERC-4337 smart account session keys
 *
 * Importantly, x402 EIP-3009 verification on USDC.e (FiatTokenV2_2) accepts
 * EIP-1271 contract signatures (verified 2026-04-30) — so a *contract*
 * wallet (Safe, smart account) can also fit this interface, returning a
 * Safe-format signature blob from `signTypedData`.
 */
import type { Address, Hex, TypedDataDomain } from "viem";

export interface Signer {
  /** Address that x402 / AllowanceModule sees as the signer / sender. */
  readonly address: Address;

  /**
   * Sign EIP-712 typed data. The bridge uses this for:
   *   - EIP-3009 TransferWithAuthorization (x402 payment)
   *   - AllowanceModule AllowanceTransfer (autoTopup)
   *
   * Returns the signature in the form the verifier expects:
   *   - EOA: 65-byte ECDSA (r ‖ s ‖ v)
   *   - Contract wallet: implementation-specific blob accepted by
   *     EIP-1271 isValidSignature
   */
  signTypedData(args: {
    domain: TypedDataDomain;
    types: Record<string, { name: string; type: string }[]>;
    primaryType: string;
    message: Record<string, unknown>;
  }): Promise<Hex>;
}
