import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DirectBalance } from "./direct-balance.js";

const USDC = "0x401eCb1D350407f13ba348573E5630B83638E30D";
const CHIP = "0x0Ac610E77ec39AB5c6B402B376548Ac02ACc5a48";
const DELEGATE = "0x00000000000000000000000000000000000000d1";

// Minimal JSON-RPC stub: balanceOf answers depend on which token is called.
const held: Record<string, bigint> = { [USDC.toLowerCase()]: 0n, [CHIP.toLowerCase()]: 50_000n };
let server: Server;
let rpc: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const one = (m: { id: number; method: string; params?: [{ to?: string }] }) => {
        const to = m.params?.[0]?.to?.toLowerCase() ?? "";
        const result = m.method === "eth_chainId" ? "0x2c3ec" : "0x" + (held[to] ?? 0n).toString(16).padStart(64, "0");
        return { jsonrpc: "2.0", id: m.id, result };
      };
      const body = JSON.parse(raw);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  rpc = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("DirectBalance (per-token funds check)", () => {
  const funds = () => new DirectBalance(DELEGATE, USDC, 181228, rpc);

  it("checks the token the seller priced in, not always USDC.e", async () => {
    // Holds CHIP only: a CHIP-priced payment passes, a USDC.e-priced one does not.
    await expect(funds().ensure(10_000n, CHIP)).resolves.toBeNull();
    await expect(funds().ensure(10_000n, USDC)).rejects.toThrow(/insufficient USDC\.e/);
    await expect(funds().ensure(10_000n)).rejects.toThrow(/insufficient USDC\.e/);
  });

  it("names the token in the funding instruction when it is not USDC.e", async () => {
    await expect(funds().ensure(60_000n, CHIP)).rejects.toThrow(new RegExp(`token ${CHIP}.*need 60000, have 50000`));
  });

  it("reads the balance of any token, defaulting to USDC.e", async () => {
    expect(await funds().balance()).toBe(0n);
    expect(await funds().balance(CHIP.toLowerCase())).toBe(50_000n);
  });
});
