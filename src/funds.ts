/**
 * Funds — abstraction over "ensure the delegate can cover this payment".
 *
 * Two implementations back the two wallet modes:
 *   - AutoTopup (Safe mode): pulls USDC.e from the user's Safe to the delegate
 *     EOA via AllowanceModule.executeAllowanceTransfer, within the on-chain
 *     daily cap, when the delegate balance is short.
 *   - DirectBalance (light mode): the delegate EOA holds USDC.e directly; this
 *     impl only verifies the balance and surfaces a clear funding instruction
 *     when short — no Safe, no on-chain topup, no native gas.
 *
 * The payment path (client.ts onPaymentRequested) depends only on this
 * interface, so the two modes share a single code path.
 */
import type { Hex } from "viem";

export interface Funds {
  /**
   * Ensure the delegate holds at least `requiredAtomic` of the payment asset
   * before the x402 payment is signed.
   *
   * Returns the topup tx hash when an on-chain refill was performed (Safe mode),
   * or `null` when no action was needed (already sufficient). Throws a clear,
   * host-surfaceable error when funds are insufficient and cannot be topped up.
   */
  ensure(requiredAtomic: bigint): Promise<Hex | null>;

  /**
   * The delegate's current balance of the payment asset (atomic units) — the
   * immediately-spendable balance. In Safe mode the Safe can top up more on
   * demand (see {@link ensure}).
   */
  balance(): Promise<bigint>;
}
