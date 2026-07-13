/**
 * hpp-x402-policy — manage the host policy file (`~/.hpp-x402/policy.json`)
 * that the `x402_http_call` tool reads for per-host auth-header injection and
 * spend guardrails. Editing the JSON by hand works too; this is a convenience
 * wrapper (mirrors hpp-x402-keychain).
 *
 * Usage:
 *   hpp-x402-policy path                         print the policy file path
 *   hpp-x402-policy show                         print the full policy JSON
 *   hpp-x402-policy list                         summarize configured hosts
 *   hpp-x402-policy set <host> [flags]           add/update a host entry
 *       --header NAME=SOURCE     (repeatable)    e.g. X-Api-Key=file:~/.hpphub/config.json#api_key
 *       --max-per-call <usdc>                    e.g. 5  (stored atomic, 6 dec)
 *       --cooldown-ms <n>                        min ms between paid calls
 *       --https <true|false>                     require https (default true)
 *   hpp-x402-policy unset <host>                 remove a host entry
 *   hpp-x402-policy unset <host> --header NAME   remove a single header
 *   hpp-x402-policy defaults [flags]             set _defaults
 *       --allow-unlisted <true|false>            allow non-listed hosts (default false)
 *       --max-per-call <usdc> / --https <bool>   default limits
 *
 * value-source for headers: file:<path>#<field> | env:<VAR> |
 *   keychain://<svc>/<acct> | literal:<value>
 */
import {
  loadPolicy,
  savePolicy,
  policyFilePath,
  type PolicyFile,
  type HostPolicy,
  type HostLimits,
  type PolicyDefaults,
} from "../policy.js";

const USDC_DECIMALS = 6; // USDC.e
const SOURCE_PREFIXES = ["file:", "env:", "keychain://", "literal:"];

