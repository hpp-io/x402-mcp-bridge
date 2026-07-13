/**
 * Smoke test for the built bridge.
 *
 * Spawns dist/index.js as a stdio MCP subprocess (exactly like Claude
 * Desktop would) and exercises:
 *   1) listTools — free, just upstream proxy
 *   2) callTool compute_hello-world — paid; if delegate has balance,
 *      pays directly; if not, triggers autoTopup
 *
 * Expects all bridge env to be set in the calling shell. Reads the
 * resource-server URL from RESOURCE_SERVER_URL.
 *
 * Run:
 *   pnpm build
 *   <env...> npx tsx scripts/smoke.ts
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const bridgeEntry = resolve(here, "..", "dist", "index.js");

async function main() {
  const transport = new StdioClientTransport({
    command: process.execPath, // node binary
    args: [bridgeEntry],
    env: process.env as Record<string, string>,
  });

  const client = new Client({ name: "bridge-smoke", version: "0.0.1" });
  await client.connect(transport);
  console.log("✅ connected to bridge");

  const tools = await client.listTools();
  console.log(`📋 listTools (${tools.tools.length}):`);
  for (const t of tools.tools) {
    console.log(`   - ${t.name}: ${t.description?.slice(0, 60) ?? ""}`);
  }

  const target = tools.tools.find((t) => t.name === "compute_hello-world");
  if (!target) {
    console.error("❌ compute_hello-world not found upstream");
    await client.close();
    process.exit(1);
  }

  console.log("\n🔧 callTool compute_hello-world (paid)");
  const result = await client.callTool({
    name: "compute_hello-world",
    arguments: { args: { prompt: "smoke from bridge" } },
  });

  const content = result.content as Array<{ type: string; text?: string }>;
  for (const c of content ?? []) {
    if (c.type === "text") {
      console.log("   text:", String(c.text ?? "").slice(0, 200));
    }
  }
  console.log("   isError:", result.isError ?? false);

  await client.close();
  console.log("\n🎉 bridge smoke OK");
}

main().catch((err) => {
  console.error("❌ smoke fail:", (err as Error).message);
  process.exit(1);
});
