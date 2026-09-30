import { describe, it, expect } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { encodeAbiParameters, type Hex } from "viem";
import type { PaymentRequirements } from "@x402/core/types";
import {
  ANY_DELEGATE,
  ERC7710_CONTRACTS,
  Erc7710ExactClient,
  decodeDelegations,
  delegationHash,
  encodeDelegations,
  isErc7710Accept,
  loadPaymentDelegation,
  needsOwnFunds,
  orderAccepts,
  type Delegation,
} from "./erc7710.js";

const agent = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const USER = "0x33019d8BE92937016371E22C710ABB71fACde773";
const F = "0x050BC3f099f0489D89b94C46Fa7DcEDf8aD7C7E0";
const USDC = "0x401eCb1D350407f13ba348573E5630B83638E30D";
const PAY_TO = "0x9Dc2A176Ca65D982854CDe9BE84Dc7028236ba2c";
const { enforcers, delegationManager } = ERC7710_CONTRACTS[181228];

const root = (delegate = agent.address): Delegation => ({
  delegate,
  delegator: USER,
  authority: ("0x" + "ff".repeat(32)) as Hex,
  caveats: [{ enforcer: enforcers.ERC20TransferAmountEnforcer, terms: "0x01", args: "0x" }],
  salt: 1n,
  signature: ("0x00" + "ab".repeat(65)) as Hex,
});
const ctx = (d = root()) => encodeDelegations([d]);

const erc7710Accept = { scheme: "exact", network: "eip155:181228", amount: "10000", asset: USDC, payTo: PAY_TO, maxTimeoutSeconds: 60, extra: { assetTransferMethod: "erc7710", facilitatorAddresses: [F], name: "USDC.e", version: "2" } };
const eip3009Accept = { scheme: "exact", network: "eip155:181228", amount: "10000", asset: USDC, payTo: PAY_TO, maxTimeoutSeconds: 60, extra: { name: "USDC.e", version: "2" } };
const uptoAccept = { scheme: "upto", network: "eip155:181228", amount: "10000", asset: USDC, payTo: PAY_TO, maxTimeoutSeconds: 60 };

describe("accept selection", () => {
  it("recognises erc7710 accepts only on exact", () => {
    expect(isErc7710Accept(erc7710Accept)).toBe(true);
    expect(isErc7710Accept(eip3009Accept)).toBe(false);
    expect(isErc7710Accept({ ...uptoAccept, extra: { assetTransferMethod: "erc7710" } })).toBe(false);
    expect(isErc7710Accept(undefined)).toBe(false);
  });
  it("without a delegation erc7710 accepts are dropped; with one they come first (seller order kept otherwise)", () => {
    const offered = [eip3009Accept, erc7710Accept, uptoAccept];
    expect(orderAccepts(offered, false)).toEqual([eip3009Accept, uptoAccept]);
    expect(orderAccepts(offered, true)).toEqual([erc7710Accept, eip3009Accept, uptoAccept]);
    expect(orderAccepts([erc7710Accept], false)).toEqual([]);
  });
  it("erc7710 payments need no funds on the bridge key", () => {
    expect(needsOwnFunds(erc7710Accept)).toBe(false);
    expect(needsOwnFunds(eip3009Accept)).toBe(true);
    expect(needsOwnFunds(undefined)).toBe(true);
  });
});

