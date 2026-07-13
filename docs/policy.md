# Host policy (`policy.json`) — reference

Per-host **auth-header injection + spending guardrails** read by the
`x402_http_call` tool. Everything that differs per service lives in data
rather than code, so adding a new service is a single line and no host is
ever hardcoded.

## Location

- Default: `~/.hpp-x402/policy.json` (the directory can be changed with `$HPP_X402_HOME`)
- Override: `$HPP_X402_CRED_FILE` (point directly at a file path)
- The bridge **reads it on every tool call** → no restart needed after edits
- Print the exact path: `hpp-x402-policy path`

## Schema

```jsonc
{
  "_defaults": {
    "allowUnlisted": false,                 // allow unlisted hosts? (default false = deny = allowlist)
    "limits": { "requireHttps": true, "maxPerCallAtomic": "1000000" }
  },
  "<host>": {                               // exact match (port included, lowercase). no wildcards
    "headers": { "<HeaderName>": "<value-source>" },
    "limits": {
      "requireHttps":     true,             // force https (set false for local http)
      "maxPerCallAtomic": "5000000",        // per-call cap (atomic, USDC.e 6dec → 5000000 = 5)
      "cooldownMs":       300000,           // minimum interval between payments (ms) — idempotency (H2)
      "maxPerDayAtomic":  "20000000"        // (parsed only; per-day ledger is a follow-up)
    }
  }
}
```

`host` is `new URL(url).host` (lowercase). If it is not in the policy and
`allowUnlisted=false`, the call is **rejected before payment**.

## value-source (where a header value comes from)

Secrets are never written into the file directly — only references are.
At call time they are resolved **locally only** and injected into the
header (never exposed to the LLM or logs). If resolution fails, the call
**aborts with an error rather than sending without auth**.

| Form | Meaning |
|------|------|
| `file:<path>#<field>` | field in a JSON file (`~` expansion, nested `a.b.c`) |
| `env:<VAR>` | environment variable |
| `keychain://<svc>/<acct>` | OS keychain |
| `literal:<value>` | inline plaintext (**dev only**) |

## Guardrails

| Key | Effect |
|----|------|
| `allowUnlisted` (_defaults) | if false, only registered hosts can be called (deny-by-default) |
| `requireHttps` | reject non-https targets (set false per-host for local http) |
| `maxPerCallAtomic` | per-call payment cap — applied to **the 402 amount the server asked for** (defends against a malicious server) |
| `cooldownMs` | a repeat payment within this window of the last one returns the previous result (no re-payment) |

> The on-chain Safe AllowanceModule daily limit is the **final hard cap** (the policy file cannot exceed it).

## CLI — `hpp-x402-policy`

Usable instead of hand-editing the JSON:

```bash
hpp-x402-policy path                          # file path
hpp-x402-policy show                          # full JSON
hpp-x402-policy list                          # host summary

# add/edit a host (--header is repeatable; --max-per-call is in USDC units → auto-converted to atomic)
hpp-x402-policy set hub-stage.hpp.io \
  --header X-Api-Key=file:~/.hpphub/config.json#api_key \
  --max-per-call 5 --cooldown-ms 300000

hpp-x402-policy set localhost:4000 \
  --header X-Api-Key=file:~/.hpphub/config.json#api_key \
  --max-per-call 5 --https false            # allow local http

hpp-x402-policy unset <host>                  # remove a host
hpp-x402-policy unset <host> --header NAME    # remove a single header

hpp-x402-policy defaults --allow-unlisted false --max-per-call 1 --https true
```

## Example (complete)

```jsonc
{
  "_defaults": { "allowUnlisted": false, "limits": { "requireHttps": true, "maxPerCallAtomic": "1000000" } },
  "hub-stage.hpp.io": {
    "headers": { "X-Api-Key": "file:~/.hpphub/config.json#api_key" },
    "limits":  { "requireHttps": true, "maxPerCallAtomic": "5000000", "cooldownMs": 300000 }
  },
  "localhost:4000": {
    "headers": { "X-Api-Key": "file:~/.hpphub/config.json#api_key" },
    "limits":  { "requireHttps": false, "maxPerCallAtomic": "5000000", "cooldownMs": 300000 }
  }
}
```

## Security notes

- File permission 0600 recommended (the CLI writes 0600). `literal:` plaintext is dev-only — use `file:`/`keychain://` in production.
- value-sources are resolved locally only, and the result is sent **only as a request header to the target host**. It is never exposed in logs or tool args.
