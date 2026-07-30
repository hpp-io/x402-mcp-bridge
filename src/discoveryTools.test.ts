import { describe, it, expect, vi } from "vitest";
import { hppDiscover, hppDescribe, hppCall } from "./discoveryTools.js";
import { x402HttpCall } from "./httpX402.js";
import type { DiscoveryClient } from "./discovery.js";

// Only hppCall touches the HTTP payment path, and these tests are about what
// hppCall does with its result — not about paying.
vi.mock("./httpX402.js", () => ({
  x402HttpCall: vi.fn(async () => ({
    content: [{ type: "text", text: '{"status":400,"body":{"error":"invalid_input"}}' }],
    isError: true,
  })),
}));

const LISTED = {
  id: "r1",
  type: "http" as const,
  resourceUrl: "https://seller.example/paid/screen",
  payTo: "0x" + "1".repeat(40),
  network: "eip155:190415",
  asset: "0x" + "2".repeat(40),
  scheme: "exact",
  priceAtomic: "1000",
  x402Version: 2,
  serviceName: "OFAC address screening",
  description: "Checks a wallet against the sanctions list.",
  tags: ["compliance", "ofac"],
  verified: true,
  trustSignals: { settlementCount: 3, uniquePayers: 1, lastSettlementAt: "2026-07-29T11:04:30Z" },
  httpMethod: "POST",
};

/** Shaped like a real bazaar block: the schema describes the envelope, and the
 *  body constraints live one level down at properties.input.properties.body. */
const DETAIL = {
  ...LISTED,
  metadata: {
    info: {
      input: { type: "http", method: "POST", bodyType: "json", body: { address: "0xabc" } },
      output: { type: "json", example: { sanctioned: false } },
    },
    schema: {
      type: "object",
      required: ["input"],
      properties: {
        input: {
          type: "object",
          required: ["type", "method", "bodyType", "body"],
          properties: {
            body: {
              type: "object",
              anyOf: [{ required: ["address"] }, { required: ["addresses"] }],
              properties: { address: { type: "string" } },
            },
            type: { const: "http" },
          },
        },
      },
    },
  },
};

function fakeClient(over: Partial<Record<"discover" | "detail", unknown>> = {}) {
  return {
    discover: vi.fn(async () => [LISTED]),
    detail: vi.fn(async () => DETAIL),
    ...over,
  } as unknown as DiscoveryClient;
}

function parse(result: { content: Array<{ text?: string }> }) {
  return JSON.parse(result.content[0].text ?? "{}");
}

describe("hpp_discover", () => {
  // Trust signals and the service name existed in the API all along but were
  // dropped before reaching the agent, leaving it to choose on price alone.
  it("surfaces name, tags, verified badge and settlement history", async () => {
    const out = parse(await hppDiscover(fakeClient(), {}) as never);
    expect(out.services[0]).toMatchObject({
      resourceId: "r1",
      name: "OFAC address screening",
      verified: true,
      trust: { settlementCount: 3, uniquePayers: 1 },
      tags: ["compliance", "ofac"],
    });
  });

  it("points the agent at hpp_describe before paying", async () => {
    const out = parse(await hppDiscover(fakeClient(), {}) as never);
    expect(out.next).toContain("hpp_describe");
  });

  // Without this default the directory hands back services on chains this
  // wallet cannot settle on; the call then fails with "no payable accept".
  it("defaults the network filter to the bridge's own network", async () => {
    const client = fakeClient();
    await hppDiscover(client, {}, "eip155:181228");
    expect(client.discover).toHaveBeenCalledWith(
      expect.objectContaining({ network: "eip155:181228" }),
    );
  });

  it("lets an explicit network (including \"all\") override the default", async () => {
    const client = fakeClient();
    await hppDiscover(client, { network: "all" }, "eip155:181228");
    expect(client.discover).toHaveBeenCalledWith(expect.objectContaining({ network: "all" }));
  });
});