describe("loadPaymentDelegation", () => {
  it("accepts a signed delegation to this key and reports the user's account", () => {
    const d = loadPaymentDelegation(ctx(), agent.address, 181228);
    expect(d).toMatchObject({ chainId: 181228, delegator: USER, caveatCount: 1 });
    expect(d?.permissionContext).toBe(ctx());
  });
  it("is optional", () => {
    expect(loadPaymentDelegation(undefined, agent.address, 181228)).toBeUndefined();
    expect(loadPaymentDelegation("  ", agent.address, 181228)).toBeUndefined();
  });
  it("rejects delegations for another key, unsigned ones, junk, and unsupported chains at boot", () => {
    expect(() => loadPaymentDelegation(ctx(root(USER)), agent.address, 181228)).toThrow(/is for 0x33019d.*this bridge's key/);
    expect(() => loadPaymentDelegation(encodeDelegations([{ ...root(), signature: "0x" }]), agent.address, 181228)).toThrow(/unsigned/);
    expect(() => loadPaymentDelegation("0x1234", agent.address, 181228)).toThrow(/does not decode/);
    expect(() => loadPaymentDelegation("nope", agent.address, 181228)).toThrow(/hex permissionContext/);
    expect(() => loadPaymentDelegation(ctx(), agent.address, 1)).toThrow(/not deployed on chain 1/);
    expect(() => loadPaymentDelegation(encodeAbiParameters([{ type: "tuple[]", components: [{ name: "a", type: "uint256" }] }], [[]]), agent.address, 181228)).toThrow(/no delegations/);
  });
});

describe("Erc7710ExactClient", () => {
  const delegation = loadPaymentDelegation(ctx(), agent.address, 181228)!;
  const fallback = { createPaymentPayload: async (v: number) => ({ x402Version: v, payload: { via: "fallback" } }) } as never;

  it("routes non-erc7710 accepts to the upstream EIP-3009 client", async () => {
    const c = new Erc7710ExactClient(agent, delegation, fallback);
    expect(await c.createPaymentPayload(2, eip3009Accept as PaymentRequirements)).toEqual({ x402Version: 2, payload: { via: "fallback" } });
  });

  it("refuses an erc7710 accept without a delegation, with an operator-readable message", async () => {
    const c = new Erc7710ExactClient(agent, undefined, fallback);
    await expect(c.createPaymentPayload(2, erc7710Accept as PaymentRequirements)).rejects.toThrow(/HPP_PAYMENT_DELEGATION is not set/);
  });

  it("signs a per-payment redelegation: ANY_DELEGATE, redeemer=facilitators, amount, payTo, expiry; root appended", async () => {
    const c = new Erc7710ExactClient(agent, delegation, fallback);
    const r = await c.createPaymentPayload(2, erc7710Accept as PaymentRequirements);
    const p = r.payload as { delegationManager: string; permissionContext: Hex; delegator: string };
    expect(p.delegationManager).toBe(delegationManager);
    expect(p.delegator).toBe(USER);
    const [leaf, parent] = decodeDelegations(p.permissionContext);
    expect(leaf.delegate).toBe(ANY_DELEGATE);
    expect(leaf.delegator).toBe(agent.address);
    expect(leaf.authority).toBe(delegationHash(root()));
    expect(leaf.caveats.map((x) => x.enforcer)).toEqual([enforcers.RedeemerEnforcer, enforcers.ERC20TransferAmountEnforcer, enforcers.AllowedCalldataEnforcer, enforcers.TimestampEnforcer]);
    expect(leaf.caveats[0].terms.toLowerCase()).toBe(F.toLowerCase()); // packed 20-byte address
    expect(leaf.caveats[1].terms.toLowerCase()).toBe((USDC + (10000n).toString(16).padStart(64, "0")).toLowerCase());
    expect(leaf.caveats[2].terms.toLowerCase()).toBe(("0x" + "4".padStart(64, "0") + PAY_TO.slice(2).padStart(64, "0")).toLowerCase());
    expect(leaf.signature.length).toBe(2 + 130); // EOA ECDSA
    expect(parent).toEqual(root());
  });

  it("rejects an erc7710 accept that names no facilitator or another chain", async () => {
    const c = new Erc7710ExactClient(agent, delegation, fallback);
    await expect(c.createPaymentPayload(2, { ...erc7710Accept, extra: { assetTransferMethod: "erc7710" } } as PaymentRequirements)).rejects.toThrow(/facilitatorAddresses/);
    await expect(c.createPaymentPayload(2, { ...erc7710Accept, network: "eip155:1" } as PaymentRequirements)).rejects.toThrow(/chain 1 but the delegation is for 181228/);
  });
});
