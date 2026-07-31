/**
 * Client for the HPP x402-discovery REST API — a curated, facilitator-indexed
 * directory of paid x402 services on the HPP chain.
 *
 * Read-only from the bridge's side: we query discovery to *find* services,
 * then pay them directly with the bridge's own wallet. Discovery never holds
 * funds or sees our keys (non-custodial).
 *
 * REST contract (hpp-x402-discovery/spec/openapi.yaml → routes/discovery.ts):
 *   GET /discovery/resources?type&network&limit&offset  -> { items: [...] }
 *   GET /discovery/search?q&type&network&sort&limit      -> { resources: [...] }
 *   GET /discovery/resources/:id                         -> ResourceDetail
 *
 * Note the envelope key differs per endpoint (`items` for the listing,
 * `resources` for search — openapi.yaml declares both shapes). We accept
 * either on both paths: assuming one key silently turned every semantic
 * search into "0 results" for the agent, since the data was there under the
 * other name.
 */
import { log } from "./log.js";

/** Curated trust signals (Bazaar's four) — surfaced so an agent can prefer
 *  services with real settlement history over freshly-listed ones. */
export interface TrustSignals {
  settlementCount?: number;
  uniquePayers?: number;
  lastSettlementAt?: string | null;
  metadataScore?: number;
  compositeScore?: number;
}

export interface DiscoveredResource {
  id: string;
  type: "http" | "mcp" | "a2a";
  resourceUrl: string;
  routeTemplate?: string;
  toolName?: string;
  skillId?: string;
  agentCardUrl?: string;
  payTo: string;
  network: string;
  asset: string;
  scheme: string;
  priceAtomic: string;
  description?: string;
  /** Seller-advertised display name (Bazaar `serviceName`). */
  serviceName?: string;
  tags?: string[];
  /** Discovery probed the endpoint's 402 challenge successfully. */
  verified?: boolean;
  trustSignals?: TrustSignals;
  httpMethod?: string;
  bodyType?: "json" | "form-data" | "text";
  transport?: "streamable-http" | "sse";
  /**
   * mcp only — the endpoint to open a session against. Distinct from
   * `resourceUrl`, which is the x402 payment identity the tool's 402 advertises
   * (`<base>/mcp/tools/<tool>`) so settlements match the listing; that path is
   * not connectable. Absent on listings registered before discovery split the
   * two, where `resourceUrl` was itself the endpoint.
   */
  mcpServerUrl?: string;
  x402Version: number;
}

/**
 * `metadata` mirrors the seller's x402 `extensions.bazaar` block: `info.input`
 * carries a concrete example of the request body, `schema` a JSON Schema for
 * it. This is the only machine-readable description of a service's input, so
 * an agent that can't see it has to guess the body — which costs a real
 * payment when the guess is wrong.
 */
export interface ResourceMetadata {
  info?: {
    input?: {
      type?: string;
      /** http */
      method?: string;
      bodyType?: string;
      body?: unknown;
      /** mcp — the seller declares the tool's argument shape here instead. */
      toolName?: string;
      transport?: string;
      inputSchema?: unknown;
      example?: unknown;
    };
    output?: { type?: string; example?: unknown };
  };
  schema?: unknown;
}

export interface DiscoveredResourceDetail extends DiscoveredResource {
  metadata?: ResourceMetadata;
}

export interface DiscoverQuery {
  /** Free-text semantic search; omit to browse the newest/highest-ranked. */
  query?: string;
  type?: "http" | "mcp" | "a2a" | "all";
  /** CAIP-2 network filter, e.g. "eip155:190415". `"all"` = no filter. */
  network?: string;
  limit?: number;
}

export class DiscoveryClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 10_000,
  ) {}

  private async get<T>(path: string): Promise<T> {
    const url = this.baseUrl.replace(/\/$/, "") + path;
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        signal: ac.signal,
        headers: { accept: "application/json" },
      });
      if (!res.ok) throw new Error(`discovery ${res.status} for ${path}`);
      return (await res.json()) as T;
    } finally {
      clearTimeout(t);
    }
  }

  /** List or semantically search the directory. */
  async discover(q: DiscoverQuery): Promise<DiscoveredResource[]> {
    const type = q.type ?? "all";
    const limit = Math.min(Math.max(q.limit ?? 20, 1), 50);
    const params = new URLSearchParams();
    params.set("type", type);
    if (q.network && q.network !== "all") params.set("network", q.network);
    params.set("limit", String(limit));

    const query = q.query?.trim();
    const path = query
      ? `/discovery/search?q=${encodeURIComponent(query)}&${params.toString()}`
      : `/discovery/resources?${params.toString()}`;

    const out = await this.get<{
      items?: DiscoveredResource[];
      resources?: DiscoveredResource[];
    }>(path);
    // Accept either envelope key — see the module header.
    const items = out.items ?? out.resources ?? [];
    log.debug("discovery.discover", { path, count: items.length });
    return items;
  }

  /** Full detail for one resource (incl. metadata.schema when present). */
  async detail(id: string): Promise<DiscoveredResourceDetail> {
    return this.get<DiscoveredResourceDetail>(
      `/discovery/resources/${encodeURIComponent(id)}`,
    );
  }
}
