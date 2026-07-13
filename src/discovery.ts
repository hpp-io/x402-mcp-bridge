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
 *   GET /discovery/search?q&type&network&sort&limit      -> { items: [...] }
 *   GET /discovery/resources/:id                         -> ResourceDetail
 */
import { log } from "./log.js";

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
  httpMethod?: string;
  bodyType?: "json" | "form-data" | "text";
  transport?: "streamable-http" | "sse";
  x402Version: number;
}

export interface DiscoveredResourceDetail extends DiscoveredResource {
  metadata?: { info?: unknown; schema?: unknown };
}

export interface DiscoverQuery {
  /** Free-text semantic search; omit to browse the newest/highest-ranked. */
  query?: string;
  type?: "http" | "mcp" | "a2a" | "all";
  /** CAIP-2 network filter, e.g. "eip155:190415". */
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
    if (q.network) params.set("network", q.network);
    params.set("limit", String(limit));

    const query = q.query?.trim();
    const path = query
      ? `/discovery/search?q=${encodeURIComponent(query)}&${params.toString()}`
      : `/discovery/resources?${params.toString()}`;

    const out = await this.get<{ items?: DiscoveredResource[] }>(path);
    const items = out.items ?? [];
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
