import { describe, it, expect, vi, afterEach } from "vitest";
import { DiscoveryClient } from "./discovery.js";

/** Capture the URL the client fetched, and reply with a fixed JSON body. */
function stubFetch(body: unknown) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(String(url));
      return { ok: true, status: 200, json: async () => body } as unknown as Response;
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

const RESOURCE = {
  id: "r1",
  type: "http" as const,
  resourceUrl: "https://seller.example/paid/x",
  payTo: "0x" + "1".repeat(40),
  network: "eip155:181228",
  asset: "0x" + "2".repeat(40),
  scheme: "exact",
  priceAtomic: "1000",
  x402Version: 2,
};

describe("DiscoveryClient.discover", () => {
  it("reads the listing envelope (`items`)", async () => {
    stubFetch({ items: [RESOURCE] });
    const out = await new DiscoveryClient("https://d.example").discover({});
    expect(out).toHaveLength(1);
  });

  // Regression: /discovery/search answers with `resources`, not `items`. Reading
  // only `items` turned every semantic search into "0 results" even though the
  // directory had matched — the failure was silent, which is why it survived.
  it("reads the search envelope (`resources`)", async () => {
    stubFetch({ resources: [RESOURCE], total: 1, searchMethod: "hybrid" });
    const out = await new DiscoveryClient("https://d.example").discover({ query: "price" });
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("r1");
  });

  it("hits /discovery/search when a query is given, /discovery/resources otherwise", async () => {
    const calls = stubFetch({ items: [] });
    const client = new DiscoveryClient("https://d.example");
    await client.discover({ query: "image generation" });
    await client.discover({});
    expect(calls[0]).toContain("/discovery/search?q=image%20generation");
    expect(calls[1]).toContain("/discovery/resources?");
  });

  it('passes a network filter through, and treats "all" as no filter', async () => {
    const calls = stubFetch({ items: [] });
    const client = new DiscoveryClient("https://d.example");
    await client.discover({ network: "eip155:190415" });
    await client.discover({ network: "all" });
    expect(calls[0]).toContain("network=eip155%3A190415");
    expect(calls[1]).not.toContain("network=");
  });

  it("clamps limit to the API's 1..50 range", async () => {
    const calls = stubFetch({ items: [] });
    const client = new DiscoveryClient("https://d.example");
    await client.discover({ limit: 999 });
    await client.discover({ limit: 0 });
    expect(calls[0]).toContain("limit=50");
    expect(calls[1]).toContain("limit=1");
  });
});