function usage(): never {
  process.stderr.write(
    [
      "hpp-x402-policy — manage ~/.hpp-x402/policy.json (host auth + spend guardrails)",
      "",
      "Usage:",
      "  hpp-x402-policy path",
      "  hpp-x402-policy show",
      "  hpp-x402-policy list",
      "  hpp-x402-policy set <host> [--header NAME=SOURCE]... [--max-per-call <usdc>]",
      "                            [--cooldown-ms <n>] [--https <true|false>]",
      "  hpp-x402-policy unset <host> [--header NAME]",
      "  hpp-x402-policy defaults [--allow-unlisted <true|false>] [--max-per-call <usdc>] [--https <true|false>]",
      "",
      "value-source: file:<path>#<field> | env:<VAR> | keychain://<svc>/<acct> | literal:<value>",
      "example: hpp-x402-policy set hub-stage.hpp.io \\",
      "           --header X-Api-Key=file:~/.hpphub/config.json#api_key --max-per-call 5 --cooldown-ms 300000",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

interface ParsedArgs {
  cmd: string;
  host?: string;
  headers: Array<{ name: string; source: string }>;
  removeHeader?: string;
  maxPerCall?: string; // USDC string
  cooldownMs?: string;
  https?: string;
  allowUnlisted?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  const cmd = args[0] ?? "help";
  const out: ParsedArgs = { cmd, headers: [] };
  const rest = args.slice(1);
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const key = a.slice(2);
    const val = rest[i + 1];
    const takeVal = () => {
      if (val === undefined || val.startsWith("--")) throw new Error(`--${key} needs a value`);
      i++;
      return val;
    };
    switch (key) {
      case "header": {
        const v = takeVal();
        if (out.cmd === "unset") {
          out.removeHeader = v; // unset --header NAME
        } else {
          const eq = v.indexOf("=");
          if (eq === -1) throw new Error(`--header expects NAME=SOURCE, got "${v}"`);
          out.headers.push({ name: v.slice(0, eq), source: v.slice(eq + 1) });
        }
        break;
      }
      case "max-per-call": out.maxPerCall = takeVal(); break;
      case "cooldown-ms": out.cooldownMs = takeVal(); break;
      case "https": out.https = takeVal(); break;
      case "allow-unlisted": out.allowUnlisted = takeVal(); break;
      default: throw new Error(`unknown flag --${key}`);
    }
  }
  out.host = positional[0];
  return out;
}

function usdcToAtomic(usdc: string): string {
  const n = Number(usdc);
  if (!Number.isFinite(n) || n < 0) throw new Error(`invalid amount: ${usdc}`);
  return String(Math.round(n * 10 ** USDC_DECIMALS));
}
function atomicToUsdc(a?: string): string {
  return a == null ? "-" : String(Number(a) / 10 ** USDC_DECIMALS);
}
function parseBool(s: string): boolean {
  if (s === "true") return true;
  if (s === "false") return false;
  throw new Error(`expected true|false, got "${s}"`);
}

function buildLimits(base: HostLimits | undefined, a: ParsedArgs): HostLimits {
  const limits: HostLimits = { ...(base ?? {}) };
  if (a.maxPerCall !== undefined) limits.maxPerCallAtomic = usdcToAtomic(a.maxPerCall);
  if (a.cooldownMs !== undefined) limits.cooldownMs = Number(a.cooldownMs);
  if (a.https !== undefined) limits.requireHttps = parseBool(a.https);
  return limits;
}

export function run(): void {
  const a = parseArgs(process.argv);

  if (a.cmd === "help") usage();

  if (a.cmd === "path") {
    process.stdout.write(policyFilePath() + "\n");
    return;
  }

  const policy: PolicyFile = loadPolicy();

  if (a.cmd === "show") {
    process.stdout.write(JSON.stringify(policy, null, 2) + "\n");
    return;
  }

  if (a.cmd === "list") {
    const hosts = Object.keys(policy).filter((k) => k !== "_defaults");
    if (hosts.length === 0) {
      process.stdout.write("(no hosts configured)\n");
      return;
    }
    const d = policy._defaults;
    if (d) process.stdout.write(`_defaults: allowUnlisted=${d.allowUnlisted ?? false} maxPerCall=${atomicToUsdc(d.limits?.maxPerCallAtomic)} https=${d.limits?.requireHttps ?? true}\n`);
    for (const h of hosts) {
      const hp = policy[h] as HostPolicy;
      const hdrs = Object.keys(hp.headers ?? {}).join(", ") || "(none)";
      const l = hp.limits ?? {};
      process.stdout.write(
        `${h}\n  headers: ${hdrs}\n  maxPerCall: ${atomicToUsdc(l.maxPerCallAtomic)}  cooldownMs: ${l.cooldownMs ?? "-"}  https: ${l.requireHttps ?? true}\n`,
      );
    }
    return;
  }

  if (a.cmd === "set") {
    if (!a.host) throw new Error("set requires <host>");
    if (a.headers.some((h) => !SOURCE_PREFIXES.some((p) => h.source.startsWith(p)))) {
      throw new Error(`header source must start with one of: ${SOURCE_PREFIXES.join(", ")}`);
    }
    const existing = (policy[a.host] as HostPolicy | undefined) ?? {};
    const headers = { ...(existing.headers ?? {}) };
    for (const h of a.headers) headers[h.name] = h.source;
    const next: HostPolicy = { ...existing };
    if (Object.keys(headers).length) next.headers = headers;
    const limits = buildLimits(existing.limits, a);
    if (Object.keys(limits).length) next.limits = limits;
    policy[a.host] = next;
    savePolicy(policy);
    process.stdout.write(`✓ set ${a.host}\n  headers: ${Object.keys(next.headers ?? {}).join(", ") || "(none)"}\n  maxPerCall: ${atomicToUsdc(next.limits?.maxPerCallAtomic)}  cooldownMs: ${next.limits?.cooldownMs ?? "-"}  https: ${next.limits?.requireHttps ?? true}\n`);
    return;
  }

  if (a.cmd === "unset") {
    if (!a.host) throw new Error("unset requires <host>");
    const hp = policy[a.host] as HostPolicy | undefined;
    if (!hp) { process.stdout.write(`(no entry: ${a.host})\n`); return; }
    if (a.removeHeader) {
      if (hp.headers) delete hp.headers[a.removeHeader];
      savePolicy(policy);
      process.stdout.write(`✓ removed header ${a.removeHeader} from ${a.host}\n`);
    } else {
      delete policy[a.host];
      savePolicy(policy);
      process.stdout.write(`✓ removed host ${a.host}\n`);
    }
    return;
  }

  if (a.cmd === "defaults") {
    const d: PolicyDefaults = { ...(policy._defaults ?? {}) };
    if (a.allowUnlisted !== undefined) d.allowUnlisted = parseBool(a.allowUnlisted);
    const limits = buildLimits(d.limits, a);
    if (Object.keys(limits).length) d.limits = limits;
    policy._defaults = d;
    savePolicy(policy);
    process.stdout.write(`✓ defaults: allowUnlisted=${d.allowUnlisted ?? false} maxPerCall=${atomicToUsdc(d.limits?.maxPerCallAtomic)} https=${d.limits?.requireHttps ?? true}\n`);
    return;
  }

  usage();
}