describe("hpp_describe", () => {
  it("returns the seller's example body, endpoint and method", async () => {
    const out = parse(await hppDescribe(fakeClient(), { resourceId: "r1" }) as never);
    expect(out.input.exampleBody).toEqual({ address: "0xabc" });
    expect(out.endpoint).toBe("https://seller.example/paid/screen");
    expect(out.httpMethod).toBe("POST");
  });

  // The seller's schema describes the bazaar envelope; handing that to an agent
  // as "the input schema" invites it to POST {input:{type,method,...}}. Only the
  // body-level constraints are the request contract.
  it("unwraps the body schema instead of exposing the bazaar envelope", async () => {
    const out = parse(await hppDescribe(fakeClient(), { resourceId: "r1" }) as never);
    expect(out.input.bodySchema.anyOf).toEqual([
      { required: ["address"] },
      { required: ["addresses"] },
    ]);
    expect(out.input.schema).toBeUndefined();
    expect(JSON.stringify(out.input)).not.toContain("bodyType");
  });

  it("omits a placeholder body schema that says nothing", async () => {
    const placeholder = {
      ...LISTED,
      metadata: {
        info: { input: { body: { input: "world" } } },
        schema: { properties: { input: { properties: { body: { type: "object" } } } } },
      },
    };
    const out = parse(
      await hppDescribe(fakeClient({ detail: vi.fn(async () => placeholder) }), {
        resourceId: "r1",
      }) as never,
    );
    expect(out.input.exampleBody).toEqual({ input: "world" });
    expect(out.input.bodySchema).toBeUndefined();
  });

  it("says so plainly when the seller declared no input contract", async () => {
    const bare = { ...LISTED, metadata: { info: {}, schema: {} } };
    const out = parse(
      await hppDescribe(fakeClient({ detail: vi.fn(async () => bare) }), {
        resourceId: "r1",
      }) as never,
    );
    expect(String(out.input)).toContain("not declared");
  });

  it("reports a lookup failure instead of throwing", async () => {
    const client = fakeClient({
      detail: vi.fn(async () => {
        throw new Error("discovery 404 for /discovery/resources/nope");
      }),
    });
    const res = await hppDescribe(client, { resourceId: "nope" });
    expect(res.isError).toBe(true);
  });

  it("requires a resourceId", async () => {
    const res = await hppDescribe(fakeClient(), {} as never);
    expect(res.isError).toBe(true);
  });
});

describe("hpp_call network guard", () => {
  const deps = {
    signer: { address: "0x" + "9".repeat(40) },
    network: "eip155:181228",
  } as never;

  // Cheap guard on purpose: without it a cross-chain resourceId costs a
  // connection (and, on some paths, a confusing SDK-internal error) before
  // anyone learns the wallet simply can't settle there.
  it("refuses a resource priced on another network before connecting", async () => {
    const client = fakeClient(); // LISTED is eip155:190415
    const res = await hppCall(deps, client, { resourceId: "r1", body: {} });
    expect(res.isError).toBe(true);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain("eip155:190415");
    expect(text).toContain("eip155:181228");
    expect(x402HttpCall).not.toHaveBeenCalled();
  });
});

describe("hpp_call failure hint", () => {
  const deps = {
    signer: { address: "0x" + "9".repeat(40) },
    network: "eip155:181228",
  } as never;
  const sameNetwork = {
    ...DETAIL,
    network: "eip155:181228",
  };

  // A rejected body is the agent's most likely mistake, and the call result
  // alone doesn't say what the service wanted — so it would retry blind, paying
  // each attempt on sellers that settle before validating.
  it("appends the declared input contract when the call fails", async () => {
    const client = fakeClient({ detail: vi.fn(async () => sameNetwork) });
    const res = await hppCall(deps, client, { resourceId: "r1", body: { wrong: 1 } });
    expect(res.isError).toBe(true);
    const hint = JSON.parse((res.content[1] as { text: string }).text);
    expect(hint.exampleBody).toEqual({ address: "0xabc" });
    expect(hint.bodySchema).toBeDefined();
  });

  it("leaves a successful result untouched", async () => {
    vi.mocked(x402HttpCall).mockResolvedValueOnce({
      content: [{ type: "text", text: '{"status":200}' }],
      isError: false,
    } as never);
    const client = fakeClient({ detail: vi.fn(async () => sameNetwork) });
    const res = await hppCall(deps, client, { resourceId: "r1", body: {} });
    expect(res.content).toHaveLength(1);
  });
});

describe("mcp endpoint vs payment identity", () => {
  const deps = {
    signer: { address: "0x" + "9".repeat(40) },
    network: "eip155:181228",
  } as never;
  const mcpRow = {
    ...DETAIL,
    network: "eip155:181228",
    type: "mcp" as const,
    toolName: "compute_freqtrade",
    // What discovery stores today: the payment identity, which is NOT connectable.
    resourceUrl: "https://seller.example/mcp/tools/compute_freqtrade",
    mcpServerUrl: "https://seller.example/mcp",
    transport: "streamable-http" as const,
  };

  it("describe reports the endpoint to connect to, not just the identity", async () => {
    const out = parse(
      await hppDescribe(fakeClient({ detail: vi.fn(async () => mcpRow) }), {
        resourceId: "r1",
      }) as never,
    );
    expect(out.mcpServerUrl).toBe("https://seller.example/mcp");
    expect(out.endpoint).toBe("https://seller.example/mcp/tools/compute_freqtrade");
  });

  // Older listings predate the split and put the endpoint in resourceUrl.
  it("falls back to resourceUrl when the listing has no endpoint field", async () => {
    const legacy = { ...mcpRow, mcpServerUrl: undefined, resourceUrl: "https://seller.example/mcp" };
    const out = parse(
      await hppDescribe(fakeClient({ detail: vi.fn(async () => legacy) }), {
        resourceId: "r1",
      }) as never,
    );
    expect(out.mcpServerUrl).toBe("https://seller.example/mcp");
  });
});
